import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSecrets } from "./security.mjs";
import { JOB_ROOT, newJobId, readJob, writeJob, updateJob } from "./job-store.mjs";
import { STATE_ROOT, getDatabase, withImmediateTransaction } from "./storage.mjs";

const WORKER = fileURLToPath(new URL("./agent-worker.mjs", import.meta.url));
const ACTIVE = new Set(["queued", "running", "cancellation_requested"]);
const FINAL = new Set(["succeeded", "failed", "invalid", "cancelled", "interrupted", "limit_exceeded"]);
const MAX_EVENTS = 200;
export const SUPERVISOR_HEARTBEAT = path.join(STATE_ROOT, "agent-supervisor.json");

export function agentSupervisorStatus() {
  if (process.env.OMP_ORCHESTRATOR_AGENT_DISPATCH !== "external") return { mode: "local", ready: true };
  try {
    const heartbeat = JSON.parse(readFileSync(SUPERVISOR_HEARTBEAT, "utf8"));
    return { mode: "external", ready: Number.isFinite(Date.parse(heartbeat.at)) && Date.now() - Date.parse(heartbeat.at) < 5_000,
      lastSeenAt: heartbeat.at };
  } catch { return { mode: "external", ready: false, lastSeenAt: null }; }
}

function configuration() {
  const file = process.env.OMP_ORCHESTRATOR_BACKENDS_FILE;
  const text = file ? readFileSync(file, "utf8") : '{"backends":[]}';
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.backends)) throw new Error("Backend configuration requires a backends array.");
  const backends = [{ id: "omp-rpc", type: "omp-rpc", executable: process.env.OMP_EXECUTABLE || "omp", args: [] }, ...parsed.backends];
  const names = new Set();
  for (const backend of backends) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(backend.id || "") || names.has(backend.id)) {
      throw new Error("Backend IDs must be unique lowercase names.");
    }
    if (!["omp-rpc", "command-json"].includes(backend.type)) throw new Error(`Unsupported backend type: ${backend.type}`);
    if (typeof backend.executable !== "string" || !backend.executable || !Array.isArray(backend.args || [])) {
      throw new Error(`Backend ${backend.id} requires an executable and argument array.`);
    }
    if ((backend.args || []).some((arg) => typeof arg !== "string")) throw new Error(`Backend ${backend.id} has invalid arguments.`);
    names.add(backend.id);
  }
  return { backends, digest: createHash("sha256").update(text).digest("hex") };
}

export function listAgentBackends() {
  return configuration().backends.map(({ id, type }) => ({
    id, type, capabilities: {
      steer: type === "omp-rpc", abort: true, sessionEvents: type === "omp-rpc",
      tokenLimitEnforced: false, providerCostKnown: false
    }
  }));
}

export function resolveBackend(id, digest) {
  const configured = configuration();
  if (digest && configured.digest !== digest) throw new Error("Backend configuration changed after approval; create a new job.");
  const backend = configured.backends.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Unknown configured backend: ${id}`);
  return backend;
}

function workspaceDirectory(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name || "") || name === "..") {
    throw new Error("Workspace must be a single safe directory name.");
  }
  const root = path.resolve(process.env.OMP_ORCHESTRATOR_WORKSPACE_ROOT || path.join(STATE_ROOT, "workspaces"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = realpathSync(root);
  const candidate = path.join(realRoot, name);
  if (!existsSync(candidate)) mkdirSync(candidate, { mode: 0o700 });
  const realCandidate = realpathSync(candidate);
  if (path.dirname(realCandidate) !== realRoot) throw new Error("Workspace resolves outside the configured root.");
  return realCandidate;
}

function publicAgentJob(job) {
  if (!job?.backend) throw new Error("Not an agent job.");
  return {
    id: job.id, backend: job.backend, workspace: job.workspace,
    status: job.status, timeoutMs: job.request.timeoutMs,
    usage: job.usage ?? null, outputBytes: Buffer.byteLength(job.output || ""),
    eventCount: job.agentEventCount || 0, error: job.error || null,
    sessionId: job.sessionId || null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    startedAt: job.startedAt || null, completedAt: job.completedAt || null
  };
}

export function appendAgentEvent(id, type, data = {}) {
  assertNoSecrets(data, "Agent event");
  return updateJob(id, (job) => {
    if (!job.backend) throw new Error("Not an agent job.");
    const sequence = (job.agentEventCount || 0) + 1;
    const event = { sequence, type, at: new Date().toISOString(), ...data };
    job.agentEventCount = sequence;
    job.agentEvents = [...(job.agentEvents || []), event].slice(-MAX_EVENTS);
    return job;
  });
}

export function getAgentEvents({ id, after = 0, limit = 100 } = {}) {
  const job = readJob(id);
  if (!job.backend) throw new Error("Not an agent job.");
  const cursor = Number(after);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("after must be a non-negative integer.");
  const cap = Math.max(1, Math.min(200, Number(limit) || 100));
  const events = (job.agentEvents || []).filter((event) => event.sequence > cursor).slice(0, cap);
  return { id, events, nextCursor: events.at(-1)?.sequence ?? cursor,
    truncated: Boolean(job.agentEvents?.length && cursor < job.agentEvents[0].sequence - 1) };
}

export function createAgentJob({ backend, workspace, prompt, timeoutMs = 600_000, idempotencyKey, confirmQuota = false } = {}) {
  if (confirmQuota !== true) throw new Error("Agent execution requires confirmQuota=true.");
  if (!agentSupervisorStatus().ready) throw new Error("Agent supervisor is unavailable; no work was queued.");
  if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 512_000) {
    throw new Error("Agent prompt must contain 1–512000 bytes.");
  }
  assertNoSecrets(prompt, "Agent prompt");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 1_800_000) {
    throw new Error("timeoutMs must be 10000–1800000.");
  }
  if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey || "")) {
    throw new Error("A stable idempotencyKey of 8–128 safe characters is required.");
  }
  const configured = configuration();
  const selected = configured.backends.find((entry) => entry.id === backend);
  if (!selected) throw new Error(`Unknown configured backend: ${backend}`);
  const cwd = workspaceDirectory(workspace);
  const requestFingerprint = createHash("sha256").update(JSON.stringify({
    backend, workspace: cwd, prompt, timeoutMs, backendConfigDigest: configured.digest
  })).digest("hex");
  const job = withImmediateTransaction(() => {
    const db = getDatabase();
    const existing = db.prepare("SELECT payload FROM jobs WHERE json_extract(payload, '$.idempotencyKey') = ? LIMIT 1").get(idempotencyKey);
    if (existing) {
      const prior = JSON.parse(existing.payload);
      if (prior.requestFingerprint !== requestFingerprint) {
        throw new Error("Idempotency key already belongs to another request.");
      }
      return { job: prior, created: false };
    }
    const active = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running','cancellation_requested') AND json_extract(payload, '$.backend') IS NOT NULL").get().count;
    const maximum = Math.max(1, Math.min(32, Number(process.env.OMP_ORCHESTRATOR_MAX_AGENTS) || 2));
    if (active >= maximum) throw new Error(`Active agent limit reached (${maximum}).`);
    const now = new Date().toISOString();
    const job = {
      id: newJobId(), backend, backendType: selected.type, backendConfigDigest: configured.digest,
      idempotencyKey, requestFingerprint, workspace: cwd, runId: null, status: "queued", attempt: 1,
      request: { selector: `agent/${backend}`, prompt, timeoutMs, role: null, provider: null, model: null },
      budget: { maxCalls: 1, maxDurationMs: timeoutMs, costPolicy: "observe", maxTotalTokens: null },
      estimate: { providerCostKnown: false, tokenLimitEnforced: false },
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      workerPid: null, output: null, usage: null, error: null,
      agentEvents: [], agentEventCount: 0, commands: [],
      createdAt: now, updatedAt: now
    };
    writeJob(job);
    return { job, created: true };
  });
  if (!job.created) return publicAgentJob(job.job);
  if (process.env.OMP_ORCHESTRATOR_AGENT_DISPATCH === "external") return publicAgentJob(job.job);
  try {
    const child = spawn(process.execPath, [WORKER, job.job.id], {
      cwd: job.job.workspace, detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, OMP_ORCHESTRATOR_ACCESS_TOKEN_FILE: "" }
    });
    child.unref();
    return publicAgentJob(updateJob(job.job.id, (current) => ({ ...current, workerPid: child.pid })));
  } catch (error) {
    updateJob(job.job.id, (current) => ({
      ...current, status: "failed", completedAt: new Date().toISOString(),
      error: { name: "WorkerSpawnError", message: "Agent worker failed to start." }
    }));
    throw error;
  }
}

export function getAgentJob({ id } = {}) { return publicAgentJob(readJob(id)); }

export function listAgentJobs({ limit = 25 } = {}) {
  const cap = Math.max(1, Math.min(100, Number(limit) || 25));
  return getDatabase().prepare("SELECT payload FROM jobs WHERE json_extract(payload, '$.backend') IS NOT NULL ORDER BY created_at DESC LIMIT ?")
    .all(cap).map((row) => publicAgentJob(JSON.parse(row.payload)));
}

export function getAgentResult({ id } = {}) {
  const job = readJob(id);
  if (!job.backend) throw new Error("Not an agent job.");
  if (job.status !== "succeeded") throw new Error(`Agent job is not complete: ${job.status}`);
  return { ...publicAgentJob(job), output: job.output ?? null };
}

export function steerAgentJob({ id, message } = {}) {
  if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message) > 64_000) {
    throw new Error("Steer message must contain 1–64000 bytes.");
  }
  assertNoSecrets(message, "Steer message");
  const job = updateJob(id, (current) => {
    if (!current.backend) throw new Error("Not an agent job.");
    if (current.backendType !== "omp-rpc") throw new Error("This backend does not support steering.");
    if (!ACTIVE.has(current.status)) throw new Error(`Agent job cannot be steered from ${current.status}.`);
    current.commands.push({ id: randomUUID(), type: "steer", message, status: "queued" });
    return current;
  });
  return publicAgentJob(job);
}

export function abortAgentJob({ id, confirm = false } = {}) {
  if (confirm !== true) throw new Error("Agent cancellation requires confirm=true.");
  const job = updateJob(id, (current) => {
    if (!current.backend) throw new Error("Not an agent job.");
    if (current.status === "cancelled") return current;
    if (FINAL.has(current.status)) throw new Error(`Agent job cannot be cancelled from ${current.status}.`);
    current.status = current.status === "queued" ? "cancelled" : "cancellation_requested";
    current.commands.push({ id: randomUUID(), type: "abort", status: "queued" });
    if (current.status === "cancelled") current.completedAt = new Date().toISOString();
    return current;
  });
  appendAgentEvent(id, "agent.cancel_requested");
  return publicAgentJob(job);
}
