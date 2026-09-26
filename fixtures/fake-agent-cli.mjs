// Fake headless agent CLI for scripts/agent-cli-adapter.mjs tests. The first
// argument selects which real CLI format to imitate; the prompt is read the
// way that CLI receives it and echoed back as "received:<prompt>".
import { existsSync, readFileSync } from "node:fs";

const [format, ...args] = process.argv.slice(2);
const after = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };

let prompt;
const file = after("-f") ?? after("--prompt-file");
if (file) {
  if (!existsSync(file)) { process.stderr.write("prompt file missing\n"); process.exit(3); }
  prompt = readFileSync(file, "utf8");
} else if (format === "grok") prompt = after("-p");
else if (format === "cursor") prompt = args.at(-1);
else if (format === "codex") prompt = args.at(-1) ?? "";
else prompt = readFileSync(0, "utf8");
const text = `received:${prompt}`;

const outputs = {
  codex: () => [
    { type: "thread.started", thread_id: "t" }, { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 } }
  ].map((line) => JSON.stringify(line)).join("\n"),
  claude: () => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01,
    usage: { input_tokens: 2, cache_creation_input_tokens: 30, cache_read_input_tokens: 50, output_tokens: 4 },
    modelUsage: { "fake-sonnet": {} } }),
  droid: () => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, factory_credits: 7 } }),
  cursor: () => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text,
    usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 0 } }),
  grok: () => JSON.stringify({ text, stopReason: "end_turn", total_cost_usd: 0.002,
    usage: { input_tokens: 30, cache_read_input_tokens: 6, cache_creation_input_tokens: 0, output_tokens: 2, total_tokens: 38 },
    modelUsage: { "fake-grok": {} } }),
  devin: () => `${text}\n`,
  muse: () => [
    { payload_type: "run.lifecycle.started", payload: { kind: "run_started" } },
    { payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text } }
  ].map((line) => JSON.stringify(line)).join("\n"),
  failing: () => { process.stderr.write(`boom while handling ${prompt}\n`); process.exit(4); }
};
process.stdout.write(outputs[format]());
