# async-bulkhead-ts

Fail-fast **admission control** and **bulkheads** for async workloads in Node.js.

Designed for services that prefer **rejecting work early** over queueing and degrading under load.

---

## Features

- ✅ **Fail-fast by default** (no hidden queues)
- ✅ Simple **bulkhead / concurrency limits**
- ✅ Explicit admission + release lifecycle
- ✅ Zero dependencies
- ✅ ESM + CJS support
- ✅ Node.js **20+**

Non-goals (by design):
- ❌ No background workers
- ❌ No retry logic
- ❌ No distributed coordination
- ❌ No metrics backend (hooks later)

---

## Install

```bash
npm install async-bulkhead-ts
```

## Basic Usage

```ts
import { createBulkhead } from 'async-bulkhead-ts';

const bulkhead = createBulkhead({ maxConcurrent: 10 });
const admission = bulkhead.admit();

if (!admission.ok) {
  // Fail fast — shed load, return 503, etc.
  throw new Error('Service overloaded');
}

try {
  // Do async work
  await doWork();
} finally {
  admission.release();
}
```

## With a Queue (Optional)

Queues are opt-in and bounded.
 ```ts
const bulkhead = createBulkhead({
  maxConcurrent: 10,
  maxQueue: 20,
});
```

If both concurrency and queue limits are exceeded, admission fails immediately.

## API

`createBulkhead(options)`

```ts
type BulkheadOptions = {
  maxConcurrent: number;
  maxQueue?: number;
};
```

Returns:

```json
{
  admit(): AdmitResult;
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
  | { ok: false; reason: 'concurrency_limit' | 'queue_limit' };
```

You must call `release()` exactly once if admission succeeds.

Failing to release will permanently reduce capacity.

## Design Philosophy

This library is intentionally small.

It exists to enforce **backpressure at the boundary** of your system:

* before request fan-out
* before hitting downstream dependencies
* before saturation cascades

If you need retries, buffering, scheduling, or persistence—compose those *around* this, not inside it.

## Compatibility

* Node.js: 20+ (24 LTS recommended)
* Module formats: ESM and CommonJS

## Roadmap (Short)

* `bulkhead.run(fn)` helper
* Structured metrics hooks
* `AbortSignal` / cancellation support
* Optional time-based admission windows

## License

MIT © 2026