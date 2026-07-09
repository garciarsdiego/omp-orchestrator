import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUN_ROOT = process.env.OMP_ORCHESTRATOR_RUN_DIR
  || path.join(os.tmpdir(), "omp-orchestrator", "runs");

function assertRunId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("Invalid run id.");
}

export function newRunId() {
  return randomUUID();
}

export function runDir(id) {
  assertRunId(id);
  return path.join(RUN_ROOT, id);
}

export function runFile(id) {
  return path.join(runDir(id), "run.json");
}

export function runJobsDir(id) {
  return path.join(runDir(id), "jobs");
}

export function runArtifactsDir(id) {
  return path.join(runDir(id), "artifacts");
}

export function readRun(id) {
  try { return JSON.parse(readFileSync(runFile(id), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`Run not found: ${id}`);
    throw error;
  }
}

export function writeRun(run) {
  const directory = runDir(run.id);
  mkdirSync(directory, { recursive: true });
  mkdirSync(runJobsDir(run.id), { recursive: true });
  mkdirSync(runArtifactsDir(run.id), { recursive: true });
  const target = runFile(run.id);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(run, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
  return run;
}

export function updateRun(id, mutate) {
  const run = readRun(id);
  const updated = mutate(run) || run;
  updated.updatedAt = new Date().toISOString();
  return writeRun(updated);
}

export function appendRunEvent(id, type, data = {}) {
  const run = readRun(id);
  const event = {
    sequence: (run.eventCount || 0) + 1,
    type,
    at: new Date().toISOString(),
    ...data
  };
  appendFileSync(path.join(runDir(id), "events.jsonl"), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  run.eventCount = event.sequence;
  run.updatedAt = event.at;
  writeRun(run);
  return event;
}

export function readRunEvents(id, after = 0, limit = 100) {
  let text = "";
  try { text = readFileSync(path.join(runDir(id), "events.jsonl"), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return text.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.sequence > after)
    .slice(0, Math.max(1, Math.min(500, limit)));
}

export function listRuns(limit = 25) {
  mkdirSync(RUN_ROOT, { recursive: true });
  return readdirSync(RUN_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
    .map((entry) => {
      try { return readRun(entry.name); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export function writeArtifact(id, name, content) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) throw new Error("Invalid artifact name.");
  const directory = runArtifactsDir(id);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, name);
  writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
  return {
    name,
    path: target,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

export function readArtifact(id, name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) throw new Error("Invalid artifact name.");
  return readFileSync(path.join(runArtifactsDir(id), name), "utf8");
}

export function publicRun(run) {
  return {
    id: run.id,
    template: run.template,
    status: run.status,
    phase: run.phase,
    budget: run.budget,
    estimate: run.estimate,
    usage: run.usage,
    nodes: run.nodes,
    artifacts: run.artifacts,
    validation: run.validation || null,
    attestation: run.attestation || null,
    error: run.error || null,
    eventCount: run.eventCount || 0,
    revisionCount: run.revisionCount || 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt || null,
    deadlineAt: run.deadlineAt || null
  };
}
