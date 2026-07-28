# Changelog

## 0.5.0 — Unreleased

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
