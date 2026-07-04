import { describe, expect, it } from 'vitest';
import type { ResearcherOutput } from '../../domain/hypothesis.ts';
import type { ResearcherPort } from '../../ports/researcher.port.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';
import { runEval } from './eval-harness.ts';
import type { ResearcherEvalInput } from './types.ts';

const output = {
  researchSummary: 'Bot results show negative pnl, low winrate and be_stop losses on ESPORTSUSDT after the long-only dump bounce stays open too long.',
  hypotheses: [{
    thesis: 'Tighten exits for trades that remain open too long after failed OI recovery in the 10% dump bounce setup.',
    targetBehavior: 'Reduce be_stop losses and average holding time.',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi recovery fails and holding time expands toward 180 minutes', action: 'tighten_stop', params: {}, rationale: 'Bot results show slow be_stop losers on ESPORTSUSDT.' }] },
    requiredFeatures: ['oi'],
    validationPlan: 'Replay the June bot-results window and compare pnl, winrate and holding time for ESPORTSUSDT be_stop losers.',
    expectedEffect: { metric: 'pnlUsd', direction: 'increase', magnitude: 'with fewer be_stop exits after 180 minutes' },
    invalidationCriteria: ['Reject if pnlUsd does not improve or be_stop losses do not fall.'],
    confidence: 0.7,
  }],
} satisfies ResearcherOutput;

let capturedTradeEvidence: readonly TradeEvidenceBundle[] | undefined;

function researcherFor(model: string): ResearcherPort {
  return {
    adapter: 'mastra',
    model,
    async propose(input) {
      capturedTradeEvidence = input.tradeEvidence;
      return output;
    },
  };
}

const input: ResearcherEvalInput = {
  models: ['model-a', 'model-b'],
  fixtureId: 'fixture',
  fixtureFingerprint: 'sha256:x',
  profile: {
    id: 'p1',
    version: 1,
    sourceKind: 'manual_description',
    sourceFingerprint: 'sha256:p',
    direction: 'long',
    coreIdea: 'Long OI bounce',
    requiredMarketFeatures: ['oi'],
    confidence: 0.8,
    unknowns: [],
    profile: {} as never,
    sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  },
  botResults: [{
    run: {
      runId: 'run-1',
      mode: 'paper',
      status: 'finished',
      bundleId: null, strategy: { name: 'long_oi_strategy', version: '1' },
      symbols: ['ESPORTSUSDT'],
      startedAtMs: 1,
      finishedAtMs: 2,
      lastSeenMs: 2,
    },
    summary: {
      runId: 'run-1',
      asOf: 2,
      closedTrades: 1,
      wins: 0,
      losses: 1,
      breakeven: 0,
      winratePct: 0,
      pnlUsd: '-10',
      avgPnl: '-10',
      exitReasons: { be_stop: 1 },
      excludesReconcile: true,
    },
    trades: [{
      tradeId: 'trade-1',
      runId: 'run-1',
      symbol: 'ESPORTSUSDT',
      side: 'long',
      realizedPnl: '-10',
      pnlPct: '-1',
      isWin: false,
      closeReason: 'stop_loss',
      openedAtMs: 1,
      closedAtMs: 2,
      entryPrice: null, exitPrice: null, closeReasonRaw: null,
    }],
  }],
  tradeEvidence: [{
    tradeId: 'trade-1',
    runId: 'run-1',
    symbol: 'ESPORTSUSDT',
    side: 'long',
    enteredAtMs: 1,
    closedAtMs: 2,
    entryPrice: '1.0',
    exitPrice: '0.9',
    realizedPnl: '-10',
    pnlPct: '-1',
    holdingDurationMs: 60_000,
    closeReason: 'be_stop',
    lifecycleEvents: [{ tsMs: 1, type: 'entry', price: '1.0', qty: '100', note: null }],
    minuteContext: [{ tsMs: 1, close: '1.0', volume: '1000', oi: '2000', liquidationsLong: '10', liquidationsShort: '0' }],
  }],
  threshold: 0.7,
  repeat: 1,
};

describe('researcher runEval', () => {
  it('runs candidate researchers and aggregates deterministic scores', async () => {
    capturedTradeEvidence = undefined;
    const result = await runEval(input, {
      researcherFor,
      providerOf: (model) => ({ provider: 'openrouter', modelId: model }),
      clock: () => 100,
    });

    expect(result.overallSuccess).toBe(true);
    expect(result.perModel).toHaveLength(2);
    expect(result.aggregates.map((a) => a.model)).toEqual(['model-a', 'model-b']);
    expect(result.aggregates[0]?.passRate).toBe(1);
    const tradeIds = (capturedTradeEvidence ?? ([] as readonly TradeEvidenceBundle[])).map((bundle) => bundle.tradeId);
    expect(tradeIds).toEqual(['trade-1']);
  });
});
