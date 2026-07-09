---
name: omp-orchestrate
description: Plan multi-provider and multi-model work using OMP roles while keeping Codex as root orchestrator and final owner. Use for delegation plans, model selection, workload routing, or provider diversification.
---

# OMP orchestration

Keep Codex responsible for scope, decomposition, integration, and the final answer.

1. Inspect `omp_roles` and query `omp_models` only where role data is insufficient.
2. Divide work into bounded tasks with explicit inputs, expected outputs, and acceptance criteria.
3. Prefer role selectors over hard-coded model ids so the user's OMP policy remains authoritative.
4. Use independent providers for genuinely useful diversity, not merely to multiply calls.
5. Identify which result Codex must verify and how conflicts will be resolved.
6. Prefer a pipeline template over low-level jobs for multi-step work.
7. Call `omp_run_estimate` before requesting approval. Report base and contingency tokens and USD-equivalent range.
8. Start the authenticated runtime only after confirmation, then call `omp_run_create` with `confirmBudget=true` and `confirmQuota=true`.
9. Follow progress through `omp_run_get` and `omp_run_events`; do not recreate a run because a node is slow.
10. When status becomes `awaiting_codex`, inspect the artifact and deterministic validation evidence.
11. Call `omp_run_attest` with `accept`, `revise`, or `reject`. A revision requires renewed quota confirmation.
12. Use `omp_run_resume` only for failed or budget-exceeded runs; checkpoints prevent successful nodes from repeating.
13. Use low-level `omp_job_*` only when no pipeline template fits.
14. Treat contract validity as shape evidence, not substantive correctness.

Return a compact run ledger: run id, node/job ids, status, contracts, actual usage, USD-equivalent range, artifacts, and Codex attestation.
