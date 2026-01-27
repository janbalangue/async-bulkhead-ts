# async-bulkhead-ts

Fail-fast **admission control** and **bulkheads** for async workloads in Node.js.

Designed for services that prefer **rejecting work early** over queueing and degrading under load.

---

## Features

- ✅ **Fail-fast by default** (no hidden queues)
- ✅ Simple **bulkhead / concurrency limits**
- ✅ Explicit admission + release lifecycle
- ✅ `bulkhead.run(fn)` helper for safe execution
- ✅ Optional cancellation via `AbortSignal`
- ✅ Lightweight lifecycle hooks for metrics
- ✅ Zero dependencies
- ✅ ESM + CJS support
- ✅ Node.js **20+**

Non-goals (by design):
- ❌ No background workers
- ❌ No retry logic
- ❌ No distributed coordination
- ❌ No built-in metrics backend (hooks only)

---

## Install

```bash
npm install async-bulkhead-ts
```

## Basic Usage (Manual)

```ts
import { createBulkhead } from 'async-bulkhead-ts';

const bulkhead = createBulkhead({ maxConcurrent: 10 });
const admission = bulkhead.admit();

if (!admission.ok) {
  // Fail fast — shed load, return 503, etc.
  throw admission.error;
}

try {
  await doWork();
} finally {
  admission.release();
}
```

You must call `release()` exactly once if admission succeeds.
Failing to release permanently reduces capacity.

## Convenience Helper

For most use cases, prefer `bulkhead.run(fn)`:

```ts
await bulkhead.run(async () => {
  await doWork();
});
```

Behavior:

* Admission + release handled automatically
* Still fail-fast
* Admission failures throw typed errors
* Supports cancellation via AbortSignal

## With a Queue (Optional)

Queues are opt-in and bounded.

```ts
const bulkhead = createBulkhead({
  maxConcurrent: 10,
  maxQueue: 20,
});
```

When both concurrency and queue limits are exceeded, admission fails immediately.

Queue ordering is FIFO.

## Cancellation

Bulkhead operations can be bound to an `AbortSignal`:

```ts
await bulkhead.run(
  async () => {
    await doWork();
  },
  { signal }
);
```

Cancellation guarantees:

* Queued work can be cancelled before execution
* In-flight work observes the signal but is not forcibly terminated
* Capacity is always released correctly

## API

`createBulkhead(options)`

```ts
type BulkheadOptions = {
  maxConcurrent: number;
  maxQueue?: number;
};
```

Returns:

```ts
{
  admit(): AdmitResult;
  run<T>(fn: () => Promise<T>, options?): Promise<T>;
  stats(): {
    inFlight: number;
    queued: number;
    maxConcurrent: number;
    maxQueue: number;
  };
}
```

`admit()`

```ts
type AdmitResult =
  | { ok: true; release: () => void }
  | { ok: false; error: BulkheadError };
```

Admission failures are returned as typed errors, not strings.

## Metrics Hooks

Optional lifecycle hooks allow integration with metrics systems:

* admission accepted
* queued
* execution started
* released
* rejected

Hooks are synchronous and side-effect–free by design.

## Design Philosophy

This library is intentionally small.

It exists to enforce backpressure at the boundary of your system:

* before request fan-out
* before hitting downstream dependencies
* before saturation cascades

If you need retries, buffering, scheduling, or persistence—compose those around this, not inside it.

## Compatibility

* Node.js: 20+ (24 LTS recommended)
* Module formats: ESM and CommonJS

## License

MIT © 2026