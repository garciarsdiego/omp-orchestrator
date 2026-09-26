import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const fakeCommand = fileURLToPath(new URL("../fixtures/command-json-fake.mjs", import.meta.url));

test("an MCP client can create and retrieve a non-OMP agent job", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-agent-mcp-test-"));
  const workspaceRoot = path.join(root, "workspaces");
  mkdirSync(workspaceRoot);
  const config = path.join(root, "backends.json");
  writeFileSync(config, JSON.stringify({ backends: [
    { id: "fake-command", type: "command-json", executable: process.execPath, args: [fakeCommand, "success"] }
  ] }));
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: root,
      OMP_ORCHESTRATOR_WORKSPACE_ROOT: workspaceRoot, OMP_ORCHESTRATOR_BACKENDS_FILE: config },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await Promise.race([
      new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000).unref())
    ]);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let number = 0;
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString().slice(0, 2000); });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let value;
    try { value = JSON.parse(line); }
    catch { return; }
    const request = pending.get(value.id);
    if (request) { pending.delete(value.id); clearTimeout(request.timer); request.resolve(value); }
  });
  async function rpc(method, params = {}) {
    const id = ++number;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout for ${method}: ${stderr}`)), 10_000);
      pending.set(id, { resolve, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18", clientInfo: { name: "test-client", version: "1.0" }, capabilities: {}
  });
  assert.equal(initialized.result.serverInfo.name, "omp-orchestrator");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const args = { backend: "fake-command", workspace: "mcp-project", prompt: "hello-mcp",
    timeoutMs: 10_000, idempotencyKey: "mcp-agent-e2e-001", confirmQuota: true };
  const created = await rpc("tools/call", { name: "omp_agent_create", arguments: args });
  assert.equal(created.result.isError, false, JSON.stringify(created.result));
  const id = created.result.structuredContent.id;
  let status;
  const deadline = Date.now() + 8_000;
  do {
    const result = await rpc("tools/call", { name: "omp_agent_get", arguments: { id } });
    status = result.result.structuredContent.status;
    if (!["queued", "running"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  assert.equal(status, "succeeded");
  const result = await rpc("tools/call", { name: "omp_agent_result", arguments: { id } });
  assert.equal(result.result.structuredContent.output, "received:hello-mcp");
});
