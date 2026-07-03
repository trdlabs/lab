import { describe, it, expect } from 'vitest';
import { compareHypotheses, sortEligible, VERDICT_RANK } from './hypothesis-score.ts';
import type { HypothesisProposal, HypothesisProxyMetrics, HypothesisStatus } from '../domain/hypothesis.ts';

function mk(overrides: Partial<HypothesisProposal> & { id: string }): HypothesisProposal {
  return {
    strategyProfileId: 'p1',
    thesis: 't',
    targetBehavior: 'b',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
    requiredFeatures: ['oi'],
    validationPlan: 'p',
    expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'],
    confidence: 0.5,
    status: 'proxy_passed',
    fingerprint: `sha256:${overrides.id}`,
    proposal: {} as never,
    issues: [],
    contractVersion: 'hypothesis-proposal-v1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function metrics(o: Partial<HypothesisProxyMetrics> = {}): HypothesisProxyMetrics {
  return {
    decision: 'PASS',
    deltaNetPnlUsd: 0,
    deltaMaxDrawdownPct: 0,
    backtestRunId: 'run-1',
    ...o,
  };
}

describe('VERDICT_RANK', () => {
  it('ranks PAPER_CANDIDATE above PASS; other decisions are unranked (never eligible)', () => {
    expect(VERDICT_RANK).toEqual({ PAPER_CANDIDATE: 2, PASS: 1 });
  });
});

describe('compareHypotheses — tier 1: verdict rank desc', () => {
  it.each([
    [
      'PAPER_CANDIDATE beats PASS',
      mk({ id: 'a', proxyMetrics: metrics({ decision: 'PAPER_CANDIDATE' }) }),
      mk({ id: 'b', proxyMetrics: metrics({ decision: 'PASS' }) }),
      -1,
    ],
    [
      'PASS beats an unranked decision (FAIL)',
      mk({ id: 'a', proxyMetrics: metrics({ decision: 'PASS' }) }),
      mk({ id: 'b', proxyMetrics: metrics({ decision: 'FAIL' }) }),
      -1,
    ],
    [
      'PASS beats missing proxyMetrics entirely (rank 0)',
      mk({ id: 'a', proxyMetrics: metrics({ decision: 'PASS' }) }),
      mk({ id: 'b' }),
      -1,
    ],
    [
      'unranked decision (FAIL) ties missing proxyMetrics at rank 0 -> falls through to next tier',
      mk({ id: 'a', proxyMetrics: metrics({ decision: 'FAIL', deltaNetPnlUsd: 10 }) }),
      mk({ id: 'b' }),
      -1, // a wins on tier 2 (pnl desc: 10 beats missing == -Infinity), not tier 1
    ],
  ])('%s', (_label, a, b, expectedSign) => {
    const result = compareHypotheses(a, b);
    if (expectedSign < 0) expect(result).toBeLessThan(0);
    else if (expectedSign > 0) expect(result).toBeGreaterThan(0);
    else expect(result).toBe(0);
  });
});

describe('compareHypotheses — tier 2: deltaNetPnlUsd desc', () => {
  it.each([
    [
      'higher deltaNetPnlUsd wins when verdict ranks tie',
      mk({ id: 'a', proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 100 }) }),
      mk({ id: 'b', proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 50 }) }),
      -1,
    ],
    [
      'present deltaNetPnlUsd (even negative) beats missing proxyMetrics (-Infinity)',
      mk({ id: 'a', proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: -1000 }) }),
      mk({ id: 'b' }),
      -1,
    ],
    [
      'equal deltaNetPnlUsd falls through to next tier',
      mk({
        id: 'a',
        proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 10, deltaMaxDrawdownPct: 1 }),
      }),
      mk({
        id: 'b',
        proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 10, deltaMaxDrawdownPct: 5 }),
      }),
      -1, // a wins on tier 3 (smaller drawdown), not tier 2
    ],
  ])('%s', (_label, a, b, expectedSign) => {
    const result = compareHypotheses(a, b);
    if (expectedSign < 0) expect(result).toBeLessThan(0);
    else expect(result).toBeGreaterThan(0);
  });
});

describe('compareHypotheses — tier 3: maxDrawdown improvement desc (smaller delta wins)', () => {
  it.each([
    [
      'smaller deltaMaxDrawdownPct wins when rank + pnl tie',
      mk({
        id: 'a',
        proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 10, deltaMaxDrawdownPct: 2 }),
      }),
      mk({
        id: 'b',
        proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 10, deltaMaxDrawdownPct: 8 }),
      }),
      -1,
    ],
    [
      'a negative deltaMaxDrawdownPct (drawdown improved) beats a positive one',
      mk({
        id: 'a',
        proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 10, deltaMaxDrawdownPct: -3 }),
      }),
      mk({
        id: 'b',
        proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 10, deltaMaxDrawdownPct: 1 }),
      }),
      -1,
    ],
    [
      'present deltaMaxDrawdownPct beats missing proxyMetrics',
      mk({
        id: 'a',
        proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: -50, deltaMaxDrawdownPct: 99 }),
      }),
      mk({ id: 'b' }),
      -1,
    ],
    [
      'equal deltaMaxDrawdownPct falls through to createdAt tier',
      mk({
        id: 'a',
        createdAt: '2026-02-01T00:00:00Z',
        proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 10, deltaMaxDrawdownPct: 4 }),
      }),
      mk({
        id: 'b',
        createdAt: '2026-01-01T00:00:00Z',
        proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 10, deltaMaxDrawdownPct: 4 }),
      }),
      -1, // a wins on tier 4 (createdAt desc: newer first), not tier 3
    ],
  ])('%s', (_label, a, b, expectedSign) => {
    const result = compareHypotheses(a, b);
    if (expectedSign < 0) expect(result).toBeLessThan(0);
    else expect(result).toBeGreaterThan(0);
  });
});

describe('compareHypotheses — tier 4: createdAt desc, missing on EITHER side skips the tier', () => {
  it('newer createdAt wins when all prior tiers tie', () => {
    const a = mk({ id: 'a', createdAt: '2026-03-01T00:00:00Z' });
    const b = mk({ id: 'b', createdAt: '2026-01-01T00:00:00Z' });
    expect(compareHypotheses(a, b)).toBeLessThan(0);
  });

  it('empty createdAt on the LEFT side skips tier 4, falling through to id asc', () => {
    const a = mk({ id: 'z', createdAt: '' });
    const b = mk({ id: 'a', createdAt: '2026-01-01T00:00:00Z' });
    // If tier 4 were applied, missing createdAt would make 'a' (or 'b') win/lose arbitrarily;
    // instead it is skipped and id asc decides: 'a' < 'z', so b sorts first.
    expect(compareHypotheses(a, b)).toBeGreaterThan(0);
  });

  it('empty createdAt on the RIGHT side skips tier 4, falling through to id asc', () => {
    const a = mk({ id: 'a', createdAt: '2026-01-01T00:00:00Z' });
    const b = mk({ id: 'z', createdAt: '' });
    expect(compareHypotheses(a, b)).toBeLessThan(0);
  });

  it('unparseable createdAt on either side is treated as missing (unreliable) and skips the tier', () => {
    const a = mk({ id: 'a', createdAt: 'not-a-date' });
    const b = mk({ id: 'z', createdAt: '2026-01-01T00:00:00Z' });
    expect(compareHypotheses(a, b)).toBeLessThan(0); // id asc: 'a' < 'z'
  });
});

describe('compareHypotheses — tier 5: id asc, final deterministic tie-break', () => {
  it('lower id wins when every prior tier ties exactly', () => {
    const a = mk({ id: 'aaa' });
    const b = mk({ id: 'bbb' });
    expect(compareHypotheses(a, b)).toBeLessThan(0);
    expect(compareHypotheses(b, a)).toBeGreaterThan(0);
  });

  it('is reflexively 0 for the identical proposal (irreflexive equality, not just id equality)', () => {
    const a = mk({ id: 'same' });
    expect(compareHypotheses(a, { ...a })).toBe(0);
  });
});

describe('sortEligible — eligibility filter', () => {
  const nonEligibleStatuses: HypothesisStatus[] = [
    'validated',
    'rejected',
    'proxy_failed',
    'merged',
    'dropped_merge_conflict',
    'dropped_combo_fail',
    'dropped_unsupported_shape',
  ];

  it.each(nonEligibleStatuses)('excludes status=%s', (status) => {
    const excluded = mk({ id: 'x', status });
    const eligible = mk({ id: 'e', status: 'proxy_passed' });
    expect(sortEligible([excluded, eligible]).map((p) => p.id)).toEqual(['e']);
  });

  it('includes proxy_passed and proxy_paper_candidate', () => {
    const passed = mk({ id: 'p', status: 'proxy_passed' });
    const candidate = mk({ id: 'c', status: 'proxy_paper_candidate' });
    const result = sortEligible([passed, candidate]);
    expect(result.map((p) => p.id).sort()).toEqual(['c', 'p']);
  });

  it('returns an empty array when nothing is eligible', () => {
    expect(sortEligible([mk({ id: 'a', status: 'validated' }), mk({ id: 'b', status: 'rejected' })])).toEqual([]);
  });
});

describe('sortEligible — filters then sorts by compareHypotheses', () => {
  it('produces the full lexicographic order across mixed statuses and tiers', () => {
    const top = mk({
      id: 'top',
      status: 'proxy_paper_candidate',
      proxyMetrics: metrics({ decision: 'PAPER_CANDIDATE', deltaNetPnlUsd: 1, deltaMaxDrawdownPct: 1 }),
    });
    const secondByPnl = mk({
      id: 'second',
      status: 'proxy_passed',
      proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 200, deltaMaxDrawdownPct: 1 }),
    });
    const thirdByDrawdown = mk({
      id: 'third',
      status: 'proxy_passed',
      proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 100, deltaMaxDrawdownPct: 10 }),
    });
    const fourthNoMetrics = mk({ id: 'fourth', status: 'proxy_passed' });
    const excludedFailed = mk({ id: 'excluded-failed', status: 'proxy_failed' });
    const excludedValidated = mk({ id: 'excluded-validated', status: 'validated' });

    const result = sortEligible([
      fourthNoMetrics,
      excludedValidated,
      thirdByDrawdown,
      excludedFailed,
      top,
      secondByPnl,
    ]);

    expect(result.map((p) => p.id)).toEqual(['top', 'second', 'third', 'fourth']);
  });

  it('is deterministic regardless of input order', () => {
    const a = mk({
      id: 'a',
      status: 'proxy_passed',
      proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 5, deltaMaxDrawdownPct: 1 }),
    });
    const b = mk({
      id: 'b',
      status: 'proxy_passed',
      proxyMetrics: metrics({ decision: 'PASS', deltaNetPnlUsd: 5, deltaMaxDrawdownPct: 1 }),
    });
    const c = mk({
      id: 'c',
      status: 'proxy_paper_candidate',
      proxyMetrics: metrics({ decision: 'PAPER_CANDIDATE', deltaNetPnlUsd: 0, deltaMaxDrawdownPct: 0 }),
    });

    const forward = sortEligible([a, b, c]).map((p) => p.id);
    const reversed = sortEligible([c, b, a]).map((p) => p.id);
    const shuffled = sortEligible([b, c, a]).map((p) => p.id);

    expect(forward).toEqual(['c', 'a', 'b']); // rank tier puts c first; a/b tie down to id asc
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });
});
