import { spawnSync } from "node:child_process";

const MAX_BUFFER = 32 * 1024 * 1024;

export function ompExecutable(env = process.env) {
  return env.OMP_EXECUTABLE || "omp";
}

export function runOmp(args, options = {}) {
  const result = spawnSync(ompExecutable(options.env), args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 30_000,
    maxBuffer: MAX_BUFFER
  });

  if (result.error) {
    const hint = result.error.code === "ENOENT"
      ? "OMP was not found. Install it or set OMP_EXECUTABLE to the full executable path."
      : result.error.message;
    throw new Error(hint);
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `OMP exited with status ${result.status}`).trim());
  }
  return (result.stdout || "").trim();
}

export function parseJsonOutput(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export function getStatus() {
  return {
    installed: true,
    version: runOmp(["--version"]),
    configPath: runOmp(["config", "path"]),
    executable: ompExecutable()
  };
}

export function getRoles() {
  const result = parseJsonOutput(runOmp(["config", "get", "modelRoles", "--json"]), "omp config");
  return result.value || {};
}

export function getModels({ provider, query, limit = 50 } = {}) {
  const payload = parseJsonOutput(runOmp(["models", "--json"]), "omp models");
  const needle = String(query || "").toLowerCase();
  const selected = (payload.models || []).filter((model) => {
    if (provider && model.provider !== provider) return false;
    if (!needle) return true;
    return [model.provider, model.id, model.selector, model.name]
      .some((value) => String(value || "").toLowerCase().includes(needle));
  });
  return {
    totalAvailable: (payload.models || []).length,
    matched: selected.length,
    returned: Math.min(selected.length, limit),
    models: selected.slice(0, limit)
  };
}

export function doctor() {
  const status = getStatus();
  const roles = getRoles();
  const catalog = getModels({ limit: Number.POSITIVE_INFINITY });
  const availableSelectors = new Set(catalog.models.map((model) => model.selector));
  const unresolvedRoles = Object.entries(roles)
    .filter(([, selector]) => {
      const normalized = String(selector).replace(/:(?:off|minimal|low|medium|high|xhigh|max|ultra)$/i, "");
      return !availableSelectors.has(normalized);
    })
    .map(([role, selector]) => ({ role, selector }));
  return {
    ok: unresolvedRoles.length === 0,
    status,
    roleCount: Object.keys(roles).length,
    modelCount: catalog.totalAvailable,
    unresolvedRoles,
    safety: {
      rawCredentialStoreRead: false,
      secretValuesReturned: false,
      mode: "read-only"
    }
  };
}
