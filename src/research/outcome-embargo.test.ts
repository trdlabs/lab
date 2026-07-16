import { describe, it, expect } from 'vitest';
import { isEmbargoedMetricKey, scrubMetricsBag } from './outcome-embargo.ts';

describe('isEmbargoedMetricKey', () => {
  it.each([
    'holdoutSharpe', 'holdout_net_pnl', 'heldoutSharpe', 'heldout_win_rate',
    'oos', 'oosSharpe', 'OOS_SHARPE',
    'promotion', 'promotionVerdict', 'promotion_reason',
    'qualification', 'qualificationEpochKey', 'qualification_epoch',
    'outOfSampleSharpe', 'out_of_sample_sharpe', 'metricsOutOfSample',
    'evaluationWindow', 'evaluation_window', 'evaluationWindowFrom',
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

  it('passes primitives and null through untouched', () => {
    expect(scrubMetricsBag(42).scrubbed).toBe(42);
    expect(scrubMetricsBag('s').scrubbed).toBe('s');
    expect(scrubMetricsBag(null).scrubbed).toBe(null);
    expect(scrubMetricsBag(42).removedKeys).toEqual([]);
  });
});
