import readline from "node:readline";

if (process.argv.includes("--ignore-term")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

let activePrompt;

send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 8 * 1_024 * 1_024
});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "negotiate_protocol") {
    send({ id: command.id, type: "response", command: command.type, success: true, data: { protocolVersion: 2 } });
    return;
  }
  if (command.type === "get_state") {
    send({ id: command.id, type: "response", command: command.type, success: true, data: { cwd: process.cwd() } });
    return;
  }
  if (command.type === "prompt") {
    activePrompt = command;
    send({ id: command.id, type: "response", command: command.type, success: true, data: { agentInvoked: true } });
    if (command.message === "complete") {
      setTimeout(() => {
        if (activePrompt?.id !== command.id) return;
        // Frame shape observed from OMP 18.3.2; values are synthetic.
        const assistant = {
          role: "assistant", provider: "fake-provider", model: "fake-model", content: [{ type: "text", text: "done" }],
          usage: { input: 100, output: 7, cacheRead: 20, cacheWrite: 0, totalTokens: 127,
            cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 } }
        };
        send({ type: "message_end", messageId: "user-1", message: { role: "user", content: "complete" } });
        send({ type: "message_end", messageId: "assistant-1", message: assistant });
        send({ type: "agent_end", isTerminal: true, yielded: false, messages: [{ role: "user", content: "complete" }, assistant] });
        send({ type: "prompt_result", id: command.id, agentInvoked: true, status: "completed", sessionSettled: false });
        setTimeout(() => send({ type: "session_settled" }), 15);
        activePrompt = null;
      }, 5);
    }
    if (command.message === "coalesced") {
      process.stdout.write(`${JSON.stringify({ type: "prompt_result", id: command.id, agentInvoked: true, status: "completed", sessionSettled: false })}\n${JSON.stringify({ type: "session_settled" })}\n`);
      activePrompt = null;
    }
    return;
  }
  if (command.type === "steer") {
    send({ id: command.id, type: "response", command: command.type, success: true, data: { queued: true } });
    return;
  }
  if (command.type === "abort") {
    send({ id: command.id, type: "response", command: command.type, success: true });
    if (activePrompt) {
      const prompt = activePrompt;
      activePrompt = null;
      setTimeout(() => {
        send({ type: "prompt_result", id: prompt.id, agentInvoked: true, status: "aborted", sessionSettled: true });
        send({ type: "session_settled" });
      }, 5);
    }
    return;
  }
  if (command.type === "fail") {
    send({ id: command.id, type: "response", command: command.type, success: false, code: "synthetic_failure", error: "synthetic error" });
    return;
  }
  if (command.type === "oversize") {
    send({ type: "message_update", text: "x".repeat(2_048) });
    return;
  }
  if (command.type === "never") return;
  send({ id: command.id, type: "response", command: command.type, success: false, code: "unknown_command", error: "unknown" });
});
