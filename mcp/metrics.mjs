import { readFileSync } from "node:fs";
import { agentSupervisorStatus } from "./agent-jobs.mjs";
import { getDatabase, storageStatus } from "./storage.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const STARTED_AT = Date.now();

// Process-local HTTP counters; the HTTP server increments them.
const http = { requests: new Map(), authFailures: 0 };

export function countHttpRequest(status) {
  const codeClass = `${Math.floor(status / 100)}xx`;
  http.requests.set(codeClass, (http.requests.get(codeClass) || 0) + 1);
}

export function countAuthFailure() { http.authFailures += 1; }

/** Operational snapshot read from SQLite plus process counters. No secrets, prompts or outputs. */
export function collectMetrics() {
  const db = getDatabase();
  const jobs = db.prepare(`
    SELECT CASE WHEN json_extract(payload, '$.backend') IS NULL THEN 'inference' ELSE 'agent' END AS kind,
      status, COUNT(*) AS count
    FROM jobs GROUP BY kind, status ORDER BY kind, status
  `).all();
  const runs = db.prepare("SELECT status, COUNT(*) AS count FROM runs GROUP BY status ORDER BY status").all();
  const consumption = db.prepare(`
    SELECT COUNT(*) AS events, COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(total_tokens), 0) AS totalTokens,
      SUM(CASE WHEN pricing_status = 'unknown' THEN 1 ELSE 0 END) AS unknownPricing
    FROM consumption_events
  `).get();
  const audit = db.prepare("SELECT outcome, COUNT(*) AS count FROM audit_events GROUP BY outcome ORDER BY outcome").all();
  const supervisor = agentSupervisorStatus();
  const storage = storageStatus();
  const lastSeen = supervisor.lastSeenAt ? Date.parse(supervisor.lastSeenAt) : NaN;
  return {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    storage: { schemaVersion: storage.schemaVersion, journalMode: storage.journalMode },
    jobs,
    runs,
    consumption,
    audit,
    agentSupervisor: {
      mode: supervisor.mode,
      ready: supervisor.ready,
      heartbeatAgeSeconds: Number.isFinite(lastSeen) ? Math.max(0, (Date.now() - lastSeen) / 1000) : null
    },
    http: {
      requests: [...http.requests].sort().map(([codeClass, count]) => ({ codeClass, count })),
      authFailures: http.authFailures
    }
  };
}

function label(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Prometheus text exposition format 0.0.4. */
export function renderPrometheus(metrics) {
  const lines = [];
  const family = (name, type, help, samples) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      const rendered = Object.entries(labels).map(([key, item]) => `${key}="${label(item)}"`).join(",");
      lines.push(`${name}${rendered ? `{${rendered}}` : ""} ${value}`);
    }
  };
  family("omp_orchestrator_info", "gauge", "Build and schema information.",
    [[{ version: metrics.version, schema_version: metrics.storage.schemaVersion }, 1]]);
  family("omp_orchestrator_uptime_seconds", "gauge", "Seconds since this HTTP process started.",
    [[{}, metrics.uptimeSeconds]]);
  family("omp_orchestrator_jobs", "gauge", "Jobs currently stored, by kind and status.",
    metrics.jobs.map((row) => [{ kind: row.kind, status: row.status }, row.count]));
  family("omp_orchestrator_runs", "gauge", "Runs currently stored, by status.",
    metrics.runs.map((row) => [{ status: row.status }, row.count]));
  family("omp_orchestrator_consumption_events_total", "counter", "Recorded provider consumption events.",
    [[{}, metrics.consumption.events]]);
  family("omp_orchestrator_tokens_total", "counter", "Recorded tokens, by direction.", [
    [{ direction: "input" }, metrics.consumption.inputTokens],
    [{ direction: "output" }, metrics.consumption.outputTokens]
  ]);
  family("omp_orchestrator_consumption_unknown_pricing_total", "counter", "Consumption events without known pricing.",
    [[{}, metrics.consumption.unknownPricing || 0]]);
  family("omp_orchestrator_audit_events_total", "counter", "Audited state-changing operations, by outcome.",
    metrics.audit.map((row) => [{ outcome: row.outcome }, row.count]));
  family("omp_orchestrator_agent_supervisor_ready", "gauge", "1 when agent dispatch is ready.",
    [[{ mode: metrics.agentSupervisor.mode }, metrics.agentSupervisor.ready ? 1 : 0]]);
  if (metrics.agentSupervisor.heartbeatAgeSeconds !== null) {
    family("omp_orchestrator_agent_supervisor_heartbeat_age_seconds", "gauge", "Age of the external supervisor heartbeat.",
      [[{}, metrics.agentSupervisor.heartbeatAgeSeconds.toFixed(3)]]);
  }
  family("omp_orchestrator_http_requests_total", "counter", "HTTP responses since start, by status class.",
    metrics.http.requests.map((row) => [{ code_class: row.codeClass }, row.count]));
  family("omp_orchestrator_http_auth_failures_total", "counter", "Rejected bearer tokens since start.",
    [[{}, metrics.http.authFailures]]);
  return `${lines.join("\n")}\n`;
}
