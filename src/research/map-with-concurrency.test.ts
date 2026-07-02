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

  it('rejects a non-positive or non-integer limit synchronously', () => {
    expect(() => mapWithConcurrency([1], 0, async () => {})).toThrow(/positive integer/);
    expect(() => mapWithConcurrency([1], 1.5, async () => {})).toThrow(/positive integer/);
  });

  it('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 'x')).toEqual([]);
  });
});
