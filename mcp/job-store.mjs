import { randomUUID } from "node:crypto";
import path from "node:path";
import { getDatabase, STATE_ROOT } from "./storage.mjs";
import { loadPricingRegistry } from "./pricing.mjs";

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

export function getJobAttempts(id) {
  assertJobId(id);
  return getDatabase().prepare(`
    SELECT attempt, status, selector, started_at AS startedAt, completed_at AS completedAt,
      usage_json AS usageJson, error_json AS errorJson
    FROM job_attempts WHERE job_id = ? ORDER BY attempt
  `).all(id).map((row) => ({
    ...row,
    usage: row.usageJson ? JSON.parse(row.usageJson) : null,
    error: row.errorJson ? JSON.parse(row.errorJson) : null
  }));
}

export function getJobConsumptionSummary(id) {
  assertJobId(id);
  const row = getDatabase().prepare(`
    SELECT COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(total_tokens), 0) AS totalTokens,
      CASE WHEN SUM(CASE WHEN equivalent_high_usd IS NULL THEN 1 ELSE 0 END) > 0
        THEN NULL ELSE COALESCE(SUM(equivalent_high_usd), 0) END AS equivalentHighUsd
    FROM consumption_events WHERE job_id = ?
  `).get(id);
  return row || { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, equivalentHighUsd: 0 };
}

export function recordConsumptionEvent(job, cost) {
  if (!job.usage) return;
  const pricing = cost?.pricing || {};
  const db = getDatabase();
  if (pricing.registryDigest) {
    const registry = loadPricingRegistry();
    db.prepare(`
      INSERT INTO pricing_snapshots(digest, revision, loaded_at, payload)
      VALUES (?, ?, ?, ?) ON CONFLICT(digest) DO NOTHING
    `).run(
      pricing.registryDigest,
      pricing.registryRevision || "unknown",
      new Date().toISOString(),
      JSON.stringify(registry)
    );
  }
  db.prepare(`
    INSERT INTO consumption_events(
      at, run_id, job_id, attempt, selector, input_tokens, cached_input_tokens,
      output_tokens, total_tokens, duration_ms, registry_digest, pricing_status,
      match_tier, equivalent_low_usd, equivalent_high_usd, currency
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, attempt) DO UPDATE SET
      input_tokens=excluded.input_tokens, cached_input_tokens=excluded.cached_input_tokens,
      output_tokens=excluded.output_tokens, total_tokens=excluded.total_tokens,
      duration_ms=excluded.duration_ms, registry_digest=excluded.registry_digest,
      pricing_status=excluded.pricing_status, match_tier=excluded.match_tier,
      equivalent_low_usd=excluded.equivalent_low_usd,
      equivalent_high_usd=excluded.equivalent_high_usd, currency=excluded.currency
  `).run(
    job.completedAt || new Date().toISOString(),
    job.runId || null,
    job.id,
    job.attempt,
    job.request.selector,
    job.usage.input_tokens || 0,
    job.usage.input_tokens_details?.cached_tokens || 0,
    job.usage.output_tokens || 0,
    job.usage.total_tokens || 0,
    job.startedAt && job.completedAt ? Date.parse(job.completedAt) - Date.parse(job.startedAt) : null,
    pricing.registryDigest || null,
    pricing.status || "unknown",
    pricing.matchTier || "unknown",
    cost?.lowUsd ?? null,
    cost?.highUsd ?? null,
    pricing.currency || "USD"
  );
}

export function recordPolicyEvents(job, breaches, mode) {
  const insert = getDatabase().prepare(`
    INSERT INTO policy_events(
      at, run_id, job_id, attempt, scope, limit_name, threshold_value,
      observed_value, mode, action_taken, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const breach of breaches) {
    insert.run(
      new Date().toISOString(),
      job.runId || null,
      job.id,
      job.attempt,
      "job",
      breach.limit,
      breach.threshold,
      breach.observed,
      mode,
      breach.enforced ? "blocked" : "observed",
      JSON.stringify(breach)
    );
  }
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
    budget: job.budget || null,
    estimate: job.estimate || null,
    deadlineAt: job.deadlineAt || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    updatedAt: job.updatedAt,
    promptBytes: Buffer.byteLength(job.request.prompt || ""),
    outputBytes: Buffer.byteLength(job.output || ""),
    validation: job.validation || null,
    normalization: job.normalization || null,
    usage: job.usage || null,
    policy: job.policy || null,
    cancellation: job.cancellation || null,
    error: job.error || null
  };
  if (includeOutput) visible.output = job.output || null;
  return visible;
}
