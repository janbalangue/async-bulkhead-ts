import { describe, it, expect } from 'vitest';
import { createBulkhead } from '../src/index';

describe('async-bulkhead-ts', () => {
  it('admits up to maxConcurrent', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    const a = bulkhead.admit();
    const b = bulkhead.admit();
    const c = bulkhead.admit();

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toBe('concurrency_limit');
    }
  });

  it('restores capacity on release', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1 });

    const a = bulkhead.admit();
    expect(a.ok).toBe(true);

    const b = bulkhead.admit();
    expect(b.ok).toBe(false);

    if (a.ok) a.release();

    const c = bulkhead.admit();
    expect(c.ok).toBe(true);
  });

  it('tracks stats accurately', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    bulkhead.admit();
    bulkhead.admit();

    const stats = bulkhead.stats();
    expect(stats.inFlight).toBe(2);
    expect(stats.queued).toBe(0);
    expect(stats.maxConcurrent).toBe(2);
  });

  it('supports a bounded queue', () => {
    const bulkhead = createBulkhead({
      maxConcurrent: 1,
      maxQueue: 1,
    });

    const a = bulkhead.admit(); // in-flight
    const b = bulkhead.admit(); // queued
    const c = bulkhead.admit(); // rejected

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);

    if (!c.ok) {
      expect(c.reason).toBe('queue_limit');
    }
  });

  it('drains queue when capacity frees', () => {
    const bulkhead = createBulkhead({
      maxConcurrent: 1,
      maxQueue: 1,
    });

    const a = bulkhead.admit();
    expect(a.ok).toBe(true);

    const b = bulkhead.admit();
    expect(b.ok).toBe(true);

    // Release first slot
    if (a.ok) a.release();

    // Now queue should have drained into in-flight
    const stats = bulkhead.stats();
    expect(stats.inFlight).toBe(1);
    expect(stats.queued).toBe(0);

    // Cleanup
    if (b.ok) b.release();
    expect(bulkhead.stats().inFlight).toBe(0);
  });

  it('fails fast when both concurrency and queue are full', () => {
    const bulkhead = createBulkhead({
      maxConcurrent: 1,
      maxQueue: 0,
    });

    const a = bulkhead.admit();
    const b = bulkhead.admit();

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
  });
});

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function randInt(maxExclusive: number) {
  return Math.floor(Math.random() * maxExclusive);
}

describe('async-bulkhead-ts stress', () => {
  it(
    'soak: inFlight/queued never exceed limits; system drains to zero',
    { timeout: 30_000 },
    async () => {
      const maxConcurrent = 20;
      const maxQueue = 50;

      const bulkhead = createBulkhead({ maxConcurrent, maxQueue });

      const durationMs = 4_000;
      const endAt = Date.now() + durationMs;

      let maxInFlightObserved = 0;
      let maxQueuedObserved = 0;

      let admittedImmediate = 0; // admitted directly into inFlight
      let admittedQueued = 0; // admitted but queued internally
      let rejected = 0;

      const work: Promise<void>[] = [];

      while (Date.now() < endAt) {
        const burst = 5 + randInt(15);

        for (let i = 0; i < burst; i++) {
          const before = bulkhead.stats();
          const admission = bulkhead.admit();

          if (!admission.ok) {
            rejected++;
            continue;
          }

          // Observe bounds after every admission attempt
          const after = bulkhead.stats();
          if (after.inFlight > maxInFlightObserved) maxInFlightObserved = after.inFlight;
          if (after.queued > maxQueuedObserved) maxQueuedObserved = after.queued;

          expect(after.inFlight).toBeLessThanOrEqual(maxConcurrent);
          expect(after.queued).toBeLessThanOrEqual(maxQueue);

          const wasImmediate = before.inFlight < maxConcurrent;

          if (wasImmediate) {
            admittedImmediate++;
            // Only start "real work" for immediately in-flight admits.
            work.push(
              (async () => {
                try {
                  await sleep(1 + randInt(6));
                } finally {
                  admission.release();
                }
              })(),
            );
          } else {
            admittedQueued++;
            // We *can't* safely start work here (queue admission doesn't block).
            // Instead, optionally cancel quickly to churn the queue.
            work.push(
              (async () => {
                await sleep(randInt(3));
                admission.release(); // cancels if not started; releases if started
              })(),
            );
          }
        }

        await sleep(randInt(3));
      }

      await Promise.all(work);

      const finalStats = bulkhead.stats();
      expect(finalStats.inFlight).toBe(0);
      expect(finalStats.queued).toBe(0);

      // Sanity: we actually exercised the system
      expect(admittedImmediate + admittedQueued + rejected).toBeGreaterThan(0);
      expect(maxInFlightObserved).toBeLessThanOrEqual(maxConcurrent);
      expect(maxQueuedObserved).toBeLessThanOrEqual(maxQueue);
    },
  );
});
