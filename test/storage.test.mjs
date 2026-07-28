import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-storage-test-"));
process.env.OMP_ORCHESTRATOR_STATE_DIR = root;

const storage = await import("../mcp/storage.mjs");
const jobs = await import(`../mcp/job-store.mjs?test=${Date.now()}`);
const jobManager = await import(`../mcp/jobs.mjs?test=${Date.now()}`);
const runs = await import(`../mcp/run-store.mjs?test=${Date.now()}`);
const recovery = await import(`../mcp/recovery.mjs?test=${Date.now()}`);
const migration = await import(`../mcp/migration.mjs?test=${Date.now()}`);
const security = await import(`../mcp/security.mjs?test=${Date.now()}`);

test.after(() => {
  storage.closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

function sampleJob(id = jobs.newJobId()) {
  const now = new Date().toISOString();
  return {
    id,
    status: "running",
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    workerPid: 2_000_000_000,
    request: {
      role: "plan",
      selector: "anthropic/claude-fable-5:high",
      provider: "anthropic",
      model: "claude-fable-5",
      reasoning: "high",
      prompt: "Plan durable storage",
      contract: "notes"
    },
    output: null,
    usage: null,
    error: null
  };
}

function sampleRun(id = runs.newRunId()) {
  const now = new Date().toISOString();
  return {
    id,
    template: "independent-analysis",
    status: "running",
    phase: "initial",
    workerPid: 2_000_000_000,
    budget: { maxCalls: 2, maxTotalTokens: 16000, maxDurationMs: 900000, costPolicy: "observe" },
    estimate: {},
    usage: {},
    nodes: [{ id: "analysis-a", type: "inference", status: "running", jobId: null }],
    artifacts: [],
    eventCount: 0,
    revisionCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

test("storage initializes a versioned SQLite WAL database", () => {
  const status = storage.storageStatus();
  assert.equal(status.journalMode, "wal");
  assert.equal(status.schemaVersion, 2);
  assert.match(status.databasePath, /orchestrator\.sqlite$/);
  const tables = storage.getDatabase().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all().map((row) => row.name);
  assert.ok(tables.includes("consumption_events"));
  assert.ok(tables.includes("policy_events"));
  assert.ok(tables.includes("pricing_snapshots"));
});

test("consumption events are idempotent per job attempt", () => {
  const job = sampleJob();
  job.status = "succeeded";
  job.workerPid = null;
  job.completedAt = new Date().toISOString();
  job.usage = { input_tokens: 10, output_tokens: 20, total_tokens: 30 };
  jobs.writeJob(job);
  const cost = {
    lowUsd: 0.01,
    highUsd: 0.01,
    pricing: {
      registryDigest: "abc",
      registryRevision: "test",
      status: "known",
      matchTier: "exact",
      currency: "USD"
    }
  };
  jobs.recordConsumptionEvent(job, cost);
  jobs.recordConsumptionEvent(job, cost);
  assert.equal(storage.getDatabase().prepare(
    "SELECT COUNT(*) AS count FROM consumption_events WHERE job_id = ?"
  ).get(job.id).count, 1);
});

test("job cancellation requires confirmation and records a terminal state", async () => {
  const job = sampleJob();
  job.status = "queued";
  job.workerPid = null;
  jobs.writeJob(job);
  await assert.rejects(() => jobManager.cancelJob({ id: job.id, confirm: false }), /confirm=true/);
  assert.equal((await jobManager.cancelJob({ id: job.id, confirm: true, graceMs: 0 })).status, "cancelled");
});

test("jobs and attempts survive updates and startup reconciliation", () => {
  const job = sampleJob();
  jobs.writeJob(job);
  assert.equal(jobs.readJob(job.id).status, "running");
  const result = recovery.reconcileInterruptedWork();
  assert.equal(result.jobs, 1);
  assert.equal(jobs.readJob(job.id).status, "interrupted");
  const attempt = storage.getDatabase().prepare(
    "SELECT status FROM job_attempts WHERE job_id = ? AND attempt = 1"
  ).get(job.id);
  assert.equal(attempt.status, "interrupted");
});

test("runs reconcile orphaned nodes without repeating completed checkpoints", () => {
  const run = sampleRun();
  run.nodes.push({ id: "done", type: "validator", status: "succeeded", jobId: null });
  runs.writeRun(run);
  const result = recovery.reconcileInterruptedWork();
  assert.equal(result.runs, 1);
  const restored = runs.readRun(run.id);
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.nodes.find((node) => node.id === "analysis-a").status, "interrupted");
  assert.equal(restored.nodes.find((node) => node.id === "done").status, "succeeded");
});

test("content-addressed artifacts deduplicate and referenced objects survive GC", () => {
  const run = sampleRun();
  run.status = "awaiting_codex";
  runs.writeRun(run);
  const first = runs.writeArtifact(run.id, "first.txt", "same content");
  const second = runs.writeArtifact(run.id, "second.txt", "same content");
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.path, second.path);
  assert.equal(runs.collectArtifacts({ graceMs: 0, dryRun: true }).count, 0);
});

test("WAL serializes concurrent writer processes without corruption", async () => {
  const ids = [
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000004"
  ];
  const code = `
    import { writeJob } from "./mcp/job-store.mjs";
    const now = new Date().toISOString();
    writeJob({
      id: process.env.TEST_JOB_ID, status: "succeeded", attempt: 1,
      createdAt: now, updatedAt: now, workerPid: null,
      request: { role: "tiny", selector: "devin/test", provider: "devin",
        model: "test", reasoning: null, prompt: "concurrent", contract: "text" },
      output: "ok", usage: { total_tokens: 1 }, error: null
    });
  `;
  await Promise.all(ids.map((id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: process.cwd(),
      env: { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: root, TEST_JOB_ID: id },
      windowsHide: true,
      stdio: "ignore"
    });
    child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`Writer exited ${status}`)));
    child.once("error", reject);
  })));
  const count = storage.getDatabase().prepare(
    `SELECT COUNT(*) AS count FROM jobs WHERE id IN (${ids.map(() => "?").join(",")})`
  ).get(...ids).count;
  assert.equal(count, ids.length);
  assert.equal(storage.getDatabase().pragma("quick_check", { simple: true }), "ok");
});

test("legacy migration is dry-run by default, explicit, and idempotent", () => {
  const legacy = path.join(root, "legacy");
  const legacyJobs = path.join(legacy, "jobs");
  mkdirSync(legacyJobs, { recursive: true });
  const job = sampleJob();
  job.status = "succeeded";
  job.workerPid = null;
  writeFileSync(path.join(legacyJobs, `${job.id}.json`), JSON.stringify(job));

  const preview = migration.migrateLegacyJson({ jobsDir: legacyJobs, apply: false });
  assert.equal(preview.jobs, 1);
  assert.equal(storage.getDatabase().prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = ?").get(job.id).count, 0);
  migration.migrateLegacyJson({ jobsDir: legacyJobs, apply: true });
  migration.migrateLegacyJson({ jobsDir: legacyJobs, apply: true });
  assert.equal(storage.getDatabase().prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = ?").get(job.id).count, 1);
});

test("legacy migration fails closed when any source is corrupt", () => {
  const legacyJobs = path.join(root, "legacy-corrupt", "jobs");
  mkdirSync(legacyJobs, { recursive: true });
  writeFileSync(path.join(legacyJobs, "20000000-0000-4000-8000-000000000001.json"), "{invalid");
  const result = migration.migrateLegacyJson({ jobsDir: legacyJobs, apply: true });
  assert.equal(result.errors.length, 1);
  assert.equal(result.jobs, 0);
});

test("high-confidence secret patterns are blocked before persistence", () => {
  assert.deepEqual(security.scanForSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), ["authorization-header"]);
  assert.throws(
    () => runs.writeArtifact(runs.newRunId(), "secret.txt", "sk-proj-abcdefghijklmnopqrstuvwxyz123456"),
    /blocked secret patterns/
  );
});
