# Changelog

## 0.8.0-preview.2 — Unreleased

- Fixed job listing (`/api/overview` returned HTTP 500), intermittent `SQLITE_BUSY` during concurrent first start, and an invalid console `pattern` that disabled client-side workspace validation.
- Added process identity (Linux `/proc` start time, Windows start FILETIME): a reused PID no longer keeps a job running or receives a cancellation signal.
- Review is client-neutral. Schema v3 migrates `awaiting_codex` to `awaiting_review`, and templates name the attestation node `review`. Legacy runs remain readable and reviewable.
- The HTTP access token file accepts several named tokens, reloads without a restart and keeps the old tokens when a rewrite is invalid. Schema v4 records an audit event (actor, mechanism, operation, target, outcome) for every state-changing operation. Review attestations carry the actor.
- Added authenticated `/metrics` (Prometheus text) and `/api/metrics` (JSON), plus the `omp_metrics` and `omp_audit_list` tools.
- Added `test/compose/smoke.sh` (also in CI) and `test/compose/upgrade-rollback.sh`, which rehearses an upgrade, an image-only rollback and a restore of a pre-upgrade backup across a schema migration.
- CI runs an ESLint `no-undef` check.

## 0.8.0-preview.1 — Unreleased

- Added a shared tool catalog served through MCP stdio, authenticated HTTP, and a JSON CLI.
- Added OMP RPC agent jobs with session events, steer and abort, plus administrator-configured headless CLI backends.
- Added a browser operations console and a pinned Linux/VPS image, Compose recipe, and online SQLite backup.
- Bundled the pinned OMP release's MIT license and third-party notices alongside its binary.
- Repaired concurrent state updates, migration startup, run budgets, retry accounting, provider selection, and exact-artifact review.
- Split HTTP and agent execution into separate Compose containers so agent processes cannot mount the HTTP access token. Shared state and OMP credentials remain within one trusted team boundary.
- Verified Windows tests (92 pass, two Linux-only skips), Linux image tests (94 pass), local Compose health/authentication, fake jobs across both containers, SQLite+CAS restore, and OMP 18.3.0/18.3.2 metadata-only RPC handshakes. Real provider execution and VPS/TLS remain unverified.

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
