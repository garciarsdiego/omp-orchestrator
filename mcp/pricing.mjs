const PRICES = {
  "anthropic/claude-fable-5": { input: 10, cachedInput: 1, output: 50, billing: "api_or_credits" },
  "google-antigravity/gemini-3.5-flash": { input: 1.5, cachedInput: 0.15, output: 9, billing: "subscription_or_api" },
  "openai-codex/gpt-5.5": { input: 5, cachedInput: 0.5, output: 30, billing: "subscription_or_credits" },
  "xai-oauth/grok-4.5": { input: 2, cachedInput: 0.2, output: 6, billing: "subscription_or_api" }
};

const RANGES = {
  "xai-oauth/grok-composer-2.5-fast": {
    low: { input: 1, cachedInput: 0.2, output: 2 },
    high: { input: 2, cachedInput: 0.2, output: 6 },
    billing: "subscription_no_public_api_price"
  }
};

function dollars(tokens, rate) {
  return (Number(tokens) || 0) * rate / 1_000_000;
}

function normalizeSelector(selector) {
  return String(selector).replace(/:(?:off|minimal|low|medium|high|xhigh|max|ultra)$/i, "");
}

export function estimateModelCost(selector, { inputTokens = 0, outputTokens = 0, cachedInputTokens = 0 } = {}) {
  const normalized = normalizeSelector(selector);
  const price = PRICES[normalized];
  const uncached = Math.max(0, inputTokens - cachedInputTokens);
  if (price) {
    const value = dollars(uncached, price.input) + dollars(cachedInputTokens, price.cachedInput) + dollars(outputTokens, price.output);
    return { known: true, lowUsd: value, highUsd: value, billing: price.billing };
  }
  const range = RANGES[normalized];
  if (range) {
    const calculate = (entry) => dollars(uncached, entry.input) + dollars(cachedInputTokens, entry.cachedInput) + dollars(outputTokens, entry.output);
    return { known: false, lowUsd: calculate(range.low), highUsd: calculate(range.high), billing: range.billing };
  }
  return { known: false, lowUsd: 0, highUsd: null, billing: "unknown" };
}

export function sumCosts(costs) {
  return costs.reduce((total, cost) => ({
    lowUsd: total.lowUsd + (cost.lowUsd || 0),
    highUsd: total.highUsd === null || cost.highUsd === null ? null : total.highUsd + cost.highUsd,
    hasUnknown: total.hasUnknown || !cost.known || cost.highUsd === null
  }), { lowUsd: 0, highUsd: 0, hasUnknown: false });
}

export function actualUsageCost(selector, usage) {
  return estimateModelCost(selector, {
    inputTokens: usage?.input_tokens || 0,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens || 0,
    outputTokens: usage?.output_tokens || 0
  });
}
