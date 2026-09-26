import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const cli = fileURLToPath(new URL("../bin/omp-orchestrator.mjs", import.meta.url));
const fakeCommand = fileURLToPath(new URL("../fixtures/command-json-fake.mjs", import.meta.url));

test("CLI works outside the repository and shares the MCP tool contract", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-cli-test-"));
  const workspaceRoot = path.join(workspace, "workspaces");
  mkdirSync(workspaceRoot);
  const configFile = path.join(workspace, "backends.json");
  writeFileSync(configFile, JSON.stringify({ backends: [
    { id: "fake-command", type: "command-json", executable: process.execPath, args: [fakeCommand, "success"] }
  ] }));
  const env = { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: workspace,
    OMP_ORCHESTRATOR_WORKSPACE_ROOT: workspaceRoot, OMP_ORCHESTRATOR_BACKENDS_FILE: configFile };
  try {
    const tools = spawnSync(process.execPath, [cli, "tools"], {
      cwd: workspace, env, encoding: "utf8", windowsHide: true, timeout: 10_000
    });
    assert.equal(tools.status, 0, tools.stderr);
    assert.ok(JSON.parse(tools.stdout).tools.some((tool) => tool.name === "omp_job_create"));

    const valid = spawnSync(process.execPath, [cli, "call", "omp_routing_policy", "--input-file", "-"], {
      cwd: workspace, env, input: "{}", encoding: "utf8", windowsHide: true, timeout: 10_000
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).version, packageVersion);

    const invalid = spawnSync(process.execPath, [cli, "call", "omp_runtime_start", "--input-file", "-"], {
      cwd: workspace, env, input: '{"confirm":"false"}', encoding: "utf8", windowsHide: true, timeout: 10_000
    });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /boolean/);

    const request = { backend: "fake-command", workspace: "cli-project", prompt: "hello-cli",
      timeoutMs: 10_000, idempotencyKey: "cli-e2e-000001", confirmQuota: true };
    const create = spawnSync(process.execPath, [cli, "call", "omp_agent_create", "--input-json", JSON.stringify(request)], {
      cwd: workspace, env, encoding: "utf8", windowsHide: true, timeout: 10_000
    });
    assert.equal(create.status, 0, create.stderr);
    const id = JSON.parse(create.stdout).id;
    let result;
    const deadline = Date.now() + 10_000;
    do {
      const read = spawnSync(process.execPath, [cli, "call", "omp_agent_get", "--input-json", JSON.stringify({ id })], {
        cwd: workspace, env, encoding: "utf8", windowsHide: true, timeout: 10_000
      });
      assert.equal(read.status, 0, read.stderr);
      result = JSON.parse(read.stdout);
      if (!["queued", "running"].includes(result.status)) break;
    } while (Date.now() < deadline);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const final = spawnSync(process.execPath, [cli, "call", "omp_agent_result", "--input-json", JSON.stringify({ id })], {
      cwd: workspace, env, encoding: "utf8", windowsHide: true, timeout: 10_000
    });
    assert.equal(final.status, 0, final.stderr);
    assert.equal(JSON.parse(final.stdout).output, "received:hello-cli");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
