import { describe, it, expect } from 'vitest';
import { isEmbargoedMetricKey, scrubMetricsBag, SAFE_RETRY_REASONS, sanitizeRetryFeedback } from './outcome-embargo.ts';

describe('isEmbargoedMetricKey', () => {
  it.each([
    'holdoutSharpe', 'holdout_net_pnl', 'heldoutSharpe', 'heldout_win_rate',
    'oos', 'oosSharpe', 'OOS_SHARPE',
    'promotion', 'promotionVerdict', 'promotion_reason',
    'qualification', 'qualificationEpochKey', 'qualification_epoch',
    'outOfSampleSharpe', 'out_of_sample_sharpe', 'metricsOutOfSample',
    'evaluationWindow', 'evaluation_window', 'evaluationWindowFrom',
    'OOSSharpe', 'totalOOSScore', 'metricsOOSVerdict',
    // IMP-1: adjacent spellings — held_out / hold_out sequences + digit-boundary segmentation
    'held_out_sharpe', 'heldOutSharpe', 'hold_out_pnl', 'oos2', 'oos2Sharpe', 'holdout2',
  ])('embargoes %s', (key) => {
    expect(isEmbargoedMetricKey(key)).toBe(true);
  });

  it.each([
    'choose',        // 'oos' is a substring but NOT a segment
    'netPnlUsd', 'sharpe', 'maxDrawdownPct', 'totalTrades', 'winRate', 'profitFactor',
    'sampleSize',    // 'sample' alone is not embargoed
    'outOf', 'ofSample', // incomplete out_of_sample sequence
    'evaluation', 'windowSize', 'window', // incomplete evaluation_window sequence
    'selectionEvaluation', // legit revision field — 'evaluation' without 'window'
    // IMP-1 negative controls: digit-boundary split + held/hold sequences must not overmatch
    'hardStopPct',   // segments ['hard','stop','pct'] — no hold/held+out sequence
    'holder',        // single segment 'holder' — not the 'hold'+'out' sequence
    'sharpe2',        // digit-boundary split must not spuriously embargo
  ])('allows %s', (key) => {
    expect(isEmbargoedMetricKey(key)).toBe(false);
  });
});

describe('scrubMetricsBag', () => {
  it('removes embargoed keys at the top level and reports their paths', () => {
    const { scrubbed, removedKeys } = scrubMetricsBag({
      netPnlUsd: 100, sharpe: 1.2, holdoutSharpe: 9.99, promotionVerdict: 1,
    });
    expect(scrubbed).toEqual({ netPnlUsd: 100, sharpe: 1.2 });
    expect(removedKeys.sort()).toEqual(['holdoutSharpe', 'promotionVerdict']);
  });

  it('recurses into nested objects and arrays (comparison / topN shapes)', () => {
    const topN = [
      { paramsHash: 'a', point: { x: 1 }, metrics: { sharpe: 2, holdout_net_pnl: 5 } },
      { paramsHash: 'b', point: { x: 2 }, metrics: { sharpe: 1, qualification: { epoch: 'e1' } } },
    ];
    const { scrubbed, removedKeys } = scrubMetricsBag(topN);
    expect(scrubbed).toEqual([
      { paramsHash: 'a', point: { x: 1 }, metrics: { sharpe: 2 } },
      { paramsHash: 'b', point: { x: 2 }, metrics: { sharpe: 1 } },
    ]);
    expect(removedKeys.sort()).toEqual(['[0].metrics.holdout_net_pnl', '[1].metrics.qualification']);
  });

  it('drops an embargoed subtree wholesale (a future promotion object)', () => {
    const { scrubbed, removedKeys } = scrubMetricsBag({
      metrics: { sharpe: 1 },
      promotion: { verdict: 'passed', evaluationWindow: { from: 'x', to: 'y' } },
    });
    expect(scrubbed).toEqual({ metrics: { sharpe: 1 } });
    expect(removedKeys).toEqual(['promotion']);
  });

  it('drops a TOP-LEVEL evaluationWindow subtree (window dates must not survive outside promotion)', () => {
    const { scrubbed, removedKeys } = scrubMetricsBag({
      sharpe: 1.2,
      evaluationWindow: { from: '2031-12-31T00:00:00Z', to: '2031-12-31T23:59:59Z' },
    });
    expect(scrubbed).toEqual({ sharpe: 1.2 });
    expect(removedKeys).toEqual(['evaluationWindow']);
    expect(JSON.stringify(scrubbed)).not.toContain('2031-12-31');
  });

  it('masks value-bearing digits in dynamic embargoed key paths — path never carries a value', () => {
    const { scrubbed, removedKeys } = scrubMetricsBag({
      periodBreakdown: { 'holdout_2031-12-31': 987654.321 },
      oos_987654: 1,
      sharpe: 1.2,
    });
    expect(scrubbed).toEqual({ periodBreakdown: {}, sharpe: 1.2 });
    // dates / ids / sentinels inside a KEY name are masked to '#' in the reported path
    expect(removedKeys.sort()).toEqual(['oos_#', 'periodBreakdown.holdout_#-#-#']);
    const s = JSON.stringify(removedKeys);
    expect(s).not.toContain('2031');
    expect(s).not.toContain('987654');
  });

  it('passes primitives and null through untouched', () => {
    expect(scrubMetricsBag(42).scrubbed).toBe(42);
    expect(scrubMetricsBag('s').scrubbed).toBe('s');
    expect(scrubMetricsBag(null).scrubbed).toBe(null);
    expect(scrubMetricsBag(42).removedKeys).toEqual([]);
  });

  it('passes non-plain objects (Date, Map) through untouched instead of corrupting them to {}', () => {
    const ts = new Date('2026-01-01T00:00:00Z');
    const m = new Map([['k', 1]]);
    const { scrubbed, removedKeys } = scrubMetricsBag({ sharpe: 1, ts, m });
    expect(scrubbed.ts).toBe(ts);
    expect(scrubbed.m).toBe(m);
    expect(removedKeys).toEqual([]);
  });
});

describe('sanitizeRetryFeedback', () => {
  it('keeps allowlisted evaluator and preservation-veto reasons verbatim', () => {
    const out = sanitizeRetryFeedback({
      hypothesisId: 'h1', decision: 'FAIL',
      reasons: ['no_improvement_over_baseline', 'abstention_gaming'],
    });
    expect(out.feedback).toEqual({
      hypothesisId: 'h1', decision: 'FAIL',
      reasons: ['no_improvement_over_baseline', 'abstention_gaming'],
    });
    expect(out.removedKeys).toEqual([]);
  });

  it('drops unknown reasons fail-closed and reports index paths, never values', () => {
    const out = sanitizeRetryFeedback({
      hypothesisId: 'h1', decision: 'MODIFY',
      reasons: ['drawdown_regression', 'holdout_failed: sharpe=1.23', 'heldout window 2023-04-01'],
    });
    expect(out.feedback.reasons).toEqual(['drawdown_regression']);
    expect(out.removedKeys).toEqual(['reasons[1]', 'reasons[2]']);
    // paths must not embed the dropped strings
    expect(JSON.stringify(out.removedKeys)).not.toContain('sharpe');
    expect(JSON.stringify(out.removedKeys)).not.toContain('2023-04-01');
  });

  it('covers the full allowlist', () => {
    for (const r of ['insufficient_sample', 'no_improvement_over_baseline', 'drawdown_regression',
      'fragile_pnl', 'strong_robust_edge', 'positive_edge',
      'end_of_data_position', 'abstention_gaming', 'winner_degradation']) {
      expect(SAFE_RETRY_REASONS.has(r)).toBe(true);
    }
  });

  it('IMP-2: drops a free-text decision fail-closed and reports it in removedKeys', () => {
    const out = sanitizeRetryFeedback({
      hypothesisId: 'h1', decision: 'FAIL — holdout sharpe=1.23',
      reasons: ['no_improvement_over_baseline'],
    });
    expect(out.feedback.decision).toBe('');
    expect(out.removedKeys).toContain('decision');
    expect(JSON.stringify(out.removedKeys)).not.toContain('sharpe');
  });

  it('IMP-2: passes an allowlisted decision (schema enum) through verbatim', () => {
    const out = sanitizeRetryFeedback({
      hypothesisId: 'h1', decision: 'FAIL',
      reasons: ['no_improvement_over_baseline'],
    });
    expect(out.feedback.decision).toBe('FAIL');
    expect(out.removedKeys).toEqual([]);
  });

  it('IMP-2: covers the full decision allowlist verbatim', () => {
    for (const d of ['PASS', 'FAIL', 'MODIFY', 'INCONCLUSIVE', 'PAPER_CANDIDATE']) {
      const out = sanitizeRetryFeedback({ hypothesisId: 'h1', decision: d, reasons: [] });
      expect(out.feedback.decision).toBe(d);
      expect(out.removedKeys).toEqual([]);
    }
  });
});
