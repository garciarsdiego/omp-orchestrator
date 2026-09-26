import { createOmpUsageAccumulator, startOmpRpc } from "./backends/omp-rpc.mjs";
import { runCommandJob } from "./backends/command-json.mjs";
import { appendAgentEvent, resolveBackend } from "./agent-jobs.mjs";
import { finalizeJobWithLedger, readJob, updateJob } from "./job-store.mjs";
import { workerProcess } from "./process-identity.mjs";
import { assertNoSecrets, scanForSecrets } from "./security.mjs";

const id = process.argv[2];
if (!id) process.exit(2);

function assistantText(frame) {
  const messages = frame.type === "agent_end" ? frame.messages : frame.message ? [frame.message] : [];
  const message = [...(messages || [])].reverse().find((item) => item?.role === "assistant");
  if (!message) return null;
  if (typeof message.content === "string") return message.content;
  return (message.content || []).filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("\n") || null;
}

function errorSummary(error) {
  return { name: error?.name || "AgentError", code: error?.code || null,
    message: ["TIMEOUT", "CANCELLED"].includes(error?.code) ? error.message : "Agent backend failed; inspect the event log." };
}

const STDERR_TAIL_CHARS = 2_000;

// What "inspect the event log" points at: the error code, exit status and the
// end of stderr. command-json has already redacted the prompt from stderr; a
// tail that still matches a secret pattern is withheld rather than stored.
function failureEvent(error) {
  const tail = typeof error?.stderr === "string" && error.stderr.trim() ? error.stderr.trim().slice(-STDERR_TAIL_CHARS) : null;
  const blocked = tail !== null && scanForSecrets(tail).length > 0;
  return { code: error?.code || null, exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : null,
    stderrTail: blocked ? null : tail, ...(blocked ? { stderrWithheld: "blocked secret pattern" } : {}) };
}

async function run() {
  let claimed = false;
  const starting = updateJob(id, (job) => {
    if (!job.backend || job.status !== "queued") return job;
    claimed = true;
    return { ...job, status: "running", startedAt: new Date().toISOString(), ...workerProcess(process.pid) };
  });
  if (!claimed) return;
  appendAgentEvent(id, "agent.started", { backend: starting.backend });

  let rpc = null;
  let readyForSteer = false;
  let polling = false;
  let lastText = null;
  const controller = new AbortController();
  async function commands() {
    if (polling) return;
    polling = true;
    try {
      const job = readJob(id);
      for (const command of job.commands || []) {
        if (command.status !== "queued") continue;
        if (command.type === "steer" && !readyForSteer) continue;
        let claimedCommand = false;
        updateJob(id, (current) => ({
          ...current,
          commands: current.commands.map((item) => {
            if (item.id !== command.id || item.status !== "queued") return item;
            claimedCommand = true;
            return { ...item, status: "running" };
          })
        }));
        if (!claimedCommand) continue;
        try {
          if (command.type === "steer") await rpc.steer(command.message);
          else if (command.type === "abort") {
            controller.abort();
            if (rpc) await rpc.abort();
          }
          updateJob(id, (current) => ({ ...current, commands: current.commands.map((item) =>
            item.id === command.id ? { ...item, status: "done", message: undefined } : item) }));
          appendAgentEvent(id, command.type === "steer" ? "agent.steered" : "agent.abort_sent");
        } catch {
          updateJob(id, (current) => ({ ...current, commands: current.commands.map((item) =>
            item.id === command.id ? { ...item, status: "failed", message: undefined } : item) }));
          appendAgentEvent(id, "agent.command_failed", { command: command.type });
        }
      }
    } finally { polling = false; }
  }
  const poller = setInterval(() => { void commands().catch(() => {}); }, 200);
  poller.unref?.();
  const ompUsage = createOmpUsageAccumulator();

  try {
    const backend = resolveBackend(starting.backend, starting.backendConfigDigest);
    const remainingMs = Math.max(1, Date.parse(starting.deadlineAt) - Date.now());
    if (remainingMs < 1000) throw Object.assign(new Error("Agent deadline expired before dispatch."), { code: "TIMEOUT" });
    let output = null;
    let usage = null;
    if (backend.type === "command-json") {
      await commands();
      const result = await runCommandJob({
        prompt: starting.request.prompt, cwd: starting.workspace,
        config: backend, signal: controller.signal, timeoutMs: remainingMs
      });
      output = result.output;
      usage = result.usage;
      for (const event of result.events.slice(0, 100)) {
        if (event && typeof event.type === "string") appendAgentEvent(id, "backend.event", { backendType: event.type.slice(0, 80) });
      }
    } else {
      rpc = await startOmpRpc({
        command: backend.executable, args: backend.args || [], cwd: starting.workspace,
        timeoutMs: Math.min(30_000, remainingMs)
      });
      rpc.on("event", ({ frame }) => {
        ompUsage.add(frame);
        if (!["agent_start", "agent_end", "tool_execution_start", "tool_execution_end", "prompt_result", "session_settled", "subagent_started", "subagent_completed", "message_end"].includes(frame.type)) return;
        const text = assistantText(frame);
        if (text) lastText = text;
        appendAgentEvent(id, `omp.${frame.type}`, {
          ...(typeof frame.status === "string" ? { status: frame.status.slice(0, 40) } : {}),
          ...(typeof frame.toolName === "string" ? { tool: frame.toolName.slice(0, 80) } : {})
        });
      });
      const initial = await rpc.command("get_state");
      if (initial.data?.sessionId) updateJob(id, (job) => ({ ...job, sessionId: initial.data.sessionId }));
      const dispatched = await rpc.prompt(starting.request.prompt, { timeoutMs: Math.min(30_000, remainingMs) });
      readyForSteer = true;
      await commands();
      const deadline = new Promise((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error("Agent deadline exceeded."), { code: "TIMEOUT" })),
          Math.max(1, Date.parse(starting.deadlineAt) - Date.now())).unref?.();
      });
      const completion = await Promise.race([dispatched.completion, deadline]);
      if (completion.status === "error") throw new Error("OMP RPC prompt failed.");
      if (completion.status === "aborted" || controller.signal.aborted) {
        updateJob(id, (job) => ({ ...job, status: "cancellation_requested" }));
      } else if (!completion.sessionSettled) {
        await Promise.race([rpc.waitForSettled({ timeoutMs: Math.max(1, Date.parse(starting.deadlineAt) - Date.now()) }), deadline]);
      }
      output = lastText;
      usage = ompUsage.result();
    }
    if (output !== null && Buffer.byteLength(output) > 2_000_000) {
      throw Object.assign(new Error("Agent output exceeded 2 MB."), { code: "OUTPUT_LIMIT" });
    }
    if (output !== null) assertNoSecrets(output, "Agent output");
    finalizeJobWithLedger(id, (job) => ({
      ...job,
      status: job.status === "cancellation_requested" || controller.signal.aborted ? "cancelled" : "succeeded",
      completedAt: new Date().toISOString(), workerPid: null,
      output: job.status === "cancellation_requested" ? null : output,
      usage, error: null
    }), { cost: null, mode: "observe" });
    appendAgentEvent(id, "agent.completed", { status: readJob(id).status, usageKnown: Boolean(usage) });
  } catch (error) {
    if (rpc && ["TIMEOUT", "CANCELLED"].includes(error?.code)) {
      try { await rpc.abort({ timeoutMs: 2_000 }); } catch {}
    }
    const cancelled = controller.signal.aborted || readJob(id).status === "cancellation_requested" || error?.code === "CANCELLED";
    // Aborted or failed sessions may already have consumed quota; keep what
    // OMP reported instead of dropping it.
    const partialUsage = ompUsage.result();
    finalizeJobWithLedger(id, (job) => ({
      ...job, status: cancelled ? "cancelled" : error?.code === "TIMEOUT" ? "limit_exceeded" : "failed",
      completedAt: new Date().toISOString(), workerPid: null,
      usage: partialUsage ?? job.usage ?? null,
      error: cancelled ? null : errorSummary(error)
    }), { cost: null, mode: "observe" });
    if (!cancelled) appendAgentEvent(id, "agent.failed", failureEvent(error));
    appendAgentEvent(id, "agent.completed", { status: readJob(id).status, usageKnown: Boolean(partialUsage) });
  } finally {
    clearInterval(poller);
    if (rpc) { try { await rpc.close({ timeoutMs: 2_000 }); } catch {} }
  }
}

await run();
