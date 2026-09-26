import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { writeJob } from "./job-store.mjs";
import { writeArtifact, writeRun } from "./run-store.mjs";
import { getDatabase } from "./storage.mjs";
import { scanForSecrets } from "./security.mjs";

function jsonFiles(directory) {
  if (!directory || !existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
    .map((name) => path.join(directory, name));
}

function runDirectories(directory) {
  if (!directory || !existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function importEvent(db, runId, event, index, fallbackAt) {
  const sequence = Number.isSafeInteger(event.sequence) && event.sequence > 0 ? event.sequence : index + 1;
  const at = typeof event.at === "string" ? event.at : fallbackAt;
  const imported = { ...event, sequence, at };
  const payload = JSON.stringify(imported);
  const existing = db.prepare("SELECT payload FROM events WHERE run_id = ? AND sequence = ?").get(runId, sequence);
  if (existing && existing.payload !== payload) {
    throw new Error(`Legacy event conflict for run ${runId}, sequence ${sequence}.`);
  }
  if (!existing) {
    db.prepare("INSERT INTO events(run_id, sequence, type, at, payload) VALUES (?, ?, ?, ?, ?)")
      .run(runId, sequence, imported.type, at, payload);
  }
  return sequence;
}

export function inspectLegacyJson({ jobsDir, runsDir } = {}) {
  const report = { jobs: [], runs: [], errors: [] };
  for (const file of jsonFiles(jobsDir)) {
    try {
      const value = readJson(file);
      const secrets = scanForSecrets(value);
      if (secrets.length) report.errors.push({ file, error: `Blocked secret patterns: ${secrets.join(", ")}` });
      else report.jobs.push({ file, value });
    }
    catch (error) { report.errors.push({ file, error: error.message }); }
  }
  for (const directory of runDirectories(runsDir)) {
    const file = path.join(directory, "run.json");
    if (!existsSync(file)) continue;
    try {
      const run = readJson(file);
      const runSecrets = scanForSecrets(run);
      if (runSecrets.length) throw new Error(`Blocked secret patterns: ${runSecrets.join(", ")}`);
      const eventFile = path.join(directory, "events.jsonl");
      const events = existsSync(eventFile)
        ? readFileSync(eventFile, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse)
        : [];
      const artifactDir = path.join(directory, "artifacts");
      const artifacts = existsSync(artifactDir)
        ? readdirSync(artifactDir).map((name) => ({ name, content: readFileSync(path.join(artifactDir, name), "utf8") }))
        : [];
      report.runs.push({ directory, run, events, artifacts });
    } catch (error) {
      report.errors.push({ file, error: error.message });
    }
  }
  return report;
}

export function migrateLegacyJson({ jobsDir, runsDir, apply = false } = {}) {
  const inspected = inspectLegacyJson({ jobsDir, runsDir });
  const summary = {
    apply,
    jobs: inspected.jobs.length,
    runs: inspected.runs.length,
    events: inspected.runs.reduce((sum, item) => sum + item.events.length, 0),
    artifacts: inspected.runs.reduce((sum, item) => sum + item.artifacts.length, 0),
    errors: inspected.errors
  };
  if (!apply || inspected.errors.length) return summary;
  const db = getDatabase();
  db.transaction(() => {
    for (const item of inspected.jobs) writeJob(item.value);
    for (const item of inspected.runs) {
      const maxSequence = item.events.reduce((max, event, index) => Math.max(
        max,
        Number.isSafeInteger(event.sequence) && event.sequence > 0 ? event.sequence : index + 1
      ), 0);
      const imported = {
        ...item.run,
        eventCount: Math.max(item.run.eventCount || 0, maxSequence),
        artifacts: []
      };
      writeRun(imported);
      item.events.forEach((event, index) => importEvent(db, imported.id, event, index, imported.updatedAt));
      const artifacts = item.artifacts.map((artifact) => writeArtifact(imported.id, artifact.name, artifact.content));
      if (artifacts.length) {
        imported.artifacts = artifacts;
        writeRun(imported);
      }
    }
  })();
  return summary;
}
