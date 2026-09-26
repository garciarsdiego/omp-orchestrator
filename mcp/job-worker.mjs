import { extractResponseText, normalizeOutput, parseRoleSelector, requestInference } from "./gateway.mjs";
import {
  finalizeJobWithLedger, getJobConsumptionSummary, readJob, updateJob
} from "./job-store.mjs";
import { evaluateActualUsage } from "./budget.mjs";
import { actualUsageCost } from "./pricing.mjs";
import { workerProcess } from "./process-identity.mjs";
import { scanForSecrets } from "./security.mjs";

const invokedAsWorker = process.argv[1]?.endsWith("job-worker.mjs");
const id = invokedAsWorker ? process.argv[2] : null;

export function guardedInferenceOutput(output, contract, originalValidation) {
  const blocked = scanForSecrets(output);
  return blocked.length
    ? { output: null, blocked,
        validation: { valid: false, contract, errors: [`Output matched blocked secret patterns: ${blocked.join(", ")}.`] } }
    : { output, blocked, validation: originalValidation };
}

export function gatewayModelForJob(job) {
  const selector = job?.request?.selector;
  if (selector) {
    const { provider, model } = parseRoleSelector(selector);
    return `${provider}/${model}`;
  }
  if (job?.request?.provider && job?.request?.model) return `${job.request.provider}/${job.request.model}`;
  throw new Error("Job has no provider-qualified selector.");
}

async function run() {
  const initial = readJob(id);
  if (initial.status !== "queued") return;
  updateJob(id, (job) => ({
    ...job,
    status: "running",
    startedAt: new Date().toISOString(),
    ...workerProcess(process.pid),
    error: null
  }));

  try {
    const job = readJob(id);
    const payload = await requestInference({
      model: gatewayModelForJob(job),
      prompt: job.request.prompt,
      reasoning: job.request.reasoning,
      maxOutputTokens: job.request.maxOutputTokens,
      cacheKey: `omp-orchestrator:${job.id}:${job.attempt}`,
      timeoutMs: job.request.timeoutMs,
      shouldCancel: () => ["cancellation_requested", "cancelled"].includes(readJob(id).status)
        || (job.deadlineAt && Date.now() >= Date.parse(job.deadlineAt))
    });
    const extracted = extractResponseText(payload);
    const normalized = normalizeOutput(extracted, job.request.contract);
    const { blocked, output, validation } = guardedInferenceOutput(normalized.output, job.request.contract, normalized.validation);
    const usage = payload.usage || null;
    const cost = usage ? actualUsageCost(job.request.selector, usage) : null;
    const prior = getJobConsumptionSummary(id);
    const completedAt = new Date().toISOString();
    const durationMs = job.startedAt ? Date.parse(completedAt) - Date.parse(job.startedAt) : 0;
    const policy = evaluateActualUsage({ budget: job.budget, usage, prior, cost, durationMs });
    const hardBreaches = policy.breaches.filter((breach) => breach.enforced);
    const completed = finalizeJobWithLedger(id, (current) => ({
      ...current,
      status: current.status === "cancellation_requested"
        ? "cancelled"
        : hardBreaches.length
          ? "limit_exceeded"
          : validation.valid ? "succeeded" : "invalid",
      completedAt,
      output,
      validation,
      normalization: normalized.changed && !blocked.length ? { transformation: normalized.transformation } : null,
      usage,
      policy: { aggregate: policy.aggregate, breaches: policy.breaches },
      error: blocked.length
        ? { name: "SecretPatternError", message: "Output was blocked before persistence." }
        : hardBreaches.length
        ? { name: "BudgetExceededError", message: `Actual usage exceeded: ${hardBreaches.map((item) => item.limit).join(", ")}.` }
        : null
    }), { cost, breaches: policy.breaches, mode: job.budget.costPolicy });
  } catch (error) {
    updateJob(id, (job) => ({
      ...job,
      status: error.name === "CancellationError" || job.status === "cancellation_requested"
        ? "cancelled"
        : "failed",
      completedAt: new Date().toISOString(),
      error: { message: scanForSecrets(error.message).length ? "Provider error contained blocked secret patterns." : error.message,
        name: error.name || "Error" }
    }));
  }
}

if (!id) {
  if (invokedAsWorker) process.exitCode = 2;
} else {
  await run();
}
