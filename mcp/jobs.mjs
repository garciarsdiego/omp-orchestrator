import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRoles } from "./lib.mjs";
import { parseRoleSelector } from "./gateway.mjs";
import { listJobs, newJobId, publicJob, readJob, updateJob, writeJob } from "./job-store.mjs";
import { runtimeStatus } from "./runtime.mjs";

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

export async function createJob({
  role,
  prompt,
  contract = "text",
  maxOutputTokens = 4096,
  timeoutMs = 720_000,
  confirmQuota = false,
  jobRoot
} = {}) {
  if (!confirmQuota) throw new Error("Inference requires confirmQuota=true because it can consume provider quota.");
  if (!role || typeof role !== "string") throw new Error("A role is required.");
  if (!prompt || typeof prompt !== "string") throw new Error("A non-empty prompt is required.");
  if (Buffer.byteLength(prompt) > 512_000) throw new Error("Prompt exceeds the 512 KB MVP limit.");
  if (!new Set(["text", "notes", "json", "html", "standalone_html", "review_json"]).has(contract)) {
    throw new Error("Unsupported output contract.");
  }
  maxOutputTokens = Math.max(1, Math.min(64_000, Number(maxOutputTokens) || 4096));
  timeoutMs = Math.max(10_000, Math.min(1_800_000, Number(timeoutMs) || 720_000));
  if (activeCount(jobRoot) >= MAX_ACTIVE) throw new Error(`Active job limit reached (${MAX_ACTIVE}).`);
  const runtime = await runtimeStatus();
  if (!runtime.running) throw new Error("OMP runtime is not running. Start it before creating an inference job.");

  const roles = getRoles();
  const selector = roles[role];
  if (!selector) throw new Error(`Unknown or unconfigured OMP role: ${role}`);
  const parsed = parseRoleSelector(selector);
  const now = new Date().toISOString();
  const job = {
    id: newJobId(),
    status: "queued",
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    request: {
      role,
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
  if (!new Set(["failed", "invalid"]).has(job.status)) {
    throw new Error(`Only failed or invalid jobs can be retried; current status is ${job.status}.`);
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
