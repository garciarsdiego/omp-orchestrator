import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getModels, getRoles } from "./lib.mjs";
import { parseRoleSelector } from "./gateway.mjs";
import { listJobs, newJobId, publicJob, readJob, updateJob, writeJob } from "./job-store.mjs";
import { runtimeStatus } from "./runtime.mjs";
import { assertNoSecrets } from "./security.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "job-worker.mjs");
const MAX_ACTIVE = Math.max(1, Number(process.env.OMP_ORCHESTRATOR_MAX_JOBS) || 4);

function activeCount(jobRoot) {
  return listJobs(100, jobRoot).filter((job) => ["queued", "running"].includes(job.status)).length;
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
  confirmQuota = false,
  jobRoot
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
  if (activeCount(jobRoot) >= MAX_ACTIVE) throw new Error(`Active job limit reached (${MAX_ACTIVE}).`);

  const roles = getRoles();
  const models = requestedSelector
    ? getModels({ provider: parseRoleSelector(requestedSelector).provider, limit: Number.POSITIVE_INFINITY }).models
    : [];
  const { selector, parsed } = resolveJobTarget({ role, requestedSelector, roles, models });
  const runtime = await runtimeStatus();
  if (!runtime.running) throw new Error("OMP runtime is not running. Start it before creating an inference job.");
  const now = new Date().toISOString();
  const job = {
    id: newJobId(),
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
    workerPid: null,
    output: null,
    validation: null,
    usage: null,
    error: null
  };
  writeJob(job, jobRoot);
  job.workerPid = spawnWorker(job.id, jobRoot);
  writeJob(job, jobRoot);
  return publicJob(job);
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

export async function retryJob({ id, confirmQuota = false, jobRoot } = {}) {
  if (!confirmQuota) throw new Error("Retry requires confirmQuota=true because it can consume provider quota again.");
  if (activeCount(jobRoot) >= MAX_ACTIVE) throw new Error(`Active job limit reached (${MAX_ACTIVE}).`);
  const runtime = await runtimeStatus();
  if (!runtime.running) throw new Error("OMP runtime is not running. Start it before retrying a job.");
  const job = readJob(id, jobRoot);
  if (!new Set(["failed", "invalid", "interrupted"]).has(job.status)) {
    throw new Error(`Only failed, invalid, or interrupted jobs can be retried; current status is ${job.status}.`);
  }
  const updated = updateJob(id, (current) => ({
    ...current,
    status: "queued",
    attempt: current.attempt + 1,
    startedAt: null,
    completedAt: null,
    workerPid: null,
    output: null,
    validation: null,
    usage: null,
    error: null
  }), jobRoot);
  updated.workerPid = spawnWorker(id, jobRoot);
  writeJob(updated, jobRoot);
  return publicJob(updated);
}
