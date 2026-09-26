import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmpRpcError, startOmpRpc } from "../mcp/backends/omp-rpc.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-rpc-test-"));
const fixture = fileURLToPath(new URL("../fixtures/fake-omp-rpc.mjs", import.meta.url));

test.after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function startClient() {
  return startOmpRpc({
    command: process.execPath,
    args: [fixture],
    cwd: root,
    timeoutMs: 5_000,
    maxFrameBytes: 16 * 1_024
  });
}

test("OMP RPC starts headlessly in the requested cwd and negotiates protocol v2", async () => {
  const client = await startClient();
  try {
    assert.equal(client.protocolVersion, 2);
    const state = await client.command("get_state");
    assert.equal(state.data.cwd, root);
  } finally {
    const result = await client.close();
    assert.equal(result.code, 0);
  }
});

test("prompt completion and session settled are distinct asynchronous events", async () => {
  const client = await startClient();
  try {
    const events = [];
    client.on("event", (event) => events.push(event));
    const prompt = await client.prompt("complete");
    assert.equal(prompt.accepted.data.agentInvoked, true);
    const completion = await prompt.completion;
    assert.deepEqual(
      { type: completion.type, status: completion.status, sessionSettled: completion.sessionSettled },
      { type: "prompt_result", status: "completed", sessionSettled: false }
    );
    const settled = await client.waitForSettled();
    assert.equal(settled.type, "session_settled");
    assert.ok(events.some((event) => event.version === 1 && event.frame.type === "prompt_result"));
    assert.ok(events.some((event) => event.version === 1 && event.frame.type === "session_settled"));
  } finally {
    await client.close();
  }
});

test("session_settled remains observable when frames arrive in one chunk", async () => {
  const client = await startClient();
  try {
    const prompt = await client.prompt("coalesced");
    const completion = await prompt.completion;
    assert.equal(completion.sessionSettled, false);
    const settled = await client.waitForSettled({ timeoutMs: 500 });
    assert.equal(settled.type, "session_settled");
  } finally { await client.close(); }
});

test("steer and abort remain correlated while a prompt is active", async () => {
  const client = await startClient();
  try {
    const prompt = await client.prompt("wait");
    const steer = await client.steer("change direction");
    assert.equal(steer.data.queued, true);
    const abort = await client.abort();
    assert.equal(abort.frame.command, "abort");
    const completion = await prompt.completion;
    assert.equal(completion.status, "aborted");
    assert.equal(completion.sessionSettled, true);
  } finally {
    await client.close();
  }
});

test("RPC command failures and timeouts reject without surfacing remote payloads", async () => {
  const client = await startClient();
  try {
    await assert.rejects(
      () => client.command("fail"),
      (error) => error instanceof OmpRpcError && error.code === "synthetic_failure" && error.message === "OMP RPC command fail failed."
    );
    await assert.rejects(
      () => client.command("never", {}, { timeoutMs: 20 }),
      (error) => error instanceof OmpRpcError && error.code === "timeout"
    );
  } finally {
    await client.close();
  }
});

test("an oversized unframed JSONL event closes the bounded transport", async () => {
  const client = await startOmpRpc({
    command: process.execPath,
    args: [fixture],
    cwd: root,
    timeoutMs: 5_000,
    maxFrameBytes: 256
  });
  const transportErrors = [];
  client.on("transport_error", (event) => transportErrors.push(event));
  await assert.rejects(() => client.command("oversize"), /session closed/);
  assert.equal(transportErrors.length, 1);
  assert.match(transportErrors[0].message, /frame limit/);
  await client.close();
});

test("RPC close escalates after a child ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const client = await startOmpRpc({
    command: process.execPath, args: [fixture, "--ignore-term"], cwd: root, timeoutMs: 5_000
  });
  const started = Date.now();
  const result = await client.close({ timeoutMs: 100 });
  assert.ok(["SIGKILL", "SIGTERM"].includes(result.signal));
  assert.ok(Date.now() - started < 3_000);
});
