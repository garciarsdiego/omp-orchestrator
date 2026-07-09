import { extractResponseText, normalizeOutput, requestInference } from "./gateway.mjs";
import { readJob, updateJob } from "./job-store.mjs";

const id = process.argv[2];
if (!id) process.exit(2);

async function run() {
  const initial = readJob(id);
  if (initial.status !== "queued") return;
  updateJob(id, (job) => ({
    ...job,
    status: "running",
    startedAt: new Date().toISOString(),
    workerPid: process.pid,
    error: null
  }));

  try {
    const job = readJob(id);
    const payload = await requestInference({
      model: job.request.model,
      prompt: job.request.prompt,
      reasoning: job.request.reasoning,
      maxOutputTokens: job.request.maxOutputTokens,
      cacheKey: `omp-orchestrator:${job.id}:${job.attempt}`,
      timeoutMs: job.request.timeoutMs
    });
    const extracted = extractResponseText(payload);
    const normalized = normalizeOutput(extracted, job.request.contract);
    const output = normalized.output;
    const validation = normalized.validation;
    updateJob(id, (current) => ({
      ...current,
      status: validation.valid ? "succeeded" : "invalid",
      completedAt: new Date().toISOString(),
      output,
      validation,
      normalization: normalized.changed ? { transformation: normalized.transformation } : null,
      usage: payload.usage || null,
      error: null
    }));
  } catch (error) {
    updateJob(id, (job) => ({
      ...job,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: { message: error.message, name: error.name || "Error" }
    }));
  }
}

await run();
