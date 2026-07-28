import test from "node:test";
import assert from "node:assert/strict";
import { createJob, resolveJobTarget, retryJob } from "../mcp/jobs.mjs";

test("job creation requires explicit quota confirmation before any runtime check", async () => {
  await assert.rejects(
    () => createJob({ role: "task", prompt: "hello", confirmQuota: false }),
    /confirmQuota=true/
  );
});

test("job creation requires exactly one role or selector", async () => {
  await assert.rejects(
    () => createJob({ prompt: "hello", confirmQuota: true }),
    /exactly one target/
  );
  await assert.rejects(
    () => createJob({ role: "task", selector: "xai-oauth/grok-4.5", prompt: "hello", confirmQuota: true }),
    /exactly one target/
  );
});

test("direct selector resolution validates availability without a runtime or provider call", () => {
  const models = [{ provider: "cursor", id: "cursor-grok-4.5-low-fast" }];
  assert.deepEqual(
    resolveJobTarget({
      requestedSelector: "cursor/cursor-grok-4.5-low-fast",
      models
    }),
    {
      selector: "cursor/cursor-grok-4.5-low-fast",
      parsed: {
        provider: "cursor",
        model: "cursor-grok-4.5-low-fast",
        reasoning: null
      }
    }
  );
  assert.throws(
    () => resolveJobTarget({ requestedSelector: "cursor/not-available", models }),
    /not currently available/
  );
});

test("job retry requires renewed quota confirmation", async () => {
  await assert.rejects(
    () => retryJob({ id: "00000000-0000-0000-0000-000000000000", confirmQuota: false }),
    /confirmQuota=true/
  );
});
