import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SUPERVISOR_HEARTBEAT } from "./agent-jobs.mjs";
import { getDatabase, STATE_ROOT } from "./storage.mjs";
import { readJob, updateJob } from "./job-store.mjs";

const WORKER = fileURLToPath(new URL("./agent-worker.mjs", import.meta.url));
const OWNER = randomUUID();
let ticking = false;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function heartbeat() {
  mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const temporary = `${SUPERVISOR_HEARTBEAT}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), owner: OWNER }), { mode: 0o600 });
  renameSync(temporary, SUPERVISOR_HEARTBEAT);
}

function reconcileAgentChildren() {
  const rows = getDatabase().prepare(`SELECT payload FROM jobs
    WHERE status IN ('running','cancellation_requested') AND json_extract(payload,'$.backend') IS NOT NULL`).all();
  for (const row of rows) {
    const job = JSON.parse(row.payload);
    if (pidAlive(job.workerPid)) continue;
    updateJob(job.id, (current) => {
      if (!["running", "cancellation_requested"].includes(current.status) || pidAlive(current.workerPid)) return current;
      return { ...current, status: "interrupted", workerPid: null, completedAt: new Date().toISOString(),
        error: { name: "InterruptedError", message: "Agent worker exited before a terminal result. No automatic replay." } };
    });
  }
}

function dispatchAgent(id) {
  let claimed = false;
  const claimId = randomUUID();
  updateJob(id, (job) => {
    const previous = job.dispatchClaim;
    if (!job.backend || job.status !== "queued" || pidAlive(job.workerPid)
      || previous && Date.now() - Date.parse(previous.at) < 30_000) return job;
    claimed = true;
    return { ...job, dispatchClaim: { id: claimId, owner: OWNER, at: new Date().toISOString() } };
  });
  if (!claimed) return;
  try {
    const child = spawn(process.execPath, [WORKER, id], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, OMP_ORCHESTRATOR_ACCESS_TOKEN_FILE: "" }
    });
    child.unref();
    updateJob(id, (job) => job.dispatchClaim?.id === claimId
      ? { ...job, workerPid: child.pid } : job);
  } catch {
    updateJob(id, (job) => job.dispatchClaim?.id === claimId
      ? { ...job, status: "failed", completedAt: new Date().toISOString(),
        error: { name: "WorkerSpawnError", message: "Agent worker failed to start." } } : job);
  }
}

export function supervisorTick() {
  if (ticking) return;
  ticking = true;
  try {
    heartbeat();
    reconcileAgentChildren();
    const queued = getDatabase().prepare(`SELECT id FROM jobs
      WHERE status = 'queued' AND json_extract(payload,'$.backend') IS NOT NULL
      ORDER BY created_at LIMIT 32`).all();
    for (const row of queued) dispatchAgent(row.id);
  } finally { ticking = false; }
}

export function startAgentSupervisor() {
  supervisorTick();
  const timer = setInterval(supervisorTick, 1_000);
  const stop = () => { clearInterval(timer); process.exitCode = 0; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { close: stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startAgentSupervisor();
}
