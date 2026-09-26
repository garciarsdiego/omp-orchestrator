import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(path.join(os.tmpdir(), "omp-agent-jobs-test-"));
const workspaceRoot = path.join(root, "workspaces");
mkdirSync(workspaceRoot);
const commandFixture = fileURLToPath(new URL("../fixtures/command-json-fake.mjs", import.meta.url));
const rpcFixture = fileURLToPath(new URL("../fixtures/fake-omp-rpc.mjs", import.meta.url));
const backendFile = path.join(root, "backends.json");
writeFileSync(backendFile, JSON.stringify({ backends: [
  { id: "fake-command", type: "command-json", executable: process.execPath, args: [commandFixture, "success"] },
  { id: "fake-command-hang", type: "command-json", executable: process.execPath, args: [commandFixture, "hang"] },
  { id: "fake-rpc", type: "omp-rpc", executable: process.execPath, args: [rpcFixture] }
] }));
process.env.OMP_ORCHESTRATOR_STATE_DIR = root;
process.env.OMP_ORCHESTRATOR_WORKSPACE_ROOT = workspaceRoot;
process.env.OMP_ORCHESTRATOR_BACKENDS_FILE = backendFile;
const jobs = await import("../mcp/agent-jobs.mjs");
const storage = await import("../mcp/storage.mjs");

test.after(() => {
  storage.closeDatabase();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function waitFor(id, statuses, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = jobs.getAgentJob({ id });
    if (statuses.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${id}: ${jobs.getAgentJob({ id }).status}`);
}

test("command backend completes through persistent jobs and an idempotent request", async () => {
  const request = { backend: "fake-command", workspace: "project-a", prompt: "hello",
    timeoutMs: 10_000, idempotencyKey: "test-command-001", confirmQuota: true };
  const created = jobs.createAgentJob(request);
  assert.equal(jobs.createAgentJob(request).id, created.id);
  assert.throws(() => jobs.createAgentJob({ ...request, prompt: "other" }), /Idempotency key/);
  assert.throws(() => jobs.createAgentJob({ ...request, timeoutMs: 20_000 }), /Idempotency key/);
  const done = await waitFor(created.id, ["succeeded", "failed", "limit_exceeded"]);
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.equal(jobs.getAgentResult({ id: created.id }).output, "received:hello");
  assert.equal(jobs.getAgentResult({ id: created.id }).usage.total_tokens, 5);
  assert.ok(jobs.getAgentEvents({ id: created.id }).events.some((event) => event.type === "agent.completed"));
  assert.ok(jobs.listAgentJobs({ limit: 10 }).some((job) => job.id === created.id));
});

test("RPC backend waits for session_settled and exposes event cursors", async () => {
  const created = jobs.createAgentJob({ backend: "fake-rpc", workspace: "project-b", prompt: "complete",
    timeoutMs: 10_000, idempotencyKey: "test-rpc-000001", confirmQuota: true });
  const done = await waitFor(created.id, ["succeeded", "failed", "limit_exceeded"]);
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  const first = jobs.getAgentEvents({ id: created.id, limit: 2 });
  const rest = jobs.getAgentEvents({ id: created.id, after: first.nextCursor });
  const types = [...first.events, ...rest.events].map((event) => event.type);
  assert.ok(types.includes("omp.prompt_result"));
  assert.ok(types.includes("omp.session_settled"));
  // Usage from the assistant message_end, counted once although agent_end
  // repeats the message; input includes cache reads.
  const result = jobs.getAgentResult({ id: created.id });
  assert.equal(result.output, "done");
  assert.deepEqual(result.usage, {
    complete: true,
    input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 7, total_tokens: 127,
    source: "omp-rpc", assistantMessages: 1, models: ["fake-provider/fake-model"], ompEquivalentCostUsd: 0.0012
  });
});

test("a trusted command backend can be cancelled without replaying the prompt", async () => {
  const created = jobs.createAgentJob({ backend: "fake-command-hang", workspace: "project-c", prompt: "hang",
    timeoutMs: 10_000, idempotencyKey: "test-cancel-001", confirmQuota: true });
  await waitFor(created.id, ["running"]);
  jobs.abortAgentJob({ id: created.id, confirm: true });
  const cancelled = await waitFor(created.id, ["cancelled", "failed", "limit_exceeded"]);
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  assert.throws(() => jobs.getAgentResult({ id: created.id }), /not complete/);
});

test("workspace names cannot traverse or resolve outside the configured root", () => {
  assert.throws(() => jobs.createAgentJob({ backend: "fake-command", workspace: "../outside", prompt: "safe",
    timeoutMs: 10_000, idempotencyKey: "test-traversal-1", confirmQuota: true }), /Workspace/);
  assert.throws(() => jobs.createAgentJob({ backend: "fake-command", workspace: "project-a", prompt: "safe",
    timeoutMs: 10_000, idempotencyKey: "test-invalid-1", confirmQuota: "true" }), /confirmQuota/);
});

test("startup reconciliation does not replay an interrupted agent request", async () => {
  const store = jobs.createAgentJob({ backend: "fake-command", workspace: "project-d", prompt: "hello",
    timeoutMs: 10_000, idempotencyKey: "test-recovery-001", confirmQuota: true });
  await waitFor(store.id, ["succeeded", "failed"]);
    const { getDatabase } = storage;
    const raw = getDatabase().prepare("SELECT payload FROM jobs WHERE id = ?").get(store.id);
    const payload = JSON.parse(raw.payload);
    payload.status = "cancellation_requested";
    payload.workerPid = 999_999_999;
    getDatabase().prepare("UPDATE jobs SET status = ?, worker_pid = ?, payload = ? WHERE id = ?")
      .run(payload.status, payload.workerPid, JSON.stringify(payload), store.id);
    const { reconcileInterruptedWork } = await import("../mcp/recovery.mjs");
    reconcileInterruptedWork();
    assert.equal(jobs.getAgentJob({ id: store.id }).status, "interrupted");
    assert.equal(jobs.createAgentJob({ backend: "fake-command", workspace: "project-d", prompt: "hello",
      timeoutMs: 10_000, idempotencyKey: "test-recovery-001", confirmQuota: true }).id, store.id);
});
