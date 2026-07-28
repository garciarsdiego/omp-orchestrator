---
name: omp-setup
description: Inspect and safely prepare a local Oh My Pi installation for use by the OMP Orchestrator plugin. Use when the user asks to configure, diagnose, connect, or verify OMP with Codex.
---

# OMP setup

Use the plugin's read-only MCP tools before proposing any change.

1. Call `omp_doctor` and summarize version, active config path, role count, model
   count, and unresolved roles.
2. Call `omp_providers` to inspect readiness for the approved provider set.
3. Call `omp_roles` to identify the current routing policy.
4. If a needed provider or model is unclear, use a bounded `omp_models` query.
5. A login in Claude, Codex, Cursor, Qwen, or another standalone CLI does not
   prove OMP can use that provider. An unavailable OMP OAuth provider requires
   `omp auth-broker login <provider-id>` in an interactive terminal.
6. Prefer an exact `selector` for providers that do not occupy one of OMP's
   finite role slots. The job API validates that selector against the available
   catalog before execution.
7. Never request or print API keys, OAuth tokens, `agent.db`, or broker tokens.
8. Inspect `omp_runtime_status` before managing background services.
9. Use `omp_runtime_start` or `omp_runtime_stop` only after explicit user confirmation; pass `confirm=true`.
10. Treat configuration writes and provider authentication as separate explicit actions requiring user confirmation.

State clearly that OMP is a separately installed dependency and this plugin is an independent integration.
