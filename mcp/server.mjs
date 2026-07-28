import readline from "node:readline";
import { doctor, getModels, getRoles, getStatus } from "./lib.mjs";
import { createJob, getJob, getJobResult, getJobs, retryJob } from "./jobs.mjs";
import {
  attestRun, cancelRun, createRun, estimateRun, getPipelineTemplates, getRoutingPolicy,
  getRun, getRunEvents, getRunResult, getRuns, resumeRun
} from "./run-manager.mjs";
import { runtimeStatus, startRuntime, stopRuntime } from "./runtime.mjs";
import { getProviderReadiness } from "./providers.mjs";

const tools = [
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
    description: "Report readiness for the approved Claude, Codex, Cursor, Grok, Qwen, Kimi, Devin, Gemini, DeepSeek, and Cerebras provider set without returning credentials.",
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
        contract: { type: "string", enum: ["text", "json", "html"], default: "text" },
        maxOutputTokens: { type: "integer", minimum: 1, maximum: 64000, default: 4096 },
        timeoutMs: { type: "integer", minimum: 10000, maximum: 1800000, default: 720000 },
        confirmQuota: { type: "boolean", description: "Must be true to authorize provider quota consumption." }
      },
      required: ["prompt", "confirmQuota"],
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
        budget: {
          type: "object",
          properties: {
            maxCalls: { type: "integer", minimum: 1, maximum: 20 },
            maxTotalTokens: { type: "integer", minimum: 1000 },
            maxApiEquivalentUsd: { type: "number", minimum: 0 },
            maxDurationMs: { type: "integer", minimum: 10000 }
          },
          additionalProperties: false
        }
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
        budget: { type: "object", additionalProperties: false, properties: {
          maxCalls: { type: "integer" }, maxTotalTokens: { type: "integer" },
          maxApiEquivalentUsd: { type: "number" }, maxDurationMs: { type: "integer" }
        } },
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
    description: "Record Codex acceptance, rejection, or revision findings. Revision can consume quota.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, verdict: { type: "string", enum: ["accept", "revise", "reject"] },
      findings: { type: "array", items: { type: "string" } }, confirmQuota: { type: "boolean", default: false }
    }, required: ["id", "verdict"], additionalProperties: false }
  },
  {
    name: "omp_run_resume",
    description: "Resume a failed or budget-exceeded run from checkpoints with renewed approval.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, budget: { type: "object" }, confirmBudget: { type: "boolean" }, confirmQuota: { type: "boolean" }
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
  }
];

async function invoke(name, args = {}) {
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
  if (name === "omp_runtime_status") return runtimeStatus();
  if (name === "omp_runtime_start") return startRuntime(args);
  if (name === "omp_runtime_stop") return stopRuntime(args);
  if (name === "omp_job_create") return createJob(args);
  if (name === "omp_job_get") return getJob(args);
  if (name === "omp_job_list") return getJobs(args);
  if (name === "omp_job_result") return getJobResult(args);
  if (name === "omp_job_retry") return retryJob(args);
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
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  try {
    if (request.method === "initialize") {
      result(request.id, {
        protocolVersion: request.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "omp-orchestrator", version: "0.5.0" }
      });
    } else if (request.method === "tools/list") {
      result(request.id, { tools });
    } else if (request.method === "tools/call") {
      const value = await invoke(request.params?.name, request.params?.arguments || {});
      result(request.id, {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
        isError: false
      });
    } else if (request.method === "ping") {
      result(request.id, {});
    } else if (request.id !== undefined) {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (error) {
    if (request.method === "tools/call") {
      result(request.id, {
        content: [{ type: "text", text: error.message }],
        isError: true
      });
    } else {
      send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32603, message: error.message } });
    }
  }
});
