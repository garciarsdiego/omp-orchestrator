import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("the inference worker limit is global across run-specific job scopes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-global-cap-test-"));
  const code = `
    import { reserveInferenceSlot } from './mcp/jobs.mjs';
    import { newJobId } from './mcp/job-store.mjs';
    const now = new Date().toISOString();
    const id = newJobId();
    try {
      reserveInferenceSlot({ id, status: 'queued', attempt: 1,
        request: { selector: 'fake/model', prompt: 'synthetic' },
        createdAt: now, updatedAt: now }, process.argv[1]);
      process.stdout.write('reserved');
    } catch (error) {
      if (!/Active job limit/.test(error.message)) throw error;
      process.stdout.write('full');
    }
  `;
  async function reserve(scope) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, scope], {
        cwd: process.cwd(),
        env: { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: root, OMP_ORCHESTRATOR_MAX_JOBS: "1" },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("exit", (status) => status === 0 ? resolve(stdout) : reject(new Error(stderr)));
      child.once("error", reject);
    });
  }
  try {
    const results = await Promise.all([reserve(path.join(root, "run-a")), reserve(path.join(root, "run-b"))]);
    assert.deepEqual(results.sort(), ["full", "reserved"]);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
