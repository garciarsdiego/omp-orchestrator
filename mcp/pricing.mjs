import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_PATH = process.env.OMP_ORCHESTRATOR_PRICING_REGISTRY
  || path.join(HERE, "..", "config", "pricing-registry.json");

let cachedRegistry;

function dollars(tokens, rate) {
  return (Number(tokens) || 0) * rate / 1_000_000;
}

export function normalizeSelector(selector) {
  return String(selector).replace(/:(?:off|minimal|low|medium|high|xhigh|max|ultra)$/i, "");
}

export function validatePricingRegistry(registry) {
  if (!registry || registry.schemaVersion !== 1) throw new Error("Unsupported pricing registry schemaVersion.");
  if (!registry.revision || !registry.currency || !Array.isArray(registry.entries)) {
    throw new Error("Pricing registry requires revision, currency, and entries.");
  }
  const exact = new Set();
  for (const [index, entry] of registry.entries.entries()) {
    if (!["exact", "family", "range", "proxy"].includes(entry.match)) {
      throw new Error(`Pricing entry ${index} has an unsupported match type.`);
    }
    if (!entry.effectiveDate || !entry.source || !entry.confidence || !entry.billingMode) {
      throw new Error(`Pricing entry ${index} is missing provenance fields.`);
    }
    if (entry.match === "exact") {
      if (!entry.selector || exact.has(entry.selector)) throw new Error(`Duplicate or missing exact selector at entry ${index}.`);
      exact.add(entry.selector);
    }
    if (entry.match === "family" && !entry.family) throw new Error(`Family entry ${index} requires family.`);
    if (entry.match === "range" && (!Array.isArray(entry.selectors) || !entry.selectors.length)) {
      throw new Error(`Range entry ${index} requires selectors.`);
    }
    if (entry.match === "proxy" && (!entry.selector || !entry.proxyFor)) {
      throw new Error(`Proxy entry ${index} requires selector and proxyFor.`);
    }
    const rateSets = [entry.rates, entry.lowRates, entry.highRates].filter(Boolean);
    if (entry.match !== "proxy" && !rateSets.length) throw new Error(`Pricing entry ${index} requires rates.`);
    for (const rates of rateSets) {
      for (const key of ["input", "cachedInput", "output"]) {
        if (!Number.isFinite(rates[key]) || rates[key] < 0) throw new Error(`Pricing entry ${index} has invalid ${key} rate.`);
      }
    }
  }
  return registry;
}

export function loadPricingRegistry(file = DEFAULT_REGISTRY_PATH) {
  if (cachedRegistry && file === DEFAULT_REGISTRY_PATH) return cachedRegistry;
  const text = readFileSync(file, "utf8");
  const registry = validatePricingRegistry(JSON.parse(text));
  const loaded = {
    ...registry,
    digest: createHash("sha256").update(text).digest("hex"),
    loadedFrom: file
  };
  if (file === DEFAULT_REGISTRY_PATH) cachedRegistry = loaded;
  return loaded;
}

function globMatch(value, pattern) {
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

function stale(entry, registry, now) {
  const days = entry.staleAfterDays ?? registry.staleAfterDays ?? 90;
  return now.getTime() - Date.parse(`${entry.effectiveDate}T00:00:00Z`) > days * 86_400_000;
}

export function resolvePricing(selector, { registry = loadPricingRegistry(), now = new Date(), seen = new Set() } = {}) {
  const normalized = normalizeSelector(selector);
  let entry = registry.entries.find((item) => item.match === "exact" && item.selector === normalized);
  let tier = "exact";
  if (!entry) {
    const families = registry.entries
      .filter((item) => item.match === "family" && normalized.startsWith(item.family))
      .sort((a, b) => b.family.length - a.family.length);
    entry = families[0];
    tier = "family";
  }
  if (!entry) {
    entry = registry.entries.find((item) => item.match === "range" && item.selectors.some((item) => globMatch(normalized, item)));
    tier = "range";
  }
  if (!entry) {
    entry = registry.entries.find((item) => item.match === "proxy" && item.selector === normalized);
    tier = "proxy";
  }
  if (!entry) {
    return {
      selector: normalized,
      status: "unknown",
      matchTier: "unknown",
      confidence: "unknown",
      stale: false,
      registryRevision: registry.revision,
      registryDigest: registry.digest || null,
      currency: registry.currency,
      billingMode: "unknown",
      rates: null
    };
  }
  if (entry.match === "proxy") {
    if (seen.has(normalized)) throw new Error(`Pricing proxy cycle detected at ${normalized}.`);
    seen.add(normalized);
    const target = resolvePricing(entry.proxyFor, { registry, now, seen });
    return {
      ...target,
      selector: normalized,
      matchTier: "proxy",
      confidence: target.status === "known" ? "approximate" : "unknown",
      proxyFor: entry.proxyFor
    };
  }
  return {
    selector: normalized,
    status: entry.highRates ? "range" : "known",
    matchTier: tier,
    confidence: entry.confidence,
    stale: stale(entry, registry, now),
    effectiveDate: entry.effectiveDate,
    source: entry.source,
    registryRevision: registry.revision,
    registryDigest: registry.digest || null,
    currency: registry.currency,
    billingMode: entry.billingMode,
    rates: entry.rates || null,
    lowRates: entry.lowRates || null,
    highRates: entry.highRates || null
  };
}

function calculate(rates, { inputTokens = 0, outputTokens = 0, cachedInputTokens = 0 } = {}) {
  const uncached = Math.max(0, inputTokens - cachedInputTokens);
  return dollars(uncached, rates.input)
    + dollars(cachedInputTokens, rates.cachedInput)
    + dollars(outputTokens, rates.output);
}

export function estimateModelCost(selector, usage = {}, options = {}) {
  const resolution = resolvePricing(selector, options);
  if (resolution.status === "unknown") {
    return {
      known: false, lowUsd: 0, highUsd: null, billing: "unknown",
      pricing: resolution
    };
  }
  if (resolution.status === "range") {
    return {
      known: false,
      lowUsd: calculate(resolution.lowRates, usage),
      highUsd: calculate(resolution.highRates, usage),
      billing: resolution.billingMode,
      pricing: resolution
    };
  }
  const value = calculate(resolution.rates, usage);
  return {
    known: true,
    lowUsd: value,
    highUsd: value,
    billing: resolution.billingMode,
    pricing: resolution
  };
}

export function sumCosts(costs) {
  return costs.reduce((total, cost) => ({
    lowUsd: total.lowUsd + (cost.lowUsd || 0),
    highUsd: total.highUsd === null || cost.highUsd === null ? null : total.highUsd + cost.highUsd,
    hasUnknown: total.hasUnknown || !cost.known || cost.highUsd === null
  }), { lowUsd: 0, highUsd: 0, hasUnknown: false });
}

export function actualUsageCost(selector, usage, options = {}) {
  return estimateModelCost(selector, {
    inputTokens: usage?.input_tokens || 0,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens || 0,
    outputTokens: usage?.output_tokens || 0
  }, options);
}

export function pricingCoverage(roles, options = {}) {
  return Object.entries(roles).map(([role, selector]) => ({ role, selector, ...resolvePricing(selector, options) }));
}
