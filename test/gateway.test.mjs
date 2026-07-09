import test from "node:test";
import assert from "node:assert/strict";
import { buildInferenceBody, extractResponseText, normalizeOutput, parseRoleSelector, validateOutput } from "../mcp/gateway.mjs";

test("role selectors preserve provider, model, and effort", () => {
  assert.deepEqual(parseRoleSelector("anthropic/claude-fable-5:medium"), {
    provider: "anthropic",
    model: "claude-fable-5",
    reasoning: "medium"
  });
  assert.deepEqual(parseRoleSelector("devin/swe-1-6-fast"), {
    provider: "devin",
    model: "swe-1-6-fast",
    reasoning: null
  });
});

test("response text extraction supports Responses API content", () => {
  assert.equal(extractResponseText({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }), "ok");
});

test("contracts distinguish valid, invalid, and fenced output", () => {
  assert.equal(validateOutput("hello", "text").valid, true);
  assert.equal(validateOutput('{"ok":true}', "json").valid, true);
  assert.equal(validateOutput("not json", "json").valid, false);
  assert.equal(validateOutput("<!DOCTYPE html><html></html>", "html").valid, true);
  assert.equal(validateOutput("```html\n<!DOCTYPE html><html></html>\n```", "html").valid, false);
  assert.equal(validateOutput("Concise architecture notes", "notes").valid, true);
  assert.equal(validateOutput("<!DOCTYPE html><html></html>", "notes").valid, false);
  assert.equal(validateOutput("<!DOCTYPE html><html><script></script></html>", "standalone_html").valid, true);
  assert.equal(validateOutput("<!DOCTYPE html><html><script src='https://example.com/x.js'></script></html>", "standalone_html").valid, false);
  assert.equal(validateOutput('{"verdict":"accept","findings":[]}', "review_json").valid, true);
  assert.equal(validateOutput('{"verdict":"maybe","findings":[]}', "review_json").valid, false);
});

test("inference body carries a unique session-isolation key", () => {
  const body = buildInferenceBody({
    model: "example-model",
    prompt: "hello",
    reasoning: "off",
    maxOutputTokens: 128,
    cacheKey: "omp-orchestrator:job-1:1"
  });
  assert.equal(body.prompt_cache_key, "omp-orchestrator:job-1:1");
  assert.equal(body.reasoning, undefined);
});

test("safe normalization removes only a complete outer artifact fence", () => {
  const fenced = "```html\n<!DOCTYPE html><html><script></script></html>\n```";
  const normalized = normalizeOutput(fenced, "standalone_html");
  assert.equal(normalized.changed, true);
  assert.equal(normalized.validation.valid, true);
  assert.equal(normalized.output, "<!DOCTYPE html><html><script></script></html>");
  assert.equal(normalizeOutput("prefix\n" + fenced, "standalone_html").changed, false);
});
