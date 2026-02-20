# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/).

---

## [0.2.2] - 2026-02-20

### Changed

* Internal pending queue replaced with a ring-buffer deque to avoid O(n) operations under contention.
* Cancelled / timed-out waiters are pruned from the front of the queue to prevent queue-slot leaks and head-of-line blocking.
* Admission drain path hardened to skip cancelled waiters deterministically.

### Tests

* Expanded race coverage for abort/timeout vs release ordering.
* Added stress/soak coverage to validate `maxConcurrent` / `maxQueue` invariants under churn.

### Design Notes

* No public API changes.
* Behavioral intent unchanged: FIFO waiting remains bounded by `maxQueue`.
* Queueing remains opt-in; the long-term direction favors fail-fast admission.

---

## [0.2.1] - 2026-01-29

### Changed

* Tightened `tryAcquire()` semantics: it is now strictly non-blocking and never enqueues. A failed `tryAcquire()` always reports `concurrency_limit`.
* Hardened the `acquire()` waiting path to guarantee pending requests settle exactly once under abort, timeout, and release races.
* TypeScript types for `tryAcquire()` were tightened to remove queue-related failure reasons that could not occur.

### Documentation

* Corrected documentation to align with actual behavior of `tryAcquire()` (removed implication of queue-related failures).
* Clarified the distinction between `tryAcquire()` (immediate, non-blocking) and `acquire()` (may wait, bounded by `maxQueue`).

### Design Notes

* No new features 
* Behavior is unchanged aside from clarified `tryAcquire()` semantics and stronger internal invariants.

---

## [0.2.0] – 2026-01-26

> Note: The v0.2.0 API evolved during development; some early design concepts
> described here were simplified or removed before the final release.

### Added

* `bulkhead.run(fn)` convenience helper to safely wrap async work with automatic acquire / release handling
* Optional AbortSignal support to allow callers to cancel queued or in-flight work
* Additional stress and soak tests covering cancellation and helper APIs

### Changed

* Internal admission bookkeeping simplified to reduce edge-case state transitions
* Queue handling made more explicit and deterministic under contention
* Test suite reorganized for clearer invariants and failure diagnostics

### Breaking Changes

* Queue behavior now guarantees FIFO ordering when maxQueue is enabled

### Design Notes

* Helpers remain optional: the core fail-fast admission model is unchanged
* No retries, scheduling, or background workers were added
* Metrics hooks are synchronous and side-effect–free by design

---

## [0.1.0] – 2026-01-23

### Added
* Initial release of **async-bulkhead-ts**
* Fail-fast admission control for async workloads
* Simple bulkhead with configurable `maxConcurrent`
* Optional bounded queue via `maxQueue`
* Explicit admission and release lifecycle
* Accurate runtime stats (`inFlight`, `queued`, limits)
* ESM and CommonJS builds
* Full TypeScript typings
* Stress and soak tests validating concurrency invariants

### Design Notes
* No hidden queues by default
* No retries, background workers, or scheduling
* Intended to be composed with higher-level systems, not replace them

---
