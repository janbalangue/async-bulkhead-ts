import { describe, it, expect } from "vitest";
import { createBulkhead } from "../src/index";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function randInt(maxExclusive: number) {
  return Math.floor(Math.random() * maxExclusive);
}

async function isSettled(p: Promise<unknown>, withinMs = 5) {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(withinMs);
  return settled;
}

describe("async-bulkhead-ts v0.2.1", () => {
  it("tryAcquire admits up to maxConcurrent", () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    const a = bulkhead.tryAcquire();
    const b = bulkhead.tryAcquire();
    const c = bulkhead.tryAcquire();

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);

    if (!c.ok) {
      // tryAcquire never waits; a rejection is always concurrency-limit
      expect(c.reason).toBe("concurrency_limit");
    }

    if (a.ok) a.token.release();
    if (b.ok) b.token.release();
  });

  it("tryAcquire ignores maxQueue and still fails with concurrency_limit when full", () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 10 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const b = bulkhead.tryAcquire();
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("concurrency_limit");

    if (a.ok) a.token.release();
  });

  it("restores capacity on release", () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const b = bulkhead.tryAcquire();
    expect(b.ok).toBe(false);

    if (a.ok) a.token.release();

    const c = bulkhead.tryAcquire();
    expect(c.ok).toBe(true);

    if (c.ok) c.token.release();
  });

  it("tracks stats accurately", () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    const a = bulkhead.tryAcquire();
    const b = bulkhead.tryAcquire();

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const stats = bulkhead.stats();
    expect(stats.inFlight).toBe(2);
    expect(stats.pending).toBe(0);
    expect(stats.maxConcurrent).toBe(2);
    expect(stats.maxQueue).toBe(0);

    if (a.ok) a.token.release();
    if (b.ok) b.token.release();
    expect(bulkhead.stats().inFlight).toBe(0);
  });

  it("supports a bounded queue via acquire (waits) and rejects beyond maxQueue", async () => {
    const bulkhead = createBulkhead({
      maxConcurrent: 1,
      maxQueue: 1,
    });

    const a = bulkhead.tryAcquire(); // consumes the only slot
    expect(a.ok).toBe(true);

    const bPromise = bulkhead.acquire(); // should enqueue (pending)
    expect(await isSettled(bPromise, 5)).toBe(false);

    const c = await bulkhead.acquire(); // should reject immediately (queue full)
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe("queue_limit");

    const stats1 = bulkhead.stats();
    expect(stats1.inFlight).toBe(1);
    expect(stats1.pending).toBe(1);

    // releasing a should grant b
    if (a.ok) a.token.release();
    const b = await bPromise;
    expect(b.ok).toBe(true);

    const stats2 = bulkhead.stats();
    expect(stats2.inFlight).toBe(1);
    expect(stats2.pending).toBe(0);

    if (b.ok) b.token.release();
    expect(bulkhead.stats().inFlight).toBe(0);
  });

  it("drains queue when capacity frees (FIFO)", async () => {
    const bulkhead = createBulkhead({
      maxConcurrent: 1,
      maxQueue: 2,
    });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const bP = bulkhead.acquire();
    const cP = bulkhead.acquire();

    expect(await isSettled(bP, 5)).toBe(false);
    expect(await isSettled(cP, 5)).toBe(false);

    let s = bulkhead.stats();
    expect(s.inFlight).toBe(1);
    expect(s.pending).toBe(2);

    if (a.ok) a.token.release();

    const b = await bP;
    expect(b.ok).toBe(true);

    s = bulkhead.stats();
    expect(s.inFlight).toBe(1);
    expect(s.pending).toBe(1);

    if (b.ok) b.token.release();

    const c = await cP;
    expect(c.ok).toBe(true);

    s = bulkhead.stats();
    expect(s.inFlight).toBe(1);
    expect(s.pending).toBe(0);

    if (c.ok) c.token.release();
    expect(bulkhead.stats().inFlight).toBe(0);
  });

  it("fails fast when concurrency is full and maxQueue is 0", async () => {
    const bulkhead = createBulkhead({
      maxConcurrent: 1,
      maxQueue: 0,
    });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const bTry = bulkhead.tryAcquire();
    expect(bTry.ok).toBe(false);
    if (!bTry.ok) expect(bTry.reason).toBe("concurrency_limit");

    const b = await bulkhead.acquire();
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("concurrency_limit");

    if (a.ok) a.token.release();
  });

  it("aborts a pending acquire and does not grant it later", async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 1 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const ac = new AbortController();
    const bP = bulkhead.acquire({ signal: ac.signal });

    expect(await isSettled(bP, 5)).toBe(false);

    ac.abort();
    const b = await bP;

    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("aborted");

    // now free capacity and ensure there isn't a "ghost" waiter that consumes it
    if (a.ok) a.token.release();
    const c = bulkhead.tryAcquire();
    expect(c.ok).toBe(true);
    if (c.ok) c.token.release();

    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });

  it("times out a pending acquire and does not grant it later", async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 1 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const b = await bulkhead.acquire({ timeoutMs: 10 });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("timeout");

    if (a.ok) a.token.release();

    const c = bulkhead.tryAcquire();
    expect(c.ok).toBe(true);
    if (c.ok) c.token.release();

    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });

  it("run() acquires + releases even on throw", async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1 });

    await expect(
      bulkhead.run(async () => {
        await sleep(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });
});

describe("async-bulkhead-ts v0.2.1 stress", () => {
  it(
    "soak: inFlight/pending never exceed limits; system drains to zero",
    { timeout: 30_000 },
    async () => {
      const maxConcurrent = 20;
      const maxQueue = 50;

      const bulkhead = createBulkhead({ maxConcurrent, maxQueue });

      const durationMs = 4_000;
      const endAt = Date.now() + durationMs;

      let maxInFlightObserved = 0;
      let maxPendingObserved = 0;

      let granted = 0;
      let rejected = 0;

      const work: Promise<void>[] = [];

      while (Date.now() < endAt) {
        const burst = 5 + randInt(15);

        for (let i = 0; i < burst; i++) {
          // create some churn: some waiters will timeout or abort while pending
          const mode = randInt(10);

          if (mode === 0) {
            // Abort quickly
            const ac = new AbortController();
            const p = (async () => {
              const rP = bulkhead.acquire({ signal: ac.signal });
              // abort shortly after enqueuing
              await sleep(randInt(3));
              ac.abort();
              const r = await rP;
              if (r.ok) {
                granted++;
                try {
                  await sleep(1 + randInt(6));
                } finally {
                  r.token.release();
                }
              } else {
                rejected++;
              }
            })();
            work.push(p);
          } else if (mode === 1) {
            // Timeout
            const p = (async () => {
              const r = await bulkhead.acquire({ timeoutMs: 2 + randInt(6) });
              if (r.ok) {
                granted++;
                try {
                  await sleep(1 + randInt(6));
                } finally {
                  r.token.release();
                }
              } else {
                rejected++;
              }
            })();
            work.push(p);
          } else {
            // Normal acquire + work
            const p = (async () => {
              const r = await bulkhead.acquire();
              if (!r.ok) {
                rejected++;
                return;
              }
              granted++;
              try {
                await sleep(1 + randInt(6));
              } finally {
                r.token.release();
              }
            })();
            work.push(p);
          }

          // Observe bounds frequently
          const s = bulkhead.stats();
          if (s.inFlight > maxInFlightObserved) maxInFlightObserved = s.inFlight;
          if (s.pending > maxPendingObserved) maxPendingObserved = s.pending;

          expect(s.inFlight).toBeLessThanOrEqual(maxConcurrent);
          expect(s.pending).toBeLessThanOrEqual(maxQueue);
        }

        await sleep(randInt(3));
      }

      await Promise.all(work);

      const finalStats = bulkhead.stats();
      expect(finalStats.inFlight).toBe(0);
      expect(finalStats.pending).toBe(0);

      // Sanity: we actually exercised the system
      expect(granted + rejected).toBeGreaterThan(0);
      expect(maxInFlightObserved).toBeLessThanOrEqual(maxConcurrent);
      expect(maxPendingObserved).toBeLessThanOrEqual(maxQueue);
    },
  );
});
