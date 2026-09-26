import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import { createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpServer } from "./server.mjs";
import { invoke, tools } from "./tool-catalog.mjs";
import { storageStatus } from "./storage.mjs";
import { agentSupervisorStatus } from "./agent-jobs.mjs";
import { withActor } from "./request-context.mjs";

const MAX_API_BODY = 1_048_576;
const WEB_ROOT = new URL("../web/", import.meta.url);

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(data);
}

function page(res, filename, contentType) {
  const data = readFileSync(new URL(filename, WEB_ROOT));
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  });
  res.end(data);
}

/** Returns the name of the matching token, or null. */
function authenticate(req, tokens) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const supplied = Buffer.from(header.slice(7), "utf8");
  let actor = null;
  for (const entry of tokens.current()) {
    if (supplied.length === entry.token.length && timingSafeEqual(supplied, entry.token)) actor = entry.name;
  }
  return actor;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_API_BODY) {
      const error = new Error("Request body exceeds 1 MiB.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { const error = new Error("Body must be valid JSON."); error.status = 400; throw error; }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("Body must be a JSON object.");
    error.status = 400;
    throw error;
  }
  return value;
}

const TOKEN_NAME = /^[A-Za-z0-9._-]{1,32}$/;

/**
 * Parses the access token file: one token per line, optionally `name:token`.
 * Blank lines and `#` comments are ignored. Several lines allow rotation
 * (old and new token valid together); the name becomes the audit actor.
 */
export function parseAccessTokens(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (!lines.length) throw new Error("The access token file contains no tokens.");
  const entries = lines.map((line, index) => {
    const separator = line.indexOf(":");
    const named = separator > 0 && TOKEN_NAME.test(line.slice(0, separator));
    const name = named ? line.slice(0, separator) : lines.length === 1 ? "default" : `token-${index + 1}`;
    const token = Buffer.from(named ? line.slice(separator + 1) : line, "utf8");
    if (token.length < 32) throw new Error(`Access token "${name}" must contain at least 32 bytes.`);
    return { name, token };
  });
  const names = new Set(entries.map((entry) => entry.name));
  const values = new Set(entries.map((entry) => entry.token.toString("base64")));
  if (names.size !== entries.length) throw new Error("Access token names must be unique.");
  if (values.size !== entries.length) throw new Error("Access tokens must be unique.");
  return entries;
}

/** Re-reads the token file when it changes, so rotation needs no restart. */
function accessTokens(file, reloadMs) {
  if (!file) throw new Error("OMP_ORCHESTRATOR_ACCESS_TOKEN_FILE is required to serve HTTP.");
  const signature = () => { const info = statSync(file); return `${info.mtimeMs}:${info.size}:${info.ino}`; };
  let entries = parseAccessTokens(readFileSync(file, "utf8"));
  let seen = signature();
  let checkedAt = Date.now();
  return {
    current() {
      if (Date.now() - checkedAt >= reloadMs) {
        checkedAt = Date.now();
        try {
          const next = signature();
          if (next !== seen) {
            entries = parseAccessTokens(readFileSync(file, "utf8"));
            seen = next;
            console.error(`Access tokens reloaded: ${entries.map((entry) => entry.name).join(", ")}`);
          }
        } catch (error) {
          // A half-written or invalid file must not lock operators out.
          console.error("Access token reload failed; keeping the previous tokens:", error.message);
        }
      }
      return entries;
    }
  };
}

export async function startHttpServer({
  bind = process.env.OMP_ORCHESTRATOR_BIND || "127.0.0.1",
  port = Number(process.env.OMP_ORCHESTRATOR_PORT || 8080),
  publicOrigin = process.env.OMP_ORCHESTRATOR_PUBLIC_ORIGIN,
  accessTokenFile = process.env.OMP_ORCHESTRATOR_ACCESS_TOKEN_FILE,
  tokenReloadMs = 1_000
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be 0–65535.");
  if (bind !== "127.0.0.1" && bind !== "::1" && !publicOrigin) {
    throw new Error("OMP_ORCHESTRATOR_PUBLIC_ORIGIN is required when listening beyond loopback.");
  }
  const tokens = accessTokens(accessTokenFile, tokenReloadMs);
  let origin = publicOrigin ? new URL(publicOrigin).origin : `http://127.0.0.1:${port}`;
  const hostname = new URL(origin).hostname;
  const allowedHosts = [...new Set([hostname, "localhost", "127.0.0.1", "[::1]"])];
  const validateHost = hostHeaderValidation(allowedHosts);
  const handler = createMcpHandler(createMcpServer);
  const handleMcp = toNodeHandler(handler, { onerror: (error) => console.error("MCP HTTP error:", error?.name || "Error") });
  const server = http.createServer(async (req, res) => {
    try {
      if (!validateHost(req, res)) return;
      const requestOrigin = req.headers.origin;
      if (requestOrigin && requestOrigin !== origin) return json(res, 403, { error: "Origin is not allowed." });
      const pathname = new URL(req.url || "/", origin).pathname;
      if (req.method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });
      if (req.method === "GET" && pathname === "/") return page(res, "index.html", "text/html; charset=utf-8");
      if (req.method === "GET" && pathname === "/app.js") return page(res, "app.js", "text/javascript; charset=utf-8");
      if (req.method === "GET" && pathname === "/style.css") return page(res, "style.css", "text/css; charset=utf-8");

      const actor = authenticate(req, tokens);
      if (!actor) {
        res.setHeader("www-authenticate", "Bearer");
        return json(res, 401, { error: "Authentication required." });
      }
      return await withActor({ name: actor, mechanism: "http-bearer" }, () => route(req, res, pathname));
    } catch (error) {
      if (res.headersSent) return void res.end();
      return json(res, error.status || 500, { error: error.status ? error.message : "Request failed." });
    }
  });

  async function route(req, res, pathname) {
    if (pathname === "/mcp") return void await handleMcp(req, res);
    if (req.method === "GET" && pathname === "/readyz") {
      const supervisor = agentSupervisorStatus();
      return json(res, supervisor.ready ? 200 : 503, {
        ok: supervisor.ready, storage: storageStatus(), agentSupervisor: supervisor
      });
    }
    if (req.method === "GET" && pathname === "/api/tools") {
      return json(res, 200, { tools });
    }
    if (req.method === "GET" && pathname === "/api/overview") {
      const [runs, jobs, agents] = await Promise.all([
        invoke("omp_run_list", { limit: 25 }),
        invoke("omp_job_list", { limit: 25 }),
        invoke("omp_agent_list", { limit: 25 })
      ]);
      return json(res, 200, { runs, jobs, agents });
    }
    if (req.method === "POST" && pathname === "/api/call") {
      const body = await readJson(req);
      const tool = tools.find((item) => item.name === body.name);
      if (!tool) return json(res, 404, { error: "Unknown tool." });
      const validated = await fromJsonSchema(tool.inputSchema)["~standard"].validate(body.arguments || {});
      if (validated.issues) return json(res, 400, {
        error: "Invalid tool arguments.", details: validated.issues.map((item) => item.message)
      });
      return json(res, 200, { result: await invoke(tool.name, validated.value) });
    }
    return json(res, 404, { error: "Not found." });
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, resolve);
  });
  const actualPort = server.address().port;
  if (!publicOrigin) origin = `http://127.0.0.1:${actualPort}`;
  return {
    bind, port: actualPort,
    close: async () => {
      await handler.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
