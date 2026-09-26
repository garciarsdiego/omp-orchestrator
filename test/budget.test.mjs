import test from "node:test";
import assert from "node:assert/strict";
import {
  assertJobEstimate, estimateJobRequest, evaluateActualUsage, normalizeJobBudget
} from "../mcp/budget.mjs";

test("observe mode reports unknown equivalent cost without blocking", () => {
  const estimate = estimateJobRequest({
    selector: "unknown/model",
    prompt: "hello",
    maxOutputTokens: 100,
    budget: { costPolicy: "observe", maxTotalTokens: 200 }
  });
  assert.equal(estimate.allowed, true);
  assert.equal(estimate.estimatedApiEquivalent.highUsd, null);
  assert.doesNotThrow(() => assertJobEstimate(estimate));
});

test("enforce mode requires a provable price and ceiling", () => {
  const estimate = estimateJobRequest({
    selector: "unknown/model",
    prompt: "hello",
    maxOutputTokens: 100,
    budget: { costPolicy: "enforce", maxApiEquivalentUsd: 1 }
  });
  assert.equal(estimate.allowed, false);
  assert.throws(() => assertJobEstimate(estimate), /priceUnknown/);
});

test("hard token limits remain enforced after provider usage exceeds the request", () => {
  const budget = normalizeJobBudget({
    prompt: "hello",
    maxOutputTokens: 3000,
    budget: {
      maxInputTokens: 1000,
      maxOutputTokens: 3000,
      maxTotalTokens: 4000,
      costPolicy: "observe"
    }
  });
  const evaluated = evaluateActualUsage({
    budget,
    usage: { input_tokens: 318, output_tokens: 3077, total_tokens: 3395 },
    prior: {},
    cost: { highUsd: 0.02 }
  });
  assert.ok(evaluated.breaches.some((item) => item.limit === "maxOutputTokens" && item.enforced));
});

test("retry and call allowances are explicit", () => {
  const budget = normalizeJobBudget({ prompt: "hello", budget: { maxRetries: 2 } });
  assert.equal(budget.maxRetries, 2);
  assert.equal(budget.maxCalls, 3);
});

test("actual wall-clock duration is a hard post-call limit", () => {
  const budget = normalizeJobBudget({
    prompt: "hello",
    timeoutMs: 10_000,
    budget: { maxDurationMs: 10_000 }
  });
  const evaluated = evaluateActualUsage({
    budget,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    durationMs: 10_001,
    cost: { highUsd: 0 }
  });
  assert.ok(evaluated.breaches.some((item) => item.limit === "maxDurationMs" && item.enforced));
});

test("zero remaining limits stay zero instead of restoring defaults", () => {
  const budget = normalizeJobBudget({
    prompt: "hello",
    maxOutputTokens: 100,
    budget: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxTotalTokens: 0, maxDurationMs: 0 }
  });
  assert.deepEqual(
    [budget.maxCalls, budget.maxInputTokens, budget.maxOutputTokens, budget.maxTotalTokens, budget.maxDurationMs],
    [0, 0, 0, 0, 0]
  );
  assert.equal(estimateJobRequest({ selector: "xai-oauth/grok-4.5", prompt: "hello", maxOutputTokens: 1, budget }).allowed, false);
});

test("enforce fails closed when a provider omits usage telemetry", () => {
  const budget = normalizeJobBudget({
    prompt: "hello", maxOutputTokens: 10,
    budget: { costPolicy: "enforce", maxApiEquivalentUsd: 1 }
  });
  const evaluated = evaluateActualUsage({ budget, usage: null, prior: {}, cost: null });
  assert.ok(evaluated.breaches.some((item) => item.limit === "priceUnknown" && item.enforced));
});
