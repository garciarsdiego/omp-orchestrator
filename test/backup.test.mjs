import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const root = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-backup-test-"));
process.env.OMP_ORCHESTRATOR_STATE_DIR = path.join(root, "state");
const storage = await import("../mcp/storage.mjs");
const runs = await import("../mcp/run-store.mjs");
const backup = await import("../scripts/backup.mjs");

test.after(() => {
  storage.closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

test("backup packages the online SQLite snapshot and CAS artifacts for verified restore", async () => {
  const now = new Date().toISOString();
  const runId = runs.newRunId();
  runs.writeRun({
    id: runId, template: "test", status: "awaiting_review", phase: "attestation", budget: {}, estimate: {}, usage: {}, nodes: [],
    artifacts: [], createdAt: now, updatedAt: now, completedAt: null, workerPid: null
  });
  const artifact = runs.writeArtifact(runId, "artifact.txt", "restorable artifact");
  const result = await backup.backupDatabase({ outputDir: path.join(root, "backups") });
  assert.match(result.database, /orchestrator\.sqlite$/);
  assert.equal(result.objects, 1);
  const snapshot = new Database(result.database, { readonly: true });
  try {
    assert.equal(snapshot.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(snapshot.prepare("SELECT sha256 FROM artifacts").get().sha256, artifact.sha256);
  } finally {
    snapshot.close();
  }
  const manifest = JSON.parse(readFileSync(result.manifest, "utf8"));
  assert.equal(manifest.objects[0].sha256, artifact.sha256);
  const stagedVolume = path.join(root, "staged-volume");
  const runtimeVolume = path.join(root, "runtime-volume");
  const runtimeState = path.join(runtimeVolume, "state");
  const restored = backup.restorePackage({
    packageDir: result.package,
    stateDir: path.join(stagedVolume, "state"),
    runtimeStateDir: runtimeState
  });
  const restoredDb = new Database(restored.database, { readonly: true });
  try {
    const row = restoredDb.prepare("SELECT object_path AS objectPath FROM artifacts WHERE sha256 = ?").get(artifact.sha256);
    assert.ok(row.objectPath.startsWith(runtimeState));
  } finally {
    restoredDb.close();
  }
  // Model mounting the restored host-volume parent at the runtime location.
  renameSync(stagedVolume, runtimeVolume);
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import { readArtifact } from './mcp/run-store.mjs';
    process.stdout.write(readArtifact(${JSON.stringify(runId)}, 'artifact.txt'));
  `], {
    cwd: path.resolve("."),
    env: { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: runtimeState },
    encoding: "utf8"
  });
  assert.equal(output, "restorable artifact");
});
