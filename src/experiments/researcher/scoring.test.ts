import { describe, expect, it } from 'vitest';
import { longOiStrategyProfile } from './fixtures.ts';
import { scoreResearcherOutput } from './scoring.ts';

const good = {
  researchSummary: 'Bot results: low winrate, negative pnl and hard_stop clusters on ESPORTSUSDT show late exits after the long-only dump-and-bounce setup. Forensic bundles confirm entry→dca→dca→sl sequence with declining OI.',
  hypotheses: [{
    thesis: 'ESPORTSUSDT hard_stop losses after dca sequences indicate tighten_stop is needed: losses cluster after long holding time when the 10% dump bounce loses OI recovery and a second dca fires.',
    targetBehavior: 'Reduce slow losing trades without changing execution.',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi fails to recover after the dump bounce and the trade remains open near 180 minutes with dca triggered', action: 'tighten_stop', params: {}, rationale: 'Observed hard_stop after dca on ESPORTSUSDT: entry→dca→dca→sl with declining OI.' }] },
    requiredFeatures: ['oi', 'ohlcv'],
    validationPlan: 'Replay against the June bot-result window and compare winrate, pnl and hard_stop rate for ESPORTSUSDT. Reject if total pnl decreases.',
    expectedEffect: { metric: 'avg losing trade pnl', direction: 'increase', magnitude: 'less negative' },
    invalidationCriteria: ['Reject if total pnl decreases or hard_stop count does not fall on ESPORTSUSDT.'],
    confidence: 0.7,
  }],
};

const evalContext = {
  threshold: 0.7,
  profile: longOiStrategyProfile(),
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
      closedTrades: 2,
      wins: 0,
      losses: 2,
      breakeven: 0,
      winratePct: 0,
      pnlUsd: '-12',
      avgPnl: '-6',
      exitReasons: { hard_stop: 1, time_exit: 1 },
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
    }, {
      tradeId: 'trade-2',
      runId: 'run-1',
      symbol: 'COAIUSDT',
      side: 'long',
      realizedPnl: '-2',
      pnlPct: '-0.2',
      isWin: false,
      closeReason: 'time_exit',
      openedAtMs: 3,
      closedAtMs: 4,
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
    entryPrice: '1',
    exitPrice: '0.90',
    realizedPnl: '-10',
    pnlPct: '-1',
    holdingDurationMs: 179 * 60_000,
    closeReason: 'hard_stop',
    lifecycleEvents: [
      { tsMs: 1, type: 'entry', price: '1', qty: '100', note: null },
      { tsMs: 60_000, type: 'dca', price: '0.97', qty: '50', note: null },
      { tsMs: 120_000, type: 'dca', price: '0.94', qty: '50', note: null },
      { tsMs: 179 * 60_000, type: 'sl', price: '0.90', qty: '200', note: null },
    ],
    minuteContext: [{ tsMs: 1, close: '1', volume: '100', oi: '200', liquidationsLong: '10', liquidationsShort: '0' }],
  }],
} as const satisfies Parameters<typeof scoreResearcherOutput>[1];

describe('scoreResearcherOutput', () => {
  it('passes schema-valid fact-grounded falsifiable output', () => {
    const result = scoreResearcherOutput(good, evalContext);
    expect(result.verdict).toBe('PASS');
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.checks.find((c) => c.id === 'evidence_specificity')?.contribution).toBeGreaterThan(0);
    expect(result.checks.find((c) => c.id === 'profile_specificity')?.contribution).toBeGreaterThan(0);
    expect(result.gates.forensicGrounded).toBe(true);
    expect(result.gates.noStrategyRewrite).toBe(true);
  });

  it('fails output that uses generic language without profile or trade grounding', () => {
    const generic = {
      researchSummary: 'Bot results show negative pnl and low winrate, so the strategy needs better filters.',
      hypotheses: [{
        thesis: 'Try a generic trend filter.',
        targetBehavior: 'Make entries more selective.',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'trend is weak', action: 'skip_entry', params: {}, rationale: 'Generic selectivity.' }] },
        requiredFeatures: ['ohlcv'],
        validationPlan: 'Run a backtest and compare metrics.',
        expectedEffect: { metric: 'entries', direction: 'decrease' },
        invalidationCriteria: ['Reject if entry count does not decrease.'],
        confidence: 0.5,
      }],
    };
    const result = scoreResearcherOutput(generic, evalContext);
    expect(result.verdict).toBe('FAIL');
    expect(result.gates.forensicGrounded).toBe(false);
    expect(result.checks.find((c) => c.id === 'evidence_specificity')?.contribution).toBe(0);
    expect(result.checks.find((c) => c.id === 'forensic_symbol_grounding')?.contribution).toBe(0);
  });

  it('passes lifecycle-grounded output even without specific symbol mentions (forensicGrounded gate)', () => {
    // Mentions lifecycle terms (dca, sl, hard_stop) but no specific symbol like ESPORTSUSDT.
    // Symbol mentions are rewarded (forensic_symbol_grounding check) but are NOT a gate requirement:
    // a hypothesis applicable to all symbols is still valid.
    const noSymbol = {
      researchSummary: 'Bot results show hard_stop losses with dca sequences. Entry occurred, then dca was triggered twice, then sl fired. OI dropped during the liquidation cascade.',
      hypotheses: [{
        thesis: 'Hard stop losses cluster after dca sequences with declining OI; tighten stop after second dca when OI falls 10%.',
        targetBehavior: 'Reduce slow losing trades.',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'after second dca when oi falls 10%', action: 'tighten_stop', params: {}, rationale: 'hard_stop after dca observed in bot results, tighten stop.' }] },
        requiredFeatures: ['oi', 'ohlcv'],
        validationPlan: 'Replay against June window; reject if total pnl decreases or hard_stop count does not fall.',
        expectedEffect: { metric: 'avg losing trade pnl', direction: 'increase', magnitude: 'less negative' },
        invalidationCriteria: ['Reject if total pnl decreases or hard_stop count does not fall.'],
        confidence: 0.6,
      }],
    };
    const result = scoreResearcherOutput(noSymbol, evalContext);
    // Lifecycle terms present (dca, sl, hard_stop) → forensicGrounded = true → PASS
    expect(result.verdict).toBe('PASS');
    expect(result.gates.forensicGrounded).toBe(true);
    // Symbol not mentioned → forensic_symbol_grounding gets 0 contribution (check still exists)
    expect(result.checks.find((c) => c.id === 'forensic_symbol_grounding')?.contribution).toBe(0);
  });

  it('fails output that attempts to rewrite the strategy', () => {
    const rewrite = {
      researchSummary: 'The current approach shows hard_stop losses on ESPORTSUSDT after dca sequences with sl events.',
      hypotheses: [{
        thesis: 'Replace the current long-OI strategy with a trend-following approach on ESPORTSUSDT after hard_stop dca sl losses.',
        targetBehavior: 'Eliminate hard_stop losses.',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'trend is weak', action: 'skip_entry', params: {}, rationale: 'Replace existing entry logic on ESPORTSUSDT.' }] },
        requiredFeatures: ['ohlcv'],
        validationPlan: 'Replay on June window; reject if hard_stop count does not fall or pnl decreases.',
        expectedEffect: { metric: 'entries', direction: 'decrease' },
        invalidationCriteria: ['Reject if hard_stop rate on ESPORTSUSDT does not fall.'],
        confidence: 0.5,
      }],
    };
    const result = scoreResearcherOutput(rewrite, evalContext);
    expect(result.verdict).toBe('FAIL');
    expect(result.gates.noStrategyRewrite).toBe(false);
  });

  it('passes output that mentions at least one forensic symbol AND lifecycle terms', () => {
    const forensicGrounded = {
      researchSummary: 'ESPORTSUSDT hard_stop losses show entry→dca→dca→sl lifecycle with declining OI. Reject if pnl does not improve.',
      hypotheses: [{
        thesis: 'ESPORTSUSDT hard_stop losses after dca sequences indicate tighten_stop is needed when OI falls after the second dca and sl is imminent.',
        targetBehavior: 'Reduce hard_stop losses without changing win trades.',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'after second dca when oi falls 10%', action: 'tighten_stop', params: {}, rationale: 'Observed hard_stop on ESPORTSUSDT after dca→sl in forensic bundles.' }] },
        requiredFeatures: ['oi', 'ohlcv'],
        validationPlan: 'Replay on June window; reject if hard_stop rate does not fall or pnl decreases on ESPORTSUSDT.',
        expectedEffect: { metric: 'avg losing trade pnl', direction: 'increase', magnitude: 'less negative' },
        invalidationCriteria: ['Reject if total pnl decreases or hard_stop count does not fall on ESPORTSUSDT.'],
        confidence: 0.7,
      }],
    };
    const result = scoreResearcherOutput(forensicGrounded, evalContext);
    expect(result.verdict).toBe('PASS');
    expect(result.gates.forensicGrounded).toBe(true);
    expect(result.gates.noStrategyRewrite).toBe(true);
    expect(result.checks.find((c) => c.id === 'forensic_symbol_grounding')?.contribution).toBeGreaterThan(0);
    expect(result.checks.find((c) => c.id === 'lifecycle_sequence_grounding')?.contribution).toBeGreaterThan(0);
  });
});
