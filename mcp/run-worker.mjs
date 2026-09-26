import { cancelJob, getJobResult, createJob, startJobWorker } from "./jobs.mjs";
import { getRoles } from "./lib.mjs";
import { normalizeOutput, parseRoleSelector } from "./gateway.mjs";
import { actualUsageCost, estimateModelCost } from "./pricing.mjs";
import { routingCompatibility } from "./run-manager.mjs";
import {
  appendRunEvent, readArtifact, readRun, runJobsDir, updateRun, writeArtifact
} from "./run-store.mjs";
import { getTemplate } from "./templates.mjs";
import { validateStandaloneHtml } from "./validators.mjs";

const invokedAsWorker = process.argv[1]?.endsWith("run-worker.mjs");
const id = invokedAsWorker ? process.argv[2] : null;
const mode = invokedAsWorker ? process.argv[3] || "initial" : "initial";
if (invokedAsWorker && !id) process.exit(2);

function nodeDefinition(run, nodeId) {
  return getTemplate(run.template).nodes.find((node) => node.id === nodeId);
}

function nodeState(run, nodeId) {
  return run.nodes.find((node) => node.id === nodeId);
}

function updateNode(nodeId, patch) {
  return updateRun(id, (run) => ({
    ...run,
    nodes: run.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node)
  }));
}

function promptTokens(prompt) { return Math.ceil(Buffer.byteLength(prompt) / 4); }

function finiteLimit(value) {
  if (value === null || value === undefined) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function completeRunForReview(runId, mutate) {
  let committed = false;
  updateRun(runId, (current) => {
    if (current.status !== "running") return current;
    committed = true;
    return { ...mutate(current), status: "awaiting_review", workerPid: null };
  });
  return committed;
}

function activeReservations(run) {
  return (run.nodes || []).reduce((totals, node) => {
    if (!node.reservation || !["reserving", "running"].includes(node.status)) return totals;
    for (const key of ["calls", "inputTokens", "outputTokens", "totalTokens", "highUsd"]) {
      if (node.reservation[key] !== null && node.reservation[key] !== undefined && totals[key] !== null) {
        totals[key] += node.reservation[key];
      }
    }
    if (node.reservation.highUsd === null) totals.highUsd = null;
    return totals;
  }, { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, highUsd: 0 });
}

function budgetError(message) {
  const error = new Error(message);
  error.name = "BudgetExceededError";
  return error;
}

function assertBudget(run, selector, prompt, maxOutputTokens) {
  if (run.deadlineAt && Date.now() >= Date.parse(run.deadlineAt)) {
    throw budgetError("Run duration budget has expired.");
  }
  const expectedInput = promptTokens(prompt);
  const expectedTokens = expectedInput + maxOutputTokens;
  const reserved = activeReservations(run);
  if (finiteLimit(run.budget.maxTotalTokens) !== null && run.usage.totalTokens + reserved.totalTokens + expectedTokens > run.budget.maxTotalTokens) {
    throw budgetError("Projected job exceeds the run token budget.");
  }
  if (finiteLimit(run.budget.maxCalls) !== null && run.usage.calls + reserved.calls + 1 > run.budget.maxCalls) {
    throw budgetError("Projected job exceeds the run call budget.");
  }
  if (run.budget.costPolicy === "enforce") {
    const projected = estimateModelCost(selector, { inputTokens: expectedInput, outputTokens: maxOutputTokens });
    if (
      projected.highUsd === null || reserved.highUsd === null || run.usage.apiEquivalentHighUsd === null
      || run.usage.apiEquivalentHighUsd + reserved.highUsd + projected.highUsd > run.budget.maxApiEquivalentUsd
    ) {
      throw budgetError("Projected job exceeds or cannot satisfy the enforced USD-equivalent budget.");
    }
  }
}

function reservationFor(selector, prompt, maxOutputTokens) {
  const inputTokens = promptTokens(prompt);
  const cost = estimateModelCost(selector, { inputTokens, outputTokens: maxOutputTokens });
  return {
    calls: 1,
    inputTokens,
    outputTokens: maxOutputTokens,
    totalTokens: inputTokens + maxOutputTokens,
    highUsd: cost.highUsd,
    createdAt: new Date().toISOString()
  };
}

export function reserveRunBudget(run, selector, prompt, maxOutputTokens) {
  assertBudget(run, selector, prompt, maxOutputTokens);
  return reservationFor(selector, prompt, maxOutputTokens);
}

function budgetForReservedNode(run, reservation) {
  const reserved = activeReservations(run);
  const others = {
    calls: reserved.calls - reservation.calls,
    inputTokens: reserved.inputTokens - reservation.inputTokens,
    outputTokens: reserved.outputTokens - reservation.outputTokens,
    totalTokens: reserved.totalTokens - reservation.totalTokens,
    highUsd: reserved.highUsd === null ? null : reserved.highUsd - (reservation.highUsd || 0)
  };
  const remaining = (name, used, reserve) => {
    const limit = finiteLimit(run.budget[name]);
    return limit === null ? undefined : Math.max(0, limit - used - reserve);
  };
  return {
    ...run.budget,
    maxCalls: remaining("maxCalls", run.usage.calls, others.calls),
    maxInputTokens: remaining("maxInputTokens", run.usage.inputTokens, others.inputTokens),
    maxOutputTokens: remaining("maxOutputTokens", run.usage.outputTokens, others.outputTokens),
    maxTotalTokens: remaining("maxTotalTokens", run.usage.totalTokens, others.totalTokens),
    maxDurationMs: Math.max(0, Date.parse(run.deadlineAt) - Date.now()),
    maxApiEquivalentUsd: run.budget.costPolicy === "disabled" ? null : remaining("maxApiEquivalentUsd", run.usage.apiEquivalentHighUsd || 0, others.highUsd || 0)
  };
}

export function accumulateRunUsage(totals, result, { costDisabled = false } = {}) {
  // A completed job consumed one call even when a backend cannot report token
  // telemetry. Keep tokens/cost unknown rather than manufacturing zero usage.
  totals.calls++;
  if (!result.usage) {
    if (!costDisabled) {
      totals.apiEquivalentLowUsd = null;
      totals.apiEquivalentHighUsd = null;
    }
    return totals;
  }
  totals.inputTokens += result.usage.input_tokens || 0;
  totals.cachedInputTokens += result.usage.input_tokens_details?.cached_tokens || 0;
  totals.outputTokens += result.usage.output_tokens || 0;
  totals.totalTokens += result.usage.total_tokens || 0;
  if (!costDisabled) {
    const cost = actualUsageCost(result.selector, result.usage);
    totals.apiEquivalentLowUsd = totals.apiEquivalentLowUsd === null || cost.lowUsd === null
      ? null : totals.apiEquivalentLowUsd + cost.lowUsd;
    totals.apiEquivalentHighUsd = totals.apiEquivalentHighUsd === null || cost.highUsd === null
      ? null : totals.apiEquivalentHighUsd + cost.highUsd;
  }
  return totals;
}

function refreshUsage() {
  const run = readRun(id);
  const seen = new Set();
  const costDisabled = run.budget.costPolicy === "disabled";
  const totals = {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    apiEquivalentLowUsd: costDisabled ? null : 0,
    apiEquivalentHighUsd: costDisabled ? null : 0
  };
  for (const node of run.nodes) {
    if (!node.jobId || seen.has(node.jobId)) continue;
    seen.add(node.jobId);
    let result;
    try { result = getJobResult({ id: node.jobId, jobRoot: runJobsDir(id) }); } catch { continue; }
    accumulateRunUsage(totals, result, { costDisabled });
  }
  const breaches = [];
  if (finiteLimit(run.budget.maxCalls) !== null && totals.calls > run.budget.maxCalls) breaches.push("maxCalls");
  if (finiteLimit(run.budget.maxTotalTokens) !== null && totals.totalTokens > run.budget.maxTotalTokens) breaches.push("maxTotalTokens");
  if (run.deadlineAt && Date.now() > Date.parse(run.deadlineAt)) breaches.push("maxDurationMs");
  if (run.budget.costPolicy === "enforce" && (
    totals.apiEquivalentHighUsd === null || totals.apiEquivalentHighUsd > run.budget.maxApiEquivalentUsd
  )) breaches.push(totals.apiEquivalentHighUsd === null ? "priceUnknown" : "maxApiEquivalentUsd");
  updateRun(id, (current) => ({ ...current, usage: totals }));
  return { totals, breaches };
}

async function waitForJob(jobId) {
  for (;;) {
    try { return getJobResult({ id: jobId, jobRoot: runJobsDir(id) }); }
    catch (error) {
      if (!/still (queued|running)/.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function startNode(nodeId, role, contract, prompt, maxOutputTokens, timeoutMs = 1_200_000) {
  let run = readRun(id);
  if (run.status !== "running") throw new Error(`Run cannot start a node from ${run.status}.`);
  const existing = nodeState(run, nodeId);
  if (existing?.jobId) {
    appendRunEvent(id, "node.resumed", { node: nodeId, jobId: existing.jobId });
    return { jobId: existing.jobId, result: null };
  }
  const roles = getRoles();
  const selector = roles[role];
  if (!selector) throw new Error(`Run role is not configured: ${role}`);
  const compatibility = routingCompatibility(selector, contract);
  if (!compatibility.allowed) throw new Error(compatibility.reason);
  const reservation = reserveRunBudget(run, selector, prompt, maxOutputTokens);
  run = updateRun(id, (current) => {
    if (current.status !== "running") throw new Error(`Run cannot reserve a node from ${current.status}.`);
    const node = nodeState(current, nodeId);
    if (node?.jobId) return current;
    if (["reserving", "running"].includes(node?.status)) throw new Error(`Node ${nodeId} is already reserved.`);
    reserveRunBudget(current, selector, prompt, maxOutputTokens);
    return {
      ...current,
      nodes: current.nodes.map((item) => item.id === nodeId
        ? { ...item, status: "reserving", role, selector, reservation, startedAt: new Date().toISOString() }
        : item)
    };
  });
  const reservedNode = nodeState(run, nodeId);
  if (reservedNode?.jobId) return { jobId: reservedNode.jobId, result: null };
  if (readRun(id).status !== "running") throw new Error("Run was cancelled before dispatch.");
  const created = await createJob({
    role, prompt, contract, maxOutputTokens, timeoutMs, budget: budgetForReservedNode(run, reservation),
    deadlineAt: run.deadlineAt, confirmQuota: true, jobRoot: runJobsDir(id), runId: id, deferWorker: true
  });
  // The run points at a queued job before it can dispatch, so recovery can
  // attach to it instead of creating a second paid attempt.
  let linked = false;
  updateRun(id, (current) => {
    if (current.status !== "running") return current;
    linked = true;
    return { ...current, nodes: current.nodes.map((item) => item.id === nodeId
      ? { ...item, status: "running", role, selector, jobId: created.id, reservation, startedAt: new Date().toISOString() }
      : item) };
  });
  if (!linked || readRun(id).status !== "running") {
    await cancelJob({ id: created.id, confirm: true, graceMs: 0, jobRoot: runJobsDir(id) }).catch(() => {});
    throw new Error("Run was cancelled before dispatch.");
  }
  startJobWorker(created.id, runJobsDir(id));
  appendRunEvent(id, "node.started", { node: nodeId, role, selector, jobId: created.id });
  return { jobId: created.id, result: null };
}

async function finishNode(nodeId, started) {
  let result = started.result || await waitForJob(started.jobId);
  if (result.status === "invalid" && result.output) {
    const definition = nodeDefinition(readRun(id), nodeId);
    const contract = definition?.contract || (nodeId.includes("fallback") ? "standalone_html" : null);
    if (contract) {
      const normalized = normalizeOutput(result.output, contract);
      if (normalized.changed && normalized.validation.valid) {
        result = {
          ...result,
          status: "succeeded",
          output: normalized.output,
          outputBytes: Buffer.byteLength(normalized.output),
          validation: normalized.validation,
          normalization: { transformation: normalized.transformation, recoveredByRun: true }
        };
        appendRunEvent(id, "contract.recovered", { node: nodeId, jobId: result.id, transformation: normalized.transformation });
      }
    }
  }
  updateNode(nodeId, { status: result.status, completedAt: new Date().toISOString(), validation: result.validation, usage: result.usage });
  const refreshed = refreshUsage();
  appendRunEvent(id, "node.completed", { node: nodeId, jobId: result.id, status: result.status, usage: result.usage });
  if (refreshed.breaches.length) throw budgetError(`Run actual usage exceeded: ${refreshed.breaches.join(", ")}.`);
  return result;
}

async function executeNode(nodeId, role, contract, prompt, maxOutputTokens) {
  return finishNode(nodeId, await startNode(nodeId, role, contract, prompt, maxOutputTokens));
}

function requireSuccess(result, label) {
  if (result.status !== "succeeded") throw new Error(`${label} failed contract or provider execution: ${result.status}`);
  return result.output;
}

async function initialPipeline() {
  const run = readRun(id);
  const input = run.input;
  const planPrompt = `Produce concise architecture notes for a separate implementer. Do not emit a complete artifact. Cover correctness, state, edge cases, validation, and acceptance criteria.\n\nREQUEST:\n${input}`;
  const designPrompt = `Produce concise visual and interaction notes for a separate implementer. Do not emit a complete HTML document or implementation. Cover layout, accessibility, responsive behavior, and user experience.\n\nREQUEST:\n${input}`;
  const planDef = nodeDefinition(run, "plan");
  const designDef = nodeDefinition(run, "design");
  const planStarted = await startNode("plan", planDef.role, planDef.contract, planPrompt, planDef.maxOutputTokens);
  const designStarted = await startNode("design", designDef.role, designDef.contract, designPrompt, designDef.maxOutputTokens);
  // Provider jobs run concurrently; persist terminal states sequentially so
  // complete run payload updates cannot overwrite one another.
  const planResult = await finishNode("plan", planStarted);
  const designResult = await finishNode("design", designStarted);
  let plan;
  if (planResult.status === "succeeded") plan = planResult.output;
  else {
    const retryId = "plan-retry";
    if (!nodeState(readRun(id), retryId)) {
      updateRun(id, (current) => ({ ...current, nodes: [...current.nodes, { id: retryId, type: "inference", status: "pending", role: "plan", jobId: null }] }));
    }
    appendRunEvent(id, "fallback.selected", { from: "plan", to: retryId, reason: planResult.status });
    plan = requireSuccess(await executeNode(retryId, "plan", "notes", planPrompt, 2500), "Planning retry");
  }
  let design;
  if (designResult.status === "succeeded") design = designResult.output;
  else {
    const fallbackId = "design-fallback";
    if (!nodeState(readRun(id), fallbackId)) {
      updateRun(id, (current) => ({ ...current, nodes: [...current.nodes, { id: fallbackId, type: "inference", status: "pending", role: "plan", jobId: null }] }));
    }
    appendRunEvent(id, "fallback.selected", { from: "design", to: fallbackId, reason: designResult.status });
    design = requireSuccess(await executeNode(fallbackId, "plan", "notes", designPrompt, 2500), "Design fallback");
  }

  const candidateDef = nodeDefinition(readRun(id), "candidate");
  const candidatePrompt = `Build the requested artifact from scratch using the advisory notes. Return only a complete offline standalone HTML document, no Markdown or commentary.\n\nREQUEST:\n${input}\n\nARCHITECTURE NOTES:\n${plan}\n\nDESIGN NOTES:\n${design}`;
  let candidateResult = await executeNode("candidate", candidateDef.role, candidateDef.contract, candidatePrompt, candidateDef.maxOutputTokens);
  if (candidateResult.status !== "succeeded" && candidateDef.fallbackRole) {
    const fallbackId = "candidate-fallback";
    if (!nodeState(readRun(id), fallbackId)) {
      updateRun(id, (current) => ({ ...current, nodes: [...current.nodes, { id: fallbackId, type: "inference", status: "pending", role: candidateDef.fallbackRole, jobId: null }] }));
    }
    appendRunEvent(id, "fallback.selected", { from: "candidate", to: fallbackId, reason: candidateResult.status });
    candidateResult = await executeNode(fallbackId, candidateDef.fallbackRole, candidateDef.contract, candidatePrompt, candidateDef.maxOutputTokens);
  }
  const candidate = requireSuccess(candidateResult, "Candidate node");
  const artifact = writeArtifact(id, "candidate.html", candidate);
  const validation = validateStandaloneHtml(candidate);
  const committed = completeRunForReview(id, (current) => ({
    ...current,
    phase: "attestation",
    validation,
    artifacts: [...current.artifacts.filter((item) => item.name !== artifact.name), artifact],
    nodes: current.nodes.map((node) => node.id === "validate" ? { ...node, status: validation.valid ? "succeeded" : "failed", validation } : node)
  }));
  if (!committed) return;
  appendRunEvent(id, "validation.completed", { valid: validation.valid, errors: validation.errors, warnings: validation.warnings });
  appendRunEvent(id, "run.awaiting_review", { artifact: artifact.name });
}

async function independentAnalysisPipeline() {
  const run = readRun(id);
  const definition = getTemplate(run.template);
  const first = definition.nodes.find((node) => node.id === "analysis-a");
  const second = definition.nodes.find((node) => node.id === "analysis-b");
  const promptA = `Analyze the request independently. Return concise evidence-oriented notes, not a final artifact.\n\nREQUEST:\n${run.input}`;
  const promptB = `Analyze the request independently from a second perspective. Return concise risks, alternatives, and verification notes, not a final artifact.\n\nREQUEST:\n${run.input}`;
  const startedA = await startNode(first.id, first.role, first.contract, promptA, first.maxOutputTokens);
  const startedB = await startNode(second.id, second.role, second.contract, promptB, second.maxOutputTokens);
  const resultA = await finishNode(first.id, startedA);
  const resultB = await finishNode(second.id, startedB);
  const analysisA = requireSuccess(resultA, "First analysis");
  const analysisB = requireSuccess(resultB, "Second analysis");
  const artifact = writeArtifact(id, "analysis.json", JSON.stringify({ analysisA, analysisB }, null, 2));
  const committed = completeRunForReview(id, (current) => ({
    ...current, phase: "attestation",
    validation: { valid: true, errors: [], warnings: [], checks: { independentOutputs: true } },
    artifacts: [...current.artifacts.filter((item) => item.name !== artifact.name), artifact]
  }));
  if (!committed) return;
  appendRunEvent(id, "run.awaiting_review", { artifact: artifact.name });
}

async function finalizePipeline() {
  const run = readRun(id);
  const candidate = readArtifact(id, run.artifacts.some((item) => item.name === "final.html") ? "final.html" : "candidate.html");
  const findings = JSON.stringify(run.attestation?.findings || []);
  const definition = nodeDefinition(run, "finalize");
  const prompt = `Revise the candidate using the reviewer findings. Return only the complete corrected offline standalone HTML document.\n\nORIGINAL REQUEST:\n${run.input}\n\nREVIEW FINDINGS:\n${findings}\n\nCANDIDATE:\n${candidate}`;
  let result = await executeNode("finalize", definition.role, definition.contract, prompt, definition.maxOutputTokens);
  if (result.status !== "succeeded") throw new Error(`Finalization failed: ${result.status}`);
  const artifact = writeArtifact(id, "final.html", result.output);
  const validation = validateStandaloneHtml(result.output);
  const committed = completeRunForReview(id, (current) => ({
    ...current, phase: "attestation_final", validation,
    artifacts: [...current.artifacts.filter((item) => item.name !== artifact.name), artifact]
  }));
  if (!committed) return;
  appendRunEvent(id, "validation.completed", { valid: validation.valid, errors: validation.errors, warnings: validation.warnings, artifact: artifact.name });
  appendRunEvent(id, "run.awaiting_review", { artifact: artifact.name, final: true });
}

if (id) {
  try {
    if (readRun(id).status === "running") {
      appendRunEvent(id, "worker.started", { mode, pid: process.pid });
      if (mode === "finalize") await finalizePipeline();
      else if (readRun(id).template === "independent-analysis") await independentAnalysisPipeline();
      else await initialPipeline();
    }
  } catch (error) {
    if (readRun(id).status === "running") {
      const budget = error.name === "BudgetExceededError";
      updateRun(id, (run) => ({
        ...run, status: budget ? "budget_exceeded" : "failed", workerPid: null,
        error: { name: error.name || "Error", message: error.message }, completedAt: new Date().toISOString()
      }));
      appendRunEvent(id, budget ? "run.budget_exceeded" : "run.failed", { error: error.message });
    }
  }
}
