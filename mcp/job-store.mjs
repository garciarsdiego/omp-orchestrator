import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const JOB_ROOT = process.env.OMP_ORCHESTRATOR_DATA_DIR
  || path.join(os.tmpdir(), "omp-orchestrator", "jobs");

function assertJobId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("Invalid job id.");
}

export function newJobId() {
  return randomUUID();
}

export function jobPath(id, root = JOB_ROOT) {
  assertJobId(id);
  return path.join(root, `${id}.json`);
}

export function readJob(id, root = JOB_ROOT) {
  try {
    return JSON.parse(readFileSync(jobPath(id, root), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Job not found: ${id}`);
    throw error;
  }
}

export function writeJob(job, root = JOB_ROOT) {
  mkdirSync(root, { recursive: true });
  const target = jobPath(job.id, root);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(job, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
  return job;
}

export function updateJob(id, mutate, root = JOB_ROOT) {
  const job = readJob(id, root);
  const updated = mutate(job) || job;
  updated.updatedAt = new Date().toISOString();
  return writeJob(updated, root);
}

export function listJobs(limit = 25, root = JOB_ROOT) {
  mkdirSync(root, { recursive: true });
  return readdirSync(root)
    .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
    .map((name) => {
      try { return JSON.parse(readFileSync(path.join(root, name), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export function publicJob(job, { includeOutput = false } = {}) {
  const visible = {
    id: job.id,
    status: job.status,
    role: job.request.role,
    selector: job.request.selector,
    provider: job.request.provider,
    model: job.request.model,
    reasoning: job.request.reasoning,
    contract: job.request.contract,
    attempt: job.attempt,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    updatedAt: job.updatedAt,
    promptBytes: Buffer.byteLength(job.request.prompt || ""),
    outputBytes: Buffer.byteLength(job.output || ""),
    validation: job.validation || null,
    normalization: job.normalization || null,
    usage: job.usage || null,
    error: job.error || null
  };
  if (includeOutput) visible.output = job.output || null;
  return visible;
}
