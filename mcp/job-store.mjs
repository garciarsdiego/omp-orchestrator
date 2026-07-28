import { randomUUID } from "node:crypto";
import path from "node:path";
import { getDatabase, STATE_ROOT } from "./storage.mjs";

export const JOB_ROOT = process.env.OMP_ORCHESTRATOR_DATA_DIR
  || path.join(STATE_ROOT, "jobs");

function assertJobId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("Invalid job id.");
}

function scopeFor(root = JOB_ROOT) {
  return path.resolve(root);
}

export function newJobId() {
  return randomUUID();
}

export function jobPath(id, root = JOB_ROOT) {
  assertJobId(id);
  return `sqlite:${scopeFor(root)}#job=${id}`;
}

export function readJob(id, root = JOB_ROOT) {
  assertJobId(id);
  const row = getDatabase().prepare("SELECT payload FROM jobs WHERE id = ? AND scope = ?").get(id, scopeFor(root));
  if (!row) throw new Error(`Job not found: ${id}`);
  return JSON.parse(row.payload);
}

export function writeJob(job, root = JOB_ROOT) {
  assertJobId(job.id);
  const db = getDatabase();
  const payload = JSON.stringify(job);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO jobs(id, scope, status, attempt, created_at, updated_at, worker_pid, payload)
      VALUES (@id, @scope, @status, @attempt, @createdAt, @updatedAt, @workerPid, @payload)
      ON CONFLICT(id) DO UPDATE SET
        scope=excluded.scope, status=excluded.status, attempt=excluded.attempt,
        updated_at=excluded.updated_at, worker_pid=excluded.worker_pid, payload=excluded.payload
    `).run({
      id: job.id,
      scope: scopeFor(root),
      status: job.status,
      attempt: job.attempt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      workerPid: job.workerPid || null,
      payload
    });
    db.prepare(`
      INSERT INTO job_attempts(job_id, attempt, status, selector, started_at, completed_at, usage_json, error_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, attempt) DO UPDATE SET
        status=excluded.status, selector=excluded.selector, started_at=excluded.started_at,
        completed_at=excluded.completed_at, usage_json=excluded.usage_json, error_json=excluded.error_json
    `).run(
      job.id,
      job.attempt,
      job.status,
      job.request?.selector || null,
      job.startedAt || null,
      job.completedAt || null,
      job.usage ? JSON.stringify(job.usage) : null,
      job.error ? JSON.stringify(job.error) : null
    );
  })();
  return job;
}

export function updateJob(id, mutate, root = JOB_ROOT) {
  const job = readJob(id, root);
  const updated = mutate(job) || job;
  updated.updatedAt = new Date().toISOString();
  return writeJob(updated, root);
}

export function listJobs(limit = 25, root = JOB_ROOT) {
  return getDatabase().prepare(`
    SELECT payload FROM jobs WHERE scope = ? ORDER BY created_at DESC LIMIT ?
  `).all(scopeFor(root), Math.max(1, Math.min(100, limit))).map((row) => JSON.parse(row.payload));
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
