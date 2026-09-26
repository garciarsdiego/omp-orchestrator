import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandJob } from "../mcp/backends/command-json.mjs";

const fixture = fileURLToPath(new URL("../fixtures/command-json-fake.mjs", import.meta.url));
const cwd = path.dirname(fileURLToPath(import.meta.url));
const configFor = (mode, extra = {}) => ({ executable: process.execPath, args: [fixture, mode], ...extra });

test("runs a fixed command and sends the prompt only through stdin", async () => {
  const result = await runCommandJob({ prompt: "hello", cwd, config: configFor("success"), timeoutMs: 2_000 });
  assert.deepEqual(result, {
    output: "received:hello",
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    events: [{ type: "fake.done" }],
    exitCode: 0
  });
});

test("rejects malformed stdout JSON with bounded diagnostics", async () => {
  await assert.rejects(
    () => runCommandJob({ prompt: "secret prompt", cwd, config: configFor("invalid"), timeoutMs: 2_000 }),
    (error) => error.code === "INVALID_JSON" && !error.message.includes("secret prompt")
  );
});

test("returns null when the command does not report usage", async () => {
  const result = await runCommandJob({ prompt: "hello", cwd, config: configFor("unknown-usage"), timeoutMs: 2_000 });
  assert.equal(result.usage, null);
});

test("bounds diagnostics without returning the submitted prompt", async () => {
  await assert.rejects(
    () => runCommandJob({ prompt: "do-not-disclose", cwd, config: configFor("stderr-prompt"), timeoutMs: 2_000 }),
    (error) => error.code === "NONZERO_EXIT" && !error.stderr.includes("do-not-disclose")
  );
});

test("kills the command tree on timeout and cancellation", async () => {
  await assert.rejects(
    () => runCommandJob({ prompt: "hang", cwd, config: configFor("hang"), timeoutMs: 50 }),
    (error) => error.code === "TIMEOUT"
  );
  const controller = new AbortController();
  const pending = runCommandJob({ prompt: "hang", cwd, config: configFor("hang"), signal: controller.signal, timeoutMs: 2_000 });
  setTimeout(() => controller.abort(), 25).unref();
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
});

test("deadline escalates when a Linux command ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  await assert.rejects(
    () => runCommandJob({ prompt: "hang", cwd, config: configFor("ignore-term"), timeoutMs: 250 }),
    (error) => error.code === "TIMEOUT"
  );
  assert.ok(Date.now() - started < 3_000);
});

test("bounds stdout before accepting a response", async () => {
  await assert.rejects(
    () => runCommandJob({ prompt: "large", cwd, config: configFor("large", { maxStdoutBytes: 128 }), timeoutMs: 2_000 }),
    (error) => error.code === "STDOUT_LIMIT"
  );
});

test("requires allowlisting configured environment variables", async () => {
  await assert.rejects(
    () => runCommandJob({ prompt: "hello", cwd, config: configFor("success", { env: { EXTRA: "1" } }), timeoutMs: 2_000 }),
    /not allowlisted/
  );
});
