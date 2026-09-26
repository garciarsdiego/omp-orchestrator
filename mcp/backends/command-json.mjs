import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_STDOUT_BYTES = 1_000_000;
const DEFAULT_STDERR_BYTES = 32_000;

function commandError(message, { code = "COMMAND_JSON_ERROR", stderr = "", exitCode = null } = {}) {
  const error = new Error(message);
  error.name = "CommandJsonError";
  error.code = code;
  error.stderr = stderr;
  error.exitCode = exitCode;
  return error;
}

function finitePositive(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer.`);
  return resolved;
}

function resolveExecutable(executable, pathValue = process.env.PATH || "") {
  if (typeof executable !== "string" || !executable) throw new Error("config.executable is required.");
  if (path.isAbsolute(executable)) {
    if (!existsSync(executable)) throw new Error("config.executable does not exist.");
    return executable;
  }
  if (executable.includes("/") || executable.includes("\\")) {
    throw new Error("config.executable must be absolute or a command name resolved from PATH.");
  }
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, executable.endsWith(extension) ? executable : `${executable}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("config.executable was not found on PATH.");
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function buildEnvironment(config) {
  const supplied = config.env || {};
  const allowlist = new Set(config.envAllowlist || []);
  if (!Array.isArray(config.envAllowlist || [])) throw new Error("config.envAllowlist must be an array.");
  for (const [key, value] of Object.entries(supplied)) {
    if (!allowlist.has(key)) throw new Error(`Environment variable is not allowlisted: ${key}.`);
    if (typeof value !== "string") throw new Error(`Environment variable ${key} must be a string.`);
  }
  // envInherit names variables copied from the Orchestrator's own environment
  // (e.g. USERPROFILE/HOME so an agent CLI finds its existing login). Only
  // names live in the catalog; values never do.
  const inheritNames = config.envInherit || [];
  if (!Array.isArray(inheritNames) || !inheritNames.every((name) => typeof name === "string" && ENV_NAME.test(name))) {
    throw new Error("config.envInherit must be an array of environment variable names.");
  }
  const inherited = ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "WINDIR", ...inheritNames];
  const env = {};
  for (const key of inherited) if (process.env[key]) env[key] = process.env[key];
  for (const key of allowlist) if (Object.hasOwn(supplied, key)) env[key] = supplied[key];
  return env;
}

function killProcessTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

function parseResponse(stdout, stderr, exitCode) {
  let payload;
  try { payload = JSON.parse(stdout); }
  catch { throw commandError("Command stdout must be exactly one JSON response.", { code: "INVALID_JSON", stderr, exitCode }); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.output !== "string") {
    throw commandError("Command JSON response requires a string output field.", { code: "INVALID_RESPONSE", stderr, exitCode });
  }
  if (payload.usage !== undefined && (payload.usage === null || typeof payload.usage !== "object" || Array.isArray(payload.usage))) {
    throw commandError("Command JSON usage must be an object when provided.", { code: "INVALID_RESPONSE", stderr, exitCode });
  }
  if (payload.events !== undefined && !Array.isArray(payload.events)) {
    throw commandError("Command JSON events must be an array when provided.", { code: "INVALID_RESPONSE", stderr, exitCode });
  }
  return { output: payload.output, usage: payload.usage ?? null, events: payload.events ?? [], exitCode };
}

function redactPrompt(stderr, prompt) {
  if (!prompt) return stderr;
  return stderr.split(prompt).join("[prompt redacted]");
}

/**
 * Runs a trusted headless adapter with a fixed command line. The prompt is
 * always written to stdin; it is never interpolated into an argument or shell.
 */
export function runCommandJob({ prompt, cwd, config = {}, signal, timeoutMs = 120_000 } = {}) {
  if (typeof prompt !== "string") return Promise.reject(new Error("prompt must be a string."));
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return Promise.reject(new Error("cwd must be an absolute path."));
  if (!existsSync(cwd)) return Promise.reject(new Error("cwd does not exist."));
  if (!Array.isArray(config.args || [])) return Promise.reject(new Error("config.args must be an array."));
  if (!(config.args || []).every((arg) => typeof arg === "string")) return Promise.reject(new Error("config.args must contain strings."));
  const stdoutLimit = finitePositive(config.maxStdoutBytes, DEFAULT_STDOUT_BYTES, "config.maxStdoutBytes");
  const stderrLimit = finitePositive(config.maxStderrBytes, DEFAULT_STDERR_BYTES, "config.maxStderrBytes");
  const deadlineMs = finitePositive(timeoutMs, 120_000, "timeoutMs");
  if (signal?.aborted) return Promise.reject(commandError("Command cancelled before start.", { code: "CANCELLED" }));

  let executable;
  let environment;
  try {
    environment = buildEnvironment(config);
    executable = resolveExecutable(config.executable, environment.PATH);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executable, config.args || [], {
      cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let settled = false;
    let escalation;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const fail = (error) => {
      if (failure) return;
      failure = error;
      killProcessTree(child, "SIGTERM");
      escalation = setTimeout(() => {
        if (!settled && child.exitCode === null) killProcessTree(child, "SIGKILL");
      }, 1_000);
      escalation.unref?.();
    };
    const append = (chunks, chunk, limit, kind) => {
      const remaining = limit - (kind === "stdout" ? stdoutBytes : stderrBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (chunk.length > remaining) fail(commandError(`${kind} exceeded its byte limit.`, { code: `${kind.toUpperCase()}_LIMIT` }));
    };
    const onAbort = () => fail(commandError("Command cancelled.", { code: "CANCELLED" }));
    const timer = setTimeout(() => fail(commandError("Command deadline exceeded.", { code: "TIMEOUT" })), deadlineMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => append(stdout, chunk, stdoutLimit, "stdout"));
    child.stderr.on("data", (chunk) => append(stderr, chunk, stderrLimit, "stderr"));
    child.on("error", (error) => finish(reject, commandError(error.message, { code: "SPAWN_FAILED" })));
    child.on("close", (exitCode) => {
      const stderrText = redactPrompt(Buffer.concat(stderr).toString("utf8"), prompt);
      if (failure) {
        failure.stderr = stderrText;
        failure.exitCode = exitCode;
        finish(reject, failure);
        return;
      }
      if (exitCode !== 0) {
        finish(reject, commandError(`Command exited with status ${exitCode}.`, { code: "NONZERO_EXIT", stderr: stderrText, exitCode }));
        return;
      }
      try { finish(resolve, parseResponse(Buffer.concat(stdout).toString("utf8"), stderrText, exitCode)); }
      catch (error) { finish(reject, error); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
