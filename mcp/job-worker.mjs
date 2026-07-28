import { extractResponseText, normalizeOutput, requestInference } from "./gateway.mjs";
import {
  getJobConsumptionSummary, readJob, recordConsumptionEvent, recordPolicyEvents, updateJob
} from "./job-store.mjs";
import { evaluateActualUsage } from "./budget.mjs";
import { actualUsageCost } from "./pricing.mjs";

const id = process.argv[2];
if (!id) process.exit(2);

async function run() {
  const initial = readJob(id);
  if (initial.status !== "queued") return;
  updateJob(id, (job) => ({
    ...job,
    status: "running",
    startedAt: new Date().toISOString(),
    workerPid: process.pid,
    error: null
  }));

  try {
    const job = readJob(id);
    const payload = await requestInference({
      model: job.request.model,
      prompt: job.request.prompt,
      reasoning: job.request.reasoning,
      maxOutputTokens: job.request.maxOutputTokens,
      cacheKey: `omp-orchestrator:${job.id}:${job.attempt}`,
      timeoutMs: job.request.timeoutMs,
      shouldCancel: () => ["cancellation_requested", "cancelled"].includes(readJob(id).status)
    });
    const extracted = extractResponseText(payload);
    const normalized = normalizeOutput(extracted, job.request.contract);
    const output = normalized.output;
    const validation = normalized.validation;
    const usage = payload.usage || null;
    const cost = usage ? actualUsageCost(job.request.selector, usage) : null;
    const prior = getJobConsumptionSummary(id);
    const completedAt = new Date().toISOString();
    const durationMs = job.startedAt ? Date.parse(completedAt) - Date.parse(job.startedAt) : 0;
    const policy = evaluateActualUsage({ budget: job.budget, usage, prior, cost, durationMs });
    const hardBreaches = policy.breaches.filter((breach) => breach.enforced);
    const completed = updateJob(id, (current) => ({
      ...current,
      status: current.status === "cancellation_requested"
        ? "cancelled"
        : hardBreaches.length
          ? "limit_exceeded"
          : validation.valid ? "succeeded" : "invalid",
      completedAt,
      output,
      validation,
      normalization: normalized.changed ? { transformation: normalized.transformation } : null,
      usage,
      policy: { aggregate: policy.aggregate, breaches: policy.breaches },
      error: hardBreaches.length
        ? { name: "BudgetExceededError", message: `Actual usage exceeded: ${hardBreaches.map((item) => item.limit).join(", ")}.` }
        : null
    }));
    recordConsumptionEvent(completed, cost);
    recordPolicyEvents(completed, policy.breaches, completed.budget.costPolicy);
  } catch (error) {
    updateJob(id, (job) => ({
      ...job,
      status: error.name === "CancellationError" || job.status === "cancellation_requested"
        ? "cancelled"
        : "failed",
      completedAt: new Date().toISOString(),
      error: { message: error.message, name: error.name || "Error" }
    }));
  }
}

await run();
