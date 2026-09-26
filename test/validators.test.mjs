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

test("standalone HTML rejects protocol-relative scripts and accepts static documents", () => {
  const remoteScript = '<!DOCTYPE html><html><body><script src="//example.invalid/app.js"></script><script>let x=1;</script></body></html>';
  const offlineStatic = '<!DOCTYPE html><html><body><h1>Offline report</h1></body></html>';
  assert.equal(validateStandaloneHtml(remoteScript).valid, false);
  const result = validateStandaloneHtml(offlineStatic);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.checks.javascriptSyntax, null);
});
