import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/omp-orchestrator.mjs", import.meta.url));
const commandFixture = fileURLToPath(new URL("../fixtures/command-json-fake.mjs", import.meta.url));
const token = "synthetic-local-test-token-0000000000000001";

async function serverFixture(t) {
  const state = mkdtempSync(path.join(os.tmpdir(), "omp-http-test-"));
  const tokenFile = path.join(state, "access-token");
  writeFileSync(tokenFile, `${token}\n`);
  const backendFile = path.join(state, "backends.json");
  writeFileSync(backendFile, JSON.stringify({ backends: [
    { id: "fake-command", type: "command-json", executable: process.execPath, args: [commandFixture, "success"] }
  ] }));
  const workspaceRoot = path.join(state, "workspaces");
  mkdirSync(workspaceRoot);
  const child = spawn(process.execPath, [cli, "serve", "--port", "0"], {
    cwd: state,
    env: {
      ...process.env,
      OMP_ORCHESTRATOR_STATE_DIR: state,
      OMP_ORCHESTRATOR_ACCESS_TOKEN_FILE: tokenFile,
      OMP_ORCHESTRATOR_BACKENDS_FILE: backendFile,
      OMP_ORCHESTRATOR_WORKSPACE_ROOT: workspaceRoot,
      OMP_ORCHESTRATOR_BIND: "127.0.0.1",
      OMP_ORCHESTRATOR_PUBLIC_ORIGIN: ""
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  let error = "";
  child.stderr.on("data", (chunk) => { error += chunk; });
  const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`HTTP startup timeout: ${error}`)), 10_000);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("\n")) {
          clearTimeout(timeout);
          try { resolve(JSON.parse(output.split("\n")[0])); }
          catch (cause) { reject(cause); }
        }
      });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`HTTP server exited: ${error}`)); });
    });
  t.after(async () => {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000).unref())
    ]);
    rmSync(state, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${ready.port}`;
}

test("stand-alone HTTP exposes authenticated API and modern MCP on the same core", async (t) => {
  const base = await serverFixture(t);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /OMP Orchestrator/);
  assert.equal((await fetch(`${base}/api/tools`)).status, 401);
  const headers = { authorization: `Bearer ${token}` };
  const tools = await fetch(`${base}/api/tools`, { headers });
  assert.equal(tools.status, 200);
  assert.ok((await tools.json()).tools.some((tool) => tool.name === "omp_run_artifact"));
  const invalidOrigin = await fetch(`${base}/api/tools`, {
    headers: { ...headers, origin: "https://example.invalid" }
  });
  assert.equal(invalidOrigin.status, 403);
  const invalid = await fetch(`${base}/api/call`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "omp_runtime_start", arguments: { confirm: "false" } })
  });
  assert.equal(invalid.status, 400);
  const invalidBudget = await fetch(`${base}/api/call`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "omp_run_resume", arguments: {
      id: "00000000-0000-0000-0000-000000000000", budget: { maxCalls: null },
      confirmBudget: true, confirmQuota: true
    } })
  });
  assert.equal(invalidBudget.status, 400);
  const valid = await fetch(`${base}/api/call`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "omp_routing_policy", arguments: {} })
  });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).result.version, "0.8.0-preview.1");
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
  const mcp = await fetch(`${base}/mcp`, {
    method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } })
  });
  const mcpBody = await mcp.text();
  assert.equal(mcp.status, 200, mcpBody);
  assert.ok(JSON.parse(mcpBody).result.supportedVersions.includes("2026-07-28"));

  const call = async (name, args = {}) => {
    const response = await fetch(`${base}/api/call`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args })
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).result;
  };
  assert.ok((await call("omp_agent_backends")).some((backend) => backend.id === "fake-command"));
  const created = await call("omp_agent_create", {
    backend: "fake-command", workspace: "http-project", prompt: "hello-http",
    idempotencyKey: "http-agent-test-001", timeoutMs: 10_000, confirmQuota: true
  });
  const deadline = Date.now() + 8_000;
  let job;
  do {
    job = await call("omp_agent_get", { id: created.id });
    if (job.status !== "queued" && job.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  assert.equal(job.status, "succeeded", JSON.stringify(job));
  assert.equal((await call("omp_agent_result", { id: created.id })).output, "received:hello-http");
});
