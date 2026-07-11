import { describe, it, expect } from 'vitest';
import { applyRevisionPreservationGate, applyBacktestPreservationGate } from './apply-preservation-gate.ts';
import { DEFAULT_PRESERVATION_THRESHOLDS } from './trade-preservation.ts';
import type { RevisionVerdict } from './revision-evaluator.ts';
import type { EvaluationOutcome } from './evaluator.ts';
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

const pass: EvaluationOutcome = { decision: 'PASS', reasons: ['positive_edge'] };
function trB(over: Partial<TradeRecord> = {}): TradeRecord {
  return { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 40, ...over };
}

it('downgrades PASS to MODIFY on winner_degradation', () => {
  const base = [trB({ entryTs: 1 }), trB({ entryTs: 2 }), trB({ entryTs: 3 }), trB({ entryTs: 4 })]; // 4 winners gross 160
  const variant = [trB({ entryTs: 1 })]; // contribution 40 < 0.9*160
  const r = applyBacktestPreservationGate(pass, base, variant, agg(160, 4, 40, 1), T);
  expect(r.outcome.decision).toBe('MODIFY');
  expect(r.outcome.reasons).toContain('winner_degradation');
});

it('downgrades PAPER_CANDIDATE to INCONCLUSIVE on end_of_data_position', () => {
  const paperCand: EvaluationOutcome = { decision: 'PAPER_CANDIDATE', reasons: ['strong_robust_edge'] };
  const base = [trB({ realizedPnl: -5 })];
  const variant = [trB({ realizedPnl: -5, entryTs: 100 }), trB({ entryTs: 999, realizedPnl: 60, closeReason: 'end_of_data' })];
  const r = applyBacktestPreservationGate(paperCand, base, variant, agg(-5, 1, 55, 2), T); // totalDelta 60, eodDelta 60
  expect(r.outcome.decision).toBe('INCONCLUSIVE');
  expect(r.outcome.reasons).toContain('end_of_data_position');
});

it('leaves a would-accept verdict untouched when nothing fires', () => {
  const base = [trB({ realizedPnl: 10 }), trB({ realizedPnl: 10 }), trB({ realizedPnl: 10 })];
  const variant = [trB({ realizedPnl: 12 }), trB({ realizedPnl: 12 }), trB({ realizedPnl: 12 })];
  const r = applyBacktestPreservationGate(pass, base, variant, agg(30, 3, 36, 3), T);
  expect(r.outcome).toEqual(pass);
  expect(r.preservation?.fired).toBe(false);
});

it('never touches a non-would-accept verdict and does no trade work', () => {
  const modify: EvaluationOutcome = { decision: 'MODIFY', reasons: ['drawdown_regression'] };
  const r = applyBacktestPreservationGate(modify, [], [], agg(0, 0, 0, 0), T);
  expect(r.outcome).toBe(modify);
  expect(r.preservation).toBeNull();
});
