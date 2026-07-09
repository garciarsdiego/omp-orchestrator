import test from "node:test";
import assert from "node:assert/strict";
import { startRuntime, stopRuntime } from "../mcp/runtime.mjs";

test("runtime mutations require explicit confirmation", async () => {
  await assert.rejects(() => startRuntime(), /confirm=true/);
  await assert.rejects(() => stopRuntime(), /confirm=true/);
});
