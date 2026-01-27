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
  // optional debug counters:
  aborted?: number;
  timedOut?: number;
  rejected?: number;
  doubleRelease?: number;
};

export type Token = { release(): void };

export type TryAcquireResult =
  | { ok: true; token: Token }
  | { ok: false; reason: 'concurrency_limit' | 'queue_limit' };

export type AcquireResult =
  | { ok: true; token: Token }
  | { ok: false; reason: 'concurrency_limit' | 'queue_limit' | 'timeout' | 'aborted' };

type Waiter = {
  resolve: (r: AcquireResult) => void;
  cancelled: boolean;

  abortListener: (() => void) | undefined;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
};

export type RejectReason = 'concurrency_limit' | 'queue_limit' | 'timeout' | 'aborted';

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

  // FIFO queue as array with head index (cheap shift)
  const q: Waiter[] = [];
  let qHead = 0;

  // optional counters
  let aborted = 0;
  let timedOut = 0;
  let rejected = 0;
  let doubleRelease = 0;

  const pendingCount = () => q.length - qHead;

  // ---- token factory ----
  const makeToken = (): Token => {
    let released = false;
    return {
      release() {
        if (released) {
          doubleRelease++;
          return; // idempotent; consider throw in dev builds if you prefer
        }
        released = true;
        inFlight--;
        if (inFlight < 0) inFlight = 0; // defensive, should never happen
        drain();
      },
    };
  };

  const cleanupWaiter = (w: Waiter) => {
    if (w.abortListener) w.abortListener();
    if (w.timeoutId) clearTimeout(w.timeoutId);
    w.abortListener = undefined;
    w.timeoutId = undefined;
  };

  // ---- drain algorithm ----
  const drain = () => {
    while (inFlight < opts.maxConcurrent && pendingCount() > 0) {
      const w = q[qHead++]!;
      // skip cancelled waiters
      if (w.cancelled) {
        cleanupWaiter(w);
        continue;
      }

      // grant slot
      inFlight++;
      cleanupWaiter(w);
      w.resolve({ ok: true, token: makeToken() });
    }

    // occasional compaction to avoid unbounded growth
    if (qHead > 1024 && qHead * 2 > q.length) {
      q.splice(0, qHead);
      qHead = 0;
    }
  };

  // ---- public APIs ----

  const tryAcquire = (): TryAcquireResult => {
    if (inFlight < opts.maxConcurrent) {
      inFlight++;
      return { ok: true, token: makeToken() };
    }
    // tryAcquire never waits; queue_limit matters only if maxQueue configured
    if (maxQueue > 0 && pendingCount() >= maxQueue) {
      rejected++;
      return { ok: false, reason: 'queue_limit' };
    }
    rejected++;
    return { ok: false, reason: maxQueue > 0 ? 'queue_limit' : 'concurrency_limit' };
  };

  const acquire = (ao: AcquireOptions = {}): Promise<AcquireResult> => {
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
    if (pendingCount() >= maxQueue) {
      rejected++;
      return Promise.resolve({ ok: false, reason: 'queue_limit' });
    }

    // enqueue
    return new Promise<AcquireResult>((resolve) => {
      const w: Waiter = {
        resolve,
        cancelled: false,
        abortListener: undefined,
        timeoutId: undefined,
      };

      // abort support
      if (ao.signal) {
        if (ao.signal.aborted) {
          aborted++;
          resolve({ ok: false, reason: 'aborted' });
          return;
        }
        const onAbort = () => {
          // mark cancelled; drain() will skip it
          if (!w.cancelled) {
            w.cancelled = true;
            aborted++;
            cleanupWaiter(w);
            resolve({ ok: false, reason: 'aborted' });
          }
        };
        ao.signal.addEventListener('abort', onAbort, { once: true });
        w.abortListener = () => ao.signal!.removeEventListener('abort', onAbort);
      }

      // timeout support (waiting only)
      if (ao.timeoutMs != null) {
        if (!Number.isFinite(ao.timeoutMs) || ao.timeoutMs < 0) {
          // invalid => treat as immediate timeout
          timedOut++;
          resolve({ ok: false, reason: 'timeout' });
          return;
        }
        w.timeoutId = setTimeout(() => {
          if (!w.cancelled) {
            w.cancelled = true;
            timedOut++;
            cleanupWaiter(w);
            resolve({ ok: false, reason: 'timeout' });
          }
        }, ao.timeoutMs);
      }

      q.push(w);
      // NOTE: we do NOT reserve capacity here.
      // A slot is consumed only when drain() grants a token.

      // No need to call drain() here because we already know we’re at capacity,
      // but it doesn’t hurt if you want (for races with release).
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
    pending: pendingCount(),
    maxConcurrent: opts.maxConcurrent,
    maxQueue,
    aborted,
    timedOut,
    rejected,
    doubleRelease,
  });

  return { tryAcquire, acquire, run, stats };
}
