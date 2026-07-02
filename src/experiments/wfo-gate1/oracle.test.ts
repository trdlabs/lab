import { describe, it, expect } from 'vitest';
import { labelObvious } from './oracle.ts';
import type { Gate1Input } from '../../ports/wfo-agents.port.ts';

const mkInput = (
  o: Partial<Gate1Input> & {
    totalTrades: number;
    params: { name: string; tunable: boolean }[];
    evidence?: boolean;
  }
): Gate1Input => ({
  profile: { profile: { parameters: o.params } } as any,
  baselineMetrics: {
    totalTrades: o.totalTrades,
    netPnlUsd: 0,
    netPnlPct: 0,
    winRate: 0,
    profitFactor: 1,
    maxDrawdownPct: 0,
    expectancyUsd: 0,
    sharpe: 0,
    topTradeContributionPct: 0,
  } as any,
  entryAffecting: [],
  hasEntrySignalEvidence: o.evidence ?? false,
});

describe('oracle labeler', () => {
  it('labels the structural 0-trade branches', () => {
    expect(labelObvious(mkInput({ totalTrades: 0, params: [{ name: 'hardStopPct', tunable: true }] }))).toEqual({
      label: 'stop_insufficient_evidence',
      confidence: 'obvious',
    });
    expect(
      labelObvious(mkInput({ totalTrades: 0, params: [{ name: 'dump.minDropPct', tunable: true }], evidence: true }))
    ).toEqual({ label: 'allow_exploratory_sweep', confidence: 'obvious' });
    expect(
      labelObvious(mkInput({ totalTrades: 0, params: [{ name: 'dump.minDropPct', tunable: true }], evidence: false }))
    ).toEqual({ label: 'stop_insufficient_evidence', confidence: 'obvious' });
  });

  it('defers has-trades cases to the teacher', () => {
    expect(labelObvious(mkInput({ totalTrades: 5, params: [{ name: 'dump.minDropPct', tunable: true }] }))).toEqual({
      needsTeacher: true,
    });
  });
});
