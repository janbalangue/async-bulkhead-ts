# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/).

---

## [0.1.0] – 2026-01-23

### Added
- Initial release of **async-bulkhead-ts**
- Fail-fast admission control for async workloads
- Simple bulkhead with configurable `maxConcurrent`
- Optional bounded queue via `maxQueue`
- Explicit `admit()` / `release()` lifecycle
- Accurate runtime stats (`inFlight`, `queued`, limits)
- ESM and CommonJS builds
- Full TypeScript typings
- Stress and soak tests validating concurrency invariants

### Design Notes
- No hidden queues by default
- No retries, background workers, or scheduling
- Intended to be composed with higher-level systems, not replace them

---
