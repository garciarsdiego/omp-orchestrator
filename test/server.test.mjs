import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("MCP lists provider readiness and selector-aware job tools", () => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-server-test-"));
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", clientInfo: { name: "test-client", version: "1.0" }, capabilities: {}
    } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  ].map((request) => JSON.stringify(request)).join("\n") + "\n";
  const result = spawnSync(process.execPath, ["mcp/server.mjs"], {
    cwd: process.cwd(),
    input: requests,
    encoding: "utf8",
    env: { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: stateRoot },
    windowsHide: true,
    timeout: 10_000
  });
  rmSync(stateRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.version, "0.8.0-preview.1");
  const tools = responses[1].result.tools;
  assert.ok(tools.some((tool) => tool.name === "omp_providers"));
  assert.ok(tools.some((tool) => tool.name === "omp_storage_status"));
  assert.ok(tools.some((tool) => tool.name === "omp_pricing_coverage"));
  assert.ok(tools.some((tool) => tool.name === "omp_job_estimate"));
  assert.ok(tools.some((tool) => tool.name === "omp_job_cancel"));
  const create = tools.find((tool) => tool.name === "omp_job_create");
  assert.deepEqual(create.inputSchema.oneOf, [{ required: ["role"] }, { required: ["selector"] }]);
});

test("MCP serves modern clients and validates arguments before invoking tools", () => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-modern-test-"));
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      _meta: meta, name: "omp_job_create", arguments: { confirmQuota: "false" }
    } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      _meta: meta, name: "omp_pipeline_templates", arguments: {}
    } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: {
      _meta: meta, name: "omp_run_resume", arguments: {
        id: "00000000-0000-0000-0000-000000000000", budget: { maxDurationMs: "forever" },
        confirmBudget: true, confirmQuota: true
      }
    } }
  ].map(JSON.stringify).join("\n") + "\n";
  const result = spawnSync(process.execPath, ["mcp/server.mjs"], {
    cwd: process.cwd(), input: requests, encoding: "utf8",
    env: { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: stateRoot },
    windowsHide: true, timeout: 10_000
  });
  rmSync(stateRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  const byId = (id) => responses.find((response) => response.id === id);
  assert.ok(byId(1).result.supportedVersions.includes("2026-07-28"));
  assert.equal(byId(2).result.isError, true);
  assert.match(byId(2).result.content[0].text, /confirmQuota must be boolean/);
  assert.ok(Array.isArray(byId(3).result.structuredContent.value));
  assert.equal(byId(4).result.isError, true);
  assert.match(byId(4).result.content[0].text, /maxDurationMs/);
});

test("a malformed stdio message does not terminate the MCP process", () => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-null-test-"));
  const requests = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", clientInfo: { name: "test-client", version: "1.0" }, capabilities: {}
    } }),
    "null",
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} })
  ].join("\n") + "\n";
  const result = spawnSync(process.execPath, ["mcp/server.mjs"], {
    cwd: process.cwd(), input: requests, encoding: "utf8",
    env: { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: stateRoot },
    windowsHide: true, timeout: 10_000
  });
  rmSync(stateRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(responses.find((response) => response.id === 2)?.result, {});
});
