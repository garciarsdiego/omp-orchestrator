import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import path from "node:path";
import { CAS_ROOT, getDatabase, STATE_ROOT } from "./storage.mjs";
import { assertNoSecrets } from "./security.mjs";

export const RUN_ROOT = process.env.OMP_ORCHESTRATOR_RUN_DIR
  || path.join(STATE_ROOT, "runs");

function assertRunId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("Invalid run id.");
}

function assertArtifactName(name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) throw new Error("Invalid artifact name.");
}

export function newRunId() {
  return randomUUID();
}

export function runDir(id) {
  assertRunId(id);
  return path.join(RUN_ROOT, id);
}

export function runFile(id) {
  assertRunId(id);
  return `sqlite:${id}`;
}

export function runJobsDir(id) {
  return path.join(runDir(id), "jobs");
}

export function runArtifactsDir(id) {
  return path.join(runDir(id), "artifacts");
}

export function readRun(id) {
  assertRunId(id);
  const row = getDatabase().prepare("SELECT payload FROM runs WHERE id = ?").get(id);
  if (!row) throw new Error(`Run not found: ${id}`);
  return JSON.parse(row.payload);
}

export function writeRun(run) {
  assertRunId(run.id);
  const db = getDatabase();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO runs(id, template, status, phase, created_at, updated_at, worker_pid, payload)
      VALUES (@id, @template, @status, @phase, @createdAt, @updatedAt, @workerPid, @payload)
      ON CONFLICT(id) DO UPDATE SET
        template=excluded.template, status=excluded.status, phase=excluded.phase,
        updated_at=excluded.updated_at, worker_pid=excluded.worker_pid, payload=excluded.payload
    `).run({
      id: run.id,
      template: run.template,
      status: run.status,
      phase: run.phase,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      workerPid: run.workerPid || null,
      payload: JSON.stringify(run)
    });
    db.prepare("DELETE FROM run_nodes WHERE run_id = ?").run(run.id);
    const insertNode = db.prepare(`
      INSERT INTO run_nodes(run_id, node_id, type, status, job_id, selector, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const node of run.nodes || []) {
      insertNode.run(
        run.id, node.id, node.type, node.status, node.jobId || null, node.selector || null, JSON.stringify(node)
      );
    }
    const linkArtifact = db.prepare(`
      INSERT INTO run_artifacts(run_id, name, sha256, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, name) DO UPDATE SET sha256=excluded.sha256, created_at=excluded.created_at
    `);
    for (const artifact of run.artifacts || []) {
      if (artifact?.name && artifact?.sha256) {
        linkArtifact.run(run.id, artifact.name, artifact.sha256, run.updatedAt);
      }
    }
    if (run.attestation) {
      const artifactSha = run.artifacts?.at(-1)?.sha256 || null;
      db.prepare(`
        INSERT INTO attestations(run_id, verdict, artifact_sha256, created_at, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET verdict=excluded.verdict,
          artifact_sha256=excluded.artifact_sha256, created_at=excluded.created_at, payload=excluded.payload
      `).run(
        run.id,
        run.attestation.verdict,
        artifactSha,
        run.attestation.at || new Date().toISOString(),
        JSON.stringify(run.attestation)
      );
    }
  })();
  return run;
}

export function updateRun(id, mutate) {
  const run = readRun(id);
  const updated = mutate(run) || run;
  updated.updatedAt = new Date().toISOString();
  return writeRun(updated);
}

export function appendRunEvent(id, type, data = {}) {
  assertNoSecrets(data, "Run event");
  const db = getDatabase();
  return db.transaction(() => {
    const run = readRun(id);
    const event = {
      sequence: (run.eventCount || 0) + 1,
      type,
      at: new Date().toISOString(),
      ...data
    };
    db.prepare("INSERT INTO events(run_id, sequence, type, at, payload) VALUES (?, ?, ?, ?, ?)")
      .run(id, event.sequence, event.type, event.at, JSON.stringify(event));
    run.eventCount = event.sequence;
    run.updatedAt = event.at;
    writeRun(run);
    return event;
  })();
}

export function readRunEvents(id, after = 0, limit = 100) {
  assertRunId(id);
  return getDatabase().prepare(`
    SELECT payload FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
  `).all(id, after, Math.max(1, Math.min(500, limit))).map((row) => JSON.parse(row.payload));
}

export function listRuns(limit = 25) {
  return getDatabase().prepare("SELECT payload FROM runs ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(100, limit)))
    .map((row) => JSON.parse(row.payload));
}

function objectPath(sha256) {
  return path.join(CAS_ROOT, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function writeArtifact(id, name, content) {
  assertRunId(id);
  assertArtifactName(name);
  assertNoSecrets(content, "Artifact");
  const body = Buffer.from(content);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const target = objectPath(sha256);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, body, { mode: 0o600 });
    try { renameSync(temporary, target); }
    catch (error) {
      rmSync(temporary, { force: true });
      if (!existsSync(target)) throw error;
    }
    try { chmodSync(target, 0o600); } catch {}
  }
  const now = new Date().toISOString();
  const db = getDatabase();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO artifacts(sha256, bytes, media_type, object_path, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING
    `).run(sha256, body.length, "application/octet-stream", target, now);
    const runExists = db.prepare("SELECT 1 FROM runs WHERE id = ?").get(id);
    if (runExists) {
      db.prepare(`
        INSERT INTO run_artifacts(run_id, name, sha256, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, name) DO UPDATE SET sha256=excluded.sha256, created_at=excluded.created_at
      `).run(id, name, sha256, now);
    }
  })();
  return { name, path: target, bytes: body.length, sha256 };
}

export function readArtifact(id, name) {
  assertRunId(id);
  assertArtifactName(name);
  const row = getDatabase().prepare(`
    SELECT a.object_path FROM run_artifacts ra
    JOIN artifacts a ON a.sha256 = ra.sha256
    WHERE ra.run_id = ? AND ra.name = ?
  `).get(id, name);
  if (!row) throw new Error(`Artifact not found: ${name}`);
  return readFileSync(row.object_path, "utf8");
}

export function collectArtifacts({ graceMs = 86_400_000, dryRun = true } = {}) {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - Math.max(0, graceMs)).toISOString();
  const candidates = db.prepare(`
    SELECT a.sha256, a.object_path FROM artifacts a
    LEFT JOIN run_artifacts ra ON ra.sha256 = a.sha256
    LEFT JOIN attestations at ON at.artifact_sha256 = a.sha256
    WHERE ra.sha256 IS NULL AND at.artifact_sha256 IS NULL AND a.created_at < ?
  `).all(cutoff);
  if (!dryRun) {
    db.transaction(() => {
      for (const candidate of candidates) {
        rmSync(candidate.object_path, { force: true });
        db.prepare("DELETE FROM artifacts WHERE sha256 = ?").run(candidate.sha256);
      }
    })();
  }
  return { dryRun, count: candidates.length, sha256: candidates.map((item) => item.sha256) };
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
