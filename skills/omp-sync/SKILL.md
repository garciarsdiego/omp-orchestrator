---
name: omp-sync
description: Compare OMP model-role configuration with Codex orchestration templates and propose synchronized updates. Use when roles, providers, models, or local OMP configuration have changed.
---

# OMP role synchronization

1. Read current roles with `omp_roles`.
2. Compare selectors semantically by role; do not infer credentials or availability from a model's presence alone.
3. Use `omp_models` to validate that referenced selectors exist in the current catalog.
4. Produce a preview of additions, updates, removals, and unresolved selectors.
5. Do not write OMP or Codex configuration in the MVP.

Keep user-specific paths, provider accounts, and secrets out of generated templates and version control.
