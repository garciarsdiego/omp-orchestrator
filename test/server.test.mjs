import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("MCP lists provider readiness and selector-aware job tools", () => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-server-test-"));
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
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
  assert.equal(responses[0].result.serverInfo.version, "0.7.0");
  const tools = responses[1].result.tools;
  assert.ok(tools.some((tool) => tool.name === "omp_providers"));
  assert.ok(tools.some((tool) => tool.name === "omp_storage_status"));
  assert.ok(tools.some((tool) => tool.name === "omp_pricing_coverage"));
  assert.ok(tools.some((tool) => tool.name === "omp_job_estimate"));
  assert.ok(tools.some((tool) => tool.name === "omp_job_cancel"));
  const create = tools.find((tool) => tool.name === "omp_job_create");
  assert.deepEqual(create.inputSchema.oneOf, [{ required: ["role"] }, { required: ["selector"] }]);
});
