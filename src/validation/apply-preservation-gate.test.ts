import { describe, it, expect } from 'vitest';
import { applyRevisionPreservationGate } from './apply-preservation-gate.ts';
import { DEFAULT_PRESERVATION_THRESHOLDS } from './trade-preservation.ts';
import type { RevisionVerdict } from './revision-evaluator.ts';
import type { TradeRecord } from '../domain/research-experiment.ts';

const T = DEFAULT_PRESERVATION_THRESHOLDS;
const accept: RevisionVerdict = { decision: 'ACCEPT', reasons: ['pnl_improved'] };
function tr(over: Partial<TradeRecord> = {}): TradeRecord {
  return { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 40, ...over };
}
const agg = (bPnl: number, bN: number, vPnl: number, vN: number) =>
  ({ baseline: { netPnlUsd: bPnl, totalTrades: bN }, variant: { netPnlUsd: vPnl, totalTrades: vN } });

it('downgrades ACCEPT to REJECT with the veto reason when preservation fires', () => {
  const base = [tr({ entryTs: 1 }), tr({ entryTs: 2 }), tr({ entryTs: 3 }), tr({ entryTs: 4 })]; // 4 winners gross 160
  const variant = [tr({ entryTs: 1 })]; // contribution 40 < 0.9*160
  const r = applyRevisionPreservationGate(accept, base, variant, agg(160, 4, 40, 1), T);
  expect(r.verdict.decision).toBe('REJECT');
  expect(r.verdict.reasons).toEqual(['winner_degradation']);
  expect(r.preservation?.fired).toBe(true);
});

it('leaves ACCEPT untouched when preservation does not fire', () => {
  const base = [tr({ realizedPnl: 10 }), tr({ realizedPnl: 10 }), tr({ realizedPnl: 10 })];
  const variant = [tr({ realizedPnl: 12 }), tr({ realizedPnl: 12 }), tr({ realizedPnl: 12 })];
  const r = applyRevisionPreservationGate(accept, base, variant, agg(30, 3, 36, 3), T);
  expect(r.verdict).toEqual(accept);
  expect(r.preservation?.fired).toBe(false);
});

it('never touches an already-REJECT verdict and does not evaluate preservation', () => {
  const reject: RevisionVerdict = { decision: 'REJECT', reasons: ['no_improvement_over_accepted'] };
  const r = applyRevisionPreservationGate(reject, [], [], agg(0, 0, 0, 0), T);
  expect(r.verdict).toBe(reject);
  expect(r.preservation).toBeNull();
});
