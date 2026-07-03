// src/domain/paper-window.test.ts
import { describe, expect, it } from 'vitest';
import { evaluatePaperWindow, validatePaperWindowPolicy, type PaperWindowPolicy } from './paper-window.ts';

const P: PaperWindowPolicy = { minTrades: 30, lowConfidenceThreshold: 15, minDays: 3, maxDays: 30, maxWaitDays: 7 };
const day = 24 * 3600 * 1000;

describe('evaluatePaperWindow', () => {
  it.each([
    ['before minDays even with enough trades', 2 * day, 100, { state: 'watching' }],
    ['enough trades at minDays boundary', 3 * day, 30, { state: 'window_complete', lowConfidence: false }],
    ['too few trades mid-window', 10 * day, 5, { state: 'watching' }],
    ['maxDays with lowConfidence band', 30 * day, 20, { state: 'window_complete', lowConfidence: true }],
    ['maxDays below lowConfidence threshold', 30 * day, 10, { state: 'stalled' }],
    ['just under maxDays stays watching', 30 * day - 1, 10, { state: 'watching' }],
  ] as const)('%s', (_n, elapsed, trades, expected) => {
    expect(evaluatePaperWindow(P, { runStartedAtMs: 0, nowMs: elapsed, closedTrades: trades })).toEqual(expected);
  });
});

describe('validatePaperWindowPolicy', () => {
  it.each([
    [{ ...P, minTrades: 0 }, /positive/],
    [{ ...P, lowConfidenceThreshold: 31 }, /lowConfidenceThreshold/],
    [{ ...P, minDays: 31 }, /minDays/],
    [{ ...P, maxWaitDays: 0 }, /maxWaitDays/],
  ] as const)('validate rejects bad policy %#', (p, re) => {
    expect(() => validatePaperWindowPolicy(p)).toThrow(re);
  });
});
