import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateModelCost, pricingCoverage, resolvePricing, sumCosts, validatePricingRegistry
} from "../mcp/pricing.mjs";

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

test("registry resolves exact, longest family, proxy, and unknown deterministically", () => {
  const registry = validatePricingRegistry({
    schemaVersion: 1,
    revision: "test",
    currency: "USD",
    staleAfterDays: 90,
    entries: [
      { match: "family", family: "p/model", billingMode: "subscription", confidence: "approximate", effectiveDate: "2026-07-01", source: "test", rates: { input: 1, cachedInput: 0.1, output: 2 } },
      { match: "family", family: "p/model-pro", billingMode: "subscription", confidence: "exact", effectiveDate: "2026-07-01", source: "test", rates: { input: 2, cachedInput: 0.2, output: 4 } },
      { match: "exact", selector: "p/exact", billingMode: "subscription", confidence: "exact", effectiveDate: "2026-07-01", source: "test", rates: { input: 3, cachedInput: 0.3, output: 6 } },
      { match: "proxy", selector: "p/alias", proxyFor: "p/exact", billingMode: "subscription", confidence: "approximate", effectiveDate: "2026-07-01", source: "test" }
    ]
  });
  assert.equal(resolvePricing("p/exact", { registry, now: new Date("2026-07-02") }).matchTier, "exact");
  assert.equal(resolvePricing("p/model-pro-v2", { registry, now: new Date("2026-07-02") }).confidence, "exact");
  assert.equal(resolvePricing("p/alias", { registry, now: new Date("2026-07-02") }).proxyFor, "p/exact");
  assert.equal(resolvePricing("p/missing", { registry, now: new Date("2026-07-02") }).status, "unknown");
});

test("coverage preserves stale and unknown pricing instead of treating it as zero", () => {
  const registry = validatePricingRegistry({
    schemaVersion: 1,
    revision: "test",
    currency: "USD",
    staleAfterDays: 1,
    entries: [
      { match: "exact", selector: "p/old", billingMode: "subscription", confidence: "exact", effectiveDate: "2026-01-01", source: "test", rates: { input: 1, cachedInput: 0.1, output: 2 } }
    ]
  });
  const coverage = pricingCoverage({ old: "p/old", missing: "p/missing" }, { registry, now: new Date("2026-07-28") });
  assert.equal(coverage[0].stale, true);
  assert.equal(coverage[1].status, "unknown");
});
