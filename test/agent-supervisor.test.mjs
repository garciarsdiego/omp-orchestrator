import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supervisor = fileURLToPath(new URL("../mcp/agent-supervisor.mjs", import.meta.url));
const fake = fileURLToPath(new URL("../fixtures/command-json-fake.mjs", import.meta.url));

test("external supervisor dispatches a queued agent without an HTTP token", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-agent-supervisor-test-"));
  const workspace = path.join(root, "workspaces");
  mkdirSync(workspace);
  const backendFile = path.join(root, "backends.json");
  writeFileSync(backendFile, JSON.stringify({ backends: [
    { id: "fake", type: "command-json", executable: process.execPath, args: [fake, "success"] }
  ] }));
  process.env.OMP_ORCHESTRATOR_STATE_DIR = root;
  process.env.OMP_ORCHESTRATOR_WORKSPACE_ROOT = workspace;
  process.env.OMP_ORCHESTRATOR_BACKENDS_FILE = backendFile;
  process.env.OMP_ORCHESTRATOR_AGENT_DISPATCH = "external";
  const jobs = await import("../mcp/agent-jobs.mjs");
  const storage = await import("../mcp/storage.mjs");
  assert.equal(jobs.agentSupervisorStatus().ready, false);
  assert.throws(() => jobs.createAgentJob({ backend: "fake", workspace: "project", prompt: "not-dispatched",
    timeoutMs: 10_000, idempotencyKey: "sidecar-no-worker", confirmQuota: true }), /supervisor is unavailable/);
  const child = spawn(process.execPath, [supervisor], {
    env: { ...process.env, OMP_ORCHESTRATOR_ACCESS_TOKEN_FILE: "" },
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000).unref())
    ]);
    storage.closeDatabase();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const deadline = Date.now() + 8_000;
  while (!jobs.agentSupervisorStatus().ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(jobs.agentSupervisorStatus().ready, true, stderr);
  const created = jobs.createAgentJob({ backend: "fake", workspace: "project", prompt: "hello-sidecar",
    timeoutMs: 10_000, idempotencyKey: "sidecar-test-00001", confirmQuota: true });
  let result;
  while (Date.now() < deadline) {
    result = jobs.getAgentJob({ id: created.id });
    if (!["queued", "running"].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(jobs.getAgentResult({ id: created.id }).output, "received:hello-sidecar");
});
