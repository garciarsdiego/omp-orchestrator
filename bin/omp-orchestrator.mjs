#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fromJsonSchema } from "@modelcontextprotocol/server";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function help() {
  return `OMP Orchestrator ${version}
Usage:
  omp-orchestrator mcp
  omp-orchestrator serve [--bind <address>] [--port <number>]
  omp-orchestrator tools
  omp-orchestrator call <tool-name> [--input-json <json> | --input-file <path|->]
  omp-orchestrator doctor
  omp-orchestrator --version

The CLI writes one JSON result to stdout. Use --input-file - to read JSON from stdin.
Tool calls that consume quota or change processes still require their explicit confirmation fields.`;
}

function parseInput(flags) {
  if (!flags.length) return {};
  if (flags.length !== 2 || !["--input-json", "--input-file"].includes(flags[0])) {
    throw new Error("Use exactly one --input-json or --input-file argument.");
  }
  const raw = flags[0] === "--input-file"
    ? readFileSync(flags[1] === "-" ? 0 : flags[1], "utf8")
    : flags[1];
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return value;
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || ["--help", "-h", "help"].includes(command)) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (command === "mcp") {
    if (rest.length) throw new Error("mcp accepts no arguments.");
    const { createMcpServer } = await import("../mcp/server.mjs");
    const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
    serveStdio(createMcpServer, { onerror: (error) => console.error("MCP transport error:", error?.name || "Error") });
    return;
  }
  if (command === "serve") {
    const options = {};
    while (rest.length) {
      const flag = rest.shift();
      if (!["--bind", "--port"].includes(flag) || !rest.length) {
        throw new Error("serve accepts only --bind <address> and --port <number>.");
      }
      options[flag === "--bind" ? "bind" : "port"] = flag === "--port" ? Number(rest.shift()) : rest.shift();
    }
    const { startHttpServer } = await import("../mcp/http-server.mjs");
    const running = await startHttpServer(options);
    process.stdout.write(`${JSON.stringify({ type: "ready", bind: running.bind, port: running.port })}\n`);
    const stop = () => void running.close().then(() => { process.exitCode = 0; });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }

  const { tools, invoke } = await import("../mcp/tool-catalog.mjs");
  if (command === "tools") {
    if (rest.length) throw new Error("tools accepts no arguments.");
    process.stdout.write(`${JSON.stringify({ version, tools })}\n`);
    return;
  }
  const name = command === "doctor" ? "omp_doctor" : rest.shift();
  if (command !== "doctor" && command !== "call") throw new Error(`Unknown command: ${command}`);
  if (!name) throw new Error("Tool name is required.");
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const input = parseInput(rest);
  const checked = await fromJsonSchema(tool.inputSchema)["~standard"].validate(input);
  if (checked.issues) {
    throw new Error(`Invalid arguments: ${checked.issues.map((issue) => issue.message).join("; ")}`);
  }
  const result = await invoke(name, checked.value);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
