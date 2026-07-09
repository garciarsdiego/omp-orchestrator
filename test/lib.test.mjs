import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonOutput } from "../mcp/lib.mjs";

test("parseJsonOutput parses valid JSON", () => {
  assert.deepEqual(parseJsonOutput('{"ok":true}', "test"), { ok: true });
});

test("parseJsonOutput rejects invalid JSON without echoing it", () => {
  assert.throws(() => parseJsonOutput("secret-ish malformed input", "test"), /invalid JSON/);
});
