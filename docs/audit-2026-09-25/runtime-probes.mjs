// Synthetic, provider-free reproductions for runtime-findings.md.
// Run from the repository root with: node docs/audit-2026-09-25/runtime-probes.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function execute(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: repository,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status) => {
      if (status !== 0) reject(new Error(`Probe exited ${status}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

const lostUpdate = await execute(String.raw`
  import { mkdtempSync, rmSync } from "node:fs";
  import os from "node:os";
  import path from "node:path";
  import { spawn } from "node:child_process";
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-audit-lost-update-"));
  process.env.OMP_ORCHESTRATOR_STATE_DIR = root;
  const store = await import("./mcp/run-store.mjs");
  const storage = await import("./mcp/storage.mjs");
  const id = store.newRunId();
  const now = new Date().toISOString();
  store.writeRun({ id, template: "test", status: "running", phase: "test", budget: {}, estimate: {}, usage: { counter: 0 }, nodes: [], artifacts: [], eventCount: 0, revisionCount: 0, createdAt: now, updatedAt: now });
  const childCode = 'import { updateRun } from "./mcp/run-store.mjs"; for (let i=0; i<500; i++) updateRun(process.env.RUN_ID, r => ({...r, usage:{...r.usage, counter:(r.usage.counter||0)+1}}));';
  const start = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], { cwd: process.cwd(), env: { ...process.env, RUN_ID: id }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("exit", (status) => resolve({ status, error: error.trim().slice(0, 300) }));
  });
  const children = await Promise.all([start(), start()]);
  const observed = store.readRun(id).usage.counter;
  const quickCheck = storage.getDatabase().pragma("quick_check", { simple: true });
  storage.closeDatabase();
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ expected: 1000, observed, children, quickCheck }));
`);

const stateTransitions = await execute(String.raw`
  import { mkdtempSync, rmSync } from "node:fs";
  import os from "node:os";
  import path from "node:path";
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-audit-state-"));
  process.env.OMP_ORCHESTRATOR_STATE_DIR = root;
  const store = await import("./mcp/run-store.mjs");
  const jobs = await import("./mcp/job-store.mjs");
  const recovery = await import("./mcp/recovery.mjs");
  const manager = await import("./mcp/run-manager.mjs");
  const storage = await import("./mcp/storage.mjs");
  const now = new Date().toISOString();
  const secretRunId = store.newRunId();
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  store.writeRun({ id: secretRunId, template: "test", status: "running", phase: "test", input: secret, budget: {}, estimate: {}, usage: {}, nodes: [], artifacts: [], eventCount: 0, revisionCount: 0, createdAt: now, updatedAt: now });
  const acceptedId = store.newRunId();
  store.writeRun({ id: acceptedId, template: "single-file-web-app", status: "awaiting_codex", phase: "attestation", budget: {}, estimate: {}, usage: {}, nodes: [], artifacts: [], validation: { valid: true }, eventCount: 0, revisionCount: 0, createdAt: now, updatedAt: now });
  const artifact = store.writeArtifact(acceptedId, "candidate.html", "<!DOCTYPE html><html></html>");
  store.updateRun(acceptedId, (run) => ({ ...run, artifacts: [artifact] }));
  await manager.attestRun({ id: acceptedId, verdict: "accept" });
  const beforeCancel = store.readRun(acceptedId).status;
  const afterCancel = manager.cancelRun({ id: acceptedId, confirm: true }).status;
  const jobId = jobs.newJobId();
  jobs.writeJob({ id: jobId, status: "running", attempt: 1, createdAt: now, updatedAt: now, workerPid: process.pid, request: { role: "plan", selector: "anthropic/test", provider: "anthropic", model: "test", reasoning: null, prompt: "x", contract: "notes" }, budget: {}, output: null, usage: null, error: null });
  const interruptedId = store.newRunId();
  store.writeRun({ id: interruptedId, template: "independent-analysis", status: "running", phase: "initial", workerPid: 2000000000, budget: {}, estimate: {}, usage: {}, nodes: [{ id: "analysis-a", type: "inference", status: "running", jobId }], artifacts: [], eventCount: 0, revisionCount: 0, createdAt: now, updatedAt: now });
  const reconciled = recovery.reconcileInterruptedWork();
  const recoveredRun = store.readRun(interruptedId);
  const prepared = manager.prepareNodesForResume(recoveredRun.nodes);
  const result = { secretPersisted: store.readRun(secretRunId).input === secret, terminalRewrite: { beforeCancel, afterCancel }, orphanRecovery: { reconciled, jobStatus: jobs.readJob(jobId).status, runStatus: recoveredRun.status, recoveredNodeStatus: recoveredRun.nodes[0].status, resumeJobId: prepared[0].jobId } };
  storage.closeDatabase();
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(result));
`);

const budgetEdges = await execute(String.raw`
  import { evaluateActualUsage, normalizeJobBudget } from "./mcp/budget.mjs";
  const budget = { maxCalls: 2, maxInputTokens: 100, maxOutputTokens: 100, maxTotalTokens: 200, maxDurationMs: 10000, costPolicy: "enforce", maxApiEquivalentUsd: 1 };
  const missingUsage = evaluateActualUsage({ budget, usage: null, prior: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, equivalentHighUsd: 0 }, cost: null, durationMs: 1 });
  const zeroRemainingNormalized = normalizeJobBudget({ prompt: "hello", maxOutputTokens: 100, timeoutMs: 10000, budget: { maxCalls: 1, maxInputTokens: 0, maxOutputTokens: 0, maxTotalTokens: 0, maxDurationMs: 10000, maxRetries: 0, costPolicy: "disabled" } });
  console.log(JSON.stringify({ missingUsage, zeroRemainingNormalized }));
`);

const migration = await execute(String.raw`
  import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
  import os from "node:os";
  import path from "node:path";
  const state = mkdtempSync(path.join(os.tmpdir(), "omp-audit-migration-state-"));
  const legacy = mkdtempSync(path.join(os.tmpdir(), "omp-audit-migration-src-"));
  process.env.OMP_ORCHESTRATOR_STATE_DIR = state;
  const migrations = await import("./mcp/migration.mjs");
  const storage = await import("./mcp/storage.mjs");
  const id = "30000000-0000-4000-8000-000000000001";
  const directory = path.join(legacy, id);
  mkdirSync(directory, { recursive: true });
  const legacyAt = "2025-01-01T00:00:00.000Z";
  writeFileSync(path.join(directory, "run.json"), JSON.stringify({ id, template: "test", status: "succeeded", phase: "complete", budget: {}, estimate: {}, usage: {}, nodes: [], artifacts: [], eventCount: 1, revisionCount: 0, createdAt: legacyAt, updatedAt: legacyAt }));
  writeFileSync(path.join(directory, "events.jsonl"), JSON.stringify({ sequence: 1, type: "run.created", at: legacyAt, source: "legacy" }) + "\n");
  const first = migrations.migrateLegacyJson({ runsDir: legacy, apply: true });
  let second;
  try { second = migrations.migrateLegacyJson({ runsDir: legacy, apply: true }); }
  catch (error) { second = { threw: error.message }; }
  const storedAt = storage.getDatabase().prepare("SELECT at FROM events WHERE run_id=? AND sequence=1").get(id).at;
  storage.closeDatabase();
  rmSync(state, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
  console.log(JSON.stringify({ first, second, legacyAt, storedAt }));
`);

const schemaRace = await execute(String.raw`
  import { mkdtempSync, rmSync } from "node:fs";
  import os from "node:os";
  import path from "node:path";
  import { spawn } from "node:child_process";
  const failedTrials = [];
  for (let trial=0; trial<20; trial++) {
    const root = mkdtempSync(path.join(os.tmpdir(), "omp-audit-migrate-race-"));
    const code = 'import { storageStatus, closeDatabase } from "./mcp/storage.mjs"; storageStatus(); closeDatabase();';
    const start = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: process.cwd(), env: { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: root }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (chunk) => { error += chunk; });
      child.on("exit", (status) => resolve({ status, error: error.trim().slice(0, 220) }));
    });
    const results = await Promise.all(Array.from({ length: 8 }, start));
    const failures = results.filter((result) => result.status !== 0);
    if (failures.length) failedTrials.push({ trial, failures });
    rmSync(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ trials: 20, processesPerTrial: 8, trialsWithFailures: failedTrials.length, sample: failedTrials[0] || null }));
`);

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), syntheticDataOnly: true, lostUpdate, stateTransitions, budgetEdges, migration, schemaRace }, null, 2));
