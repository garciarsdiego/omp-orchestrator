# Changelog

## 0.7.0 — Unreleased

### Added

- Versioned declarative pricing registry with provenance, effective dates,
  confidence, staleness, exact/family/range/proxy resolution, and unknown
  preservation.
- Pricing coverage reporting for active roles through
  `omp_pricing_coverage`.
- Standalone job estimation through `omp_job_estimate`.
- Per-job hard limits for calls, input/output/total tokens, duration, and
  retries, plus `observe`, `enforce`, and `disabled` equivalent-cost policies.
- Persisted pricing snapshots, consumption events, and structured policy events
  in SQLite schema version 2.
- Explicit job cancellation through `omp_job_cancel`.

### Changed

- Standalone retries consume the remaining policy envelope.
- Provider usage is evaluated after each response so output or reasoning tokens
  beyond the requested maximum become a durable `limit_exceeded` result.
- Run-node jobs now link consumption records to their parent run.

### Validation

- Pricing precedence, proxies, staleness, unknown coverage, and range pricing.
- Observe/enforce behavior, actual token overruns, retry allowances, deadline
  accounting, cancellation, and idempotent consumption events.

## 0.6.0 — Unreleased

### Added

- Durable SQLite storage in WAL mode for jobs, attempts, runs, nodes, events,
  artifacts, and attestations.
- Explicit dry-run-first legacy JSON migration through `npm run migrate:json`.
- Startup reconciliation for orphaned jobs and runs.
- SHA-256 content-addressed artifact storage with deduplication and safe
  reference-aware garbage collection.
- High-confidence secret-pattern rejection before prompts, events, migration
  payloads, or artifacts are persisted.
- Storage diagnostics through `omp_storage_status`.

### Changed

- Subscription pipelines observe API-equivalent cost by default while retaining
  hard call, token, and duration limits; pay-as-you-go runs can opt into
  enforced USD-equivalent ceilings.
- Resume preserves successful checkpoints and creates new jobs only for failed,
  invalid, or interrupted nodes after renewed approval.
- Persistent state now defaults to the operating system's user-local state
  directory instead of `%TEMP%`.

### Validation

- SQLite WAL and schema migration checks.
- Multi-process concurrent writers.
- Startup reconciliation and checkpoint preservation.
- CAS deduplication, referenced-object GC safety, explicit migration, rollback
  on corrupt input, and secret scanning.

## 0.5.0 — 2026-07-28

### Added

- Readiness reporting for the approved ten-provider set through
  `omp_providers`.
- Exact `provider/model` selector support for quota-confirmed jobs.
- Provider/model catalog snapshot documentation and an executable roadmap.
- Regression coverage for catalogs larger than 200 entries and MCP tool
  discovery.

### Changed

- Updated the local OMP routing policy for quality-oriented role assignments.
- OMP doctor now reports unresolved role selectors.
- Provider readiness and doctor checks inspect the complete available catalog.
- Pricing normalization recognizes `max` and `ultra` reasoning suffixes.

### Fixed

- False provider failures after Cursor and Qwen expanded the catalog beyond 200
  models.
- Routing policy version drift after the plugin moved to 0.5.0.
- Explicit selector validation now occurs before runtime startup is required.

### Validation

- Unit and integration tests.
- OMP catalog and role smoke test.
- Managed broker/gateway start and stop cycle.
