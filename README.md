# OMP Orchestrator

OMP Orchestrator coordinates model calls and agent jobs from a local CLI, an MCP client, or an authenticated stand-alone HTTP console. OMP is one execution backend; an administrator can register other headless CLIs through a small JSON contract. This project is independent of [Oh My Pi](https://github.com/can1357/oh-my-pi) and does not include provider credentials.

The current code is an **unpublished preview**. It has been tested on Windows with Node 24 and OMP 18.3.2. The Linux x64 image pins the same OMP release; Docker in WSL/Ubuntu built the image, ran the full suite, and exercised both Compose services with fake backends. Real agent sessions ran locally on Windows through OMP and seven other agent CLIs. An external VPS deployment has not been run.

## What runs where

| Entry | Purpose | Start |
|---|---|---|
| CLI | JSON discovery and tool calls from scripts or any CLI able to launch a process | `node bin/omp-orchestrator.mjs tools` |
| MCP stdio | Local agents with MCP support | `node bin/omp-orchestrator.mjs mcp` |
| HTTP | Remote MCP, JSON API, and browser console | `node bin/omp-orchestrator.mjs serve` |

| Backend | Work unit | Available controls |
|---|---|---|
| OMP inference | Bounded Responses call through the local authenticated gateway | Estimate, create, retry, cancel, validate |
| `omp-rpc` | OMP agent process in a named workspace | Prompt, lifecycle events, steer, abort; completion waits for `session_settled` |
| `command-json` | An administrator-registered headless CLI process | One prompt on stdin, one JSON result on stdout, cancel |

The core exposes the same operations through CLI, MCP, and HTTP. A CLI that is only interactive or has no reliable machine output needs a wrapper or a dedicated adapter; the project does not claim to run every executable unmodified. `omp_agent_backends` reports capabilities instead of implying that all backends can steer or report token cost: each backend declares `usageReported`, `usageSemantics`, cache behavior, prompt delivery and how unknown usage is represented (always omitted, never zero).

## Local install and inspection

Requires Node 22 or 24. `better-sqlite3` is a native dependency, installed from `package-lock.json`. OMP must be installed separately for the OMP backends. The command backend can run without OMP.

```sh
npm ci
npm test
node bin/omp-orchestrator.mjs tools
node bin/omp-orchestrator.mjs doctor
npm run smoke
```

`doctor` reports configured OMP roles that are absent from its current available model catalog. `smoke` checks public OMP metadata commands and prints unresolved roles; it does not test a provider account or consume quota. An OMP login on one machine or in another CLI does not authenticate an OMP installation on a VPS.
`omp_providers` enumerates every provider ID currently seen in OMP's available model catalog and retains the older ten-family grouping for compatibility. Presence in that catalog does not prove current endpoint reachability or remaining quota.

`OMP_ORCHESTRATOR_STATE_DIR` selects the SQLite/WAL state and artifact root. `OMP_ORCHESTRATOR_WORKSPACE_ROOT` selects the parent of named agent workspaces. The default workspace root is under the state directory. Back up both the database and the content-addressed artifact objects; see [VPS deployment](docs/DEPLOY-VPS.md).

### CLI and MCP clients

The CLI writes one JSON value to stdout, with errors on stderr and a nonzero exit code. `call` validates the tool's published JSON schema before executing it. Use `--input-file -` to pipe arguments without shell quoting:

```sh
node bin/omp-orchestrator.mjs call omp_agent_backends --input-file -
node bin/omp-orchestrator.mjs call omp_job_estimate --input-file request.json
```

For a local MCP client, configure its command as an absolute path to Node and its argument as an absolute path to `bin/omp-orchestrator.mjs`, followed by `mcp`. When the package is installed as a CLI, the `omp-orchestrator mcp` command serves the same tools. The Codex plugin manifest remains under `.codex-plugin/`.

The stdio server uses the official MCP TypeScript SDK and serves both older handshake clients and the 2026-07-28 protocol. HTTP uses Streamable HTTP at `/mcp`. Tool arguments are validated on both transports; lists use an object wrapper in `structuredContent` so strict MCP clients can parse them.

### Agent jobs

Administrators may register command backends in a JSON file selected by `OMP_ORCHESTRATOR_BACKENDS_FILE`:

```json
{
  "backends": [
    {
      "id": "my-agent",
      "type": "command-json",
      "executable": "/usr/local/bin/my-agent-wrapper",
      "args": ["--json"],
      "envAllowlist": []
    }
  ]
}
```

The configured command receives the prompt on UTF-8 stdin, with no shell interpolation. It must write exactly one JSON object to stdout:

```json
{"output":"Work completed; see the changed files.","usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30},"events":[{"type":"completed"}]}
```

`usage` and `events` may be omitted. Missing usage remains unknown; the Orchestrator does not invent a zero cost.

`scripts/agent-cli-adapter.mjs` turns common agent CLIs into such a command. It has profiles for `codex`, `claude` (Claude Code), `droid`, `cursor` (cursor-agent), `grok`, `devin` and `muse`. The adapter reads the prompt from stdin and runs the CLI's headless mode in the job workspace without a shell. It delivers the prompt through stdin or a private temporary file. `cursor` and `grok` accept it only as an argument, so it is visible in the local process list while they run. The adapter then converts the CLI's JSON or JSONL to the contract above, with usage normalized to input/output/total tokens. Devin and Muse report no usage, so theirs stays unknown. Cursor reports `inputTokens` as the full prompt with `cacheReadTokens`/`cacheWriteTokens` partitioning it (independent `pi-cursor-sdk` observation; the Cursor vendor docs do not define the relation), so the normalized `total_tokens` is `inputTokens + outputTokens` without double-counting cache; `omp_agent_backends` reports this as `cursor-inclusive-cache-partition`. `envInherit` lists the names of variables copied from the Orchestrator's environment (for example `USERPROFILE`, `APPDATA`) so a CLI finds its existing login; values never go into the catalog:

```json
{ "id": "claude", "type": "command-json", "executable": "/usr/bin/node",
  "args": ["/opt/omp-orchestrator/scripts/agent-cli-adapter.mjs", "claude", "--", "/usr/local/bin/claude"],
  "envInherit": ["HOME"] }
```

A CLI started as `node index.js` uses `--launch <script>` before `--`. Fixed flags such as a model or `-s read-only` follow the executable. The recorded output formats (see `mcp/backends/cli-profiles.mjs`) belong to specific CLI versions, and a parser fails instead of guessing when a format changes. The configuration is operator-owned; a client cannot submit an arbitrary executable through `omp_agent_create`. Child processes get only fixed arguments and allowlisted environment values. Do not put secrets or broad host mounts in a worker's accessible workspace.

`omp_agent_create` requires a registered backend ID, a single directory name for `workspace`, a bounded prompt, `timeoutMs`, `confirmQuota: true`, and a stable `idempotencyKey`. A repeat with the same key returns the same job; a different request using that key fails. Use `omp_agent_get`, `omp_agent_events`, and `omp_agent_result` to inspect it. `omp_agent_steer` applies only to OMP RPC jobs; `omp_agent_abort` requests cancellation. A crashed job is marked interrupted and is never automatically replayed, because an external provider may already have consumed quota.

The OMP RPC backend uses a child process and the upstream JSONL protocol. A `prompt_result` says a turn yielded; `session_settled` is the completion signal for the agent job. Real sessions against OMP 18.3.2 (`openai-codex/gpt-5.5`) completed, accepted a mid-run steer and were aborted through the JSON CLI. Usage comes from the assistant `message_end` frames: tokens, the effective provider/model and OMP's own API-equivalent estimate. An aborted message reports zero usage, which the Orchestrator records as unknown rather than free.

Agent jobs currently enforce a wall-clock deadline and process count. They **do not claim hard token or price caps** on internal subcalls made by a CLI/agent. The backend's telemetry may be absent. The existing OMP inference jobs and DAG runs retain their separate budget controls.

### Run review

Inference runs use three built-in templates: `multi-model-build-review`, `single-file-web-app`, and `independent-analysis`. Review starts at `awaiting_review`; legacy `awaiting_codex` runs remain readable. Read metadata with `omp_run_get`, then retrieve the candidate body with `omp_run_artifact`. The artifact is returned as text and is not executed in the browser console.

`omp_run_attest` requires `accept`, `revise`, or `reject` plus `expectedArtifactSha256`, the hash of the artifact actually inspected. A changed candidate is rejected before the review can alter the run. Revision consumes quota and needs `confirmQuota: true`. Accepted results are available through `omp_run_result`. Shape validation and a reviewer decision do not prove that generated code is safe or correct.

### Stand-alone HTTP

Create a private token file with at least one token of at least 32 bytes and point `OMP_ORCHESTRATOR_ACCESS_TOKEN_FILE` at it. Start `npm run serve` or `node bin/omp-orchestrator.mjs serve --bind 127.0.0.1 --port 8080`. The endpoints are:

- `/`: the console;
- `/api/*`: the authenticated API;
- `/mcp`: MCP;
- `/healthz`: checks the HTTP process;
- `/readyz` (authenticated): checks storage;
- `/metrics` (authenticated): Prometheus text;
- `/api/metrics` (authenticated): JSON.

The browser holds the token only in memory and needs it again after a reload.

The token file may hold several `name:token` lines. Old and new tokens are valid together during a rotation, and the file reloads without a restart. The name is the audited actor: state-changing operations are recorded with actor, mechanism, operation, target and outcome (see `omp_audit_list`), and review attestations carry it. Local stdio/CLI use appears as `local-operator`. The listener binds to loopback by default. A bind beyond loopback requires `OMP_ORCHESTRATOR_PUBLIC_ORIGIN`; place TLS and an access policy at the edge. Requests validate `Host` and `Origin`; the internal OMP broker/gateway remains separate from the product's HTTP listener. In Compose, a separate agent worker container receives jobs through the shared state volume and **does not mount the HTTP access token**.

The [VPS guide](docs/DEPLOY-VPS.md) describes a pinned Linux x64 image, Compose, volumes, health checks, backup and restore, and a reverse TLS proxy. The browser UI can inspect runs, artifacts, jobs and agents and call any exposed tool. The worker still shares the SQLite state volume and OMP credential home with the trusted installation. It is **not** a hardened sandbox or tenant boundary for untrusted prompts/users. Workspaces prevent accidental directory mix-ups but do not stop an agent with shell access from reading other files available to the worker account.

## Validation and limits

- `npm test` exercises storage concurrency, budget enforcement, MCP protocol/argument validation, CLI from another directory, authenticated HTTP, both agent adapters with fake processes, and backup.
- `npm run smoke` reads OMP CLI metadata without provider calls.
- `npm pack --dry-run --json` checks the distribution file allowlist. This is not an npm publication; `private: true` is intentional.
- `npm run lint` checks for undefined references.
- `test/compose/smoke.sh` (also run in CI) covers the two-service Compose stack with fake engines: authentication, `Origin` rejection, sidecar execution, idempotency, restart, sidecar restart during a running job, abort, and SQLite+CAS backup/restore.
- `test/compose/upgrade-rollback.sh` rehearses an upgrade across a schema migration, an image-only rollback and a restore of a pre-upgrade backup.
- Real engines ran end to end through the JSON CLI on Windows: OMP 18.3.2 over RPC (completion, steer, abort) and Codex, Claude Code, Droid, Cursor, Grok, Devin and Muse through the adapter. External TLS and a VPS remain unverified.

This repository uses the MIT License. OMP is an independent dependency; see [third-party notices](THIRD_PARTY_NOTICES.md). Older implementation notes in `NEXT_STEPS.md` are historical. The audit that prompted this work is in `docs/audit-2026-09-25/`.
