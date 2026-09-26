import test from "node:test";
import assert from "node:assert/strict";
import { createJob, remainingRetryBudget, resolveJobTarget, retryJob } from "../mcp/jobs.mjs";
import { gatewayModelForJob, guardedInferenceOutput } from "../mcp/job-worker.mjs";
import { assertJobEstimate } from "../mcp/budget.mjs";

test("job creation requires explicit quota confirmation before any runtime check", async () => {
  await assert.rejects(
    () => createJob({ role: "task", prompt: "hello", confirmQuota: false }),
    /confirmQuota=true/
  );
});

test("job creation requires exactly one role or selector", async () => {
  await assert.rejects(
    () => createJob({ prompt: "hello", confirmQuota: true }),
    /exactly one target/
  );
  await assert.rejects(
    () => createJob({ role: "task", selector: "xai-oauth/grok-4.5", prompt: "hello", confirmQuota: true }),
    /exactly one target/
  );
});

test("direct selector resolution validates availability without a runtime or provider call", () => {
  const models = [{ provider: "cursor", id: "cursor-grok-4.5-low-fast" }];
  assert.deepEqual(
    resolveJobTarget({
      requestedSelector: "cursor/cursor-grok-4.5-low-fast",
      models
    }),
    {
      selector: "cursor/cursor-grok-4.5-low-fast",
      parsed: {
        provider: "cursor",
        model: "cursor-grok-4.5-low-fast",
        reasoning: null
      }
    }
  );
  assert.throws(
    () => resolveJobTarget({ requestedSelector: "cursor/not-available", models }),
    /not currently available/
  );
});

test("job retry requires renewed quota confirmation", async () => {
  await assert.rejects(
    () => retryJob({ id: "00000000-0000-0000-0000-000000000000", confirmQuota: false }),
    /confirmQuota=true/
  );
});

test("blocked secret patterns are excluded from inference output and error evidence", () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const guarded = guardedInferenceOutput(`The model returned ${secret}`, "text", { valid: true, contract: "text", errors: [] });
  assert.equal(guarded.output, null);
  assert.equal(guarded.validation.valid, false);
  assert.equal(JSON.stringify(guarded).includes(secret), false);
});

test("retry with an exhausted token allowance stays blocked", () => {
  const result = remainingRetryBudget({
    budget: { maxCalls: 2, maxInputTokens: 100, maxOutputTokens: 50, maxTotalTokens: 150, maxDurationMs: 10_000, maxRetries: 1, costPolicy: "disabled" },
    attempts: [{ usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }],
    request: { selector: "xai-oauth/grok-4.5", prompt: "hello", maxOutputTokens: 50, timeoutMs: 10_000 }
  });
  assert.equal(result.remaining.maxTotalTokens, 0);
  assert.equal(result.nextEstimate.allowed, false);
  assert.throws(() => assertJobEstimate(result.nextEstimate), /maxInputTokens|maxOutputTokens|maxTotalTokens/);
});

test("worker sends a provider-qualified model to the gateway without inference", () => {
  assert.equal(
    gatewayModelForJob({ request: { selector: "provider-a/shared-model:high", provider: "provider-a", model: "shared-model" } }),
    "provider-a/shared-model"
  );
});
