import Database from "better-sqlite3";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
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

/** Latest schema version this code writes; older code must tolerate it. */
export const SCHEMA_VERSION = 4;

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
  }, {
    version: 2,
    name: "consumption_governance",
    sql: `
      CREATE TABLE pricing_snapshots (
        digest TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        loaded_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE consumption_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        run_id TEXT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        selector TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        duration_ms INTEGER,
        registry_digest TEXT,
        pricing_status TEXT NOT NULL,
        match_tier TEXT NOT NULL,
        equivalent_low_usd REAL,
        equivalent_high_usd REAL,
        currency TEXT NOT NULL,
        UNIQUE(job_id, attempt)
      );
      CREATE INDEX consumption_job ON consumption_events(job_id);
      CREATE INDEX consumption_run ON consumption_events(run_id);

      CREATE TABLE policy_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        run_id TEXT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        scope TEXT NOT NULL,
        limit_name TEXT NOT NULL,
        threshold_value REAL,
        observed_value REAL,
        mode TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX policy_job ON policy_events(job_id);
      CREATE INDEX policy_run ON policy_events(run_id);

      INSERT INTO consumption_events(
        at, run_id, job_id, attempt, selector, input_tokens, cached_input_tokens,
        output_tokens, total_tokens, duration_ms, registry_digest, pricing_status,
        match_tier, equivalent_low_usd, equivalent_high_usd, currency
      )
      SELECT
        COALESCE(ja.completed_at, j.updated_at),
        json_extract(j.payload, '$.runId'),
        j.id,
        ja.attempt,
        COALESCE(ja.selector, json_extract(j.payload, '$.request.selector')),
        COALESCE(json_extract(ja.usage_json, '$.input_tokens'), 0),
        COALESCE(json_extract(ja.usage_json, '$.input_tokens_details.cached_tokens'), 0),
        COALESCE(json_extract(ja.usage_json, '$.output_tokens'), 0),
        COALESCE(json_extract(ja.usage_json, '$.total_tokens'), 0),
        CASE WHEN ja.started_at IS NOT NULL AND ja.completed_at IS NOT NULL
          THEN CAST((julianday(ja.completed_at) - julianday(ja.started_at)) * 86400000 AS INTEGER)
          ELSE NULL END,
        NULL,
        'unknown',
        'legacy',
        NULL,
        NULL,
        'USD'
      FROM job_attempts ja
      JOIN jobs j ON j.id = ja.job_id
      WHERE ja.usage_json IS NOT NULL;
    `
  }, {
    version: 3,
    name: "neutral_review_status",
    // Review is not tied to one client. Code keeps accepting the legacy status
    // (and the legacy "codex" attestation node id), so an older image can
    // still read and attest runs written by this schema.
    sql: `
      UPDATE runs
      SET status = 'awaiting_review', payload = json_set(payload, '$.status', 'awaiting_review')
      WHERE status = 'awaiting_codex';
    `
  }, {
    version: 4,
    name: "audit_events",
    // Who changed state, through which mechanism. Arguments are not stored:
    // prompts and findings may contain sensitive text.
    sql: `
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        mechanism TEXT NOT NULL,
        operation TEXT NOT NULL,
        target_id TEXT,
        outcome TEXT NOT NULL,
        error_name TEXT
      );
      CREATE INDEX audit_events_at ON audit_events(at DESC);
    `
  }];
  if (migrations.at(-1).version !== SCHEMA_VERSION) throw new Error("SCHEMA_VERSION is out of date.");
  const beforeLock = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const pendingBeforeLock = migrations.filter((migration) => !beforeLock.has(migration.version));
  if (beforeLock.size && pendingBeforeLock.length && existsSync(DATABASE_PATH)) {
    const currentVersion = Math.max(...beforeLock);
    const backup = `${DATABASE_PATH}.bak-v${currentVersion}`;
    if (!existsSync(backup)) {
      db.pragma("wal_checkpoint(FULL)");
      copyFileSync(DATABASE_PATH, backup);
      restrict(backup, 0o600);
    }
  }
  runImmediateTransaction(db, () => {
    const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
    }
  });
}

function runImmediateTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function withImmediateTransaction(work) {
  const db = getDatabase();
  // Operations that coordinate several store updates hold the outer write
  // transaction. A nested store call uses a SQLite savepoint rather than
  // starting another BEGIN, preserving one atomic commit.
  return db.inTransaction ? db.transaction(work)() : runImmediateTransaction(db, work);
}

const INIT_BUSY_DEADLINE_MS = 10_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function isBusy(error) {
  return typeof error?.code === "string" && error.code.startsWith("SQLITE_BUSY");
}

// Switching a new file into WAL mode and WAL recovery can return SQLITE_BUSY
// without consulting the busy handler while another process initializes the
// same database. Initialization is idempotent (migrations re-check under
// BEGIN IMMEDIATE), so retry it with bounded backoff.
function retryWhileBusy(work) {
  const deadline = Date.now() + INIT_BUSY_DEADLINE_MS;
  let delay = 10;
  for (;;) {
    try {
      return work();
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(sleeper, 0, 0, delay);
      delay = Math.min(delay * 2, 250);
    }
  }
}

export function getDatabase() {
  if (database) return database;
  mkdirSync(path.dirname(DATABASE_PATH), { recursive: true, mode: 0o700 });
  restrict(path.dirname(DATABASE_PATH), 0o700);
  const db = new Database(DATABASE_PATH, { timeout: 5_000 });
  try {
    db.pragma("busy_timeout = 5000");
    retryWhileBusy(() => db.pragma("journal_mode = WAL"));
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    retryWhileBusy(() => migrate(db));
  } catch (error) {
    // Never cache a handle whose pragmas or migrations did not complete.
    try { db.close(); } catch {}
    throw error;
  }
  restrict(DATABASE_PATH, 0o600);
  database = db;
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
