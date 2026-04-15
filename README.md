# async-bulkhead-ts

`async-bulkhead-ts` is a minimal, explicit bulkhead primitive for Node.js:
it enforces hard concurrency limits, optionally allows bounded waiting, and makes overload visible via immediate rejection—not latency.

It is designed for:

* APIs and services where latency SLOs matter more than throughput
* Systems where queue growth = failure mode
* Boundaries such as:
  * LLM calls
  * DB / downstream dependencies
  * request fan-out
  * parallel work

It is not:

* a scheduler
* a retry framework
* a background worker
* a resilience “kitchen sink”

---

## Features

* ✅ Hard **max in-flight** concurrency (`maxConcurrent`)
* ✅ Optional **bounded FIFO waiting** (`maxQueue`)
* ✅ **Fail-fast by default** (`maxQueue: 0`)
* ✅ Explicit acquire + release via a **token**
* ✅ `bulkhead.run(fn)` helper (acquire + `finally` release)
* ✅ Optional waiting **timeout** and **AbortSignal** cancellation
* ✅ Graceful shutdown via **`close()`** + **`drain()`**
* ✅ Optional synchronous **instrumentation hooks**
* ✅ Operational counters via **`stats()`**
* ✅ Zero dependencies
* ✅ ESM + CJS support
* ✅ Node.js **20+**

Non-goals (by design):

* ❌ No background workers
* ❌ No retry logic
* ❌ No distributed coordination

---

## Competitive Matrix

| Capability / Library | async-bulkhead-ts | p-limit | p-queue | Bottleneck | cockatiel / polly |
| ------------------- | ----------------- | ------- | ------- | ---------- | ------------------ |
| **Primary goal** | Admission control | Concurrency limit | Task queue | Scheduler + rate limit | Full resilience |
| **Fail-fast by default** | ✅ Yes | ❌ No | ❌ No | ❌ No | ⚠️ Depends |
| **Bounded queue (optional)** | ✅ Yes | ❌ No | ✅ Yes | ✅ Yes | ⚠️ Indirect |
| **Reject reason (typed)** | ✅ Yes | ❌ No | ❌ No | ❌ No | ⚠️ Mixed |
| **Explicit acquire/release** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Abort / timeout (admission)** | ✅ Yes | ❌ No | ⚠️ Partial | ⚠️ Partial | ✅ Yes |
| **No hidden work accumulation** | ✅ Yes | ❌ No | ❌ No | ❌ No | ⚠️ Depends |
| **Designed for overload visibility** | ✅ Core feature | ❌ No | ❌ No | ❌ No | ⚠️ Indirect |
| **Retries / fallback** | ❌ No | ❌ No | ❌ No | ❌ No | ✅ Yes |
| **Scheduling / prioritization** | ❌ No | ❌ No | ✅ Yes | ✅ Yes | ❌ No |
| **Operational stats (in-flight, pending)** | ✅ Yes | ❌ No | ⚠️ Limited | ⚠️ Limited | ⚠️ Limited |

---

### Quick positioning

* **p-limit** → simple concurrency limiting  
* **p-queue / Bottleneck** → queueing + scheduling  
* **cockatiel / polly** → full resilience (retries, breakers, etc.)  
* **async-bulkhead-ts** → **fail-fast admission control (protect latency under load)**

---

### Rule of thumb

> If you want to *process everything eventually*, use a queue.  
> If you want to *protect your system under overload*, use a bulkhead.

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

* Acquire + release handled automatically (finally release)
* Still fail-fast (unless you configure `maxQueue`)
* Rejections throw a typed `BulkheadRejectedError` when using `run()`
* The provided `AbortSignal` is passed through to the function
* Supports waiting cancellation via `AbortSignal` and `timeoutMs`

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

* If `inFlight` < `maxConcurrent`: `acquire()` succeeds immediately.
* Else if `maxQueue` > 0 and queue has space: `acquire()` waits FIFO.
* Else: rejected immediately.

## Cancellation

Waiting can be cancelled with an `AbortSignal`:

```ts
await bulkhead.run(
  async () => doWork(),
  { signal }
);
```

Cancellation guarantees:

* Work that is waiting in the queue can be cancelled before it starts.
* In-flight work is not forcibly terminated (your function may observe the signal).
* Capacity is always released correctly for acquired tokens.
* Cancelled or timed-out waiters do not permanently consume queue capacity.
* Cancelled waiters will not block subsequent admissions.
* FIFO order is preserved for non-cancelled waiters.

You can also bound waiting time:

```ts
await bulkhead.run(async () => doWork(), { timeoutMs: 50 });
```

## Instrumentation

You can attach optional synchronous hooks for admission, rejection, release, and close events:

```ts
const bulkhead = createBulkhead({
  name: 'llm-outbound',
  maxConcurrent: 8,
  maxQueue: 0,
  hooks: {
    onAcquireSuccess(event) {
      metrics.counter('bulkhead_admit_total').add(1, {
        bulkhead: event.name ?? 'unnamed',
      });
    },
    onReject(event) {
      metrics.counter('bulkhead_reject_total').add(1, {
        bulkhead: event.name ?? 'unnamed',
        reason: event.reason,
      });
    },
  },
});
```

Hook semantics:

* Hooks are synchronous and best-effort.
* Hooks should be fast and non-blocking.
* Hook exceptions are swallowed and counted in stats().hookErrors.
* Hooks observe admission state; they do not participate in scheduling or cancellation.

## Graceful Shutdown

`close()` stops new admissions and rejects all pending waiters with `'shutdown'`.
`drain()` resolves when the bulkhead becomes fully idle:

* `inFlight === 0`
* `pending === 0`

```ts
// In your SIGTERM handler:
bulkhead.close();

// All pending waiters are rejected with 'shutdown'.
// All future acquire/run calls reject immediately with 'shutdown'.
// In-flight work is not interrupted — tokens release normally.
await bulkhead.drain();
```

`close()` is synchronous, idempotent, and irreversible. If you need a fresh bulkhead, create a new instance.

`drain()` is an observation primitive — it tells you when work finishes, but it cannot force work to complete. The bulkhead does not own in-flight work. If your functions support cancellation, signal them via the `AbortSignal` you already hold.

`drain()` also works without `close()`. It resolves when current in-flight and pending work completes, but it does not prevent future admissions once it has resolved:

```ts
// Wait for current work to finish, without stopping new admissions.
await bulkhead.drain();
```

## Behavioral Guarantees

* maxConcurrent is never exceeded.
* pending never exceeds maxQueue.
* Under cancellation or timeout churn, admission remains bounded and deterministic.

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
  totalAdmitted: number;
  totalReleased: number;  
  // operational / debug counters:
  aborted?: number;
  timedOut?: number;
  rejected?: number;
  rejectedByReason?: Partial<Record<RejectReason, number>>;
  doubleRelease?: number;
  inFlightUnderflow?: number;
  hookErrors?: number;
};
```

`stats()` is a pure read with no side effects. `totalAdmitted`, `totalReleased`,
and `rejectedByReason` are intended for operational visibility and metrics export.

`inFlightUnderflow` should always be 0. A nonzero value indicates a bug in the library.

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

Apache-2.0 © 2026 Jan Balangue
