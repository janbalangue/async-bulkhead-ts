/**
 * A small ring-buffer queue.
 * - O(1) pushBack / popFront
 * - avoids array shift and head-index + compaction heuristics
 */
class RingDeque<T> {
  private buf: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private size = 0;

  constructor(capacity: number) {
    const cap = Math.max(4, capacity | 0);
    this.buf = new Array<T | undefined>(cap);
  }

  get length() {
    return this.size;
  }

  pushBack(item: T) {
    if (this.size === this.buf.length) {
      this.grow();
    }
    const idx = (this.head + this.size) % this.buf.length;
    this.buf[idx] = item;
    this.size++;
  }

  peekFront(): T | undefined {
    if (this.size === 0) return undefined;
    return this.buf[this.head];
  }

  popFront(): T | undefined {
    if (this.size === 0) return undefined;
    const item = this.buf[this.head];
    this.buf[this.head] = undefined; // help GC
    this.head = (this.head + 1) % this.buf.length;
    this.size--;
    return item;
  }

  private grow() {
    const newBuf = new Array<T | undefined>(this.buf.length * 2);
    for (let i = 0; i < this.size; i++) {
      newBuf[i] = this.buf[(this.head + i) % this.buf.length];
    }
    this.buf = newBuf;
    this.head = 0;
  }
}

export type BulkheadOptions = {
  maxConcurrent: number;
  maxQueue?: number; // pending waiters allowed (0 => no waiting)
};

export type AcquireOptions = {
  signal?: AbortSignal;
  timeoutMs?: number; // waiting timeout only
};

export type Stats = {
  inFlight: number;
  pending: number;
  maxConcurrent: number;
  maxQueue: number;
  closed: boolean;
  // optional debug counters:
  aborted?: number;
  timedOut?: number;
  rejected?: number;
  doubleRelease?: number;
  inFlightUnderflow?: number;
};

export type Token = { release(): void };

export type TryAcquireResult =
  | { ok: true; token: Token }
  | { ok: false; reason: 'concurrency_limit' | 'shutdown' };

export type AcquireResult =
  | { ok: true; token: Token }
  | { ok: false; reason: RejectReason };

type Waiter = {
  resolve: (r: AcquireResult) => void;
  cancelled: boolean;
  settled: boolean;

  abortListener: (() => void) | undefined;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
};

export type RejectReason =
  | 'concurrency_limit'
  | 'queue_limit'
  | 'timeout'
  | 'aborted'
  | 'shutdown';

export class BulkheadRejectedError extends Error {
  readonly code = 'BULKHEAD_REJECTED' as const;

  constructor(readonly reason: RejectReason) {
    super(`Bulkhead rejected: ${reason}`);
    this.name = 'BulkheadRejectedError';
  }
}

export function createBulkhead(opts: BulkheadOptions) {
  // ---- validate ----
  if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent <= 0) {
    throw new Error('maxConcurrent must be a positive integer');
  }
  const maxQueue = opts.maxQueue ?? 0;
  if (!Number.isInteger(maxQueue) || maxQueue < 0) {
    throw new Error('maxQueue must be an integer >= 0');
  }

  // ---- state ----
  let inFlight = 0;
  let closed = false;

  // Live pending count — the number of waiters in the queue that have not
  // been settled (admitted, cancelled, timed out, or aborted). Tracked
  // separately from `q.length` so that `stats()` is a pure read — the
  // queue may contain stale (cancelled/settled) entries that haven't been
  // pruned yet, but `livePending` is always accurate.
  let livePending = 0;

  // FIFO queue as deque (no head index, just pushBack / popFront)
  const q = new RingDeque<Waiter>(maxQueue + 1); // +1 to avoid full queue edge case

  // Drain waiters — resolve functions for pending drain() promises.
  let drainWaiters: Array<() => void> = [];

  // optional counters
  let aborted = 0;
  let timedOut = 0;
  let rejected = 0;
  let doubleRelease = 0;
  let inFlightUnderflow = 0;

  // ---- internal helpers ----

  const cleanupWaiter = (w: Waiter) => {
    if (w.abortListener) w.abortListener();
    if (w.timeoutId) clearTimeout(w.timeoutId);
    w.abortListener = undefined;
    w.timeoutId = undefined;
  };

  const settle = (w: Waiter, r: AcquireResult) => {
    if (w.settled) return;
    w.settled = true;
    // Once settled, it's effectively cancelled for pump-skipping purposes.
    if (!w.cancelled && !r.ok) w.cancelled = true;
    cleanupWaiter(w);
    livePending--;
    w.resolve(r);
  };

  /**
   * Remove cancelled/settled waiters from the front of the queue so the
   * deque doesn't accumulate stale entries. Called from pump() and
   * release paths — never from stats().
   */
  const pruneCancelledFront = () => {
    while (q.length > 0) {
      const w = q.peekFront()!;
      if (w.cancelled || w.settled) {
        q.popFront();
        continue;
      }
      break;
    }
  };

  /** Notify drain() waiters if inFlight has reached zero. */
  const notifyDrainWaiters = () => {
    if (inFlight === 0 && livePending === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  // ---- token factory ----
  const makeToken = (): Token => {
    let released = false;
    return {
      release() {
        if (released) {
          doubleRelease++;
          return;
        }
        released = true;
        inFlight--;
        if (inFlight < 0) {
          inFlightUnderflow++;
          inFlight = 0;
        }
        pump();
        notifyDrainWaiters();
      },
    };
  };

  // ---- pump: admit waiters from the queue when capacity frees ----
  const pump = () => {
    pruneCancelledFront();
    while (inFlight < opts.maxConcurrent && q.length > 0) {
      const w = q.popFront()!;
      if (w.cancelled || w.settled) {
        pruneCancelledFront();
        continue;
      }
      inFlight++;
      settle(w, { ok: true, token: makeToken() });
    }
  };

  // ---- close(): reject all pending, block future admission ----
  const close = (): void => {
    if (closed) return;
    closed = true;

    // Reject all pending waiters.
    while (q.length > 0) {
      const w = q.popFront()!;
      if (w.settled || w.cancelled) continue;
      rejected++;
      settle(w, { ok: false, reason: 'shutdown' });
    }

    // If nothing is in-flight, notify drain waiters immediately.
    notifyDrainWaiters();
  };

  // ---- drain(): wait for inFlight to reach zero ----
  const drainFn = (): Promise<void> => {
    if (inFlight === 0 && livePending === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainWaiters.push(resolve);
    });
  };

  // ---- public APIs ----

  const tryAcquire = (): TryAcquireResult => {
    if (closed) {
      return { ok: false, reason: 'shutdown' };
    }
    if (inFlight < opts.maxConcurrent) {
      inFlight++;
      return { ok: true, token: makeToken() };
    }
    return { ok: false, reason: 'concurrency_limit' };
  };

  const acquire = (ao: AcquireOptions = {}): Promise<AcquireResult> => {
    // closed fast path
    if (closed) {
      rejected++;
      return Promise.resolve({ ok: false, reason: 'shutdown' });
    }

    // immediate fast path
    if (inFlight < opts.maxConcurrent) {
      inFlight++;
      return Promise.resolve({ ok: true, token: makeToken() });
    }

    // no waiting allowed
    if (maxQueue === 0) {
      rejected++;
      return Promise.resolve({ ok: false, reason: 'concurrency_limit' });
    }

    // bounded waiting
    if (livePending >= maxQueue) {
      rejected++;
      return Promise.resolve({ ok: false, reason: 'queue_limit' });
    }

    // enqueue
    return new Promise<AcquireResult>((resolve) => {
      const w: Waiter = {
        resolve,
        cancelled: false,
        settled: false,
        abortListener: undefined,
        timeoutId: undefined,
      };

      livePending++;

      // abort support
      if (ao.signal) {
        if (ao.signal.aborted) {
          aborted++;
          settle(w, { ok: false, reason: 'aborted' });
          return;
        }
        const onAbort = () => {
          aborted++;
          w.cancelled = true;
          settle(w, { ok: false, reason: 'aborted' });
        };

        ao.signal.addEventListener('abort', onAbort, { once: true });
        w.abortListener = () => ao.signal!.removeEventListener('abort', onAbort);
      }

      // timeout support (waiting only)
      if (ao.timeoutMs != null) {
        if (!Number.isFinite(ao.timeoutMs) || ao.timeoutMs < 0) {
          timedOut++;
          settle(w, { ok: false, reason: 'timeout' });
          return;
        }
        w.timeoutId = setTimeout(() => {
          timedOut++;
          w.cancelled = true;
          settle(w, { ok: false, reason: 'timeout' });
        }, ao.timeoutMs);
      }

      q.pushBack(w);
      // Capacity may have freed after the fast-path check but before enqueue.
      if (inFlight < opts.maxConcurrent) {
        pump();
      }
    });
  };

  const run = async <T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    ao: AcquireOptions = {},
  ): Promise<T> => {
    const r = await acquire(ao);
    if (!r.ok) {
      throw new BulkheadRejectedError(r.reason);
    }
    try {
      return await fn(ao.signal);
    } finally {
      r.token.release();
    }
  };

  const stats = (): Stats => ({
    inFlight,
    pending: livePending,
    maxConcurrent: opts.maxConcurrent,
    maxQueue,
    closed,
    aborted,
    timedOut,
    rejected,
    doubleRelease,
    inFlightUnderflow,
  });

  return { tryAcquire, acquire, run, stats, close, drain: drainFn };
}
