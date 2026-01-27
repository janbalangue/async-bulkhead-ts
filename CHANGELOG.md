# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/).

---

## [0.2.0] – 2026-01-26

### Added

* `bulkhead.run(fn)` convenience helper to safely wrap async work with automatic `admit()` / `release()` handling
* Optional AbortSignal support to allow callers to cancel queued or in-flight work
* Structured lifecycle hooks for lightweight metrics integration (admit, queue, start, release, reject)
* Explicit error types for admission failures to improve observability and control-flow clarity
* Additional stress and soak tests covering cancellation and helper APIs

### Changed

* Internal admission bookkeeping simplified to reduce edge-case state transitions
* Queue handling made more explicit and deterministic under contention
* Test suite reorganized for clearer invariants and failure diagnostics

### Breaking Changes

* `admit()` failure reasons are now typed as structured errors instead of plain strings
* Queue behavior now guarantees FIFO ordering when maxQueue is enabled

### Design Notes

* Helpers remain optional: the core fail-fast admission model is unchanged
* No retries, scheduling, or background workers were added
* Metrics hooks are synchronous and side-effect–free by design

## [0.1.0] – 2026-01-23

### Added
* Initial release of **async-bulkhead-ts**
* Fail-fast admission control for async workloads
* Simple bulkhead with configurable `maxConcurrent`
* Optional bounded queue via `maxQueue`
* Explicit `admit()` / `release()` lifecycle
* Accurate runtime stats (`inFlight`, `queued`, limits)
* ESM and CommonJS builds
* Full TypeScript typings
* Stress and soak tests validating concurrency invariants

### Design Notes
* No hidden queues by default
* No retries, background workers, or scheduling
* Intended to be composed with higher-level systems, not replace them

---
