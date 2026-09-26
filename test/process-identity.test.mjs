import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-identity-test-"));
process.env.OMP_ORCHESTRATOR_STATE_DIR = root;
process.env.OMP_ORCHESTRATOR_AGENT_DISPATCH = "external";

const identity = await import("../mcp/process-identity.mjs");
const storage = await import("../mcp/storage.mjs");
const jobs = await import("../mcp/job-store.mjs");
const runs = await import("../mcp/run-store.mjs");
const recovery = await import("../mcp/recovery.mjs");
const supervisor = await import("../mcp/agent-supervisor.mjs");

const supported = ["linux", "win32"].includes(process.platform);
const skip = !supported && "needs a process start time source";

test.after(() => {
  storage.closeDatabase();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// Same live PID, different start time: what a restarted container or a
// wrapped PID counter looks like to a stale record.
function reusedIdentity(pid) {
  const parts = identity.processIdentity(pid).split(":");
  // Windows FILETIME values exceed Number precision.
  parts[parts.length - 1] = String(BigInt(parts.at(-1)) + 1n);
  return parts.join(":");
}

function agentJob(fields) {
  const now = new Date().toISOString();
  return {
    id: jobs.newJobId(), status: "running", attempt: 1, createdAt: now, updatedAt: now, startedAt: now,
    backend: "fake", workspace: root, request: { prompt: "synthetic" }, budget: {},
    output: null, validation: null, usage: null, error: null, ...fields
  };
}

test("identity confirms the live process and falls back to PID-only without one", () => {
  const self = identity.processIdentity(process.pid);
  if (process.platform === "linux") assert.match(self, new RegExp(`^linux:[^:]+:${process.pid}:\\d+$`));
  else if (process.platform === "win32") assert.match(self, new RegExp(`^win32:${process.pid}:\\d+$`));
  else assert.equal(self, null);
  assert.equal(identity.processAlive(process.pid, self), true);
  assert.equal(identity.processAlive(process.pid, undefined), true);
  assert.equal(identity.processAlive(process.pid, "linux:boot:1:1"), true, "identity of another PID is ignored");
  assert.equal(identity.processReused(process.pid, self), false);
  assert.deepEqual(identity.workerProcess(process.pid), { workerPid: process.pid, workerIdentity: self });
  assert.equal(identity.processAlive(0, null), false);
  assert.equal(identity.processAlive(-1, null), false);
});

test("an exited process is not alive", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(identity.processAlive(pid, null), false);
});

test("a reused PID is reported dead and never as the recorded process", { skip }, () => {
  const stale = reusedIdentity(process.pid);
  assert.equal(identity.processAlive(process.pid, stale), false);
  assert.equal(identity.processReused(process.pid, stale), true);
});

test("supervisor interrupts an agent job whose PID was reused", { skip }, () => {
  const reused = agentJob({ workerPid: process.pid, workerIdentity: reusedIdentity(process.pid) });
  const genuine = agentJob({ workerPid: process.pid, workerIdentity: identity.processIdentity(process.pid) });
  jobs.writeJob(reused);
  jobs.writeJob(genuine);
  supervisor.supervisorTick();
  const after = jobs.readJob(reused.id);
  assert.equal(after.status, "interrupted");
  assert.equal(after.workerPid, null);
  assert.equal(jobs.readJob(genuine.id).status, "running");
});

test("startup recovery interrupts runs and jobs whose PID was reused", { skip }, () => {
  delete process.env.OMP_ORCHESTRATOR_AGENT_DISPATCH;
  try {
    const now = new Date().toISOString();
    const runId = runs.newRunId();
    const jobRoot = runs.runJobsDir(runId);
    const child = agentJob({ runId, backend: undefined, workerPid: process.pid, workerIdentity: reusedIdentity(process.pid),
      request: { selector: "xai-oauth/grok-4.5", prompt: "synthetic", contract: "text" } });
    jobs.writeJob(child, jobRoot);
    runs.writeRun({
      id: runId, template: "independent-analysis", status: "running", phase: "initial",
      workerPid: process.pid, workerIdentity: reusedIdentity(process.pid),
      budget: {}, estimate: {}, usage: {}, nodes: [{ id: "analysis-a", type: "inference", status: "running", jobId: child.id }],
      artifacts: [], createdAt: now, updatedAt: now, completedAt: null, error: null
    });
    recovery.reconcileInterruptedWork();
    const run = runs.readRun(runId);
    assert.equal(run.status, "interrupted");
    assert.equal(run.nodes[0].status, "interrupted", "a reused child PID must not keep the node attached");
    assert.equal(jobs.readJob(child.id, jobRoot).status, "interrupted");
  } finally {
    process.env.OMP_ORCHESTRATOR_AGENT_DISPATCH = "external";
  }
});
