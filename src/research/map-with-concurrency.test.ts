import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './map-with-concurrency.ts';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('mapWithConcurrency', () => {
  it('returns results ordered by input index even when completion order is shuffled', async () => {
    const delays = [30, 0, 10];
    const out = await mapWithConcurrency(delays, 3, async (d, i) => {
      await new Promise((r) => setTimeout(r, d));
      return `item-${i}`;
    });
    expect(out).toEqual(['item-0', 'item-1', 'item-2']);
  });

  it('never exceeds the concurrency bound', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(maxInFlight).toBe(2);
  });

  it('limit=1 degenerates to strict serial order', async () => {
    const started: number[] = [];
    await mapWithConcurrency([0, 1, 2], 1, async (_x, i) => {
      started.push(i);
      await tick();
    });
    expect(started).toEqual([0, 1, 2]);
  });

  it('fail-fast: first rejection propagates, no new items start after it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3], 1, async (_x, i) => {
        started.push(i);
        await tick();
        if (i === 1) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]); // items 2 and 3 never started
  });

  it('fail-fast under concurrency: no new item starts after a rejection settles (limit=2)', async () => {
    // Deliberately construct a true same-microtask-drain tie: item 0's
    // resolution and item 1's rejection are triggered by two independent
    // deferred promises, settled back-to-back in the SAME synchronous
    // callback (no timers involved, so this is deterministic regardless
    // of OS timer granularity — unlike setTimeout-based delays, which on
    // this platform (WSL2) coalesce/jitter and mask the actual race).
    // Since lane 0 starts before lane 1, both lanes are already suspended
    // on their respective gates by the time mapWithConcurrency returns,
    // and resolving/rejecting the gates in the same tick reproduces
    // exactly the "both continuations queued in the same microtask drain"
    // scenario from the review finding.
    const started: number[] = [];
    let resolveGate0!: () => void;
    let rejectGate1!: (err: unknown) => void;
    const gate0 = new Promise<void>((res) => {
      resolveGate0 = res;
    });
    const gate1 = new Promise<void>((_res, rej) => {
      rejectGate1 = rej;
    });

    const resultPromise = mapWithConcurrency([0, 1, 2, 3], 2, async (_x, i) => {
      started.push(i);
      if (i === 0) {
        await gate0;
        return 'ok';
      }
      if (i === 1) {
        await gate1;
        return 'never';
      }
      return 'ok';
    });

    // Both lanes are already parked on their gates here (lane creation is
    // synchronous up to the first await). Settle them in the same tick.
    resolveGate0();
    rejectGate1(new Error('boom'));

    await expect(resultPromise).rejects.toThrow('boom');
    // Items 2 and 3 must never start: lane 0 must observe the sibling
    // lane's rejection before grabbing another item, even though its own
    // await resolved successfully in the same microtask drain as lane 1's
    // rejection settled.
    expect(started).toEqual([0, 1]);
  });

  it('rejects a non-positive or non-integer limit synchronously', () => {
    expect(() => mapWithConcurrency([1], 0, async () => {})).toThrow(/positive integer/);
    expect(() => mapWithConcurrency([1], 1.5, async () => {})).toThrow(/positive integer/);
  });

  it('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 'x')).toEqual([]);
  });
});
