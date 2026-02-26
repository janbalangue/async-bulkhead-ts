# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/).

---

## [0.3.0] - 2026-02-26

### Added

* `close()` — stops admission permanently. All pending waiters are rejected with `'shutdown'`; all future `tryAcquire`/`acquire`/`run` calls reject immediately. In-flight work is not interrupted — tokens remain valid and release normally. Idempotent and synchronous.
* `drain()` — returns a `Promise<void>` that resolves when `inFlight` and pending both reach zero. Works independently of `close()`. Compose as `close()` → `drain()` for graceful shutdown.
* `'shutdown'` added to `RejectReason` union. Flows through `BulkheadRejectedError` without breaking existing switch/match consumers.
* `closed` field on `Stats`.
* `inFlightUnderflow` counter on `Stats` — observable counter that increments if `inFlight` ever goes negative (should always be 0; nonzero indicates a bug). Replaces the previous silent clamp.

### Changed

* `stats()` is now a pure read. Previously it called `pruneCancelledFront()` internally, mutating the queue on every read. Pending count is now tracked via a `livePending` counter maintained on enqueue and settle. The queue is only pruned during the admission pump.
* Internal `drain` function renamed to `pump`. The internal function that admits waiters from the queue is now `pump()`, freeing `drain` for the public API.
* Redundant pump-on-enqueue removed. The unconditional `drain()` call at the end of the `acquire` promise constructor is replaced with a guarded check, avoiding a full queue walk when concurrency is known to be saturated.

### Tests

* `close()`: rejects pending waiters, rejects future admission, does not cancel in-flight work, cleans up abort listeners and timeouts, idempotent.
* `drain()`: resolves immediately when empty, resolves on last release, multiple callers all resolve, works without `close()`, waits for pending→admitted work.
* `close()` + `drain()` composition: graceful shutdown pattern, drain-then-close ordering, close with nothing in-flight.
* Mass abort: 100 simultaneous aborts, system drains cleanly, no ghost waiters.
* Soak with mid-run close/drain: invariants hold under churn when shutdown fires during active traffic.
* `stats()` purity: repeated calls return identical results with no side effects.

### Design Notes

* `close()` is irreversible — a closed bulkhead stays closed. Create a new instance if you need a fresh one.
* `drain()` is an observation primitive, not a cancellation primitive. The bulkhead does not own in-flight work and cannot force it to complete.
* Fully backward compatible for existing consumers. The new `'shutdown'` reason is additive — existing code that doesn't match on it will simply never see it unless `close()` is called.

---


## [0.2.3] - 2026-02-22

### Security

* Patched a transitive vulnerability in `minimatch` by pinning to ^10.2.1 via npm `overrides`.
* Patched a transitive vulnerability in `ajv` (used by ESLint tooling) by pinning to ^6.12.6 via scoped npm `overrides`.

### Changed

* Added explicit overrides in `package.json` to enforce secure dependency resolution.
* No runtime or public API changes.

### Design Notes

* This release contains dependency security updates only.
* No behavioral changes to bulkhead semantics, queueing, or concurrency limits.
* Fully backward compatible.

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
