export type BulkheadOptions = {
  maxConcurrent: number;
  maxQueue?: number; // if undefined => no queue (fail fast)
};

export type AdmitResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "concurrency_limit" | "queue_limit" };

export function createBulkhead(opts: BulkheadOptions) {
  if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent <= 0) {
    throw new Error("maxConcurrent must be a positive integer");
  }
  const maxQueue = opts.maxQueue ?? 0;

  let inFlight = 0;
  const queue: Array<() => void> = [];

  const tryStartNext = () => {
    while (inFlight < opts.maxConcurrent && queue.length > 0) {
      const start = queue.shift()!;
      inFlight++;
      start();
    }
  };

  const release = () => {
    inFlight = Math.max(0, inFlight - 1);
    tryStartNext();
  };

  const admit = (): AdmitResult => {
    if (inFlight < opts.maxConcurrent) {
      inFlight++;
      return { ok: true, release };
    }
    if (maxQueue > 0 && queue.length < maxQueue) {
      let started = false;
      const gate = () => {
        started = true;
      };
      queue.push(gate);

      return {
        ok: true,
        release: () => {
          // If not started yet, remove from queue and free slot reserved by queue entry.
          if (!started) {
            const idx = queue.indexOf(gate);
            if (idx >= 0) queue.splice(idx, 1);
          } else {
            release();
          }
        }
      };
    }
    return { ok: false, reason: maxQueue > 0 ? "queue_limit" : "concurrency_limit" };
  };

  return {
    admit,
    stats: () => ({ inFlight, queued: queue.length, maxConcurrent: opts.maxConcurrent, maxQueue })
  };
}
