import { describe, it, expect } from 'vitest';
import { createBulkhead, BulkheadRejectedError } from '../src/index';

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

// ============================================================
// Existing v0.2.2 behaviour (carried forward)
// ============================================================

describe('core admission', () => {
  it('tryAcquire admits up to maxConcurrent', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    const a = bulkhead.tryAcquire();
    const b = bulkhead.tryAcquire();
    const c = bulkhead.tryAcquire();

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);

    if (!c.ok) {
      expect(c.reason).toBe('concurrency_limit');
    }

    if (a.ok) a.token.release();
    if (b.ok) b.token.release();
  });

  it('tryAcquire ignores maxQueue and still fails with concurrency_limit when full', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 10 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const b = bulkhead.tryAcquire();
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('concurrency_limit');

    if (a.ok) a.token.release();
  });

  it('restores capacity on release', () => {
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

  it('tracks stats accurately', () => {
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

  it('supports a bounded queue via acquire (waits) and rejects beyond maxQueue', async () => {
    const bulkhead = createBulkhead({
      maxConcurrent: 1,
      maxQueue: 1,
    });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const bPromise = bulkhead.acquire();
    expect(await isSettled(bPromise, 5)).toBe(false);

    const c = await bulkhead.acquire();
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('queue_limit');

    const stats1 = bulkhead.stats();
    expect(stats1.inFlight).toBe(1);
    expect(stats1.pending).toBe(1);

    if (a.ok) a.token.release();
    const b = await bPromise;
    expect(b.ok).toBe(true);

    const stats2 = bulkhead.stats();
    expect(stats2.inFlight).toBe(1);
    expect(stats2.pending).toBe(0);

    if (b.ok) b.token.release();
    expect(bulkhead.stats().inFlight).toBe(0);
  });

  it('drains queue when capacity frees (FIFO)', async () => {
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

  it('fails fast when concurrency is full and maxQueue is 0', async () => {
    const bulkhead = createBulkhead({
      maxConcurrent: 1,
      maxQueue: 0,
    });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const bTry = bulkhead.tryAcquire();
    expect(bTry.ok).toBe(false);
    if (!bTry.ok) expect(bTry.reason).toBe('concurrency_limit');

    const b = await bulkhead.acquire();
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('concurrency_limit');

    if (a.ok) a.token.release();
  });

  it('run() acquires + releases even on throw', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1 });

    await expect(
      bulkhead.run(async () => {
        await sleep(1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });
});

// ============================================================
// Abort / timeout / cancellation (carried forward)
// ============================================================

describe('cancellation', () => {
  it('aborts a pending acquire and does not grant it later', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 1 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const ac = new AbortController();
    const bP = bulkhead.acquire({ signal: ac.signal });

    expect(await isSettled(bP, 5)).toBe(false);

    ac.abort();
    const b = await bP;

    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('aborted');

    const s0 = bulkhead.stats();
    expect(s0.inFlight).toBe(1);
    expect(s0.pending).toBe(0);

    if (a.ok) a.token.release();
    const c = bulkhead.tryAcquire();
    expect(c.ok).toBe(true);
    if (c.ok) c.token.release();

    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });

  it('cancellation storm does not starve a later live waiter', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 3 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const bP = bulkhead.acquire({ signal: ac1.signal });
    const cP = bulkhead.acquire({ signal: ac2.signal });

    expect(await isSettled(bP, 5)).toBe(false);
    expect(await isSettled(cP, 5)).toBe(false);

    ac1.abort();
    ac2.abort();

    const b = await bP;
    const c = await cP;

    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('aborted');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('aborted');

    const dP = bulkhead.acquire();
    expect(await isSettled(dP, 5)).toBe(false);

    if (a.ok) a.token.release();

    const d = await dP;
    expect(d.ok).toBe(true);
    if (d.ok) d.token.release();

    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });

  it('abort vs release race settles exactly once (no ghost admission)', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 1 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const ac = new AbortController();
    const bP = bulkhead.acquire({ signal: ac.signal });
    expect(await isSettled(bP, 5)).toBe(false);

    const r = randInt(3);
    if (r === 0) {
      ac.abort();
      if (a.ok) a.token.release();
    } else if (r === 1) {
      if (a.ok) a.token.release();
      ac.abort();
    } else {
      const t1 = sleep(randInt(3)).then(() => ac.abort());
      const t2 = sleep(randInt(3)).then(() => {
        if (a.ok) a.token.release();
      });
      await Promise.all([t1, t2]);
    }

    const b = await bP;

    if (b.ok) {
      b.token.release();
    } else {
      expect(b.reason).toBe('aborted');
    }

    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });

  it('timeout vs release race settles exactly once (no ghost admission)', async () => {
    for (let i = 0; i < 50; i++) {
      const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 1 });

      const a = bulkhead.tryAcquire();
      expect(a.ok).toBe(true);

      const bP = bulkhead.acquire({ timeoutMs: 25 + randInt(10) });
      expect(await isSettled(bP, 5)).toBe(false);

      await sleep(randInt(6));
      if (a.ok) a.token.release();

      const b = await bP;
      if (b.ok) {
        b.token.release();
      } else {
        expect(b.reason).toBe('timeout');
      }

      const s = bulkhead.stats();
      expect(s.inFlight).toBe(0);
      expect(s.pending).toBe(0);
    }
  });

  it('times out a pending acquire and does not grant it later', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 1 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const b = await bulkhead.acquire({ timeoutMs: 10 });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('timeout');

    const s0 = bulkhead.stats();
    expect(s0.inFlight).toBe(1);
    expect(s0.pending).toBe(0);

    if (a.ok) a.token.release();

    const c = bulkhead.tryAcquire();
    expect(c.ok).toBe(true);
    if (c.ok) c.token.release();

    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });

  it('prunes cancelled waiters at the head so they stop consuming maxQueue', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 2 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const ac1 = new AbortController();
    const p1 = bulkhead.acquire({ signal: ac1.signal });
    expect(await isSettled(p1, 5)).toBe(false);

    const ac2 = new AbortController();
    const p2 = bulkhead.acquire({ signal: ac2.signal });
    expect(await isSettled(p2, 5)).toBe(false);

    let s = bulkhead.stats();
    expect(s.inFlight).toBe(1);
    expect(s.pending).toBe(2);

    ac1.abort();

    s = bulkhead.stats();
    expect(s.inFlight).toBe(1);
    expect(s.pending).toBe(1);

    ac2.abort();

    s = bulkhead.stats();
    expect(s.inFlight).toBe(1);
    expect(s.pending).toBe(0);

    if (a.ok) a.token.release();

    const c = bulkhead.tryAcquire();
    expect(c.ok).toBe(true);
    if (c.ok) c.token.release();

    s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });
});

// ============================================================
// v0.3.0: stats() is a pure read
// ============================================================

describe('stats() purity', () => {
  it('calling stats() repeatedly returns identical results without side effects', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 2 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const ac = new AbortController();
    const bP = bulkhead.acquire({ signal: ac.signal });
    expect(await isSettled(bP, 5)).toBe(false);

    // Before abort: stats is stable across multiple calls
    const s1 = bulkhead.stats();
    const s2 = bulkhead.stats();
    const s3 = bulkhead.stats();
    expect(s1).toEqual(s2);
    expect(s2).toEqual(s3);
    expect(s1.pending).toBe(1);

    // After abort: stable again
    ac.abort();
    const s4 = bulkhead.stats();
    const s5 = bulkhead.stats();
    expect(s4).toEqual(s5);
    expect(s4.pending).toBe(0);

    if (a.ok) a.token.release();
    await bP;
  });
});

// ============================================================
// v0.3.0: inFlightUnderflow counter
// ============================================================

describe('inFlightUnderflow counter', () => {
  it('reports zero under normal operation', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);
    if (a.ok) a.token.release();

    expect(bulkhead.stats().inFlightUnderflow).toBe(0);
  });

  it('double release increments doubleRelease but not inFlightUnderflow', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);
    if (a.ok) {
      a.token.release();
      a.token.release(); // double release — idempotent
    }

    const s = bulkhead.stats();
    expect(s.doubleRelease).toBe(1);
    expect(s.inFlightUnderflow).toBe(0);
    expect(s.inFlight).toBe(0);
  });
});

// ============================================================
// v0.3.0: close()
// ============================================================

describe('close()', () => {
  it('rejects future tryAcquire with shutdown', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    bulkhead.close();

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe('shutdown');
  });

  it('rejects future acquire with shutdown', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    bulkhead.close();

    const a = await bulkhead.acquire();
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe('shutdown');
  });

  it('rejects future run() with BulkheadRejectedError(shutdown)', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    bulkhead.close();

    let caught: BulkheadRejectedError | undefined;
    try {
      await bulkhead.run(async () => {});
    } catch (e) {
      if (e instanceof BulkheadRejectedError) caught = e;
      else throw e;
    }

    expect(caught).toBeDefined();
    expect(caught!.reason).toBe('shutdown');
    expect(caught!.code).toBe('BULKHEAD_REJECTED');
  });

  it('rejects all pending waiters with shutdown', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 3 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const bP = bulkhead.acquire();
    const cP = bulkhead.acquire();
    const dP = bulkhead.acquire();

    expect(await isSettled(bP, 5)).toBe(false);
    expect(await isSettled(cP, 5)).toBe(false);
    expect(await isSettled(dP, 5)).toBe(false);

    expect(bulkhead.stats().pending).toBe(3);

    bulkhead.close();

    const b = await bP;
    const c = await cP;
    const d = await dP;

    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('shutdown');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('shutdown');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('shutdown');

    expect(bulkhead.stats().pending).toBe(0);

    // In-flight token still works normally
    if (a.ok) a.token.release();
    expect(bulkhead.stats().inFlight).toBe(0);
  });

  it('does not forcibly cancel in-flight work', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    let workCompleted = false;
    const workP = bulkhead.run(async () => {
      await sleep(30);
      workCompleted = true;
    });

    expect(bulkhead.stats().inFlight).toBe(1);

    bulkhead.close();

    // In-flight work continues — close() doesn't interrupt it.
    expect(bulkhead.stats().inFlight).toBe(1);

    await workP;
    expect(workCompleted).toBe(true);
    expect(bulkhead.stats().inFlight).toBe(0);
  });

  it('is idempotent', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    bulkhead.close();
    bulkhead.close();
    bulkhead.close();

    expect(bulkhead.stats().closed).toBe(true);
  });

  it('stats() reports closed status', () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    expect(bulkhead.stats().closed).toBe(false);

    bulkhead.close();

    expect(bulkhead.stats().closed).toBe(true);
  });

  it('cleans up abort listeners and timeouts on pending waiters', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 2 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const ac = new AbortController();
    const bP = bulkhead.acquire({ signal: ac.signal, timeoutMs: 60_000 });
    expect(await isSettled(bP, 5)).toBe(false);

    bulkhead.close();

    const b = await bP;
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('shutdown');

    // The abort signal listener should have been removed — aborting now is a no-op.
    ac.abort();

    if (a.ok) a.token.release();
  });
});

// ============================================================
// v0.3.0: drain()
// ============================================================

describe('drain()', () => {
  it('resolves immediately when nothing is in-flight', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    const settled = await isSettled(bulkhead.drain(), 5);
    expect(settled).toBe(true);
  });

  it('resolves when last in-flight token is released', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    const a = bulkhead.tryAcquire();
    const b = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const drainP = bulkhead.drain();
    expect(await isSettled(drainP, 5)).toBe(false);

    if (a.ok) a.token.release();
    expect(await isSettled(drainP, 5)).toBe(false);

    if (b.ok) b.token.release();
    expect(await isSettled(drainP, 5)).toBe(true);
  });

  it('multiple drain() calls all resolve when inFlight reaches zero', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const d1 = bulkhead.drain();
    const d2 = bulkhead.drain();
    const d3 = bulkhead.drain();

    expect(await isSettled(d1, 5)).toBe(false);
    expect(await isSettled(d2, 5)).toBe(false);
    expect(await isSettled(d3, 5)).toBe(false);

    if (a.ok) a.token.release();

    // All three should resolve.
    await Promise.all([d1, d2, d3]);
  });

  it('works without close() — new work can still be admitted', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const drainP = bulkhead.drain();

    if (a.ok) a.token.release();
    await drainP;

    // After drain resolves, new work is still possible.
    const b = bulkhead.tryAcquire();
    expect(b.ok).toBe(true);
    if (b.ok) b.token.release();
  });

  it('waits for pending-then-admitted work to complete', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 1 });

    let workDone = false;
    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    // B will be queued, then admitted when A releases.
    const bP = bulkhead.run(async () => {
      await sleep(20);
      workDone = true;
    });

    expect(bulkhead.stats().pending).toBe(1);

    const drainP = bulkhead.drain();
    expect(await isSettled(drainP, 5)).toBe(false);

    // Release A — B gets admitted and starts running.
    if (a.ok) a.token.release();

    // drain() should NOT resolve yet — B is now in-flight.
    expect(await isSettled(drainP, 5)).toBe(false);

    await bP;
    expect(workDone).toBe(true);

    // Now drain() should resolve.
    await drainP;
  });
});

// ============================================================
// v0.3.0: close() + drain() composition
// ============================================================

describe('close() + drain() composition', () => {
  it('close then drain: resolves when in-flight work finishes', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2, maxQueue: 2 });

    let workFinished = 0;

    // Two in-flight tasks
    const p1 = bulkhead.run(async () => {
      await sleep(30);
      workFinished++;
    });
    const p2 = bulkhead.run(async () => {
      await sleep(50);
      workFinished++;
    });

    // Two pending waiters
    const p3 = bulkhead.acquire();
    const p4 = bulkhead.acquire();

    expect(bulkhead.stats().inFlight).toBe(2);
    expect(bulkhead.stats().pending).toBe(2);

    bulkhead.close();

    // Pending should be rejected immediately.
    const r3 = await p3;
    const r4 = await p4;
    expect(r3.ok).toBe(false);
    expect(r4.ok).toBe(false);

    // In-flight work continues.
    expect(bulkhead.stats().inFlight).toBe(2);

    const drainP = bulkhead.drain();
    expect(await isSettled(drainP, 5)).toBe(false);

    await Promise.all([p1, p2]);
    await drainP;

    expect(workFinished).toBe(2);
    expect(bulkhead.stats().inFlight).toBe(0);
  });

  it('drain then close: drain still resolves', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 1 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const bP = bulkhead.acquire();
    expect(bulkhead.stats().pending).toBe(1);

    const drainP = bulkhead.drain();

    // Close while drain is pending — rejects B, but A is still in-flight.
    bulkhead.close();
    const b = await bP;
    expect(b.ok).toBe(false);

    expect(await isSettled(drainP, 5)).toBe(false);

    if (a.ok) a.token.release();

    await drainP;
    expect(bulkhead.stats().inFlight).toBe(0);
  });

  it('close with no in-flight: drain resolves immediately', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 2 });

    bulkhead.close();

    const settled = await isSettled(bulkhead.drain(), 5);
    expect(settled).toBe(true);
  });

  it('graceful shutdown pattern: close → drain → assert clean', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 3, maxQueue: 5 });

    const results: number[] = [];
    const tasks = Array.from({ length: 3 }, (_, i) =>
      bulkhead.run(async () => {
        await sleep(10 + randInt(20));
        results.push(i);
      }),
    );

    // Simulate SIGTERM
    bulkhead.close();
    await bulkhead.drain();

    // All in-flight work completed.
    await Promise.all(tasks);
    expect(results.length).toBe(3);

    // System is clean.
    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
    expect(s.closed).toBe(true);
  });
});

// ============================================================
// v0.3.0: mass-abort stress test
// ============================================================

describe('mass-abort stress', () => {
  it('100 waiters all abort simultaneously — system drains cleanly', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 100 });

    const a = bulkhead.tryAcquire();
    expect(a.ok).toBe(true);

    const controllers: AbortController[] = [];
    const promises: Promise<unknown>[] = [];

    for (let i = 0; i < 100; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      promises.push(bulkhead.acquire({ signal: ac.signal }));
    }

    expect(bulkhead.stats().pending).toBe(100);

    // Abort all simultaneously.
    for (const ac of controllers) ac.abort();

    const results = await Promise.all(promises);

    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('aborted');
    }

    expect(bulkhead.stats().pending).toBe(0);

    // Release the holder — no ghost waiters should consume the slot.
    if (a.ok) a.token.release();

    const s = bulkhead.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);

    // Fresh acquire still works.
    const b = bulkhead.tryAcquire();
    expect(b.ok).toBe(true);
    if (b.ok) b.token.release();
  });
});

// ============================================================
// Soak test (carried forward, updated for v0.3.0)
// ============================================================

describe('soak', () => {
  it(
    'inFlight/pending never exceed limits; system drains to zero',
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
          const mode = randInt(10);

          if (mode === 0) {
            // Abort quickly
            const ac = new AbortController();
            const p = (async () => {
              const rP = bulkhead.acquire({ signal: ac.signal });
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
      expect(finalStats.inFlightUnderflow).toBe(0);

      expect(granted + rejected).toBeGreaterThan(0);
      expect(maxInFlightObserved).toBeLessThanOrEqual(maxConcurrent);
      expect(maxPendingObserved).toBeLessThanOrEqual(maxQueue);
    },
  );

  it(
    'soak with close/drain mid-run: invariants hold',
    { timeout: 30_000 },
    async () => {
      const maxConcurrent = 10;
      const maxQueue = 20;

      const bulkhead = createBulkhead({ maxConcurrent, maxQueue });

      let granted = 0;
      let rejected = 0;

      const work: Promise<void>[] = [];

      // Run for 2 seconds, then close and drain.
      const endAt = Date.now() + 2_000;

      while (Date.now() < endAt) {
        const burst = 3 + randInt(8);

        for (let i = 0; i < burst; i++) {
          const p = (async () => {
            const r = await bulkhead.acquire();
            if (!r.ok) {
              rejected++;
              return;
            }
            granted++;
            try {
              await sleep(1 + randInt(10));
            } finally {
              r.token.release();
            }
          })();
          work.push(p);

          const s = bulkhead.stats();
          expect(s.inFlight).toBeLessThanOrEqual(maxConcurrent);
          expect(s.pending).toBeLessThanOrEqual(maxQueue);
        }

        await sleep(randInt(3));
      }

      // Close and drain.
      bulkhead.close();
      await bulkhead.drain();

      // Wait for all work promises to settle (some may have been rejected by close).
      await Promise.allSettled(work);

      const s = bulkhead.stats();
      expect(s.inFlight).toBe(0);
      expect(s.pending).toBe(0);
      expect(s.closed).toBe(true);
      expect(s.inFlightUnderflow).toBe(0);
      expect(granted + rejected).toBeGreaterThan(0);
    },
  );
});
