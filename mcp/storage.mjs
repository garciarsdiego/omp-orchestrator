import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultStateRoot() {
  if (process.env.OMP_ORCHESTRATOR_STATE_DIR) return process.env.OMP_ORCHESTRATOR_STATE_DIR;
  if (process.env.OMP_ORCHESTRATOR_RUN_DIR) return process.env.OMP_ORCHESTRATOR_RUN_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), "omp-orchestrator");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "omp-orchestrator");
}

export const STATE_ROOT = defaultStateRoot();
export const DATABASE_PATH = process.env.OMP_ORCHESTRATOR_DB_PATH
  || path.join(STATE_ROOT, "orchestrator.sqlite");
export const CAS_ROOT = process.env.OMP_ORCHESTRATOR_CAS_DIR
  || path.join(STATE_ROOT, "objects", "sha256");

let database;

function restrict(pathname, mode) {
  try { chmodSync(pathname, mode); } catch {}
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const migrations = [{
    version: 1,
    name: "durable_state",
    sql: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        worker_pid INTEGER,
        payload TEXT NOT NULL
      );
      CREATE INDEX jobs_scope_created ON jobs(scope, created_at DESC);
      CREATE INDEX jobs_status ON jobs(status);

      CREATE TABLE job_attempts (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        selector TEXT,
        started_at TEXT,
        completed_at TEXT,
        usage_json TEXT,
        error_json TEXT,
        PRIMARY KEY(job_id, attempt)
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        template TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        worker_pid INTEGER,
        payload TEXT NOT NULL
      );
      CREATE INDEX runs_created ON runs(created_at DESC);
      CREATE INDEX runs_status ON runs(status);

      CREATE TABLE run_nodes (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        job_id TEXT,
        selector TEXT,
        payload TEXT NOT NULL,
        PRIMARY KEY(run_id, node_id)
      );

      CREATE TABLE events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );

      CREATE TABLE artifacts (
        sha256 TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        object_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE run_artifacts (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES artifacts(sha256),
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, name)
      );

      CREATE TABLE attestations (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        verdict TEXT NOT NULL,
        artifact_sha256 TEXT,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `
  }];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

export function getDatabase() {
  if (database) return database;
  mkdirSync(path.dirname(DATABASE_PATH), { recursive: true, mode: 0o700 });
  restrict(path.dirname(DATABASE_PATH), 0o700);
  database = new Database(DATABASE_PATH, { timeout: 5_000 });
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  migrate(database);
  restrict(DATABASE_PATH, 0o600);
  return database;
}

export function closeDatabase() {
  if (!database) return;
  database.close();
  database = undefined;
}

export function storageStatus() {
  const db = getDatabase();
  return {
    databasePath: DATABASE_PATH,
    casRoot: CAS_ROOT,
    journalMode: db.pragma("journal_mode", { simple: true }),
    schemaVersion: db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version
  };
}
