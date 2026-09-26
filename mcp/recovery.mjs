import { getDatabase } from "./storage.mjs";

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function reconcileInterruptedWork() {
  const db = getDatabase();
  const now = new Date().toISOString();
  let jobs = 0;
  let runs = 0;
  db.transaction(() => {
    for (const row of db.prepare("SELECT id, payload FROM jobs WHERE status IN ('queued', 'running', 'cancellation_requested')").all()) {
      const job = JSON.parse(row.payload);
      // Agent workers in the optional sidecar have a separate PID namespace.
      // The sidecar reconciles those PIDs; the HTTP container must not infer
      // their death by testing a number in its own namespace.
      if (job.backend && process.env.OMP_ORCHESTRATOR_AGENT_DISPATCH === "external") continue;
      if (pidAlive(job.workerPid)) continue;
      job.status = "interrupted";
      job.completedAt = now;
      job.updatedAt = now;
      job.workerPid = null;
      job.error = { name: "InterruptedError", message: "Worker was not alive during startup reconciliation." };
      db.prepare("UPDATE jobs SET status = ?, updated_at = ?, worker_pid = NULL, payload = ? WHERE id = ?")
        .run(job.status, now, JSON.stringify(job), job.id);
      db.prepare(`
        UPDATE job_attempts SET status = ?, completed_at = ?, error_json = ?
        WHERE job_id = ? AND attempt = ?
      `).run(job.status, now, JSON.stringify(job.error), job.id, job.attempt);
      jobs++;
    }
    for (const row of db.prepare("SELECT id, payload FROM runs WHERE status IN ('running', 'cancellation_requested')").all()) {
      const run = JSON.parse(row.payload);
      if (pidAlive(run.workerPid)) continue;
      run.status = "interrupted";
      run.interruptedFromPhase = run.phase;
      run.phase = "interrupted";
      run.completedAt = now;
      run.updatedAt = now;
      run.workerPid = null;
      run.error = { name: "InterruptedError", message: "Run worker was not alive during startup reconciliation." };
      run.nodes = (run.nodes || []).map((node) => {
        if (!["running", "reserving"].includes(node.status) || !node.jobId) {
          return ["running", "reserving"].includes(node.status)
            ? { ...node, status: "interrupted", completedAt: now } : node;
        }
        const jobRow = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(node.jobId);
        const job = jobRow && JSON.parse(jobRow.payload);
        // A surviving child owns the paid request. Preserve the node/job link
        // so resumeRun attaches to it rather than spawning a duplicate.
        if (job && ["queued", "running"].includes(job.status) && pidAlive(job.workerPid)) return node;
        return { ...node, status: "interrupted", completedAt: now };
      });
      db.prepare("UPDATE runs SET status = ?, phase = ?, updated_at = ?, worker_pid = NULL, payload = ? WHERE id = ?")
        .run(run.status, run.phase, now, JSON.stringify(run), run.id);
      for (const node of run.nodes) {
        db.prepare("UPDATE run_nodes SET status = ?, payload = ? WHERE run_id = ? AND node_id = ?")
          .run(node.status, JSON.stringify(node), run.id, node.id);
      }
      runs++;
    }
  })();
  return { jobs, runs, reconciledAt: now };
}
