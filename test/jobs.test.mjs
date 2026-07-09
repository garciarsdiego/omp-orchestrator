import test from "node:test";
import assert from "node:assert/strict";
import { createJob, retryJob } from "../mcp/jobs.mjs";

test("job creation requires explicit quota confirmation before any runtime check", async () => {
  await assert.rejects(
    () => createJob({ role: "task", prompt: "hello", confirmQuota: false }),
    /confirmQuota=true/
  );
});

test("job retry requires renewed quota confirmation", async () => {
  await assert.rejects(
    () => retryJob({ id: "00000000-0000-0000-0000-000000000000", confirmQuota: false }),
    /confirmQuota=true/
  );
});
