import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "omp-orchestrator-run-test-"));
process.env.OMP_ORCHESTRATOR_RUN_DIR = root;

const store = await import(`../mcp/run-store.mjs?test=${Date.now()}`);
const manager = await import(`../mcp/run-manager.mjs?test=${Date.now()}`);
const worker = await import(`../mcp/run-worker.mjs?test=${Date.now()}`);
const storage = await import("../mcp/storage.mjs");
const { getTemplate } = await import("../mcp/templates.mjs");

test.after(() => {
  storage.closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

test("run store isolates artifacts and sequences events", () => {
  const id = store.newRunId();
  const now = new Date().toISOString();
  store.writeRun({ id, template: "test", status: "running", phase: "test", budget: {}, estimate: {}, usage: {}, nodes: [], artifacts: [], createdAt: now, updatedAt: now });
  const first = store.appendRunEvent(id, "run.started");
  const second = store.appendRunEvent(id, "run.progress");
  const artifact = store.writeArtifact(id, "result.txt", "hello");
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(store.readRunEvents(id).length, 2);
  assert.equal(artifact.bytes, 5);
  assert.equal(store.readArtifact(id, "result.txt"), "hello");
});

test("run estimate separates base and contingency and blocks Composer artifacts", () => {
  const roles = {
    plan: "anthropic/claude-fable-5:medium",
    designer: "google-antigravity/gemini-3.5-flash:high",
    default: "xai-oauth/grok-4.5:off",
    advisor: "openai-codex/gpt-5.5:xhigh"
  };
  const estimate = manager.estimateRun({ template: "single-file-web-app", input: "Build a game", rolesOverride: roles });
  assert.equal(estimate.base.calls, 3);
  assert.equal(estimate.contingency.calls, 1);
  assert.ok(estimate.base.tokens + estimate.contingency.tokens <= 70000);
  assert.equal(estimate.warnings.length, 0);
  assert.equal(manager.routingCompatibility("xai-oauth/grok-composer-2.5-fast", "standalone_html").allowed, false);
  assert.equal(manager.routingCompatibility("xai-oauth/grok-composer-2.5-fast:high", "standalone_html").allowed, false);
});

test("run creation previews without writes and rejects an insufficient budget", async () => {
  const roles = {
    plan: "anthropic/claude-fable-5:medium",
    designer: "google-antigravity/gemini-3.5-flash:high",
    default: "xai-oauth/grok-4.5:off",
    advisor: "openai-codex/gpt-5.5:xhigh"
  };
  const preview = await manager.createRun({ input: "Build a game", confirmBudget: false, confirmQuota: false, rolesOverride: roles });
  assert.equal(preview.awaitingApproval, true);
  await assert.rejects(
    () => manager.createRun({
      input: "Build a game",
      budget: { maxCalls: 1, maxTotalTokens: 1000, maxApiEquivalentUsd: 0.01 },
      confirmBudget: true,
      confirmQuota: true,
      rolesOverride: roles
    }),
    /Budget does not cover/
  );
});

test("subscription cost policy observes unknown pricing without blocking token governance", () => {
  const roles = {
    plan: "anthropic/claude-fable-5:high",
    advisor: "anthropic/claude-opus-5:high"
  };
  const observed = manager.estimateRun({
    template: "independent-analysis",
    input: "Design durable storage",
    budget: { costPolicy: "observe", maxCalls: 2, maxTotalTokens: 16000 },
    rolesOverride: roles
  });
  assert.equal(observed.base.cost.highUsd, null);
  assert.match(observed.warnings.join(" "), /reporting will be partial/);
  assert.doesNotThrow(() => manager.assertEstimateBudget(observed));

  const enforced = manager.estimateRun({
    template: "independent-analysis",
    input: "Design durable storage",
    budget: { costPolicy: "enforce", maxCalls: 2, maxTotalTokens: 16000, maxApiEquivalentUsd: 0.5 },
    rolesOverride: roles
  });
  assert.throws(
    () => manager.assertEstimateBudget(enforced),
    /unknown pricing/
  );
});

test("disabled cost policy retains hard call and token limits", () => {
  const roles = {
    plan: "anthropic/claude-fable-5:high",
    advisor: "anthropic/claude-opus-5:high"
  };
  const estimate = manager.estimateRun({
    template: "independent-analysis",
    input: "Design durable storage",
    budget: { costPolicy: "disabled", maxCalls: 1, maxTotalTokens: 16000 },
    rolesOverride: roles
  });
  assert.doesNotMatch(estimate.warnings.join(" "), /pricing/);
  assert.throws(() => manager.assertEstimateBudget(estimate), /maxCalls/);
});

test("resume preserves completed checkpoints and resets only retryable nodes", () => {
  const nodes = [
    { id: "complete", status: "succeeded", jobId: "kept" },
    { id: "failed", status: "failed", jobId: "replaced", usage: { total_tokens: 10 } },
    { id: "interrupted", status: "interrupted", jobId: "orphaned" }
  ];
  const prepared = manager.prepareNodesForResume(nodes);
  assert.equal(prepared[0].jobId, "kept");
  assert.equal(prepared[0].status, "succeeded");
  assert.equal(prepared[1].jobId, null);
  assert.equal(prepared[1].status, "pending");
  assert.equal(prepared[1].usage, null);
  assert.equal(prepared[2].jobId, null);
  assert.equal(prepared[2].status, "pending");
});

test("cancellation requires explicit confirmation before reading run state", () => {
  assert.throws(() => manager.cancelRun({ id: "00000000-0000-0000-0000-000000000000", confirm: false }), /confirm=true/);
});

test("terminal runs cannot be rewritten as cancelled", () => {
  const id = store.newRunId();
  const now = new Date().toISOString();
  store.writeRun({
    id, template: "test", status: "succeeded", phase: "complete", budget: {}, estimate: {}, usage: {}, nodes: [], artifacts: [],
    createdAt: now, updatedAt: now, completedAt: now, workerPid: null
  });
  assert.throws(() => manager.cancelRun({ id, confirm: true }), /terminal status succeeded/);
  assert.equal(store.readRun(id).status, "succeeded");
});

test("a late worker cannot overwrite a requested cancellation with review state", () => {
  const id = store.newRunId();
  const now = new Date().toISOString();
  store.writeRun({
    id, template: "single-file-web-app", status: "running", phase: "initial", workerPid: null,
    budget: {}, estimate: {}, usage: {}, nodes: [], artifacts: [],
    createdAt: now, updatedAt: now, completedAt: null
  });
  assert.equal(manager.cancelRun({ id, confirm: true }).status, "cancelled");
  assert.equal(worker.completeRunForReview(id, (run) => ({ ...run, phase: "attestation" })), false);
  assert.equal(store.readRun(id).status, "cancelled");
  assert.equal(store.readRunEvents(id).filter((event) => event.type === "run.cancelled").length, 1);
});

test("resume preparation keeps a linked live node for attachment", () => {
  const prepared = manager.prepareNodesForResume([{ id: "live", status: "running", jobId: "still-running" }]);
  assert.equal(prepared[0].status, "running");
  assert.equal(prepared[0].jobId, "still-running");
  const reservation = manager.prepareNodesForResume([{ id: "unstarted", status: "reserving", jobId: null }]);
  assert.equal(reservation[0].status, "pending");
});

test("run reservation blocks a second parallel dispatch beyond the call envelope", () => {
  const run = {
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    budget: { maxCalls: 1, maxTotalTokens: 1_000, costPolicy: "disabled" },
    usage: { calls: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, apiEquivalentHighUsd: null },
    nodes: []
  };
  const reservation = worker.reserveRunBudget(run, "xai-oauth/grok-4.5", "synthetic", 10);
  run.nodes.push({ id: "first", status: "running", reservation });
  assert.throws(
    () => worker.reserveRunBudget(run, "xai-oauth/grok-4.5", "synthetic", 10),
    /run call budget/
  );
});

test("run accounting records a call with unknown usage without inventing tokens or cost", () => {
  const totals = {
    calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
    apiEquivalentLowUsd: 0, apiEquivalentHighUsd: 0
  };
  worker.accumulateRunUsage(totals, { selector: "xai-oauth/grok-4.5", usage: null });
  assert.equal(totals.calls, 1);
  assert.equal(totals.totalTokens, 0);
  assert.equal(totals.apiEquivalentLowUsd, null);
  assert.equal(totals.apiEquivalentHighUsd, null);
});

test("a reviewer accepts only the inspected artifact hash", async () => {
  const id = store.newRunId();
  const now = new Date().toISOString();
  const artifact = store.writeArtifact(id, "candidate.html", "<!DOCTYPE html><html></html>");
  store.writeRun({
    id, template: "single-file-web-app", status: "awaiting_review", phase: "attestation",
    budget: {}, estimate: {}, usage: {}, nodes: [], artifacts: [artifact], validation: { valid: true },
    revisionCount: 0, eventCount: 0, createdAt: now, updatedAt: now
  });
  await assert.rejects(
    () => manager.attestRun({ id, verdict: "accept", findings: [], expectedArtifactSha256: "0".repeat(64) }),
    /current artifact SHA-256/
  );
  assert.equal(store.readRun(id).status, "awaiting_review");
  const result = await manager.attestRun({ id, verdict: "accept", findings: [], expectedArtifactSha256: artifact.sha256 });
  assert.equal(result.status, "succeeded");
  assert.equal(result.attestation.artifactSha256, artifact.sha256);
  // Local transports attest as the machine operator; HTTP uses the token name.
  assert.equal(result.attestation.actor, "local-operator");
  assert.equal(result.attestation.mechanism, "local-process");
  assert.equal(manager.getRunResult({ id }).output, "<!DOCTYPE html><html></html>");
});

test("runs written before the neutral rename remain reviewable", async () => {
  const id = store.newRunId();
  const now = new Date().toISOString();
  const artifact = store.writeArtifact(id, "candidate.html", "<!DOCTYPE html><html>legacy</html>");
  store.writeRun({
    id, template: "single-file-web-app", status: "awaiting_codex", phase: "attestation",
    budget: {}, estimate: {}, usage: {}, artifacts: [artifact], validation: { valid: true },
    nodes: [{ id: "validate", type: "validator", status: "succeeded" }, { id: "codex", type: "attestation", status: "pending" }],
    revisionCount: 0, eventCount: 0, createdAt: now, updatedAt: now
  });
  const result = await manager.attestRun({ id, verdict: "accept", findings: [], expectedArtifactSha256: artifact.sha256 });
  assert.equal(result.status, "succeeded");
  assert.equal(store.readRun(id).nodes.find((node) => node.id === "codex").status, "succeeded");
  assert.equal(store.readRun(id).nodes.find((node) => node.id === "validate").status, "succeeded");
});

test("pipeline templates use a neutral review node", () => {
  for (const template of manager.getPipelineTemplates()) assert.doesNotMatch(template.description, /codex/i);
  const node = getTemplate("multi-model-build-review").nodes.find((item) => item.type === "attestation");
  assert.equal(node.id, "review");
  assert.deepEqual(getTemplate("multi-model-build-review").nodes.find((item) => item.id === "finalize").dependsOn, ["review"]);
});

test("resume validates budgets and atomically claims the run once", () => {
  const id = store.newRunId();
  const now = new Date().toISOString();
  store.writeRun({
    id, template: "independent-analysis", status: "interrupted", phase: "initial",
    budget: { maxCalls: 2, maxTotalTokens: 20_000, maxDurationMs: 900_000, costPolicy: "observe", maxApiEquivalentUsd: 0.5 },
    estimate: {}, usage: { calls: 0, totalTokens: 0 }, nodes: [], artifacts: [],
    createdAt: now, updatedAt: now, workerPid: null
  });
  for (const budget of [{ maxCalls: null }, { maxTotalTokens: null }, { maxDurationMs: "forever" }, { other: true }]) {
    assert.throws(() => manager.claimRunResume(id, budget), /must|Unknown/);
    assert.equal(store.readRun(id).status, "interrupted");
  }
  const claim = manager.claimRunResume(id, { maxCalls: 3 });
  assert.equal(claim.run.status, "running");
  assert.equal(claim.run.budget.maxCalls, 3);
  assert.throws(() => manager.claimRunResume(id, { maxCalls: 4 }), /cannot be resumed from running/);
});
