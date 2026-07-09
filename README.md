# OMP Orchestrator

An independent Codex plugin that uses a local
[Oh My Pi](https://github.com/can1357/oh-my-pi) installation as a multi-provider
runtime while Codex remains the root orchestrator and final reviewer.

## MVP scope

- Detect the installed OMP executable and active configuration directory.
- Read OMP model roles through the public CLI.
- Search the model catalog without reading credential databases.
- Give Codex workflows for planning, delegation, review, and setup.
- Manage an authenticated loopback broker/gateway runtime with explicit confirmation.
- Run asynchronous, persistent inference jobs through configured OMP roles.
- Validate `text`, `json`, and standalone `html` output contracts before review.
- Execute isolated, budgeted DAG runs with checkpoints and Codex attestation.
- Never return API keys, OAuth tokens, or raw contents of `agent.db`.

The MCP server is dependency-free and uses Node.js 20 or newer. OMP must be
installed separately and available on `PATH`, or its executable can be supplied
through `OMP_EXECUTABLE`.

## Local checks

```powershell
npm test
npm run smoke
```

## Architecture

```text
User -> Codex (plan/review) -> plugin skills + MCP -> OMP CLI -> providers/models
```

Catalog and configuration access remain read-only. The second milestone adds an
opt-in local runtime manager: it starts an OMP credential broker on
`127.0.0.1:9000` and an authenticated OpenAI-compatible gateway on
`127.0.0.1:4000`. Start and stop operations require `confirm=true`; bearer
tokens are created and consumed internally and are never returned by MCP tools.

Jobs require `confirmQuota=true`, are capped at four concurrent executions by
default, and persist only in the operating-system temporary directory. Failed
or invalid jobs can be retried without repeating successful jobs. Codex provider
configuration writes and quota-aware automatic routing remain disabled.

## Job lifecycle

```text
queued -> running -> succeeded
                  -> invalid (shape/contract failure)
                  -> failed  (transport/provider failure)
```

Use `omp_job_create`, poll with `omp_job_get`, and retrieve a completed body with
`omp_job_result`. A retry requires a second explicit quota confirmation.
Every attempt receives a unique `prompt_cache_key` so gateway credential
stickiness cannot accidentally reuse another job's conversational session.

## Version 0.4 run workflow

1. Preview with `omp_run_estimate`.
2. Approve budget and quota with `omp_run_create`.
3. Observe durable state with `omp_run_get` and `omp_run_events`.
4. Inspect the validated candidate when status is `awaiting_codex`.
5. Record `accept`, `revise`, or `reject` through `omp_run_attest`.
6. Retrieve an accepted artifact with `omp_run_result`.

Runs receive separate directories, job stores, artifacts, event logs, hashes,
budgets, and provenance. Composer 2.5 is blocked for HTML artifact contracts over
the Responses gateway because repeated clean-room runs produced invalid outputs.

## Security boundaries

- Both services bind only to `127.0.0.1`.
- The gateway always requires its own bearer token; `--no-auth` is never used.
- Broker and gateway tokens remain in OMP-managed files and process environment.
- Runtime state stores only process ids and start time in the operating-system
  temporary directory.
- The stop operation targets only the process tree recorded by this plugin.

## Legal

This repository has its own MIT license. OMP is also MIT-licensed and remains a
separate dependency. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
