import { describe, it, expect } from 'vitest';
import { parseBearer, safeEqual } from './bearer.ts';

describe('parseBearer', () => {
  it('extracts the token after the "Bearer " prefix', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
  });

  it('returns null for an absent header', () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('')).toBeNull();
  });

  it('returns null for a malformed header (no Bearer prefix)', () => {
    expect(parseBearer('Token abc')).toBeNull();
    expect(parseBearer('abc')).toBeNull();
    expect(parseBearer('bearer abc')).toBeNull(); // case-sensitive prefix
  });
});

describe('safeEqual (hash-based constant-time)', () => {
  it('true for equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('false for different strings, including different lengths', () => {
    expect(safeEqual('a', 'ab')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
});
