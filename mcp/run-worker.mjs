import { getJobResult, createJob } from "./jobs.mjs";
import { getRoles } from "./lib.mjs";
import { normalizeOutput, parseRoleSelector } from "./gateway.mjs";
import { actualUsageCost, estimateModelCost } from "./pricing.mjs";
import { routingCompatibility } from "./run-manager.mjs";
import {
  appendRunEvent, readArtifact, readRun, runJobsDir, updateRun, writeArtifact
} from "./run-store.mjs";
import { getTemplate } from "./templates.mjs";
import { validateStandaloneHtml } from "./validators.mjs";

const id = process.argv[2];
const mode = process.argv[3] || "initial";
if (!id) process.exit(2);

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

function assertBudget(run, selector, prompt, maxOutputTokens) {
  if (run.deadlineAt && Date.now() >= Date.parse(run.deadlineAt)) {
    const error = new Error("Run duration budget has expired.");
    error.name = "BudgetExceededError";
    throw error;
  }
  const expectedInput = promptTokens(prompt);
  const expectedTokens = expectedInput + maxOutputTokens;
  if (run.usage.totalTokens + expectedTokens > run.budget.maxTotalTokens) {
    const error = new Error("Projected job exceeds the run token budget.");
    error.name = "BudgetExceededError";
    throw error;
  }
  if (run.usage.calls + 1 > run.budget.maxCalls) {
    const error = new Error("Projected job exceeds the run call budget.");
    error.name = "BudgetExceededError";
    throw error;
  }
  const projected = estimateModelCost(selector, { inputTokens: expectedInput, outputTokens: maxOutputTokens });
  if (projected.highUsd === null || run.usage.apiEquivalentHighUsd + projected.highUsd > run.budget.maxApiEquivalentUsd) {
    const error = new Error("Projected job exceeds or cannot satisfy the run USD-equivalent budget.");
    error.name = "BudgetExceededError";
    throw error;
  }
}

function refreshUsage() {
  const run = readRun(id);
  const seen = new Set();
  const totals = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, apiEquivalentLowUsd: 0, apiEquivalentHighUsd: 0 };
  for (const node of run.nodes) {
    if (!node.jobId || seen.has(node.jobId)) continue;
    seen.add(node.jobId);
    let result;
    try { result = getJobResult({ id: node.jobId, jobRoot: runJobsDir(id) }); } catch { continue; }
    if (!result.usage) continue;
    totals.calls++;
    totals.inputTokens += result.usage.input_tokens || 0;
    totals.cachedInputTokens += result.usage.input_tokens_details?.cached_tokens || 0;
    totals.outputTokens += result.usage.output_tokens || 0;
    totals.totalTokens += result.usage.total_tokens || 0;
    const cost = actualUsageCost(result.selector, result.usage);
    totals.apiEquivalentLowUsd += cost.lowUsd || 0;
    totals.apiEquivalentHighUsd = totals.apiEquivalentHighUsd === null || cost.highUsd === null ? null : totals.apiEquivalentHighUsd + cost.highUsd;
  }
  updateRun(id, (current) => ({ ...current, usage: totals }));
  return totals;
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
  assertBudget(run, selector, prompt, maxOutputTokens);
  const created = await createJob({ role, prompt, contract, maxOutputTokens, timeoutMs, confirmQuota: true, jobRoot: runJobsDir(id) });
  updateNode(nodeId, { status: "running", role, selector, jobId: created.id, startedAt: new Date().toISOString() });
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
  refreshUsage();
  appendRunEvent(id, "node.completed", { node: nodeId, jobId: result.id, status: result.status, usage: result.usage });
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
  // atomic run.json updates cannot overwrite one another.
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
  updateRun(id, (current) => ({
    ...current,
    status: "awaiting_codex",
    phase: "attestation",
    workerPid: null,
    validation,
    artifacts: [...current.artifacts.filter((item) => item.name !== artifact.name), artifact],
    nodes: current.nodes.map((node) => node.id === "validate" ? { ...node, status: validation.valid ? "succeeded" : "failed", validation } : node)
  }));
  appendRunEvent(id, "validation.completed", { valid: validation.valid, errors: validation.errors, warnings: validation.warnings });
  appendRunEvent(id, "run.awaiting_codex", { artifact: artifact.name });
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
  updateRun(id, (current) => ({
    ...current, status: "awaiting_codex", phase: "attestation", workerPid: null,
    validation: { valid: true, errors: [], warnings: [], checks: { independentOutputs: true } },
    artifacts: [...current.artifacts.filter((item) => item.name !== artifact.name), artifact]
  }));
  appendRunEvent(id, "run.awaiting_codex", { artifact: artifact.name });
}

async function finalizePipeline() {
  const run = readRun(id);
  const candidate = readArtifact(id, run.artifacts.some((item) => item.name === "final.html") ? "final.html" : "candidate.html");
  const findings = JSON.stringify(run.attestation?.findings || []);
  const definition = nodeDefinition(run, "finalize");
  const prompt = `Revise the candidate using the Codex findings. Return only the complete corrected offline standalone HTML document.\n\nORIGINAL REQUEST:\n${run.input}\n\nCODEX FINDINGS:\n${findings}\n\nCANDIDATE:\n${candidate}`;
  let result = await executeNode("finalize", definition.role, definition.contract, prompt, definition.maxOutputTokens);
  if (result.status !== "succeeded") throw new Error(`Finalization failed: ${result.status}`);
  const artifact = writeArtifact(id, "final.html", result.output);
  const validation = validateStandaloneHtml(result.output);
  updateRun(id, (current) => ({
    ...current, status: "awaiting_codex", phase: "attestation_final", workerPid: null, validation,
    artifacts: [...current.artifacts.filter((item) => item.name !== artifact.name), artifact]
  }));
  appendRunEvent(id, "validation.completed", { valid: validation.valid, errors: validation.errors, warnings: validation.warnings, artifact: artifact.name });
  appendRunEvent(id, "run.awaiting_codex", { artifact: artifact.name, final: true });
}

try {
  appendRunEvent(id, "worker.started", { mode, pid: process.pid });
  if (mode === "finalize") await finalizePipeline();
  else if (readRun(id).template === "independent-analysis") await independentAnalysisPipeline();
  else await initialPipeline();
} catch (error) {
  const budget = error.name === "BudgetExceededError";
  updateRun(id, (run) => ({
    ...run, status: budget ? "budget_exceeded" : "failed", workerPid: null,
    error: { name: error.name || "Error", message: error.message }, completedAt: new Date().toISOString()
  }));
  appendRunEvent(id, budget ? "run.budget_exceeded" : "run.failed", { error: error.message });
}
