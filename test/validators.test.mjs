import test from "node:test";
import assert from "node:assert/strict";
import { validateStandaloneHtml } from "../mcp/validators.mjs";

test("standalone HTML validator accepts an offline interactive document", () => {
  const html = '<!DOCTYPE html><html><body><canvas aria-label="game"></canvas><button>Start</button><script>addEventListener("keydown",()=>{});requestAnimationFrame(()=>{});</script></body></html>';
  const result = validateStandaloneHtml(html);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.checks.javascriptSyntax, true);
});

test("standalone HTML validator rejects syntax errors and duplicate ids", () => {
  const html = '<!DOCTYPE html><html><body><div id="x"></div><div id="x"></div><script>function broken( {</script></body></html>';
  const result = validateStandaloneHtml(html);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /syntax|Duplicate/i);
});
