---
name: omp-setup
description: Inspect and safely prepare a local Oh My Pi installation for use by the OMP Orchestrator plugin. Use when the user asks to configure, diagnose, connect, or verify OMP with Codex.
---

# OMP setup

Use the plugin's read-only MCP tools before proposing any change.

1. Call `omp_doctor` and summarize version, active config path, role count, and model count.
2. Call `omp_roles` to identify the current routing policy.
3. If a needed provider or model is unclear, use a bounded `omp_models` query.
4. Never request or print API keys, OAuth tokens, `agent.db`, or broker tokens.
5. Inspect `omp_runtime_status` before managing background services.
6. Use `omp_runtime_start` or `omp_runtime_stop` only after explicit user confirmation; pass `confirm=true`.
7. Treat configuration writes and provider authentication as separate explicit actions requiring user confirmation.

State clearly that OMP is a separately installed dependency and this plugin is an independent integration.
