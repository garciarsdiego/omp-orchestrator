import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJob, updateJob } from "./job-store.mjs";
import { getRoles } from "./lib.mjs";
import { processReused, workerProcess } from "./process-identity.mjs";
import { parseRoleSelector } from "./gateway.mjs";
import { estimateModelCost, sumCosts } from "./pricing.mjs";
import {
  appendRunEvent, listRuns, newRunId, publicRun, readArtifact, readRun, readRunEvents,
  runJobsDir, updateRun, writeRun
} from "./run-store.mjs";
import { runtimeStatus } from "./runtime.mjs";
import { getDatabase } from "./storage.mjs";
import { getTemplate, listTemplates } from "./templates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_WORKER = path.join(HERE, "run-worker.mjs");

export function routingCompatibility(selector, contract) {
  const { provider, model } = parseRoleSelector(selector);
  if (`${provider}/${model}` === "xai-oauth/grok-composer-2.5-fast" && ["html", "standalone_html"].includes(contract)) {
    return { allowed: false, reason: "Composer 2.5 is quarantined for artifact contracts over the Responses gateway." };
  }
  return { allowed: true, reason: null };
}

export function estimateRun({ template = "single-file-web-app", input = "", budget, rolesOverride } = {}) {
  const definition = getTemplate(template);
  const roles = rolesOverride || getRoles();
  const nodes = definition.nodes.map((node) => {
    if (node.type !== "inference") return { id: node.id, type: node.type, conditional: Boolean(node.conditional) };
    const selector = roles[node.role];
    if (!selector) throw new Error(`Template role is not configured: ${node.role}`);
    const compatibility = routingCompatibility(selector, node.contract);
    const inputTokens = node.estimatedInputTokens + Math.ceil(Buffer.byteLength(input) / 4);
    const outputTokens = node.maxOutputTokens;
    const cost = estimateModelCost(selector, { inputTokens, outputTokens });
    return {
      id: node.id,
      type: node.type,
      role: node.role,
      selector,
      contract: node.contract,
      conditional: Boolean(node.conditional),
      compatibility,
      estimatedInputTokens: inputTokens,
      maxOutputTokens: outputTokens,
      estimatedTotalTokens: inputTokens + outputTokens,
      estimatedCost: cost
    };
  });
  const baseNodes = nodes.filter((node) => node.type === "inference" && !node.conditional);
  const contingencyNodes = nodes.filter((node) => node.type === "inference" && node.conditional);
  const summarize = (selected) => ({
    calls: selected.length,
    tokens: selected.reduce((sum, node) => sum + node.estimatedTotalTokens, 0),
    cost: sumCosts(selected.map((node) => node.estimatedCost))
  });
  const base = summarize(baseNodes);
  const contingency = summarize(contingencyNodes);
  const effectiveBudget = { ...definition.defaultBudget, ...(budget || {}) };
  if (!["observe", "enforce", "disabled"].includes(effectiveBudget.costPolicy)) {
    throw new Error("costPolicy must be observe, enforce, or disabled.");
  }
  const warnings = [];
  for (const node of nodes) if (node.compatibility && !node.compatibility.allowed) warnings.push(`${node.id}: ${node.compatibility.reason}`);
  if (effectiveBudget.costPolicy !== "disabled") {
    for (const node of baseNodes) {
      if (node.estimatedCost.highUsd === null) {
        warnings.push(effectiveBudget.costPolicy === "enforce"
          ? `${node.id}: pricing is unknown and cannot satisfy an enforced USD-equivalent budget.`
          : `${node.id}: pricing is unknown; USD-equivalent reporting will be partial.`);
      }
    }
  }
  if (base.tokens > effectiveBudget.maxTotalTokens) warnings.push("Base estimate exceeds maxTotalTokens.");
  if (
    effectiveBudget.costPolicy === "enforce"
    && base.cost.highUsd !== null
    && base.cost.highUsd > effectiveBudget.maxApiEquivalentUsd
  ) warnings.push("Base estimate exceeds maxApiEquivalentUsd.");
  return { template: definition.id, nodes, base, contingency, budget: effectiveBudget, warnings };
}

export function assertEstimateBudget(estimate) {
  if (estimate.base.tokens > estimate.budget.maxTotalTokens) {
    throw new Error("Budget does not cover the base pipeline: Base estimate exceeds maxTotalTokens.");
  }
  if (estimate.base.calls > estimate.budget.maxCalls) {
    throw new Error("Budget does not cover the base pipeline: Base estimate exceeds maxCalls.");
  }
  if (estimate.budget.costPolicy === "enforce") {
    if (estimate.base.cost.highUsd === null) {
      throw new Error("Base pipeline contains unknown pricing and cannot satisfy an enforced USD-equivalent budget.");
    }
    if (estimate.base.cost.highUsd > estimate.budget.maxApiEquivalentUsd) {
      throw new Error("Budget does not cover the base pipeline: Base estimate exceeds maxApiEquivalentUsd.");
    }
  }
}

const RUN_BUDGET_FIELDS = new Set(["maxCalls", "maxTotalTokens", "costPolicy", "maxApiEquivalentUsd", "maxDurationMs"]);

export function validateRunBudget(changes, previous = {}, usage = {}) {
  if (changes === undefined) changes = {};
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("Run budget must be an object.");
  for (const [key, value] of Object.entries(changes)) {
    if (!RUN_BUDGET_FIELDS.has(key)) throw new Error(`Unknown run budget field: ${key}.`);
    if (key === "costPolicy") {
      if (!["observe", "enforce", "disabled"].includes(value)) throw new Error("Invalid costPolicy.");
    } else if (key === "maxApiEquivalentUsd") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("maxApiEquivalentUsd must be a finite non-negative number.");
    } else if (!Number.isSafeInteger(value) || value < (key === "maxDurationMs" ? 10_000 : 1)) {
      throw new Error(`${key} must be a positive bounded integer.`);
    }
  }
  const next = { ...previous, ...changes };
  if (!Number.isSafeInteger(next.maxCalls) || next.maxCalls < 1 || next.maxCalls > 20) throw new Error("maxCalls must be 1–20.");
  if (!Number.isSafeInteger(next.maxTotalTokens) || next.maxTotalTokens < 1) throw new Error("maxTotalTokens must be positive.");
  if (!Number.isSafeInteger(next.maxDurationMs) || next.maxDurationMs < 10_000 || next.maxDurationMs > 7_200_000) throw new Error("maxDurationMs must be 10000–7200000.");
  if (!["observe", "enforce", "disabled"].includes(next.costPolicy)) throw new Error("Invalid costPolicy.");
  if (next.costPolicy === "enforce" && (!Number.isFinite(next.maxApiEquivalentUsd) || next.maxApiEquivalentUsd < 0)) {
    throw new Error("Enforced cost policy requires maxApiEquivalentUsd.");
  }
  if (Number.isFinite(usage.calls) && next.maxCalls < usage.calls) throw new Error("Run budget is below calls already consumed.");
  if (Number.isFinite(usage.totalTokens) && next.maxTotalTokens < usage.totalTokens) throw new Error("Run budget is below tokens already consumed.");
  return next;
}

function spawnRunWorker(id, mode = "initial") {
  const child = spawn(process.execPath, [RUN_WORKER, id, mode], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env
  });
  child.unref();
  return child.pid;
}

// A PID reused by another process (and that process's group) must never
// receive SIGTERM. A dead leader is still signalled by group so surviving
// children stop; Linux does not reuse a PID while its process group exists.
function stopProcessTree(pid, identity) {
  if (!Number.isInteger(pid) || pid <= 0 || processReused(pid, identity)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch {}
  }
}

export async function createRun({
  template = "single-file-web-app", input, budget, confirmBudget = false, confirmQuota = false, rolesOverride
} = {}) {
  if (!input || typeof input !== "string") throw new Error("A non-empty run input is required.");
  if (Buffer.byteLength(input) > 512_000) throw new Error("Run input exceeds the 512 KB limit.");
  const checkedBudget = validateRunBudget(budget, getTemplate(template).defaultBudget);
  const estimate = estimateRun({ template, input, budget: checkedBudget, rolesOverride });
  if (!confirmBudget) return { awaitingApproval: true, estimate };
  if (!confirmQuota) throw new Error("Run creation requires confirmQuota=true.");
  if (estimate.nodes.some((node) => node.compatibility && !node.compatibility.allowed)) {
    throw new Error("Routing policy blocks at least one required pipeline node.");
  }
  assertEstimateBudget(estimate);
  const runtime = await runtimeStatus();
  if (!runtime.running) throw new Error("OMP runtime is not running. Start it before creating a run.");
  const now = new Date().toISOString();
  const definition = getTemplate(template);
  const run = {
    id: newRunId(),
    template: definition.id,
    status: "running",
    phase: "initial",
    input,
    budget: estimate.budget,
    estimate,
    usage: {
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      apiEquivalentLowUsd: estimate.budget.costPolicy === "disabled" ? null : 0,
      apiEquivalentHighUsd: estimate.budget.costPolicy === "disabled" ? null : 0
    },
    nodes: definition.nodes.map((node) => ({ id: node.id, type: node.type, status: "pending", role: node.role || null, jobId: null })),
    artifacts: [],
    validation: null,
    attestation: null,
    revisionCount: 0,
    eventCount: 0,
    workerPid: null,
    deadlineAt: new Date(Date.now() + estimate.budget.maxDurationMs).toISOString(),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null
  };
  writeRun(run);
  appendRunEvent(run.id, "run.created", { template: run.template, budget: run.budget });
  const pid = spawnRunWorker(run.id, "initial");
  const updated = updateRun(run.id, (current) => ({ ...current, ...workerProcess(pid) }));
  return publicRun(updated);
}

export function getRun({ id } = {}) { return publicRun(readRun(id)); }
export function getRuns({ limit = 25 } = {}) { return listRuns(limit).map(publicRun); }
export function getRunEvents({ id, after = 0, limit = 100 } = {}) { return readRunEvents(id, after, limit); }
export function getPipelineTemplates() { return listTemplates(); }
export function getRoutingPolicy() {
  return {
    version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    rules: [
      {
        selector: "xai-oauth/grok-composer-2.5-fast",
        transport: "responses",
        contracts: ["html", "standalone_html"],
        policy: "blocked",
        reason: "Repeated artifact-contract failures in clean-room validation runs."
      }
    ],
    default: "allowed"
  };
}

export function prepareNodesForResume(nodes = []) {
  return nodes.map((node) => (
    ["failed", "invalid", "interrupted", "reserving"].includes(node.status)
      ? {
          ...node,
          status: "pending",
          jobId: null,
          startedAt: null,
          completedAt: null,
          validation: null,
          usage: null
        }
      : node
  ));
}

export async function attestRun({ id, verdict, findings = [], expectedArtifactSha256, confirmQuota = false } = {}) {
  if (!new Set(["accept", "revise", "reject"]).has(verdict)) throw new Error("Verdict must be accept, revise, or reject.");
  const normalizedFindings = Array.isArray(findings) ? findings.map(String) : [String(findings)];
  if (Buffer.byteLength(JSON.stringify(normalizedFindings)) > 64_000) throw new Error("Attestation findings exceed 64 KB.");
  if (verdict === "revise") {
    if (!confirmQuota) throw new Error("Revision requires confirmQuota=true.");
    const runtime = await runtimeStatus();
    if (!runtime.running) throw new Error("OMP runtime is not running.");
  }
  const result = getDatabase().transaction(() => {
    const run = readRun(id);
    if (!["awaiting_review", "awaiting_codex"].includes(run.status)) {
      throw new Error(`Run is not awaiting review; current status is ${run.status}.`);
    }
    const artifact = run.artifacts.find((item) => item.name === "final.html")
      || run.artifacts.find((item) => item.name === "candidate.html")
      || run.artifacts.at(-1);
    if (!artifact?.sha256 || expectedArtifactSha256 !== artifact.sha256) {
      throw new Error("Review requires the current artifact SHA-256. Inspect the artifact and retry with its exact hash.");
    }
    if (verdict === "accept" && !run.validation?.valid) {
      throw new Error("Cannot accept a run with failing deterministic validation.");
    }
    if (verdict === "revise" && (run.revisionCount || 0) >= 1) {
      throw new Error("This pipeline allows one paid revision per run.");
    }
    const at = new Date().toISOString();
    const attestation = { verdict, findings: normalizedFindings, at, artifactSha256: artifact.sha256 };
    const nodeStatus = verdict === "accept" ? "succeeded" : verdict === "reject" ? "failed" : "revision_requested";
    const updated = updateRun(id, (current) => ({
      ...current,
      status: verdict === "accept" ? "succeeded" : verdict === "reject" ? "failed" : "running",
      phase: verdict === "accept" ? "complete" : verdict === "reject" ? "rejected" : "finalization",
      attestation,
      finalArtifact: verdict === "accept" ? artifact.name : current.finalArtifact,
      revisionCount: (current.revisionCount || 0) + (verdict === "revise" ? 1 : 0),
      completedAt: verdict === "revise" ? null : at,
      workerPid: null,
      error: verdict === "revise" ? null : current.error,
      nodes: current.nodes.map((node) => node.id === "codex" ? { ...node, status: nodeStatus, verdict, completedAt: at } : node)
    }));
    appendRunEvent(id, "review.attested", { verdict, findingCount: normalizedFindings.length, artifactSha256: artifact.sha256 });
    if (verdict === "accept") appendRunEvent(id, "run.succeeded", { artifact: artifact.name });
    else if (verdict === "reject") appendRunEvent(id, "run.rejected");
    else appendRunEvent(id, "run.revision_started", { revisionCount: updated.revisionCount });
    return publicRun(readRun(id));
  }).immediate();
  if (verdict !== "revise") return result;
  const pid = spawnRunWorker(id, "finalize");
  updateRun(id, (current) => ({ ...current, ...workerProcess(pid) }));
  return publicRun(readRun(id));
}

export function claimRunResume(id, budget) {
  const lease = randomUUID();
  const run = updateRun(id, (current) => {
    if (!new Set(["failed", "budget_exceeded", "interrupted"]).has(current.status)) {
      throw new Error(`Run cannot be resumed from ${current.status}.`);
    }
    const nextBudget = validateRunBudget(budget, current.budget, current.usage);
    const resumedPhase = current.phase === "interrupted" ? current.interruptedFromPhase || "initial" : current.phase;
    return {
      ...current, status: "running", phase: resumedPhase, interruptedFromPhase: null,
      budget: nextBudget, workerPid: null, error: null,
      resumeLease: lease, nodes: prepareNodesForResume(current.nodes),
      deadlineAt: new Date(Date.now() + nextBudget.maxDurationMs).toISOString(), completedAt: null
    };
  });
  return { run, lease };
}

export async function resumeRun({ id, budget, confirmBudget = false, confirmQuota = false } = {}) {
  if (!confirmBudget || !confirmQuota) throw new Error("Resume requires confirmBudget=true and confirmQuota=true.");
  const runtime = await runtimeStatus();
  if (!runtime.running) throw new Error("OMP runtime is not running.");
  const { run, lease } = claimRunResume(id, budget);
  const mode = run.phase === "finalization" ? "finalize" : "initial";
  appendRunEvent(id, "run.resumed", { mode });
  const beforeSpawn = readRun(id);
  if (beforeSpawn.resumeLease !== lease || beforeSpawn.status !== "running") {
    throw new Error("Run state changed before worker dispatch.");
  }
  const pid = spawnRunWorker(id, mode);
  updateRun(id, (current) => current.resumeLease === lease && current.status === "running"
    ? { ...current, ...workerProcess(pid) } : current);
  return publicRun(readRun(id));
}

export function cancelRun({ id, confirm = false } = {}) {
  if (!confirm) throw new Error("Cancellation requires confirm=true.");
  const run = updateRun(id, (current) => {
    if (current.status === "cancelled" || current.status === "cancellation_requested") return current;
    if (["succeeded", "failed", "rejected", "budget_exceeded"].includes(current.status)) {
      throw new Error(`Run cannot be cancelled from terminal status ${current.status}.`);
    }
    if (current.status !== "running") throw new Error(`Run cannot be cancelled from ${current.status}.`);
    return { ...current, status: "cancellation_requested", phase: "cancellation" };
  });
  if (run.status === "cancelled") return publicRun(run);
  stopProcessTree(run.workerPid, run.workerIdentity);
  for (const node of run.nodes) {
    if (node.jobId) {
      try {
        const job = readJob(node.jobId, runJobsDir(id));
        stopProcessTree(job.workerPid, job.workerIdentity);
        updateJob(node.jobId, (current) => ["queued", "running", "cancellation_requested"].includes(current.status)
          ? { ...current, status: "cancelled", workerPid: null, completedAt: new Date().toISOString() }
          : current, runJobsDir(id));
      } catch {}
    }
  }
  let committed = false;
  updateRun(id, (current) => {
    if (current.status !== "cancellation_requested") return current;
    committed = true;
    return { ...current, status: "cancelled", phase: "cancelled", workerPid: null, completedAt: new Date().toISOString() };
  });
  if (committed) appendRunEvent(id, "run.cancelled");
  return publicRun(readRun(id));
}

export function getRunResult({ id } = {}) {
  const run = readRun(id);
  if (run.status !== "succeeded") throw new Error(`Run is not complete; current status is ${run.status}.`);
  return { ...publicRun(run), output: readArtifact(id, run.finalArtifact) };
}
