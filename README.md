# async-bulkhead-ts

Fail-fast **admission control** (async bulkheads) for Node.js / TypeScript.

Designed for services that prefer **rejecting work early** over silently degrading via growing queues and timeouts.

---

## Features

- ✅ Hard **max in-flight** concurrency (`maxConcurrent`)
- ✅ Optional **bounded FIFO waiting** (`maxQueue`)
- ✅ **Fail-fast by default** (`maxQueue: 0`)
- ✅ Explicit acquire + release via a **token**
- ✅ `bulkhead.run(fn)` helper (acquire + `finally` release)
- ✅ Optional waiting **timeout** and **AbortSignal** cancellation
- ✅ Zero dependencies
- ✅ ESM + CJS support
- ✅ Node.js **20+**

Non-goals (by design):
- ❌ No background workers
- ❌ No retry logic
- ❌ No distributed coordination

---

## Install

```bash
npm install async-bulkhead-ts
```

## Basic Usage (Manual acquire/release)

```ts
import { createBulkhead } from 'async-bulkhead-ts';

const bulkhead = createBulkhead({
  maxConcurrent: 10,
});

const r = await bulkhead.acquire();

if (!r.ok) {
  // Fail fast — shed load, return 503, etc.
  // r.reason is one of:
  // 'concurrency_limit' | 'queue_limit' | 'timeout' | 'aborted'
  throw new Error(`Rejected: ${r.reason}`);
}

try {
  await doWork();
} finally {
  r.token.release();
}
```

You must call `token.release()` exactly once if acquisition succeeds.
Failing to release permanently reduces available capacity.

## Convenience Helper

For most use cases, prefer `bulkhead.run(fn)`:

```ts
await bulkhead.run(async () => doWork());
```

Behavior:

- Acquire + release handled automatically (finally release)
- Still fail-fast (unless you configure `maxQueue`)
- Rejections throw a typed `BulkheadRejectedError` when using `run()`
- The provided `AbortSignal` is passed through to the function
- Supports waiting cancellation via `AbortSignal` and `timeoutMs`

> The signal passed to `run()` only affects admission and observation; in-flight work is not forcibly cancelled.

## With a Queue (Optional)

Waiting is opt-in and bounded (FIFO).

```ts
const bulkhead = createBulkhead({
  maxConcurrent: 10,
  maxQueue: 20,
});
```

Semantics:
- If `inFlight` < `maxConcurrent`: `acquire()` succeeds immediately.
- Else if `maxQueue` > 0 and queue has space: `acquire()` waits FIFO.
- Else: rejected immediately.

## Cancellation

Waiting can be cancelled with an `AbortSignal`:

```ts
await bulkhead.run(
  async () => doWork(),
  { signal }
);
```

Cancellation guarantees:
- Work that is waiting in the queue can be cancelled before it starts.
- In-flight work is not forcibly terminated (your function may observe the signal).
- Capacity is always released correctly for acquired tokens.

You can also bound waiting time:

```ts
await bulkhead.run(async () => doWork(), { timeoutMs: 50 });
```

## API

`createBulkhead(options)`

```ts
type BulkheadOptions = {
  maxConcurrent: number;
  maxQueue?: number; // pending waiters allowed (0 => no waiting)
};
```

Returns:

```ts
{
  tryAcquire(): TryAcquireResult;
  acquire(options?): Promise<AcquireResult>;
  run<T>(fn: (signal?: AbortSignal) => Promise<T>, options?): Promise<T>;
  stats(): {
    inFlight: number;
    pending: number;
    maxConcurrent: number;
    maxQueue: number;
    aborted?: number;
    timedOut?: number;
    rejected?: number;
    doubleRelease?: number;
  };
}
```

`tryAcquire()`

```ts
export type TryAcquireResult =
  | { ok: true; token: Token }
  | { ok: false; reason: 'concurrency_limit' };
```

> `tryAcquire()` never waits and never enqueues; it either acquires immediately or fails fast.

`acquire(options?)`

```ts
type AcquireOptions = {
  signal?: AbortSignal;
  timeoutMs?: number; // waiting timeout only
};

type AcquireResult =
  | { ok: true; token: Token }
  | { ok: false; reason: 'concurrency_limit' | 'queue_limit' | 'timeout' | 'aborted' };
```

`run(fn, options?)`

Throws on rejection:

```ts
class BulkheadRejectedError extends Error {
  readonly code = 'BULKHEAD_REJECTED';
  readonly reason: 'concurrency_limit' | 'queue_limit' | 'timeout' | 'aborted';
}
```

The function passed to `run()` receives the same `AbortSignal` (if provided), allowing
in-flight work to observe cancellation:

```ts
await bulkhead.run(async (signal) => doWork(signal), { signal });
```

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