import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-recovery-test-"));
process.env.OMP_ORCHESTRATOR_STATE_DIR = root;
process.env.OMP_ORCHESTRATOR_RUN_DIR = path.join(root, "runs");

const storage = await import("../mcp/storage.mjs");
const jobs = await import("../mcp/job-store.mjs");
const runs = await import("../mcp/run-store.mjs");
const recovery = await import("../mcp/recovery.mjs");
const manager = await import("../mcp/run-manager.mjs");

test.after(() => {
  storage.closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

test("recovery preserves a live child link when its run worker is gone", () => {
  const now = new Date().toISOString();
  const runId = runs.newRunId();
  const jobId = jobs.newJobId();
  const jobRoot = runs.runJobsDir(runId);
  jobs.writeJob({
    id: jobId, runId, status: "running", attempt: 1, createdAt: now, updatedAt: now, startedAt: now,
    workerPid: process.pid, request: { selector: "xai-oauth/grok-4.5", prompt: "synthetic", contract: "text" },
    budget: {}, output: null, validation: null, usage: null, error: null
  }, jobRoot);
  runs.writeRun({
    id: runId, template: "independent-analysis", status: "running", phase: "initial", workerPid: 99999999,
    budget: {}, estimate: {}, usage: {}, nodes: [{ id: "analysis-a", type: "inference", status: "running", jobId }],
    artifacts: [], createdAt: now, updatedAt: now, completedAt: null, error: null
  });

  const result = recovery.reconcileInterruptedWork();
  const restored = runs.readRun(runId);
  assert.equal(result.runs, 1);
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.nodes[0].status, "running");
  assert.equal(restored.nodes[0].jobId, jobId);
  assert.equal(jobs.readJob(jobId, jobRoot).status, "running");
});

test("recovery preserves finalization as the resume mode", () => {
  const now = new Date().toISOString();
  const id = runs.newRunId();
  runs.writeRun({
    id, template: "single-file-web-app", status: "running", phase: "finalization", workerPid: 99999999,
    budget: { maxCalls: 5, maxTotalTokens: 70_000, maxDurationMs: 1_200_000, costPolicy: "observe", maxApiEquivalentUsd: 0.8 },
    usage: { calls: 3, totalTokens: 21_000 }, estimate: {},
    nodes: [{ id: "finalize", type: "inference", status: "pending", jobId: null }],
    artifacts: [], createdAt: now, updatedAt: now, completedAt: null, error: null
  });
  recovery.reconcileInterruptedWork();
  assert.equal(runs.readRun(id).interruptedFromPhase, "finalization");
  const claimed = manager.claimRunResume(id);
  assert.equal(claimed.run.phase, "finalization");
  assert.equal(claimed.run.nodes[0].status, "pending");
});
