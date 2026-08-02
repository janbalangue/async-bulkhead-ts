# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.2] - 2026-08-01

### Changed

- Extended the CI matrix to Node 24 alongside 20 and 22. This was written up
  as part of 1.0.1 (see below) but the corresponding `ci.yml` change was
  never committed, so 1.0.1's CI actually only ran on 20 and 22. Lint, tests,
  build, and pack pass on all three versions now.

---

## [1.0.1] - 2026-07-29

No runtime or API change. The published `dist/` output is byte-identical to
`1.0.0`; this release exists only because the `package.json` fix below ships
inside the package tarball and npm versions are immutable.

### Fixed

- Changed the `test` script from `vitest` to `vitest run`. Vitest enters watch
  mode when stdout is a TTY, so `prepublishOnly` (`npm run test && npm run
  build`) hung indefinitely when `npm publish` was invoked from an interactive
  terminal and never reached the build step. Non-TTY contexts such as CI were
  unaffected, which is why the defect was not visible in automated runs.

### Added

- Added a `test:watch` script preserving the previous watch-mode behavior under
  an explicit name.

### Changed

- Extended the CI matrix to Node 24 alongside 20 and 22, matching
  `async-bulkhead-llm`. Lint, tests, build, and pack pass on all three.

---

## [1.0.0] - 2026-07-14

First stable release. This is an **API-stability commitment**, not a feature
change — the public surface below is now frozen under SemVer for the 1.x line.

### Stable public API

The following are guaranteed stable within 1.x. Removals or incompatible
renames will require a 2.0:

- **Factory:** `createBulkhead(options)`
- **Instance methods:** `tryAcquire()`, `acquire()`, `run()`, `close()`, `drain()`, `stats()`
- **Options:** `maxConcurrent`, `maxQueue`, `timeoutMs`, `name`, `hooks`
- **Reject reasons:** `'concurrency_limit' | 'queue_limit' | 'timeout' | 'aborted' | 'shutdown'`
- **Types:** `BulkheadOptions`, `AcquireOptions`, `Token`, `TryAcquireResult`,
  `AcquireResult`, `RejectReason`, `Stats`, `BulkheadHooks`, `BulkheadEvent`,
  `BulkheadRejectEvent`, `BulkheadCloseEvent`, `BulkheadRejectedError`

### Committed

- The bounded FIFO queue (`maxQueue`, `timeoutMs`) is a **stable, opt-in**
  part of the v1 API. Prior README language suggesting it might be removed in a
  future major has been withdrawn. Fail-fast admission (`maxQueue: 0`) remains
  the default.

### Notes

- No runtime behavior change from `0.4.2`. Existing `0.4.x` consumers can adopt
  `1.0.0` by widening their version range; because `^0.4.x` resolves to
  `>=0.4.1 <0.5.0`, the bump to `1.0.0` is deliberate, not automatic.

---

## [0.4.2] - 2026-05-11

### Security

- Patched a transitive vulnerability in `postcss` (via `tsup`) by pinning to ^8.5.10 via npm `overrides`. See [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93).

### Changed

- Added explicit override in `package.json` to enforce secure dependency resolution.
- No runtime or public API changes.

### Tests

- Fixed untyped `Promise<unknown>[]` in mass-abort stress test; array is now `Promise<AcquireResult>[]` so the loop variable resolves through the discriminated union.

### Notes

- `postcss` is a transitive dev dependency (build tooling only) and is not present in the published package. This vulnerability does not affect consumers at runtime.
- Fully backward compatible.

---

## [0.4.1] - 2026-04-15

### Documentation

- Corrected the `BulkheadOptions` API docs in the README to include:
  - `name?: string`
  - `hooks?: BulkheadHooks`
- Clarified hook timing semantics in the README.
- Documented `onRelease` as a post-release/post-pump snapshot: if a queued waiter is admitted immediately, the hook may observe `inFlight` already refilled and `pending` already reduced.

### Notes

- No runtime behavior changes.
- No public API changes.
- This release aligns README documentation with the published `0.4.0` implementation.

---

## [0.4.0] - 2026-04-15

### Added

- Optional `name` field on `BulkheadOptions` for bulkhead identification in logs and metrics.
- Optional synchronous instrumentation hooks on `BulkheadOptions`:
  - `onAcquireSuccess`
  - `onReject`
  - `onRelease`
  - `onClose`
- Operational counters on `stats()`:
  - `totalAdmitted`
  - `totalReleased`
  - `rejectedByReason`
  - `hookErrors`

### Changed

- `stats()` now serves as an operational telemetry surface in addition to debug observation.
- Hook exceptions are swallowed and counted in `hookErrors` so instrumentation cannot corrupt bulkhead state.
- Removed an unused internal deque field.

### Documentation

- Added instrumentation examples and hook semantics to the README.
- Clarified that hooks are synchronous, best-effort, and should remain fast/non-blocking.

### Tests

- Added coverage for hook firing order and state snapshots.
- Added coverage for `totalAdmitted`, `totalReleased`, and `rejectedByReason`.
- Added coverage proving hook exceptions do not corrupt state and are counted in `hookErrors`.

### Notes

- No change to core admission semantics.
- `tryAcquire()` remains non-blocking.
- `acquire()` remains bounded-wait or fail-fast depending on `maxQueue`.
- `close()` / `drain()` semantics are unchanged.

---

## [0.3.1] - 2026-04-13

### Changed

- Updated package metadata to reflect the current release line.
- License changed from MIT to Apache-2.0.

### Documentation

- Updated README to document the current public API, including `close()`, `drain()`, `shutdown`, `closed`, and `inFlightUnderflow`.
- Clarified graceful shutdown behavior and `drain()` semantics.
- Aligned README examples and API docs with the current implementation.

### Notes

- No runtime behavior changes.
- This release aligns documentation, package metadata, and licensing with the already-published v0.3.0 feature set.

---

## [0.3.0] - 2026-02-26

### Added

- `close()` — stops admission permanently. All pending waiters are rejected with `'shutdown'`; all future `tryAcquire`/`acquire`/`run` calls reject immediately. In-flight work is not interrupted — tokens remain valid and release normally. Idempotent and synchronous.
- `drain()` — returns a `Promise<void>` that resolves when `inFlight` and pending both reach zero. Works independently of `close()`. Compose as `close()` → `drain()` for graceful shutdown.
- `'shutdown'` added to `RejectReason` union. Flows through `BulkheadRejectedError` without breaking existing switch/match consumers.
- `closed` field on `Stats`.
- `inFlightUnderflow` counter on `Stats` — observable counter that increments if `inFlight` ever goes negative (should always be 0; nonzero indicates a bug). Replaces the previous silent clamp.

### Changed

- `stats()` is now a pure read. Previously it called `pruneCancelledFront()` internally, mutating the queue on every read. Pending count is now tracked via a `livePending` counter maintained on enqueue and settle. The queue is only pruned during the admission pump.
- Internal `drain` function renamed to `pump`. The internal function that admits waiters from the queue is now `pump()`, freeing `drain` for the public API.
- Redundant pump-on-enqueue removed. The unconditional `drain()` call at the end of the `acquire` promise constructor is replaced with a guarded check, avoiding a full queue walk when concurrency is known to be saturated.

### Tests

- `close()`: rejects pending waiters, rejects future admission, does not cancel in-flight work, cleans up abort listeners and timeouts, idempotent.
- `drain()`: resolves immediately when empty, resolves on last release, multiple callers all resolve, works without `close()`, waits for pending→admitted work.
- `close()` + `drain()` composition: graceful shutdown pattern, drain-then-close ordering, close with nothing in-flight.
- Mass abort: 100 simultaneous aborts, system drains cleanly, no ghost waiters.
- Soak with mid-run close/drain: invariants hold under churn when shutdown fires during active traffic.
- `stats()` purity: repeated calls return identical results with no side effects.

### Design Notes

- `close()` is irreversible — a closed bulkhead stays closed. Create a new instance if you need a fresh one.
- `drain()` is an observation primitive, not a cancellation primitive. The bulkhead does not own in-flight work and cannot force it to complete.
- Fully backward compatible for existing consumers. The new `'shutdown'` reason is additive — existing code that doesn't match on it will simply never see it unless `close()` is called.

---

## [0.2.3] - 2026-02-22

### Security

- Patched a transitive vulnerability in `minimatch` by pinning to 10.2.1 via npm `overrides`.
- Patched a transitive vulnerability in `ajv` (used by ESLint tooling) by pinning to 6.12.6 via scoped npm `overrides`.

### Changed

- Added explicit overrides in `package.json` to enforce secure dependency resolution.
- No runtime or public API changes.

### Design Notes

- This release contains dependency security updates only.
- No behavioral changes to bulkhead semantics, queueing, or concurrency limits.
- Fully backward compatible.

---

## [0.2.2] - 2026-02-20

### Changed

- Internal pending queue replaced with a ring-buffer deque to avoid O(n) operations under contention.
- Cancelled / timed-out waiters are pruned from the front of the queue to prevent queue-slot leaks and head-of-line blocking.
- Admission drain path hardened to skip cancelled waiters deterministically.

### Tests

- Expanded race coverage for abort/timeout vs release ordering.
- Added stress/soak coverage to validate `maxConcurrent` / `maxQueue` invariants under churn.

### Design Notes

- No public API changes.
- Behavioral intent unchanged: FIFO waiting remains bounded by `maxQueue`.
- Queueing remains opt-in; the long-term direction favors fail-fast admission.

---

## [0.2.1] - 2026-01-29

### Changed

- Tightened `tryAcquire()` semantics: it is now strictly non-blocking and never enqueues. A failed `tryAcquire()` always reports `concurrency_limit`.
- Hardened the `acquire()` waiting path to guarantee pending requests settle exactly once under abort, timeout, and release races.
- TypeScript types for `tryAcquire()` were tightened to remove queue-related failure reasons that could not occur.

### Documentation

- Corrected documentation to align with actual behavior of `tryAcquire()` (removed implication of queue-related failures).
- Clarified the distinction between `tryAcquire()` (immediate, non-blocking) and `acquire()` (may wait, bounded by `maxQueue`).

### Design Notes

- No new features 
- Behavior is unchanged aside from clarified `tryAcquire()` semantics and stronger internal invariants.

---

## [0.2.0] – 2026-01-26

> Note: The v0.2.0 API evolved during development; some early design concepts
> described here were simplified or removed before the final release.

### Added

- `bulkhead.run(fn)` convenience helper to safely wrap async work with automatic acquire / release handling
- Optional AbortSignal support to allow callers to cancel queued or in-flight work
- Additional stress and soak tests covering cancellation and helper APIs

### Changed

- Internal admission bookkeeping simplified to reduce edge-case state transitions
- Queue handling made more explicit and deterministic under contention
- Test suite reorganized for clearer invariants and failure diagnostics

### Breaking Changes

- Queue behavior now guarantees FIFO ordering when maxQueue is enabled

### Design Notes

- Helpers remain optional: the core fail-fast admission model is unchanged
- No retries, scheduling, or background workers were added
- Metrics hooks are synchronous and side-effect–free by design

---

## [0.1.0] – 2026-01-23

### Added

- Initial release of **async-bulkhead-ts**
- Fail-fast admission control for async workloads
- Simple bulkhead with configurable `maxConcurrent`
- Optional bounded queue via `maxQueue`
- Explicit admission and release lifecycle
- Accurate runtime stats (`inFlight`, `queued`, limits)
- ESM and CommonJS builds
- Full TypeScript typings
- Stress and soak tests validating concurrency invariants

### Design Notes

- No hidden queues by default
- No retries, background workers, or scheduling
- Intended to be composed with higher-level systems, not replace them

---
