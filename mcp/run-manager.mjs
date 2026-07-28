import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRoles } from "./lib.mjs";
import { parseRoleSelector } from "./gateway.mjs";
import { estimateModelCost, sumCosts } from "./pricing.mjs";
import {
  appendRunEvent, listRuns, newRunId, publicRun, readArtifact, readRun, readRunEvents,
  runJobsDir, updateRun, writeRun
} from "./run-store.mjs";
import { runtimeStatus } from "./runtime.mjs";
import { getTemplate, listTemplates } from "./templates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_WORKER = path.join(HERE, "run-worker.mjs");

export function routingCompatibility(selector, contract) {
  if (selector === "xai-oauth/grok-composer-2.5-fast" && ["html", "standalone_html"].includes(contract)) {
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
  const warnings = [];
  for (const node of nodes) if (node.compatibility && !node.compatibility.allowed) warnings.push(`${node.id}: ${node.compatibility.reason}`);
  for (const node of baseNodes) if (node.estimatedCost.highUsd === null) warnings.push(`${node.id}: pricing is unknown and cannot satisfy a hard USD budget.`);
  if (base.tokens > effectiveBudget.maxTotalTokens) warnings.push("Base estimate exceeds maxTotalTokens.");
  if (base.cost.highUsd !== null && base.cost.highUsd > effectiveBudget.maxApiEquivalentUsd) warnings.push("Base estimate exceeds maxApiEquivalentUsd.");
  return { template: definition.id, nodes, base, contingency, budget: effectiveBudget, warnings };
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

function stopProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
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
  const estimate = estimateRun({ template, input, budget, rolesOverride });
  if (!confirmBudget) return { awaitingApproval: true, estimate };
  if (!confirmQuota) throw new Error("Run creation requires confirmQuota=true.");
  if (estimate.nodes.some((node) => node.compatibility && !node.compatibility.allowed)) {
    throw new Error("Routing policy blocks at least one required pipeline node.");
  }
  if (estimate.base.cost.highUsd === null) throw new Error("Base pipeline contains unknown pricing and cannot satisfy a hard USD budget.");
  if (estimate.warnings.some((warning) => warning.includes("exceeds"))) {
    throw new Error(`Budget does not cover the base pipeline: ${estimate.warnings.join(" ")}`);
  }
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
    usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, apiEquivalentLowUsd: 0, apiEquivalentHighUsd: 0 },
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
  const updated = updateRun(run.id, (current) => ({ ...current, workerPid: pid }));
  return publicRun(updated);
}

export function getRun({ id } = {}) { return publicRun(readRun(id)); }
export function getRuns({ limit = 25 } = {}) { return listRuns(limit).map(publicRun); }
export function getRunEvents({ id, after = 0, limit = 100 } = {}) { return readRunEvents(id, after, limit); }
export function getPipelineTemplates() { return listTemplates(); }
export function getRoutingPolicy() {
  return {
    version: "0.5.0",
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

export async function attestRun({ id, verdict, findings = [], confirmQuota = false } = {}) {
  if (!new Set(["accept", "revise", "reject"]).has(verdict)) throw new Error("Verdict must be accept, revise, or reject.");
  const run = readRun(id);
  if (run.status !== "awaiting_codex") throw new Error(`Run is not awaiting Codex attestation; current status is ${run.status}.`);
  const normalizedFindings = Array.isArray(findings) ? findings.map(String) : [String(findings)];
  if (Buffer.byteLength(JSON.stringify(normalizedFindings)) > 64_000) throw new Error("Attestation findings exceed 64 KB.");
  const attestation = { verdict, findings: normalizedFindings, at: new Date().toISOString() };
  if (verdict === "accept" && !run.validation?.valid) throw new Error("Cannot accept a run with failing deterministic validation.");
  if (verdict === "revise") {
    if (!confirmQuota) throw new Error("Revision requires confirmQuota=true.");
    if ((run.revisionCount || 0) >= 1) throw new Error("The 0.4 MVP allows one paid revision per run.");
    const runtime = await runtimeStatus();
    if (!runtime.running) throw new Error("OMP runtime is not running.");
  }
  appendRunEvent(id, "codex.attested", { verdict, findingCount: attestation.findings.length });
  if (verdict === "accept") {
    const artifact = run.artifacts.find((item) => item.name === "final.html")
      || run.artifacts.find((item) => item.name === "candidate.html")
      || run.artifacts[run.artifacts.length - 1];
    const updated = updateRun(id, (current) => ({
      ...current, status: "succeeded", phase: "complete", attestation, finalArtifact: artifact?.name || null,
      completedAt: new Date().toISOString(), workerPid: null,
      nodes: current.nodes.map((node) => node.id === "codex" ? { ...node, status: "succeeded", verdict: "accept", completedAt: attestation.at } : node)
    }));
    appendRunEvent(id, "run.succeeded", { artifact: updated.finalArtifact });
    return publicRun(readRun(id));
  }
  if (verdict === "reject") {
    updateRun(id, (current) => ({
      ...current, status: "failed", phase: "rejected", attestation, completedAt: new Date().toISOString(), workerPid: null,
      nodes: current.nodes.map((node) => node.id === "codex" ? { ...node, status: "failed", verdict: "reject", completedAt: attestation.at } : node)
    }));
    appendRunEvent(id, "run.rejected");
    return publicRun(readRun(id));
  }
  const prepared = updateRun(id, (current) => ({
    ...current, status: "running", phase: "finalization", attestation, revisionCount: (current.revisionCount || 0) + 1,
    workerPid: null, error: null,
    nodes: current.nodes.map((node) => node.id === "codex" ? { ...node, status: "revision_requested", verdict: "revise", completedAt: attestation.at } : node)
  }));
  appendRunEvent(id, "run.revision_started", { revisionCount: prepared.revisionCount });
  const pid = spawnRunWorker(id, "finalize");
  updateRun(id, (current) => ({ ...current, workerPid: pid }));
  return publicRun(readRun(id));
}

export async function resumeRun({ id, budget, confirmBudget = false, confirmQuota = false } = {}) {
  const run = readRun(id);
  if (!new Set(["failed", "budget_exceeded"]).has(run.status)) throw new Error(`Run cannot be resumed from ${run.status}.`);
  if (!confirmBudget || !confirmQuota) throw new Error("Resume requires confirmBudget=true and confirmQuota=true.");
  const runtime = await runtimeStatus();
  if (!runtime.running) throw new Error("OMP runtime is not running.");
  const mode = run.phase === "finalization" ? "finalize" : "initial";
  updateRun(id, (current) => {
    const nextBudget = { ...current.budget, ...(budget || {}) };
    return {
      ...current, status: "running", budget: nextBudget, workerPid: null, error: null,
      deadlineAt: new Date(Date.now() + nextBudget.maxDurationMs).toISOString(), completedAt: null
    };
  });
  appendRunEvent(id, "run.resumed", { mode });
  const pid = spawnRunWorker(id, mode);
  updateRun(id, (current) => ({ ...current, workerPid: pid }));
  return publicRun(readRun(id));
}

export function cancelRun({ id, confirm = false } = {}) {
  if (!confirm) throw new Error("Cancellation requires confirm=true.");
  const run = readRun(id);
  stopProcessTree(run.workerPid);
  for (const node of run.nodes) {
    if (node.jobId) {
      try {
        const job = JSON.parse(readFileSync(path.join(runJobsDir(id), `${node.jobId}.json`), "utf8"));
        stopProcessTree(job.workerPid);
      } catch {}
    }
  }
  updateRun(id, (current) => ({ ...current, status: "cancelled", phase: "cancelled", workerPid: null, completedAt: new Date().toISOString() }));
  appendRunEvent(id, "run.cancelled");
  return publicRun(readRun(id));
}

export function getRunResult({ id } = {}) {
  const run = readRun(id);
  if (run.status !== "succeeded") throw new Error(`Run is not complete; current status is ${run.status}.`);
  return { ...publicRun(run), output: readArtifact(id, run.finalArtifact) };
}
