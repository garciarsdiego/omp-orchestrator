import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

// Browsers compile the pattern attribute as ^(?:pattern)$ with the `v` flag;
// an invalid expression is ignored silently, disabling client validation.
function patterns() {
  return [...html.matchAll(/\bpattern="([^"]*)"/g)].map((match) => match[1]);
}

test("console pattern attributes are valid under the HTML `v` regex flag", () => {
  const found = patterns();
  assert.ok(found.length > 0);
  for (const pattern of found) {
    assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, "v"), pattern);
  }
});

test("workspace pattern matches the server's safe directory rule", () => {
  const input = html.match(/<input id="agent-workspace"[^>]*>/)[0];
  const client = new RegExp(`^(?:${input.match(/pattern="([^"]*)"/)[1]})$`, "v");
  const maxLength = Number(input.match(/maxlength="(\d+)"/)[1]);
  const server = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
  for (const name of ["project", "browser-qa", "a.b_c-1", "x".repeat(64), "-lead", ".hidden", "a/b", "a b", ""]) {
    const accepted = client.test(name) && name.length <= maxLength;
    assert.equal(accepted, server.test(name), name);
  }
});
