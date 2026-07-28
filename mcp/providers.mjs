import { getModels, getRoles } from "./lib.mjs";
import { parseRoleSelector } from "./gateway.mjs";

export const TARGET_PROVIDERS = Object.freeze({
  claude: {
    label: "Claude",
    providerIds: ["anthropic"],
    loginProvider: "anthropic",
    recommendedSelector: "anthropic/claude-fable-5"
  },
  codex: {
    label: "Codex",
    providerIds: ["openai-codex"],
    loginProvider: "openai-codex",
    recommendedSelector: "openai-codex/gpt-5.5"
  },
  cursor: {
    label: "Cursor",
    providerIds: ["cursor"],
    loginProvider: "cursor",
    recommendedSelector: null
  },
  grok: {
    label: "Grok",
    providerIds: ["xai-oauth", "xai"],
    loginProvider: "xai-oauth",
    recommendedSelector: "xai-oauth/grok-4.5"
  },
  qwen: {
    label: "Qwen",
    providerIds: ["qwen-portal", "alibaba-coding-plan", "alibaba-token-plan"],
    loginProvider: "qwen-portal",
    recommendedSelector: null
  },
  kimi: {
    label: "Kimi",
    providerIds: ["kimi-code", "moonshot"],
    loginProvider: "kimi-code",
    recommendedSelector: "kimi-code/k3"
  },
  devin: {
    label: "Devin",
    providerIds: ["devin"],
    loginProvider: "devin",
    recommendedSelector: "devin/swe-1-7-lightning"
  },
  gemini: {
    label: "Gemini",
    providerIds: ["google-antigravity", "google-gemini-cli", "google"],
    loginProvider: "google-antigravity",
    recommendedSelector: "google-antigravity/gemini-3.6-flash"
  },
  deepseek: {
    label: "DeepSeek",
    providerIds: ["deepseek"],
    loginProvider: "deepseek",
    recommendedSelector: "deepseek/deepseek-v4-flash"
  },
  cerebras: {
    label: "Cerebras",
    providerIds: ["cerebras"],
    loginProvider: "cerebras",
    recommendedSelector: "cerebras/gemma-4-31b"
  }
});

export function buildProviderReadiness(models, roles = {}) {
  const roleEntries = Object.entries(roles);
  return Object.entries(TARGET_PROVIDERS).map(([key, definition]) => {
    const available = models.filter((model) => definition.providerIds.includes(model.provider));
    const configuredRoles = roleEntries
      .filter(([, selector]) => {
        try {
          return definition.providerIds.includes(parseRoleSelector(selector).provider);
        } catch {
          return false;
        }
      })
      .map(([role]) => role);
    const recommendedAvailable = definition.recommendedSelector
      ? available.some((model) => model.selector === definition.recommendedSelector)
      : false;
    return {
      key,
      label: definition.label,
      ready: available.length > 0,
      providerIds: definition.providerIds,
      availableProviderIds: [...new Set(available.map((model) => model.provider))],
      modelCount: available.length,
      configuredRoles,
      recommendedSelector: recommendedAvailable ? definition.recommendedSelector : null,
      loginProvider: available.length ? null : definition.loginProvider,
      action: available.length ? "ready" : `Run an OMP login for provider '${definition.loginProvider}'.`
    };
  });
}

export function getProviderReadiness() {
  const catalog = getModels({ limit: Number.POSITIVE_INFINITY });
  return {
    requested: Object.keys(TARGET_PROVIDERS).length,
    ready: buildProviderReadiness(catalog.models, getRoles()),
    secretsReturned: false
  };
}
