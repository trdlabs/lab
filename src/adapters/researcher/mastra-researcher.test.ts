import { describe, it, expect, vi } from 'vitest';
import { MastraResearcher, buildPrompt } from './mastra-researcher.ts';
import { ResearcherOutputSchema } from '../../domain/hypothesis.ts';
import type { ResearcherInput } from '../../ports/researcher.port.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createResearcherAgent } from '../../mastra/agents/researcher.agent.ts';
import { buildMarketContextMath } from '../../research-math/market-context-math.ts';
import { buildTradeContextMath } from '../../research-math/trade-context-math.ts';
import type { CanonicalRowV2 } from '../../ports/market-history-read.port.ts';

const baseInput: ResearcherInput = {
  profile: {
    coreIdea: 'idea',
    direction: 'long',
    requiredMarketFeatures: [],
    profile: {
      summary: 'Enter after a >=10% dump over 20 minutes when OI recovers and long liquidations confirm the bounce.',
      entryConditions: ['Dump >=10% over 20m', 'OI recovery within 3 candles'],
      exitConditions: ['TP1 +3.5%', 'TP2 +5%', 'SL -12%', 'time exit 180m'],
      parameters: [{ name: 'dump.minDropPct', value: 10, unit: '%', description: 'Minimum dump', tunable: true }],
      positionManagementSummary: 'Up to two DCA adds, then move stop to breakeven after TP1.',
      riskManagementSummary: 'Runner owns leverage and execution; strategy controls overlays only.',
      unknowns: ['exact venue'],
      evidence: ['source quote'],
    },
  } as unknown as StrategyProfile,
  marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: {} },
  marketRegime: 'ranging',
  similarHypotheses: [],
  maxHypotheses: 2,
};

const detail: BotRunResultDetail = {
  run: { runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] },
  summary: { runId: 'r1', excludesReconcile: true, asOf: 2, closedTrades: 2, wins: 1, losses: 1, breakeven: 0, winratePct: 50, pnlUsd: '7.5', avgPnl: '3.75', exitReasons: { tp: 1, stop_loss: 1 } },
  trades: [
    { tradeId: 't1', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 1, closedAtMs: 60_001, realizedPnl: '-5', pnlPct: '-0.5', isWin: false, closeReason: 'stop_loss' },
  ],
};

const bundle: TradeEvidenceBundle = {
  tradeId: 't1',
  runId: 'r1',
  symbol: 'COAIUSDT',
  side: 'long',
  enteredAtMs: 1,
  closedAtMs: 60_001,
  entryPrice: '1.25',
  exitPrice: '1.10',
  realizedPnl: '-50.81',
  pnlPct: '-4.1',
  holdingDurationMs: 8_640_000,
  closeReason: 'stop_loss',
  lifecycleEvents: [
    { tsMs: 1, type: 'entry', price: '1.25', qty: '100' },
    { tsMs: 30_000, type: 'dca', price: '1.20', qty: '120' },
    { tsMs: 60_001, type: 'sl', price: '1.10', qty: '220' },
  ],
  minuteContext: [
    { tsMs: 0, close: '1.26', volume: '10000', oi: '440000', liquidationsLong: '0', liquidationsShort: '200' },
    { tsMs: 60_000, close: '1.11', volume: '18000', oi: '390000', liquidationsLong: '1400', liquidationsShort: '0' },
  ],
};

describe('buildPrompt bot-results block', () => {
  it('includes a bot-results block when botResults is non-empty', () => {
    const out = buildPrompt({ ...baseInput, botResults: [detail] });
    expect(out).toContain('Live/paper bot performance evidence');
    expect(out).toContain('trades=2 winratePct=50 pnlUsd=7.5 avgPnl=3.75');
    expect(out).toContain('exitReasons=stop_loss:1, tp:1');
    expect(out).toContain('Worst losing trades:');
    expect(out).toContain('BTCUSDT pnlUsd=-5 pnlPct=-0.5 holdingMinutes=1 closeReason=stop_loss');
  });
  it('includes full strategy profile details and forensic trade evidence when available', () => {
    const out = buildPrompt({ ...baseInput, botResults: [detail], tradeEvidence: [bundle] });
    expect(out).toContain('Strategy summary: Enter after a >=10% dump over 20 minutes');
    expect(out).toContain('Entry conditions: Dump >=10% over 20m');
    expect(out).toContain('Position management: Up to two DCA adds');
    expect(out).toContain('Forensic trade evidence');
    expect(out).toContain('COAIUSDT tradeId=t1 entryPrice=1.25 exitPrice=1.10');
    expect(out).toContain('type=dca');
    expect(out).not.toContain('close=1.11 volume=18000'); // raw minute-context dropped (redundant with per-trade context)
    expect(out).not.toMatch(/^ {2}minute tsMs=/m);
  });
  it('omits the block when botResults is empty or undefined', () => {
    expect(buildPrompt(baseInput)).not.toContain('Live/paper bot performance');
    expect(buildPrompt({ ...baseInput, botResults: [] })).not.toContain('Live/paper bot performance');
  });
});

describe('buildPrompt marketContextMath injection', () => {
  it('injects the formatted market-context block when marketContextMath is present', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      schema_version: 2, minute_ts: i * 60_000, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    }));
    const math = buildMarketContextMath({
      symbol: 'BTCUSDT', rows: rows as any, direction: 'long', regime: 'ranging',
      requiredFeatures: ['oi'], window: { fromMs: 0, toMs: 1 },
    }, 0);
    const prompt = buildPrompt({ ...baseInput, marketContextMath: math });
    expect(prompt).toContain('## Market Context: BTCUSDT');
    expect(prompt).not.toContain('Market context features: {');
  });

  it('falls back to the raw features line when marketContextMath is absent', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('Market context features:');
  });
});

const run = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;

describe('MastraResearcher (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const r = new MastraResearcher(createResearcherAgent(model), label);
    expect(r.adapter).toBe('mastra');
    expect(r.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('MastraResearcher.propose – tracingOptions forwarding', () => {
  const minimalLlmOutput = { researchSummary: 'summary', hypotheses: [] };

  function makeFakeAgent() {
    const generateFn = vi.fn().mockResolvedValue({
      object: minimalLlmOutput,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    return {
      generateFn,
      agent: { generate: generateFn } as unknown as import('@mastra/core/agent').Agent,
    };
  }

  it('forwards tracingMetadata as tracingOptions.metadata on the generate call', async () => {
    const { agent, generateFn } = makeFakeAgent();
    const researcher = new MastraResearcher(agent, 'test-model');
    await researcher.propose(baseInput, { tracingMetadata: { research_market_context_artifact_id: 'art_123' } });
    const opts = generateFn.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts['tracingOptions']).toEqual({ metadata: { research_market_context_artifact_id: 'art_123' } });
  });

  it('omits tracingOptions entirely when no tracingMetadata is given', async () => {
    const { agent, generateFn } = makeFakeAgent();
    const researcher = new MastraResearcher(agent, 'test-model');
    await researcher.propose(baseInput);
    const opts = generateFn.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('tracingOptions');
  });
});

(run ? describe : describe.skip)('MastraResearcher (live)', () => {
  it('returns schema-valid output', async () => {
    const { model, label } = resolveLanguageModel(
      { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      'anthropic/claude-sonnet-4-6',
    );
    const profile: StrategyProfile = {
      id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:abc',
      direction: 'long', coreIdea: 'Buy capitulation wicks on high OI', requiredMarketFeatures: ['oi'],
      confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
      contractVersion: 'strategy-profile-v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    const input: ResearcherInput = {
      profile, marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: { oi: 1 } },
      marketRegime: 'capitulation', similarHypotheses: [], maxHypotheses: 2,
    };
    const out = await new MastraResearcher(createResearcherAgent(model), label).propose(input);
    expect(ResearcherOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});

describe('buildPrompt per-trade context', () => {
  const MIN = 60_000;
  function rows(): CanonicalRowV2[] {
    return Array.from({ length: 260 }, (_, i) => ({
      schema_version: 2, minute_ts: i * MIN, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    } as CanonicalRowV2));
  }
  function tc() {
    return buildTradeContextMath({
      tradeId: 'tr1', symbol: 'BTCUSDT', rows: rows(), entryMs: 200 * MIN, exitMs: 240 * MIN,
      realizedPnl: -12, pnlPct: -1.5, closeReason: 'stop_loss',
      direction: 'long', regime: 'ranging', requiredFeatures: ['oi'],
    }, 0);
  }

  it('injects per-trade context sections when tradeContexts is present', () => {
    const prompt = buildPrompt({ ...baseInput, tradeContexts: [tc()] });
    expect(prompt).toContain('## Per-trade context (losing trades)');
    expect(prompt).toContain('### Trade tr1 · BTCUSDT');
  });

  it('omits per-trade sections when tradeContexts is absent', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).not.toContain('## Per-trade context');
  });
});
