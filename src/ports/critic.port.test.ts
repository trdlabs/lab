import { describe, it, expect } from 'vitest';
import { NoopCritic } from './critic.port.ts';

describe('NoopCritic', () => {
  it('passes everything through (default, critic disabled in SP-1)', async () => {
    const critic = new NoopCritic();
    const review = await critic.review({ anything: true });
    expect(review.verdict).toBe('pass');
    expect(review.issues).toEqual([]);
  });
});
