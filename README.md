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
- ✅ Graceful shutdown via **`close()`** + **`drain()`**
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
  // 'concurrency_limit' | 'queue_limit' | 'timeout' | 'aborted' | 'shutdown'
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

> Note: bounded waiting is optional.
> Future major versions may focus on fail-fast admission only.

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
- Cancelled or timed-out waiters do not permanently consume queue capacity.
- Cancelled waiters will not block subsequent admissions.
- FIFO order is preserved for non-cancelled waiters.

You can also bound waiting time:

```ts
await bulkhead.run(async () => doWork(), { timeoutMs: 50 });
```

## Graceful Shutdown

`close()` stops admission. `drain()` waits for in-flight work to finish. Together they give you a clean shutdown sequence:

```ts
// In your SIGTERM handler:
bulkhead.close();

// All pending waiters are rejected with 'shutdown'.
// All future acquire/run calls reject immediately with 'shutdown'.
// In-flight work is not interrupted — tokens release normally.

await bulkhead.drain();
// Resolves when inFlight reaches zero.
```

`close()` is synchronous, idempotent, and irreversible. If you need a fresh bulkhead, create a new instance.

`drain()` is an observation primitive — it tells you when work finishes, but it cannot force work to complete. The bulkhead does not own in-flight work. If your functions support cancellation, signal them via the `AbortSignal` you already hold.

`drain()` also works without `close()`. On its own it resolves when current in-flight and pending work completes, but new work can still be admitted:

```ts
// Wait for current work to finish, without stopping new admissions.
await bulkhead.drain();
```

## Behavioral Guarantees

- maxConcurrent is never exceeded.
- pending never exceeds maxQueue.
- Under cancellation or timeout churn, admission remains bounded and deterministic.

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
  close(): void;
  drain(): Promise<void>;
  stats(): Stats;
}
```

`tryAcquire()`

```ts
export type TryAcquireResult =
  | { ok: true; token: Token }
  | { ok: false; reason: 'concurrency_limit' | 'shutdown' };
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
  | { ok: false; reason: RejectReason };

type RejectReason =
  | 'concurrency_limit'
  | 'queue_limit'
  | 'timeout'
  | 'aborted'
  | 'shutdown';
```

`run(fn, options?)`

Throws on rejection:

```ts
class BulkheadRejectedError extends Error {
  readonly code = 'BULKHEAD_REJECTED';
  readonly reason: RejectReason;
}
```

The function passed to `run()` receives the same `AbortSignal` (if provided), allowing
in-flight work to observe cancellation:

```ts
await bulkhead.run(async (signal) => doWork(signal), { signal });
```

`close()`

Stops admission permanently. Rejects all pending waiters with `'shutdown'`. All future `tryAcquire`/`acquire`/`run` calls reject immediately with `'shutdown'`. In-flight tokens remain valid. Idempotent.

`drain()`

Returns a `Promise<void>` that resolves when `inFlight` and pending both reach zero. Multiple concurrent calls all resolve at the same moment. Works with or without `close()`.

`stats()`

```ts
type Stats = {
  inFlight: number;
  pending: number;
  maxConcurrent: number;
  maxQueue: number;
  closed: boolean;
  // debug counters:
  aborted?: number;
  timedOut?: number;
  rejected?: number;
  doubleRelease?: number;
  inFlightUnderflow?: number;
};
```

`stats()` is a pure read with no side effects.

`inFlightUnderflow` should always be 0. A nonzero value indicates a bug in the library.

## Design Philosophy

This library is intentionally small.

It exists to enforce backpressure at the boundary of your system:

- before request fan-out
- before hitting downstream dependencies
- before saturation cascades

If you need retries, buffering, scheduling, or persistence—compose those around this, not inside it.

## Compatibility

- Node.js: 20+ (24 LTS recommended)
- Module formats: ESM and CommonJS


## License

MIT © 2026
