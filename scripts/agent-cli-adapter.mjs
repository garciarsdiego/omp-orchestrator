#!/usr/bin/env node
// Adapts a headless agent CLI to the command-json contract.
//
//   node scripts/agent-cli-adapter.mjs <profile> [--launch <arg>]... -- <executable> [fixed args...]
//
// --launch arguments go right after the executable, before the profile's
// subcommand and flags: e.g. `--launch C:/…/index.js -- C:/…/node.exe` for a
// CLI started as `node index.js`. Fixed args (model, sandbox…) follow the
// subcommand.
//
// Reads the prompt from stdin, runs the CLI in its non-interactive mode in the
// current directory (the job workspace) without a shell, and prints exactly
// one JSON object { output, usage, events } on stdout. Errors go to stderr
// without the prompt; the exit code is nonzero. The Orchestrator enforces the
// deadline and cancellation by killing this process tree.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliProfile } from "../mcp/backends/cli-profiles.mjs";

const MAX_STDOUT = 16 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

function usage(message) {
  process.stderr.write(`${message}\nUsage: agent-cli-adapter.mjs <profile> [--launch <arg>]... -- <executable> [fixed args...]\n`);
  process.exit(2);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator < 1) usage("Expected a profile, --, and the CLI executable.");
const [profileName, ...options] = argv.slice(0, separator);
const launch = [];
for (let index = 0; index < options.length; index += 2) {
  if (options[index] !== "--launch" || options[index + 1] === undefined) usage(`Unexpected option: ${options[index]}`);
  launch.push(options[index + 1]);
}
const [executable, ...fixed] = argv.slice(separator + 1);
if (!executable) usage("Missing CLI executable.");

let profile;
try { profile = cliProfile(profileName); } catch (error) { usage(error.message); }

const prompt = await readStdin();
if (!prompt.trim()) usage("The prompt on stdin is empty.");

let tempDir = null;
let promptArg = prompt;
if (profile.promptVia === "file") {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "omp-agent-cli-"));
  promptArg = path.join(tempDir, `${randomUUID()}.txt`);
  writeFileSync(promptArg, prompt, { mode: 0o600 });
}
const cleanup = () => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); };
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { cleanup(); process.exit(143); });

const child = spawn(executable, [...launch, ...profile.args(fixed, promptArg)], {
  cwd: process.cwd(), env: process.env, shell: false, windowsHide: true,
  stdio: [profile.promptVia === "stdin" ? "pipe" : "ignore", "pipe", "pipe"]
});
if (profile.promptVia === "stdin") {
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
}
const out = [];
const err = [];
let outBytes = 0;
let errBytes = 0;
child.stdout.on("data", (chunk) => {
  outBytes += chunk.length;
  if (outBytes > MAX_STDOUT) { child.kill(); return; }
  out.push(chunk);
});
child.stderr.on("data", (chunk) => {
  if (errBytes < MAX_STDERR) err.push(chunk.subarray(0, MAX_STDERR - errBytes));
  errBytes += chunk.length;
});

const exitCode = await new Promise((resolve) => {
  child.once("error", (error) => { err.push(Buffer.from(error.message)); resolve(127); });
  child.once("close", (code) => resolve(code ?? 1));
});
cleanup();

const redact = (text) => text.split(prompt).join("[prompt redacted]").slice(-4_000);
if (outBytes > MAX_STDOUT) {
  process.stderr.write(`${profileName}: output exceeded ${MAX_STDOUT} bytes.\n`);
  process.exit(1);
}
if (exitCode !== 0) {
  process.stderr.write(`${profileName} exited with status ${exitCode}.\n${redact(Buffer.concat(err).toString("utf8"))}\n`);
  process.exit(1);
}
try {
  const { output, usage: reported, events } = profile.parse(Buffer.concat(out).toString("utf8"));
  // The contract omits usage when unknown (null is rejected, zero would lie).
  process.stdout.write(JSON.stringify({ output, ...(reported ? { usage: reported } : {}), events }));
} catch (error) {
  process.stderr.write(`${error.message}\n${redact(Buffer.concat(err).toString("utf8"))}\n`);
  process.exit(1);
}
