import { doctor, getModels, getRoles, getStatus } from "./lib.mjs";
import { cancelJob, createJob, estimateJob, getJob, getJobResult, getJobs, retryJob } from "./jobs.mjs";
import {
  attestRun, cancelRun, createRun, estimateRun, getPipelineTemplates, getRoutingPolicy,
  getRun, getRunEvents, getRunResult, getRuns, resumeRun
} from "./run-manager.mjs";
import { runtimeStatus, startRuntime, stopRuntime } from "./runtime.mjs";
import { getProviderReadiness } from "./providers.mjs";
import { reconcileInterruptedWork } from "./recovery.mjs";
import { storageStatus } from "./storage.mjs";
import { loadPricingRegistry, pricingCoverage } from "./pricing.mjs";
import { readArtifact } from "./run-store.mjs";
import {
  abortAgentJob, createAgentJob, getAgentEvents, getAgentJob, getAgentResult,
  listAgentBackends, listAgentJobs, steerAgentJob
} from "./agent-jobs.mjs";
import { AUDITED_OPERATIONS, listAudit, recordAudit } from "./audit.mjs";
import { collectMetrics } from "./metrics.mjs";

export const startupRecovery = reconcileInterruptedWork();

const RUN_BUDGET_SCHEMA = {
  type: "object", additionalProperties: false, properties: {
    maxCalls: { type: "integer", minimum: 1, maximum: 20 },
    maxTotalTokens: { type: "integer", minimum: 1 },
    costPolicy: { type: "string", enum: ["observe", "enforce", "disabled"] },
    maxApiEquivalentUsd: { type: "number", minimum: 0 },
    maxDurationMs: { type: "integer", minimum: 10000, maximum: 7200000 }
  }
};

export const tools = [
  {
    name: "omp_status",
    description: "Detect the installed OMP version, executable, and active config path without reading secrets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_doctor",
    description: "Run safe read-only checks for OMP, configured roles, and the model catalog.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_roles",
    description: "Return OMP model-role selectors through the public configuration CLI.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_models",
    description: "Search OMP's model catalog. Results are capped to keep tool output bounded.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Exact provider id." },
        query: { type: "string", description: "Case-insensitive substring." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      },
      additionalProperties: false
    }
  },
  {
    name: "omp_providers",
    description: "Report catalog availability for every OMP provider plus the legacy ten-provider grouping; operational reachability is unknown.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_storage_status",
    description: "Report durable SQLite/WAL storage configuration and startup reconciliation counts without returning stored content.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_pricing_coverage",
    description: "Report versioned pricing coverage, provenance, confidence, and staleness for active OMP roles.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_runtime_status",
    description: "Inspect the managed local broker and authenticated gateway without returning bearer tokens.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_runtime_start",
    description: "Start a managed OMP broker on 127.0.0.1:9000 and authenticated gateway on 127.0.0.1:4000.",
    inputSchema: {
      type: "object",
      properties: { confirm: { type: "boolean", description: "Must be true to start background processes." } },
      required: ["confirm"],
      additionalProperties: false
    }
  },
  {
    name: "omp_runtime_stop",
    description: "Stop only the OMP broker and gateway processes started by this plugin.",
    inputSchema: {
      type: "object",
      properties: { confirm: { type: "boolean", description: "Must be true to stop managed processes." } },
      required: ["confirm"],
      additionalProperties: false
    }
  },
  {
    name: "omp_job_create",
    description: "Create an asynchronous inference job using a configured OMP role. Always consumes provider quota.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Configured OMP role. Mutually exclusive with selector." },
        selector: { type: "string", description: "Exact available provider/model selector. Mutually exclusive with role." },
        prompt: { type: "string", description: "Complete bounded prompt for the delegated model." },
        contract: { type: "string", enum: ["text", "notes", "json", "html", "standalone_html", "review_json"], default: "text" },
        maxOutputTokens: { type: "integer", minimum: 1, maximum: 64000, default: 4096 },
        timeoutMs: { type: "integer", minimum: 10000, maximum: 1800000, default: 720000 },
        budget: { type: "object", additionalProperties: false, properties: {
          maxCalls: { type: "integer", minimum: 1 },
          maxInputTokens: { type: "integer", minimum: 1 },
          maxOutputTokens: { type: "integer", minimum: 1 },
          maxTotalTokens: { type: "integer", minimum: 1 },
          maxDurationMs: { type: "integer", minimum: 10000 },
          maxRetries: { type: "integer", minimum: 0 },
          costPolicy: { type: "string", enum: ["observe", "enforce", "disabled"] },
          maxApiEquivalentUsd: { type: "number", minimum: 0 }
        } },
        confirmQuota: { type: "boolean", description: "Must be true to authorize provider quota consumption." }
      },
      required: ["prompt", "confirmQuota"],
      oneOf: [{ required: ["role"] }, { required: ["selector"] }],
      additionalProperties: false
    }
  },
  {
    name: "omp_job_estimate",
    description: "Estimate standalone job tokens and API-equivalent cost against a consumption policy without using provider quota.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string" },
        selector: { type: "string" },
        prompt: { type: "string" },
        maxOutputTokens: { type: "integer", minimum: 1, maximum: 64000, default: 4096 },
        timeoutMs: { type: "integer", minimum: 10000, maximum: 1800000, default: 720000 },
        budget: { type: "object" }
      },
      required: ["prompt"],
      oneOf: [{ required: ["role"] }, { required: ["selector"] }],
      additionalProperties: false
    }
  },
  {
    name: "omp_job_get",
    description: "Read inference job status and metadata without returning its prompt or output by default.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        includeOutput: { type: "boolean", default: false }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "omp_job_list",
    description: "List recent inference jobs with bounded metadata and no prompt/output bodies.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
      additionalProperties: false
    }
  },
  {
    name: "omp_job_result",
    description: "Return the completed output, validation result, and usage for one inference job.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "omp_job_retry",
    description: "Retry only a failed or contract-invalid job. This consumes provider quota again.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        confirmQuota: { type: "boolean", description: "Must be true to authorize another provider call." }
      },
      required: ["id", "confirmQuota"],
      additionalProperties: false
    }
  },
  {
    name: "omp_job_cancel",
    description: "Request cancellation and stop the recorded worker process for a queued or running job.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        confirm: { type: "boolean" },
        graceMs: { type: "integer", minimum: 0, maximum: 5000, default: 1000 }
      },
      required: ["id", "confirm"],
      additionalProperties: false
    }
  },
  {
    name: "omp_pipeline_templates",
    description: "List built-in allowlisted pipeline templates and their default budgets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_routing_policy",
    description: "Inspect model/transport compatibility rules used by the run executor.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_run_estimate",
    description: "Estimate calls, tokens, and API-equivalent USD before creating a run. Does not consume quota.",
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", default: "single-file-web-app" },
        input: { type: "string" },
        budget: RUN_BUDGET_SCHEMA
      },
      required: ["input"],
      additionalProperties: false
    }
  },
  {
    name: "omp_run_create",
    description: "Create an isolated persistent DAG run after explicit budget and quota approval.",
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", default: "single-file-web-app" },
        input: { type: "string" },
        budget: RUN_BUDGET_SCHEMA,
        confirmBudget: { type: "boolean" },
        confirmQuota: { type: "boolean" }
      },
      required: ["input", "confirmBudget", "confirmQuota"],
      additionalProperties: false
    }
  },
  {
    name: "omp_run_get",
    description: "Read run status, DAG nodes, usage, artifacts, validation, and attestation metadata.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
  },
  {
    name: "omp_run_list",
    description: "List recent isolated runs without prompts or artifact bodies.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, additionalProperties: false }
  },
  {
    name: "omp_run_events",
    description: "Read append-only lifecycle events for a run.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, after: { type: "integer", minimum: 0, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 500, default: 100 }
    }, required: ["id"], additionalProperties: false }
  },
  {
    name: "omp_run_attest",
    description: "Record review of the exact artifact SHA-256. Revision can consume quota.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, verdict: { type: "string", enum: ["accept", "revise", "reject"] },
      findings: { type: "array", items: { type: "string" } }, expectedArtifactSha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
      confirmQuota: { type: "boolean", default: false }
    }, required: ["id", "verdict", "expectedArtifactSha256"], additionalProperties: false }
  },
  {
    name: "omp_run_resume",
    description: "Resume a failed or budget-exceeded run from checkpoints with renewed approval.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, budget: RUN_BUDGET_SCHEMA, confirmBudget: { type: "boolean" }, confirmQuota: { type: "boolean" }
    }, required: ["id", "confirmBudget", "confirmQuota"], additionalProperties: false }
  },
  {
    name: "omp_run_cancel",
    description: "Cancel only the run worker and provider jobs recorded under one run.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, confirm: { type: "boolean" } }, required: ["id", "confirm"], additionalProperties: false }
  },
  {
    name: "omp_run_result",
    description: "Return the final artifact and complete provenance for an accepted run.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
  },
  {
    name: "omp_run_artifact",
    description: "Read a named run artifact for review as text, including before acceptance. Never executes it.",
    inputSchema: {
      type: "object", properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"], additionalProperties: false
    }
  },
  {
    name: "omp_agent_backends",
    description: "List administrator-configured execution backends and their actual capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "omp_agent_create",
    description: "Start an OMP RPC agent or a configured headless CLI in a named workspace. May use provider quota and tools.",
    inputSchema: { type: "object", properties: {
      backend: { type: "string" }, workspace: { type: "string" }, prompt: { type: "string" },
      timeoutMs: { type: "integer", minimum: 10000, maximum: 1800000 },
      idempotencyKey: { type: "string", minLength: 8 },
      confirmQuota: { type: "boolean" }
    }, required: ["backend", "workspace", "prompt", "idempotencyKey", "confirmQuota"], additionalProperties: false }
  },
  {
    name: "omp_agent_get",
    description: "Inspect an agent job without returning its prompt or output body.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
  },
  {
    name: "omp_agent_list",
    description: "List recent agent jobs without prompt or output bodies.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false }
  },
  {
    name: "omp_agent_events",
    description: "Read bounded, sanitized agent lifecycle events with a cursor.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, after: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 }
    }, required: ["id"], additionalProperties: false }
  },
  {
    name: "omp_agent_result",
    description: "Read the final text and telemetry of a completed agent job.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
  },
  {
    name: "omp_agent_steer",
    description: "Queue a follow-up instruction for an active OMP RPC agent. Not supported by one-shot CLI backends.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, message: { type: "string" } },
      required: ["id", "message"], additionalProperties: false }
  },
  {
    name: "omp_agent_abort",
    description: "Request cancellation of an active agent job.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, confirm: { type: "boolean" } },
      required: ["id", "confirm"], additionalProperties: false }
  },
  {
    name: "omp_audit_list",
    description: "List recent state-changing operations with actor, mechanism, target and outcome (no arguments are stored).",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 } },
      additionalProperties: false }
  },
  {
    name: "omp_metrics",
    description: "Operational metrics as JSON: jobs and runs by status, consumption totals, audit outcomes, agent supervisor and HTTP counters.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

/**
 * Every transport (stdio/HTTP MCP, HTTP API, CLI) dispatches here, so audit
 * of state-changing operations lives in the core rather than per interface.
 */
export async function invoke(name, args = {}) {
  if (!AUDITED_OPERATIONS.has(name)) return dispatch(name, args);
  try {
    const result = await dispatch(name, args);
    recordAudit({ operation: name, targetId: args.id || result?.id || null, outcome: "ok" });
    return result;
  } catch (error) {
    recordAudit({ operation: name, targetId: args.id || null, outcome: "error", errorName: error?.name || "Error" });
    throw error;
  }
}

async function dispatch(name, args) {
  if (name === "omp_status") return getStatus();
  if (name === "omp_doctor") return doctor();
  if (name === "omp_roles") return getRoles();
  if (name === "omp_models") {
    return getModels({
      provider: args.provider,
      query: args.query,
      limit: Math.max(1, Math.min(200, Number(args.limit) || 50))
    });
  }
  if (name === "omp_providers") return getProviderReadiness();
  if (name === "omp_storage_status") return { ...storageStatus(), startupRecovery };
  if (name === "omp_pricing_coverage") {
    const registry = loadPricingRegistry();
    const coverage = pricingCoverage(getRoles(), { registry });
    return {
      revision: registry.revision,
      digest: registry.digest,
      currency: registry.currency,
      roles: coverage,
      summary: {
        total: coverage.length,
        known: coverage.filter((item) => item.status !== "unknown").length,
        unknown: coverage.filter((item) => item.status === "unknown").length,
        stale: coverage.filter((item) => item.stale).length
      }
    };
  }
  if (name === "omp_runtime_status") return runtimeStatus();
  if (name === "omp_runtime_start") return startRuntime(args);
  if (name === "omp_runtime_stop") return stopRuntime(args);
  if (name === "omp_job_create") return createJob(args);
  if (name === "omp_job_estimate") return estimateJob(args);
  if (name === "omp_job_get") return getJob(args);
  if (name === "omp_job_list") return getJobs(args);
  if (name === "omp_job_result") return getJobResult(args);
  if (name === "omp_job_retry") return retryJob(args);
  if (name === "omp_job_cancel") return cancelJob(args);
  if (name === "omp_pipeline_templates") return getPipelineTemplates();
  if (name === "omp_routing_policy") return getRoutingPolicy();
  if (name === "omp_run_estimate") return estimateRun(args);
  if (name === "omp_run_create") return createRun(args);
  if (name === "omp_run_get") return getRun(args);
  if (name === "omp_run_list") return getRuns(args);
  if (name === "omp_run_events") return getRunEvents(args);
  if (name === "omp_run_attest") return attestRun(args);
  if (name === "omp_run_resume") return resumeRun(args);
  if (name === "omp_run_cancel") return cancelRun(args);
  if (name === "omp_run_result") return getRunResult(args);
  if (name === "omp_run_artifact") {
    const body = readArtifact(args.id, args.name);
    if (Buffer.byteLength(body) > 2_000_000) throw new Error("Artifact exceeds the 2 MB review limit.");
    return { id: args.id, name: args.name, body };
  }
  if (name === "omp_agent_backends") return listAgentBackends();
  if (name === "omp_agent_create") return createAgentJob(args);
  if (name === "omp_agent_get") return getAgentJob(args);
  if (name === "omp_agent_list") return listAgentJobs(args);
  if (name === "omp_agent_events") return getAgentEvents(args);
  if (name === "omp_agent_result") return getAgentResult(args);
  if (name === "omp_agent_steer") return steerAgentJob(args);
  if (name === "omp_agent_abort") return abortAgentJob(args);
  if (name === "omp_audit_list") return listAudit(args);
  if (name === "omp_metrics") return collectMetrics();
  throw new Error(`Unknown tool: ${name}`);
}
