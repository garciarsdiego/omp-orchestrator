import test from "node:test";
import assert from "node:assert/strict";
import { estimateModelCost, sumCosts } from "../mcp/pricing.mjs";

test("known model cost accounts for cached input", () => {
  const cost = estimateModelCost("openai-codex/gpt-5.5", {
    inputTokens: 1000,
    cachedInputTokens: 800,
    outputTokens: 1000
  });
  assert.equal(cost.known, true);
  assert.equal(cost.lowUsd, 0.0314);
});

test("pricing ignores configured reasoning suffixes", () => {
  const cost = estimateModelCost("anthropic/claude-fable-5:medium", { inputTokens: 1000, outputTokens: 1000 });
  assert.equal(cost.known, true);
  assert.ok(Math.abs(cost.lowUsd - 0.06) < 1e-12);
});

test("pricing normalizes max and ultra reasoning suffixes", () => {
  const max = estimateModelCost("anthropic/claude-fable-5:max", { inputTokens: 1000, outputTokens: 1000 });
  const ultra = estimateModelCost("anthropic/claude-fable-5:ultra", { inputTokens: 1000, outputTokens: 1000 });
  assert.equal(max.known, true);
  assert.equal(ultra.known, true);
  assert.equal(max.lowUsd, ultra.lowUsd);
});

test("unknown public price is represented as a range", () => {
  const cost = estimateModelCost("xai-oauth/grok-composer-2.5-fast", { inputTokens: 1000, outputTokens: 1000 });
  assert.equal(cost.known, false);
  assert.equal(cost.lowUsd, 0.003);
  assert.equal(cost.highUsd, 0.008);
  assert.equal(sumCosts([cost]).hasUnknown, true);
});
