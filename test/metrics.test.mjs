import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const state = mkdtempSync(path.join(os.tmpdir(), "omp-metrics-test-"));
process.env.OMP_ORCHESTRATOR_STATE_DIR = state;

const { startHttpServer } = await import("../mcp/http-server.mjs");
const { invoke } = await import("../mcp/tool-catalog.mjs");
const storage = await import("../mcp/storage.mjs");
const jobs = await import("../mcp/job-store.mjs");
const runs = await import("../mcp/run-store.mjs");

const secret = "metrics-synthetic-token-0000000000000001";

test.after(() => {
  storage.closeDatabase();
  rmSync(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function seed() {
  const now = new Date().toISOString();
  const base = { attempt: 1, createdAt: now, updatedAt: now, budget: {}, output: null, validation: null, usage: null, error: null };
  jobs.writeJob({ ...base, id: jobs.newJobId(), status: "succeeded", request: { selector: "p/m", prompt: "x", contract: "text" } });
  jobs.writeJob({ ...base, id: jobs.newJobId(), status: "succeeded", backend: "fake", workspace: state, request: { prompt: "x" } });
  jobs.writeJob({ ...base, id: jobs.newJobId(), status: "interrupted", backend: "fake", workspace: state, request: { prompt: "x" } });
  runs.writeRun({ id: runs.newRunId(), template: "t", status: "awaiting_review", phase: "attestation", budget: {}, estimate: {},
    usage: {}, nodes: [], artifacts: [], createdAt: now, updatedAt: now });
}

test("metrics are authenticated and exposed as Prometheus text and JSON", async (t) => {
  seed();
  const tokenFile = path.join(state, "token");
  writeFileSync(tokenFile, `${secret}\n`);
  const server = await startHttpServer({ bind: "127.0.0.1", port: 0, accessTokenFile: tokenFile, publicOrigin: "" });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${secret}` };

  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  assert.equal((await fetch(`${base}/api/metrics`)).status, 401);

  const text = await fetch(`${base}/metrics`, { headers });
  assert.equal(text.status, 200);
  assert.match(text.headers.get("content-type"), /^text\/plain; version=0\.0\.4/);
  const body = await text.text();
  for (const line of body.trimEnd().split("\n")) {
    if (line.startsWith("#")) assert.match(line, /^# (HELP|TYPE) omp_orchestrator_[a-z_]+ /);
    else assert.match(line, /^omp_orchestrator_[a-z_]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? -?\d+(\.\d+)?$/, line);
  }
  assert.match(body, /omp_orchestrator_jobs\{kind="agent",status="succeeded"\} 1/);
  assert.match(body, /omp_orchestrator_jobs\{kind="agent",status="interrupted"\} 1/);
  assert.match(body, /omp_orchestrator_jobs\{kind="inference",status="succeeded"\} 1/);
  assert.match(body, /omp_orchestrator_runs\{status="awaiting_review"\} 1/);
  assert.match(body, new RegExp(`omp_orchestrator_info\\{version="[^"]+",schema_version="${storage.SCHEMA_VERSION}"\\} 1`));
  assert.match(body, /omp_orchestrator_http_auth_failures_total 2/);
  assert.doesNotMatch(body, new RegExp(secret));

  const json = await (await fetch(`${base}/api/metrics`, { headers })).json();
  assert.equal(json.storage.schemaVersion, storage.SCHEMA_VERSION);
  assert.deepEqual(json.runs, [{ status: "awaiting_review", count: 1 }]);
  assert.ok(json.http.requests.some((row) => row.codeClass === "4xx" && row.count >= 2));
  assert.equal(json.agentSupervisor.mode, "local");

  // Same core snapshot through the tool catalog (CLI and MCP).
  const viaTool = await invoke("omp_metrics");
  assert.deepEqual(viaTool.jobs, json.jobs);
  assert.deepEqual(viaTool.runs, json.runs);
});
