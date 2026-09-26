import { currentActor } from "./request-context.mjs";
import { getDatabase } from "./storage.mjs";

/** Operations that change state, start processes or may consume quota. */
export const AUDITED_OPERATIONS = new Set([
  "omp_runtime_start", "omp_runtime_stop",
  "omp_job_create", "omp_job_retry", "omp_job_cancel",
  "omp_run_create", "omp_run_attest", "omp_run_resume", "omp_run_cancel",
  "omp_agent_create", "omp_agent_steer", "omp_agent_abort"
]);

const TARGET = /^[A-Za-z0-9._:-]{1,128}$/;

export function recordAudit({ operation, targetId = null, outcome, errorName = null }) {
  const actor = currentActor();
  getDatabase().prepare(`
    INSERT INTO audit_events(at, actor, mechanism, operation, target_id, outcome, error_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(), actor.name, actor.mechanism, operation,
    typeof targetId === "string" && TARGET.test(targetId) ? targetId : null,
    outcome, typeof errorName === "string" ? errorName.slice(0, 64) : null
  );
}

export function listAudit({ limit = 50 } = {}) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 50));
  const items = getDatabase().prepare(`
    SELECT at, actor, mechanism, operation, target_id AS targetId, outcome, error_name AS errorName
    FROM audit_events ORDER BY id DESC LIMIT ?
  `).all(bounded);
  return { items };
}
