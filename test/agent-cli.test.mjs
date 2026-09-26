import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_PROFILES, cliCapabilities, cliProfile } from "../mcp/backends/cli-profiles.mjs";
import { runCommandJob } from "../mcp/backends/command-json.mjs";

const adapter = fileURLToPath(new URL("../scripts/agent-cli-adapter.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("../fixtures/fake-agent-cli.mjs", import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), "omp-agent-cli-test-"));

test.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

const run = (profile, prompt, extra = {}) => runCommandJob({
  prompt, cwd: root, timeoutMs: 20_000,
  config: { executable: process.execPath,
    args: [adapter, profile, "--launch", fakeCli, "--launch", extra.format || profile, "--", process.execPath],
    envInherit: ["TEMP", "TMP", "TMPDIR"] }
});

test("each CLI profile reaches the prompt its way and normalizes usage", async () => {
  const prompt = "hello \"quoted\" $(not-a-shell) & |";
  const results = Object.fromEntries(await Promise.all(Object.keys(CLI_PROFILES).map(async (name) => [name, await run(name, prompt)])));
  for (const [name, result] of Object.entries(results)) assert.equal(result.output, `received:${prompt}`, name);

  assert.deepEqual(results.codex.usage, {
    input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 5, total_tokens: 105, source: "codex", turns: 1
  });
  assert.deepEqual(results.claude.usage, {
    input_tokens: 82, input_tokens_details: { cached_tokens: 50 }, output_tokens: 4, total_tokens: 86,
    source: "claude-code", models: ["fake-sonnet"], equivalentCostUsd: 0.01
  });
  assert.equal(results.droid.usage.providerCredits, 7);
  // Cursor fixture: inputTokens 20 is the full prompt, 5 cached. The
  // normalized total must not double-count cache (20 + 3, not 25 + 3).
  assert.deepEqual(results.cursor.usage, {
    input_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens: 3, total_tokens: 23,
    source: "cursor-agent", normalization: "cursor-inclusive-cache-partition"
  });
  assert.equal(results.grok.usage.total_tokens, 38);
  assert.equal(results.devin.usage, null, "plain-text CLI usage stays unknown");
  assert.equal(results.muse.usage, null, "muse reports no usage");
  // Prompt files are private and removed afterwards.
  assert.equal(readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("omp-agent-cli-") && !entry.startsWith("omp-agent-cli-test-")).length, 0);
});

test("adapter capabilities report cursor cache as an inclusive partition", () => {
  const byProfile = Object.fromEntries(cliCapabilities().map((entry) => [entry.profile, entry]));
  for (const [name, entry] of Object.entries(byProfile)) {
    assert.equal(typeof entry.usageSemantics, "string", name);
    assert.equal(typeof entry.cacheBehavior, "string", name);
    assert.equal(entry.usageUnknownAs.includes("zero"), true, name);
  }
  assert.equal(byProfile.cursor.usageSemantics, "cursor-inclusive-cache-partition");
  assert.match(byProfile.cursor.cacheBehavior, /full prompt.*partition/i);
  assert.equal(byProfile.claude.usageSemantics, "anthropic-exclusive-cache");
  assert.equal(byProfile.devin.usageReported, false);
  // A cursor document without usage stays unknown instead of zero.
  assert.equal(cliProfile("cursor").parse(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "ok"
  })).usage, null);
  // Cache can never exceed the full prompt after clamping.
  const over = cliProfile("cursor").parse(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "ok",
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 8, cacheWriteTokens: 9 }
  })).usage;
  assert.equal(over.input_tokens_details.cached_tokens, 10);
  assert.equal(over.total_tokens, 11);
});

test("a failing CLI surfaces an error without echoing the prompt", async () => {
  await assert.rejects(run("claude", "secret-prompt-text", { format: "failing" }), (error) => {
    assert.equal(error.code, "NONZERO_EXIT");
    assert.doesNotMatch(error.stderr, /secret-prompt-text/);
    return true;
  });
});

test("error results and unknown formats fail loudly instead of guessing", () => {
  assert.throws(() => cliProfile("claude").parse(JSON.stringify({ is_error: true, result: "x" })), /error result/);
  assert.throws(() => cliProfile("codex").parse('{"type":"turn.failed"}'), /failed turn/);
  assert.throws(() => cliProfile("codex").parse('{"type":"turn.completed","usage":{}}'), /no agent message/);
  assert.throws(() => cliProfile("muse").parse('{"payload_type":"run.terminal.failed","payload":{"terminal":"failed"}}'), /ended as failed/);
  assert.throws(() => cliProfile("grok").parse('{"text":"x","stopReason":"error"}'), /stopped with error/);
  assert.throws(() => cliProfile("devin").parse("  \n"), /no output/);
  assert.throws(() => cliProfile("nope"), /Unknown agent CLI profile/);
});

test("envInherit copies only named variables and rejects values or bad names", async () => {
  process.env.OMP_TEST_INHERITED = "inherited-value";
  process.env.OMP_TEST_NOT_INHERITED = "hidden";
  const probe = ["-e", "process.stdout.write(JSON.stringify({ output: JSON.stringify({ a: process.env.OMP_TEST_INHERITED ?? null, b: process.env.OMP_TEST_NOT_INHERITED ?? null }) }))"];
  const result = await runCommandJob({ prompt: "x", cwd: root, config: { executable: process.execPath, args: probe, envInherit: ["OMP_TEST_INHERITED"] } });
  assert.deepEqual(JSON.parse(result.output), { a: "inherited-value", b: null });
  await assert.rejects(runCommandJob({ prompt: "x", cwd: root, config: { executable: process.execPath, args: probe, envInherit: ["BAD=VALUE"] } }), /envInherit/);
});
