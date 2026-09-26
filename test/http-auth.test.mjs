import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const state = mkdtempSync(path.join(os.tmpdir(), "omp-http-auth-test-"));
process.env.OMP_ORCHESTRATOR_STATE_DIR = state;

const { parseAccessTokens, startHttpServer } = await import("../mcp/http-server.mjs");
const storage = await import("../mcp/storage.mjs");

const alice = "alice-synthetic-token-000000000000000001";
const bob = "bob-synthetic-token-00000000000000000002";
const carol = "carol-synthetic-token-0000000000000000003";
const tokenFile = path.join(state, "access-tokens");

test.after(() => {
  storage.closeDatabase();
  rmSync(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

test("access token file accepts one or several named tokens", () => {
  assert.deepEqual(parseAccessTokens(`${alice}\n`).map((entry) => entry.name), ["default"]);
  const entries = parseAccessTokens(`# rotation window\nalice:${alice}\n\n${bob}\n`);
  assert.deepEqual(entries.map((entry) => entry.name), ["alice", "token-2"]);
  assert.equal(entries[0].token.toString(), alice);
  assert.throws(() => parseAccessTokens("\n# none\n"), /no tokens/);
  assert.throws(() => parseAccessTokens("short:abc"), /at least 32 bytes/);
  assert.throws(() => parseAccessTokens(`a:${alice}\na:${bob}`), /names must be unique/);
  assert.throws(() => parseAccessTokens(`a:${alice}\nb:${alice}`), /tokens must be unique/);
});

test("named tokens identify the actor, rotate without restart and never lock out", async (t) => {
  writeFileSync(tokenFile, `alice:${alice}\nbob:${bob}\n`);
  const server = await startHttpServer({ port: 0, accessTokenFile: tokenFile, tokenReloadMs: 0, publicOrigin: "" });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const request = (secret, pathname, body) => fetch(`${base}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body && JSON.stringify(body)
  });
  const audit = async (secret) => (await (await request(secret, "/api/call", { name: "omp_audit_list", arguments: { limit: 5 } })).json()).result.items;

  assert.equal((await request(alice, "/api/tools")).status, 200);
  assert.equal((await request(bob, "/api/tools")).status, 200);
  assert.equal((await request(carol, "/api/tools")).status, 401);

  // A state-changing call is audited with the token name, even when it fails.
  const cancel = await request(alice, "/api/call", {
    name: "omp_job_cancel", arguments: { id: "00000000-0000-4000-8000-000000000000", confirm: true }
  });
  assert.equal(cancel.status, 500);
  const [event] = await audit(bob);
  assert.equal(event.actor, "alice");
  assert.equal(event.mechanism, "http-bearer");
  assert.equal(event.operation, "omp_job_cancel");
  assert.equal(event.outcome, "error");
  assert.equal(event.targetId, "00000000-0000-4000-8000-000000000000");
  // Reads are not audited.
  assert.equal((await audit(bob)).filter((item) => item.operation === "omp_audit_list").length, 0);

  // The actor also reaches the core through the MCP transport.
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "auth-test", version: "1.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
  const mcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bob}`, "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "omp_agent_abort"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {
      name: "omp_agent_abort", arguments: { id: "00000000-0000-4000-8000-000000000001", confirm: true }, _meta: meta
    } })
  });
  assert.equal(mcp.status, 200, await mcp.clone().text());
  const viaMcp = (await audit(alice)).find((item) => item.operation === "omp_agent_abort");
  assert.equal(viaMcp?.actor, "bob");

  // Rotation: drop alice, add carol. No restart.
  writeFileSync(tokenFile, `bob:${bob}\ncarol:${carol}\n`);
  assert.equal((await request(alice, "/api/tools")).status, 401);
  assert.equal((await request(carol, "/api/tools")).status, 200);

  // An invalid rewrite keeps the previous tokens instead of locking everyone out.
  writeFileSync(tokenFile, "short:abc\n");
  assert.equal((await request(carol, "/api/tools")).status, 200);
  assert.equal((await request(alice, "/api/tools")).status, 401);
});
