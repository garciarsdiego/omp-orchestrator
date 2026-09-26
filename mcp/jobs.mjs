import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getModels, getRoles } from "./lib.mjs";
import { parseRoleSelector } from "./gateway.mjs";
import {
  getJobAttempts, newJobId, publicJob, readJob, updateJob, writeJob
} from "./job-store.mjs";
import { getDatabase, withImmediateTransaction } from "./storage.mjs";
import { runtimeStatus } from "./runtime.mjs";
import { assertNoSecrets } from "./security.mjs";
import { assertJobEstimate, estimateJobRequest } from "./budget.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "job-worker.mjs");
const MAX_ACTIVE = Math.max(1, Number(process.env.OMP_ORCHESTRATOR_MAX_JOBS) || 4);

function activeCount(db = getDatabase()) {
  return db.prepare(`SELECT COUNT(*) AS count FROM jobs
    WHERE status IN ('queued', 'running', 'cancellation_requested')
      AND json_extract(payload, '$.backend') IS NULL`).get().count;
}

function assertGlobalCapacity(db) {
  if (activeCount(db) >= MAX_ACTIVE) throw new Error(`Active job limit reached (${MAX_ACTIVE}).`);
}

export function reserveInferenceSlot(job, jobRoot) {
  return withImmediateTransaction(() => {
    assertGlobalCapacity(getDatabase());
    return writeJob(job, jobRoot);
  });
}

function spawnWorker(id, jobRoot) {
  const child = spawn(process.execPath, [WORKER, id], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...(jobRoot ? { OMP_ORCHESTRATOR_DATA_DIR: jobRoot } : {}) }
  });
  child.unref();
  return child.pid;
}

export function startJobWorker(id, jobRoot) {
  const pid = spawnWorker(id, jobRoot);
  return updateJob(id, (current) => ({ ...current, workerPid: pid }), jobRoot);
}

export function resolveJobTarget({ role, requestedSelector, roles = {}, models = [] } = {}) {
  if ((!role && !requestedSelector) || (role && requestedSelector)) {
    throw new Error("Provide exactly one target: role or selector.");
  }
  if (role && typeof role !== "string") throw new Error("Role must be a string.");
  if (requestedSelector && typeof requestedSelector !== "string") throw new Error("Selector must be a string.");
  const selector = requestedSelector || roles[role];
  if (!selector) throw new Error(`Unknown or unconfigured OMP role: ${role}`);
  const parsed = parseRoleSelector(selector);
  if (requestedSelector && !models.some((model) => model.provider === parsed.provider && model.id === parsed.model)) {
    throw new Error(`OMP selector is not currently available: ${requestedSelector}`);
  }
  return { selector, parsed };
}

export async function createJob({
  role,
  selector: requestedSelector,
  prompt,
  contract = "text",
  maxOutputTokens = 4096,
  timeoutMs = 720_000,
  budget,
  confirmQuota = false,
  jobRoot,
  runId,
  deadlineAt,
  deferWorker = false
} = {}) {
  if (!confirmQuota) throw new Error("Inference requires confirmQuota=true because it can consume provider quota.");
  if ((!role && !requestedSelector) || (role && requestedSelector)) {
    throw new Error("Provide exactly one target: role or selector.");
  }
  if (role && typeof role !== "string") throw new Error("Role must be a string.");
  if (requestedSelector && typeof requestedSelector !== "string") throw new Error("Selector must be a string.");
  if (!prompt || typeof prompt !== "string") throw new Error("A non-empty prompt is required.");
  if (Buffer.byteLength(prompt) > 512_000) throw new Error("Prompt exceeds the 512 KB MVP limit.");
  assertNoSecrets(prompt, "Job prompt");
  if (!new Set(["text", "notes", "json", "html", "standalone_html", "review_json"]).has(contract)) {
    throw new Error("Unsupported output contract.");
  }
  maxOutputTokens = Math.max(1, Math.min(64_000, Number(maxOutputTokens) || 4096));
  timeoutMs = Math.max(10_000, Math.min(1_800_000, Number(timeoutMs) || 720_000));

  const roles = getRoles();
  const models = requestedSelector
    ? getModels({ provider: parseRoleSelector(requestedSelector).provider, limit: Number.POSITIVE_INFINITY }).models
    : [];
  const { selector, parsed } = resolveJobTarget({ role, requestedSelector, roles, models });
  const absoluteDeadline = deadlineAt ? Date.parse(deadlineAt) : null;
  if (deadlineAt && !Number.isFinite(absoluteDeadline)) throw new Error("deadlineAt must be a valid timestamp.");
  if (absoluteDeadline && absoluteDeadline <= Date.now()) throw new Error("Job deadline has already expired.");
  if (absoluteDeadline) timeoutMs = Math.min(timeoutMs, absoluteDeadline - Date.now());
  const estimate = estimateJobRequest({ selector, prompt, maxOutputTokens, timeoutMs, budget });
  assertJobEstimate(estimate);
  maxOutputTokens = Math.min(maxOutputTokens, estimate.budget.maxOutputTokens);
  timeoutMs = Math.min(timeoutMs, estimate.budget.maxDurationMs);
  const runtime = await runtimeStatus();
  if (!runtime.running) throw new Error("OMP runtime is not running. Start it before creating an inference job.");
  const now = new Date().toISOString();
  const job = {
    id: newJobId(),
    runId: runId || null,
    status: "queued",
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    request: {
      role: role || null,
      selector,
      ...parsed,
      prompt,
      contract,
      maxOutputTokens,
      timeoutMs
    },
    budget: estimate.budget,
    estimate,
    deadlineAt: deadlineAt || new Date(Date.now() + estimate.budget.maxDurationMs).toISOString(),
    workerPid: null,
    output: null,
    validation: null,
    usage: null,
    error: null
  };
  reserveInferenceSlot(job, jobRoot);
  return publicJob(deferWorker ? job : startJobWorker(job.id, jobRoot));
}

export function getJob({ id, includeOutput = false, jobRoot } = {}) {
  return publicJob(readJob(id, jobRoot), { includeOutput });
}

export function getJobResult({ id, jobRoot } = {}) {
  const job = readJob(id, jobRoot);
  if (["queued", "running"].includes(job.status)) throw new Error(`Job is still ${job.status}.`);
  return publicJob(job, { includeOutput: true });
}

export function getJobs({ limit = 25, jobRoot } = {}) {
  return listJobs(limit, jobRoot).map((job) => publicJob(job));
}

export function remainingRetryBudget({ budget, attempts = [], request = {} } = {}) {
  const prior = attempts.reduce((totals, attempt) => ({
    inputTokens: totals.inputTokens + (attempt.usage?.input_tokens || 0),
    outputTokens: totals.outputTokens + (attempt.usage?.output_tokens || 0),
    totalTokens: totals.totalTokens + (attempt.usage?.total_tokens || 0)
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const remaining = {
    ...budget,
    maxInputTokens: budget.maxInputTokens - prior.inputTokens,
    maxOutputTokens: budget.maxOutputTokens - prior.outputTokens,
    maxTotalTokens: budget.maxTotalTokens - prior.totalTokens,
    maxCalls: budget.maxCalls - attempts.length
  };
  const nextEstimate = estimateJobRequest({
    selector: request.selector,
    prompt: request.prompt,
    maxOutputTokens: request.maxOutputTokens,
    timeoutMs: request.timeoutMs,
    budget: remaining
  });
  return { prior, remaining, nextEstimate };
}

export async function retryJob({ id, confirmQuota = false, jobRoot } = {}) {
  if (!confirmQuota) throw new Error("Retry requires confirmQuota=true because it can consume provider quota again.");
  const runtime = await runtimeStatus();
  if (!runtime.running) throw new Error("OMP runtime is not running. Start it before retrying a job.");
  const queued = withImmediateTransaction(() => {
    assertGlobalCapacity(getDatabase());
    const job = readJob(id, jobRoot);
    if (!new Set(["failed", "invalid", "interrupted"]).has(job.status)) {
      throw new Error(`Only failed, invalid, or interrupted jobs can be retried; current status is ${job.status}.`);
    }
    const attempts = getJobAttempts(id);
    const budget = job.budget || estimateJobRequest({
      selector: job.request.selector, prompt: job.request.prompt,
      maxOutputTokens: job.request.maxOutputTokens, timeoutMs: job.request.timeoutMs
    }).budget;
    if (job.attempt > budget.maxRetries || attempts.length >= budget.maxCalls) {
      throw new Error("Retry exceeds maxRetries or maxCalls.");
    }
    const { nextEstimate } = remainingRetryBudget({ budget, attempts, request: job.request });
    assertJobEstimate(nextEstimate);
    return updateJob(id, (current) => ({
      ...current, status: "queued", attempt: current.attempt + 1,
      startedAt: null, completedAt: null, workerPid: null,
      output: null, validation: null, usage: null, error: null,
      request: {
        ...current.request,
        maxOutputTokens: Math.min(current.request.maxOutputTokens, nextEstimate.budget.maxOutputTokens),
        timeoutMs: Math.min(current.request.timeoutMs, nextEstimate.budget.maxDurationMs)
      },
      deadlineAt: new Date(Date.now() + current.budget.maxDurationMs).toISOString()
    }), jobRoot);
  });
  return publicJob(startJobWorker(queued.id, jobRoot));
}

function stopProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { return false; }
  }
  return true;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function cancelJob({ id, confirm = false, graceMs = 1_000, jobRoot } = {}) {
  if (!confirm) throw new Error("Cancellation requires confirm=true.");
  const job = readJob(id, jobRoot);
  if (!["queued", "running", "cancellation_requested"].includes(job.status)) {
    throw new Error(`Job cannot be cancelled from ${job.status}.`);
  }
  const requestedAt = new Date().toISOString();
  updateJob(id, (current) => ({
    ...current,
    status: "cancellation_requested",
    cancellationRequestedAt: requestedAt
  }), jobRoot);
  const deadline = Date.now() + Math.max(0, Math.min(5_000, Number(graceMs) || 1_000));
  while (pidAlive(job.workerPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const terminated = pidAlive(job.workerPid) ? stopProcessTree(job.workerPid) : false;
  const cancelled = updateJob(id, (current) => ({
    ...current,
    status: "cancelled",
    completedAt: new Date().toISOString(),
    workerPid: null,
    cancellation: { requestedAt, terminated }
  }), jobRoot);
  return publicJob(cancelled);
}

export function estimateJob({
  role,
  selector: requestedSelector,
  prompt,
  maxOutputTokens = 4096,
  timeoutMs = 720_000,
  budget
} = {}) {
  if ((!role && !requestedSelector) || (role && requestedSelector)) {
    throw new Error("Provide exactly one target: role or selector.");
  }
  const roles = getRoles();
  const models = requestedSelector
    ? getModels({ provider: parseRoleSelector(requestedSelector).provider, limit: Number.POSITIVE_INFINITY }).models
    : [];
  const { selector } = resolveJobTarget({ role, requestedSelector, roles, models });
  return estimateJobRequest({ selector, prompt, maxOutputTokens, timeoutMs, budget });
}
