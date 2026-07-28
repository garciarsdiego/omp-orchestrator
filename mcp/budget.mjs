import { estimateModelCost } from "./pricing.mjs";

export const COST_POLICIES = new Set(["observe", "enforce", "disabled"]);

export function estimatePromptTokens(prompt) {
  return Math.ceil(Buffer.byteLength(String(prompt || "")) / 4);
}

export function normalizeJobBudget({
  prompt,
  maxOutputTokens = 4096,
  timeoutMs = 720_000,
  budget = {}
} = {}) {
  const inputEstimate = estimatePromptTokens(prompt);
  const maxRetries = Math.max(0, Number(budget.maxRetries ?? 1));
  const normalized = {
    maxCalls: Math.max(1, Number(budget.maxCalls) || maxRetries + 1),
    maxInputTokens: Math.max(1, Number(budget.maxInputTokens) || Math.max(inputEstimate, 128_000)),
    maxOutputTokens: Math.max(1, Number(budget.maxOutputTokens) || maxOutputTokens),
    maxTotalTokens: Math.max(1, Number(budget.maxTotalTokens) || Math.max(inputEstimate + maxOutputTokens, 192_000)),
    maxDurationMs: Math.max(10_000, Number(budget.maxDurationMs) || timeoutMs),
    maxRetries,
    costPolicy: budget.costPolicy || "observe",
    maxApiEquivalentUsd: budget.maxApiEquivalentUsd ?? null
  };
  if (!COST_POLICIES.has(normalized.costPolicy)) {
    throw new Error("costPolicy must be observe, enforce, or disabled.");
  }
  if (
    normalized.costPolicy === "enforce"
    && (!Number.isFinite(normalized.maxApiEquivalentUsd) || normalized.maxApiEquivalentUsd < 0)
  ) throw new Error("enforce costPolicy requires maxApiEquivalentUsd.");
  return normalized;
}

export function estimateJobRequest({ selector, prompt, maxOutputTokens = 4096, timeoutMs = 720_000, budget } = {}) {
  const normalizedBudget = normalizeJobBudget({ prompt, maxOutputTokens, timeoutMs, budget });
  const estimatedInputTokens = estimatePromptTokens(prompt);
  const estimatedOutputTokens = Math.min(maxOutputTokens, normalizedBudget.maxOutputTokens);
  const cost = normalizedBudget.costPolicy === "disabled"
    ? null
    : estimateModelCost(selector, { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens });
  const violations = [];
  if (estimatedInputTokens > normalizedBudget.maxInputTokens) violations.push("maxInputTokens");
  if (estimatedOutputTokens > normalizedBudget.maxOutputTokens) violations.push("maxOutputTokens");
  if (estimatedInputTokens + estimatedOutputTokens > normalizedBudget.maxTotalTokens) violations.push("maxTotalTokens");
  if (normalizedBudget.maxCalls < 1) violations.push("maxCalls");
  if (
    normalizedBudget.costPolicy === "enforce"
    && (cost.highUsd === null || cost.highUsd > normalizedBudget.maxApiEquivalentUsd)
  ) violations.push(cost.highUsd === null ? "priceUnknown" : "maxApiEquivalentUsd");
  return {
    selector,
    budget: normalizedBudget,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    estimatedApiEquivalent: cost,
    allowed: violations.length === 0,
    violations
  };
}

export function assertJobEstimate(estimate) {
  if (!estimate.allowed) {
    const error = new Error(`Job estimate exceeds policy: ${estimate.violations.join(", ")}.`);
    error.name = "BudgetExceededError";
    error.reasons = estimate.violations;
    throw error;
  }
}

export function evaluateActualUsage({ budget, usage, prior = {}, cost, durationMs = 0 } = {}) {
  const aggregate = {
    calls: (prior.calls || 0) + 1,
    inputTokens: (prior.inputTokens || 0) + (usage?.input_tokens || 0),
    outputTokens: (prior.outputTokens || 0) + (usage?.output_tokens || 0),
    totalTokens: (prior.totalTokens || 0) + (usage?.total_tokens || 0),
    equivalentHighUsd: prior.equivalentHighUsd === null || cost?.highUsd === null
      ? null
      : (prior.equivalentHighUsd || 0) + (cost?.highUsd || 0)
  };
  const breaches = [];
  if (aggregate.calls > budget.maxCalls) breaches.push({ limit: "maxCalls", threshold: budget.maxCalls, observed: aggregate.calls, enforced: true });
  if (aggregate.inputTokens > budget.maxInputTokens) breaches.push({ limit: "maxInputTokens", threshold: budget.maxInputTokens, observed: aggregate.inputTokens, enforced: true });
  if (aggregate.outputTokens > budget.maxOutputTokens) breaches.push({ limit: "maxOutputTokens", threshold: budget.maxOutputTokens, observed: aggregate.outputTokens, enforced: true });
  if (aggregate.totalTokens > budget.maxTotalTokens) breaches.push({ limit: "maxTotalTokens", threshold: budget.maxTotalTokens, observed: aggregate.totalTokens, enforced: true });
  if (durationMs > budget.maxDurationMs) {
    breaches.push({ limit: "maxDurationMs", threshold: budget.maxDurationMs, observed: durationMs, enforced: true });
  }
  if (budget.costPolicy === "observe" && aggregate.equivalentHighUsd === null) {
    breaches.push({ limit: "priceUnknown", threshold: budget.maxApiEquivalentUsd, observed: null, enforced: false });
  }
  if (
    budget.costPolicy === "observe"
    && Number.isFinite(budget.maxApiEquivalentUsd)
    && aggregate.equivalentHighUsd !== null
    && aggregate.equivalentHighUsd > budget.maxApiEquivalentUsd
  ) {
    breaches.push({
      limit: "maxApiEquivalentUsd",
      threshold: budget.maxApiEquivalentUsd,
      observed: aggregate.equivalentHighUsd,
      enforced: false
    });
  }
  if (
    budget.costPolicy === "enforce"
    && (aggregate.equivalentHighUsd === null || aggregate.equivalentHighUsd > budget.maxApiEquivalentUsd)
  ) {
    breaches.push({
      limit: aggregate.equivalentHighUsd === null ? "priceUnknown" : "maxApiEquivalentUsd",
      threshold: budget.maxApiEquivalentUsd,
      observed: aggregate.equivalentHighUsd,
      enforced: true
    });
  }
  return { aggregate, breaches };
}
