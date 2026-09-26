import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

test("package, lockfile and Codex plugin manifest declare one version", () => {
  const { version } = read("package.json");
  const lock = read("package-lock.json");
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
  assert.equal(read(".codex-plugin/plugin.json").version, version);
});
