// Headless agent CLI profiles for scripts/agent-cli-adapter.mjs.
//
// Each profile knows one CLI's non-interactive flags, how the prompt reaches
// it (stdin, a private temp file, or an argument when the CLI accepts nothing
// else) and how to turn its structured output into the command-json contract
// { output, usage, events }. Formats were recorded from these versions on
// 2026-09-26: codex-cli 0.155.1, Claude Code 2.1.280, droid 0.209.1,
// cursor-agent 2026.09.26, grok 1.0.41, devin 3000.1.27, Muse Code 1.3.0.
// A CLI update can change them; parsers fail loudly rather than guess.

const n = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

function fail(message) {
  const error = new Error(message);
  error.name = "AgentCliOutputError";
  throw error;
}

function parseJson(stdout, cli) {
  try { return JSON.parse(stdout.trim()); }
  catch { return fail(`${cli} did not print one JSON document.`); }
}

function parseJsonLines(stdout) {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((value) => value && typeof value === "object");
}

/** Usage where input excludes cache reads/writes (Anthropic-style fields). */
function exclusiveCacheUsage(raw, extra = {}) {
  if (!raw || typeof raw !== "object") return null;
  const input = n(raw.input_tokens) + n(raw.cache_read_input_tokens) + n(raw.cache_creation_input_tokens);
  const output = n(raw.output_tokens);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: n(raw.cache_read_input_tokens) },
    output_tokens: output,
    total_tokens: n(raw.total_tokens) || input + output,
    ...extra
  };
}

function modelsFrom(modelUsage) {
  return modelUsage && typeof modelUsage === "object" ? Object.keys(modelUsage).map((key) => key.slice(0, 160)) : [];
}

function cost(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1e6) / 1e6 : null;
}

function resultDocument(stdout, cli) {
  const doc = parseJson(stdout, cli);
  if (doc.is_error === true || (doc.subtype && doc.subtype !== "success")) fail(`${cli} reported an error result.`);
  if (typeof doc.result !== "string") fail(`${cli} result has no text.`);
  return doc;
}

export const CLI_PROFILES = {
  codex: {
    promptVia: "stdin",
    args: (fixed) => ["exec", ...fixed, "--json", "--skip-git-repo-check", "--ephemeral", "-"],
    parse(stdout) {
      const events = parseJsonLines(stdout);
      const failed = events.find((event) => event.type === "turn.failed" || event.type === "error");
      if (failed) fail("codex reported a failed turn.");
      const messages = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message");
      if (!messages.length) fail("codex produced no agent message.");
      const turns = events.filter((event) => event.type === "turn.completed" && event.usage);
      // OpenAI-style: input_tokens already includes cached input.
      const usage = turns.length ? turns.reduce((sum, { usage: raw }) => ({
        input_tokens: sum.input_tokens + n(raw.input_tokens),
        input_tokens_details: { cached_tokens: sum.input_tokens_details.cached_tokens + n(raw.cached_input_tokens) },
        output_tokens: sum.output_tokens + n(raw.output_tokens),
        total_tokens: sum.total_tokens + n(raw.input_tokens) + n(raw.output_tokens)
      }), { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, total_tokens: 0 }) : null;
      return {
        output: String(messages.at(-1).item.text ?? ""),
        usage: usage && { ...usage, source: "codex", turns: turns.length },
        events: events.filter((event) => typeof event.type === "string").slice(0, 100).map((event) => ({ type: `codex.${event.type}` }))
      };
    }
  },

  claude: {
    promptVia: "stdin",
    args: (fixed) => ["-p", ...fixed, "--output-format", "json"],
    parse(stdout) {
      const doc = resultDocument(stdout, "claude");
      return {
        output: doc.result,
        usage: exclusiveCacheUsage(doc.usage, {
          source: "claude-code", models: modelsFrom(doc.modelUsage), equivalentCostUsd: cost(doc.total_cost_usd)
        }),
        events: [{ type: "claude.result" }]
      };
    }
  },

  droid: {
    promptVia: "file",
    args: (fixed, promptFile) => ["exec", ...fixed, "-o", "json", "-f", promptFile],
    parse(stdout) {
      const doc = resultDocument(stdout, "droid");
      return {
        output: doc.result,
        usage: exclusiveCacheUsage(doc.usage, {
          source: "droid", ...(Number.isFinite(doc.usage?.factory_credits) ? { providerCredits: doc.usage.factory_credits } : {})
        }),
        events: [{ type: "droid.result" }]
      };
    }
  },

  cursor: {
    // cursor-agent takes the prompt only as an argument; it is visible in the
    // local process list while the job runs.
    promptVia: "argv",
    args: (fixed, prompt) => [...fixed, "-p", "--output-format", "json", "--trust", prompt],
    parse(stdout) {
      const doc = resultDocument(stdout, "cursor-agent");
      const raw = doc.usage;
      return {
        output: doc.result,
        // Field semantics are undocumented; cache counts are assumed to be
        // exclusive of inputTokens, as in the other Anthropic-style CLIs.
        usage: raw ? exclusiveCacheUsage({
          input_tokens: raw.inputTokens, output_tokens: raw.outputTokens,
          cache_read_input_tokens: raw.cacheReadTokens, cache_creation_input_tokens: raw.cacheWriteTokens
        }, { source: "cursor-agent", normalization: "assumed-exclusive-cache" }) : null,
        events: [{ type: "cursor.result" }]
      };
    }
  },

  grok: {
    // grok takes the prompt only as an argument (-p); see cursor.
    promptVia: "argv",
    args: (fixed, prompt) => [...fixed, "--output-format", "json", "-p", prompt],
    parse(stdout) {
      const doc = parseJson(stdout, "grok");
      if (typeof doc.text !== "string") fail("grok result has no text.");
      if (doc.stopReason && !["end_turn", "stop"].includes(doc.stopReason)) fail(`grok stopped with ${doc.stopReason}.`);
      return {
        output: doc.text,
        usage: exclusiveCacheUsage(doc.usage, {
          source: "grok", models: modelsFrom(doc.modelUsage), equivalentCostUsd: cost(doc.total_cost_usd)
        }),
        events: [{ type: "grok.result" }]
      };
    }
  },

  devin: {
    promptVia: "file",
    args: (fixed, promptFile) => [...fixed, "-p", "--prompt-file", promptFile],
    // devin -p prints plain text only: usage stays unknown.
    parse(stdout) {
      const output = stdout.trim();
      if (!output) fail("devin produced no output.");
      return { output, usage: null, events: [{ type: "devin.text" }] };
    }
  },

  muse: {
    promptVia: "file",
    args: (fixed, promptFile) => ["exec", ...fixed, "--json", "--prompt-file", promptFile],
    parse(stdout) {
      const events = parseJsonLines(stdout);
      const terminal = events.filter((event) => event.payload_type?.startsWith("run.terminal.")).at(-1);
      if (!terminal) fail("muse produced no terminal run event.");
      if (terminal.payload?.terminal !== "completed" || typeof terminal.payload?.text !== "string") {
        fail(`muse run ended as ${terminal.payload?.terminal ?? "unknown"}.`);
      }
      // Muse exec --json reports no token usage: unknown, not zero.
      return {
        output: terminal.payload.text,
        usage: null,
        events: [...new Set(events.map((event) => event.payload_type).filter(Boolean))].slice(0, 100)
          .map((type) => ({ type: `muse.${type}` }))
      };
    }
  }
};

export function cliProfile(name) {
  const profile = Object.hasOwn(CLI_PROFILES, name) ? CLI_PROFILES[name] : null;
  if (!profile) throw new Error(`Unknown agent CLI profile: ${name}. Known: ${Object.keys(CLI_PROFILES).join(", ")}.`);
  return profile;
}
