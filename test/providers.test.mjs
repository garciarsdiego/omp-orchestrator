import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderReadiness, catalogProviders } from "../mcp/providers.mjs";

test("provider readiness maps aliases and configured roles without credentials", () => {
  const readiness = buildProviderReadiness([
    { provider: "anthropic", id: "claude-fable-5", selector: "anthropic/claude-fable-5" },
    { provider: "xai-oauth", id: "grok-4.5", selector: "xai-oauth/grok-4.5" }
  ], {
    plan: "anthropic/claude-fable-5:medium",
    task: "xai-oauth/grok-4.5"
  });

  const claude = readiness.find((entry) => entry.key === "claude");
  const grok = readiness.find((entry) => entry.key === "grok");
  const cursor = readiness.find((entry) => entry.key === "cursor");

  assert.equal(claude.ready, true);
  assert.deepEqual(claude.configuredRoles, ["plan"]);
  assert.equal(claude.recommendedSelector, "anthropic/claude-fable-5");
  assert.equal(grok.ready, true);
  assert.deepEqual(grok.configuredRoles, ["task"]);
  assert.equal(cursor.ready, false);
  assert.equal(cursor.loginProvider, "cursor");
});

test("provider readiness does not truncate providers after 200 catalog entries", () => {
  const filler = Array.from({ length: 250 }, (_, index) => ({
    provider: "other",
    id: `model-${index}`,
    selector: `other/model-${index}`
  }));
  const readiness = buildProviderReadiness([
    ...filler,
    { provider: "cursor", id: "default", selector: "cursor/default" },
    { provider: "alibaba-token-plan", id: "qwen3.8-max-preview", selector: "alibaba-token-plan/qwen3.8-max-preview" }
  ]);
  assert.equal(readiness.find((entry) => entry.key === "cursor").ready, true);
  assert.equal(readiness.find((entry) => entry.key === "qwen").ready, true);
});

test("dynamic catalog discovery includes providers outside the historical ten", () => {
  const result = catalogProviders([
    { provider: "custom-local", id: "a" },
    { provider: "custom-local", id: "b" },
    { provider: "anthropic", id: "c" }
  ], { default: "custom-local/a" });
  assert.deepEqual(result.find((item) => item.id === "custom-local"), {
    id: "custom-local", modelCount: 2, configuredRoles: ["default"],
    catalogAvailable: true, operationalStatus: "unknown"
  });
});
