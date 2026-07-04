// src/orchestrator/handlers/research-run-cycle.handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  researchRunCycleHandler,
  selectWinningTrades,
  isTypedCloseReason,
  rankWinnersTyped,
  postExitHeadroomPct,
  rankWinnersByHeadroom,
} from './research-run-cycle.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { FakeCritic } from '../../adapters/critic/fake-critic.ts';
import type { HypothesisProposalDraft, ResearcherOutput } from '../../domain/hypothesis.ts';
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { AppServices } from '../app-services.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';
import type { BotResultsReadPort } from '../../ports/bot-results-read.port.ts';
import type { TradeEvidenceReadPort } from '../../ports/trade-evidence-read.port.ts';
import type { MarketHistoryReadPort, CanonicalRowV2 } from '../../ports/market-history-read.port.ts';
import { InMemoryQueueAdapter } from '../../adapters/queue/in-memory-queue.adapter.ts';
import { InMemoryTokenUsageRepository } from '../../adapters/repository/in-memory-token-usage.repository.ts';
import { InMemoryArtifactStore } from '../../adapters/artifact/in-memory-artifact-store.ts';
import type { ArtifactStorePort } from '../../ports/artifact-store.port.ts';
import type { AgentCallOpts } from '../../ports/agent-call-opts.ts';
import type { ModelPricingPort } from '../../ports/model-pricing.port.ts';

function profile(): StrategyProfile {
  return {
    id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:p',
    direction: 'long', coreIdea: 'Long OI divergence', requiredMarketFeatures: ['oi'],
    confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function task(payload: Record<string, unknown>): ResearchTask {
  return {
    id: 't1', taskType: 'research.run_cycle', source: 'operator', correlationId: 'c1',
    status: 'running', payload, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function draft(thesis: string, action: 'skip_entry' | 'no_op' = 'skip_entry', bars = 1): HypothesisProposalDraft {
  return {
    thesis, targetBehavior: 'filter entries',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend', action, params: { bars } }] },
    requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['no improvement'], confidence: 0.5,
  };
}

function stubResearcher(out: ResearcherOutput): ResearcherPort {
  return { adapter: 'fake', model: 'stub', async propose(_in: ResearcherInput) { return out; } };
}

function capturingResearcher(out: ResearcherOutput): { port: ResearcherPort; captured: () => ResearcherInput | undefined; capturedOpts: () => AgentCallOpts | undefined } {
  let cap: ResearcherInput | undefined;
  let capOpts: AgentCallOpts | undefined;
  return {
    port: { adapter: 'fake', model: 'stub', async propose(inp: ResearcherInput, opts?: AgentCallOpts) { cap = inp; capOpts = opts; return out; } },
    captured: () => cap,
    capturedOpts: () => capOpts,
  };
}

async function seedProfile(services: AppServices) {
  await services.strategyProfiles.create(profile());
}

async function types(services: AppServices): Promise<string[]> {
  return (await services.events.listByTask('t1')).map((e) => e.type);
}

describe('researchRunCycleHandler', () => {
  it('throws on invalid payload', async () => {
    const services = makeServices();
    await expect(researchRunCycleHandler(task({}), services)).rejects.toThrow();
  });

  it('throws when the strategy profile is missing', async () => {
    const services = makeServices();
    await expect(researchRunCycleHandler(task({ strategyProfileId: 'nope' }), services)).rejects.toThrow();
  });

  it('persists validated hypotheses and emits the audit trail', async () => {
    const services = makeServices({ researcher: stubResearcher({ hypotheses: [draft('thesis A')], researchSummary: 's' }) });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    const stored = await services.hypotheses.listByStrategyProfile('p1');
    expect(stored.length).toBe(1);
    expect(stored[0]!.status).toBe('validated');
    const t = await types(services);
    expect(t[0]).toBe('research.run_cycle.started');
    expect(t).toContain('hypothesis.validated');
    expect(t.at(-1)).toBe('research.run_cycle.completed');
  });

  it('persists rejected hypotheses with issues', async () => {
    const bad = draft('Place order on the exchange now'); // live_intent
    const services = makeServices({ researcher: stubResearcher({ hypotheses: [bad], researchSummary: 's' }) });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    const stored = await services.hypotheses.listByStrategyProfile('p1');
    expect(stored.length).toBe(1);
    expect(stored[0]!.status).toBe('rejected');
    expect(stored[0]!.issues.map((i) => i.code)).toContain('live_intent');
    expect(await types(services)).toContain('hypothesis.rejected');
  });

  it('dedupes a batch-internal duplicate: first persists, second only emits deduped', async () => {
    const d = draft('same thesis', 'no_op');
    const services = makeServices({ researcher: stubResearcher({ hypotheses: [d, { ...d }], researchSummary: 's' }) });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    const stored = await services.hypotheses.listByStrategyProfile('p1');
    expect(stored.length).toBe(1);
    const t = await types(services);
    expect(t.filter((x) => x === 'hypothesis.deduped').length).toBe(1);
  });

  it('adds rejected fingerprints to seen so an identical later draft dedupes (seen.add on both paths)', async () => {
    const bad = draft('Place order live', 'no_op'); // rejected by Validator
    const services = makeServices({ researcher: stubResearcher({ hypotheses: [bad, { ...bad }], researchSummary: 's' }) });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    const stored = await services.hypotheses.listByStrategyProfile('p1');
    expect(stored.length).toBe(1);
    expect(stored[0]!.status).toBe('rejected');
    expect((await types(services)).filter((x) => x === 'hypothesis.deduped').length).toBe(1);
  });

  it('clamps effectiveMax to the env guardrail even when payload asks for more', async () => {
    const many = Array.from({ length: 4 }, (_u, i) => draft(`thesis ${i}`, 'no_op', i));
    const services = makeServices({
      maxHypothesesPerCycle: 2,
      researcher: stubResearcher({ hypotheses: many, researchSummary: 's' }),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', maxHypotheses: 99 }), services);

    expect((await services.hypotheses.listByStrategyProfile('p1')).length).toBe(2);
  });

  it('runs the Critic only when enabled and never lets it gate', async () => {
    const off = makeServices({ researcher: stubResearcher({ hypotheses: [draft('thesis C')], researchSummary: 's' }) });
    await seedProfile(off);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), off);
    expect((await off.hypothesisReviews.listByHypothesis((await off.hypotheses.listByStrategyProfile('p1'))[0]!.id)).length).toBe(0);

    const on = makeServices({ critic: new FakeCritic(), researcher: stubResearcher({ hypotheses: [draft('thesis C')], researchSummary: 's' }) });
    await seedProfile(on);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), on);
    const h = (await on.hypotheses.listByStrategyProfile('p1'))[0]!;
    expect((await on.hypothesisReviews.listByHypothesis(h.id)).length).toBe(1);
    expect((await types(on))).toContain('critic.reviewed');
  });

  it('does not block a hypothesis even when lexical similarity is high (similarity is not a gate)', async () => {
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('identical thesis text', 'no_op', 1)], researchSummary: 's' }),
    });
    await seedProfile(services);

    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
    expect((await services.hypotheses.listByStrategyProfile('p1')).length).toBe(1);

    const second = makeServices({
      ...services,
      researcher: stubResearcher({ hypotheses: [draft('identical thesis text', 'skip_entry', 7)], researchSummary: 's' }),
    });
    const t2 = task({ strategyProfileId: 'p1' });
    t2.id = 't2';
    await researchRunCycleHandler(t2, second);

    expect((await second.hypotheses.listByStrategyProfile('p1')).length).toBe(2);
    expect((await second.events.listByTask('t2')).map((e) => e.type)).not.toContain('hypothesis.deduped');
  });

  it('enqueues one hypothesis.build task per validated hypothesis (fan-out)', async () => {
    const queue = new InMemoryQueueAdapter();
    const twoHypotheses = [draft('thesis X', 'skip_entry', 1), draft('thesis Y', 'skip_entry', 2)];
    const services = makeServices({
      taskQueue: queue,
      researcher: stubResearcher({ hypotheses: twoHypotheses, researchSummary: 's' }),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    const buildEnvelopes = queue.queued.filter((e) => e.taskType === 'hypothesis.build');
    expect(buildEnvelopes).toHaveLength(2);

    const savedHypotheses = await services.hypotheses.listByStrategyProfile('p1');
    const savedIds = new Set(savedHypotheses.map((h) => h.id));
    for (const env of buildEnvelopes) {
      const buildTask = await services.researchTasks.findById(env.taskId);
      expect(buildTask).not.toBeNull();
      expect(buildTask?.taskType).toBe('hypothesis.build');
      expect(savedIds.has(buildTask?.payload.hypothesisId as string)).toBe(true);
    }
  });

  it('does NOT enqueue hypothesis.build for rejected hypotheses', async () => {
    const queue = new InMemoryQueueAdapter();
    const bad = draft('Place order on the exchange now');
    const services = makeServices({
      taskQueue: queue,
      researcher: stubResearcher({ hypotheses: [bad], researchSummary: 's' }),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    expect(queue.queued.filter((e) => e.taskType === 'hypothesis.build')).toHaveLength(0);
  });

  it('gathers live bot-results (status=finished, symbol-filtered) and passes them to the researcher', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis BR')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port }); // default MockBotResultsAdapter -> finished ESPORTSUSDT run
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'ESPORTSUSDT' }), services);

    const input = cap.captured();
    expect(input?.botResults?.length).toBe(1);
    expect(input?.botResults?.[0]?.run.symbols).toContain('ESPORTSUSDT');
    expect(typeof input?.botResults?.[0]?.summary.pnlUsd).toBe('string');
    expect(Array.isArray(input?.botResults?.[0]?.trades)).toBe(true);
  });

  it('filters out runs whose symbols do not include the cycle symbol', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis BR2')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port }); // mock run is ESPORTSUSDT only
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'ETHUSDT' }), services);
    expect(cap.captured()?.botResults).toEqual([]);
  });

  it('is fail-soft: a throwing bot-results port yields [] + a researcher.bot_results_unavailable event', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis BR3')], researchSummary: 's' });
    const throwing: BotResultsReadPort = {
      async listBotRuns() { throw new Error('ops-read down'); },
      async getClosedTrades() { return []; },
      async getRunSummary() { throw new Error('ops-read down'); },
      async getOperationalEvents() { throw new Error('ops-read down'); },
      async getDecisionLog() { throw new Error('ops-read down'); },
    };
    const services = makeServices({ researcher: cap.port, botResults: throwing });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    expect(cap.captured()?.botResults).toEqual([]);
    expect(await types(services)).toContain('researcher.bot_results_unavailable');
  });

  it('is fail-soft mid-gather: a per-run summary failure (after listBotRuns succeeds) also yields [] + the event', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis BR4')], researchSummary: 's' });
    const midThrow: BotResultsReadPort = {
      async listBotRuns() {
        return [{ runId: 'r1', mode: 'paper', status: 'finished', bundleId: null, strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] }];
      },
      async getRunSummary() { throw new Error('summary down'); },
      async getClosedTrades() { return []; },
      async getOperationalEvents() { return { items: [], nextCursor: null, asOf: 0, window: {}, freshness: 'fresh' }; },
      async getDecisionLog() { return { items: [], nextCursor: null, asOf: 0, window: {}, freshness: 'fresh' }; },
    };
    const services = makeServices({ researcher: cap.port, botResults: midThrow });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);
    expect(cap.captured()?.botResults).toEqual([]);
    expect(await types(services)).toContain('researcher.bot_results_unavailable');
  });

  it('includes the monitored paper run via paperRunId even though it is running (excluded by the finished filter)', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis PR1')], researchSummary: 's' });
    const runningPaperRun = {
      runId: 'paper-1', mode: 'paper' as const, status: 'running' as const, bundleId: null, strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: 0, lastSeenMs: 5, symbols: ['BTCUSDT'],
    };
    const botResults: BotResultsReadPort = {
      async listBotRuns(filter) {
        if (filter?.mode === 'paper') return [runningPaperRun];
        return []; // 'finished' filter excludes the still-running paper run
      },
      async getRunSummary(runId) {
        expect(runId).toBe('paper-1');
        return { runId: 'paper-1', excludesReconcile: true, asOf: 5, closedTrades: 1, wins: 1, losses: 0, breakeven: 0, winratePct: 100, pnlUsd: '5', avgPnl: '5', exitReasons: {} };
      },
      async getClosedTrades(runId) {
        expect(runId).toBe('paper-1');
        return [{ tradeId: 'pt-1', runId: 'paper-1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 1, closedAtMs: 2, realizedPnl: '5', pnlPct: '0.5', isWin: true, closeReason: 'take_profit_final', entryPrice: null, exitPrice: null, closeReasonRaw: null }];
      },
      async getOperationalEvents() { return { items: [], nextCursor: null, asOf: 5, window: {}, freshness: 'fresh' }; },
      async getDecisionLog() { return { items: [], nextCursor: null, asOf: 5, window: {}, freshness: 'fresh' }; },
    };
    const services = makeServices({ researcher: cap.port, botResults });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT', paperRunId: 'paper-1' }), services);

    const input = cap.captured();
    expect(input?.botResults?.[0]?.run.runId).toBe('paper-1');
    expect(input?.botResults?.[0]?.trades.map((t) => t.tradeId)).toEqual(['pt-1']);
  });

  it('emits researcher.paper_run_missing and still completes the cycle when paperRunId points nowhere', async () => {
    const services = makeServices({ researcher: stubResearcher({ hypotheses: [draft('thesis PR2')], researchSummary: 's' }) });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', paperRunId: 'does-not-exist' }), services);

    const t = await types(services);
    expect(t).toContain('researcher.paper_run_missing');
    expect(t.at(-1)).toBe('research.run_cycle.completed');
  });

  it('does not touch mode=paper bot-results when paperRunId is absent (byte-identical behavior)', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis PR3')], researchSummary: 's' });
    let paperModeCalls = 0;
    const botResults: BotResultsReadPort = {
      async listBotRuns(filter) {
        if (filter?.mode === 'paper') paperModeCalls += 1;
        return [];
      },
      async getRunSummary() { throw new Error('should not be called'); },
      async getClosedTrades() { throw new Error('should not be called'); },
      async getOperationalEvents() { return { items: [], nextCursor: null, asOf: 0, window: {}, freshness: 'fresh' }; },
      async getDecisionLog() { return { items: [], nextCursor: null, asOf: 0, window: {}, freshness: 'fresh' }; },
    };
    const services = makeServices({ researcher: cap.port, botResults });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    expect(paperModeCalls).toBe(0);
    expect(cap.captured()?.botResults).toEqual([]);
    expect(await types(services)).not.toContain('researcher.paper_run_missing');
  });

  it('records researcher token usage against the task correlationId', async () => {
    const tokenUsage = new InMemoryTokenUsageRepository();
    const reportingResearcher: ResearcherPort = {
      adapter: 'fake', model: 'test',
      async propose(_input: ResearcherInput, opts?: AgentCallOpts) {
        await opts?.onUsage?.({ modelId: 'test', inputTokens: 700, outputTokens: 77, totalTokens: 777 });
        return { researchSummary: 's', hypotheses: [] };
      },
    };
    const services = makeServices({ tokenUsage, researcher: reportingResearcher });
    const t = task({ strategyProfileId: 'p1' });
    await seedProfile(services);
    await researchRunCycleHandler(t, services);
    expect(await tokenUsage.get(t.correlationId)).toBe(777);
  });

  it('selects suspicious trades and passes forensic tradeEvidence to the researcher', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis forensic')], researchSummary: 's' });
    const tradeEvidence: TradeEvidenceReadPort = {
      async getTradeEvidence(query) {
        expect(query.tradeIds).toEqual(['t-loss-1', 't-loss-2']);
        return query.tradeIds.map((tradeId) => ({
          tradeId,
          runId: 'r1',
          symbol: 'BTCUSDT',
          side: 'long',
          enteredAtMs: 1,
          closedAtMs: 2,
          entryPrice: '1.0',
          exitPrice: '0.9',
          realizedPnl: '-10',
          pnlPct: '-1',
          holdingDurationMs: 60_000,
          closeReason: 'stop_loss',
          lifecycleEvents: [{ tsMs: 1, type: 'entry', price: '1.0', qty: '10' }],
          minuteContext: [{ tsMs: 1, close: '1.0', volume: '100', oi: '5000', liquidationsLong: '50', liquidationsShort: '0' }],
        }));
      },
    };
    const botResults: BotResultsReadPort = {
      async listBotRuns() {
        return [{ runId: 'r1', mode: 'paper', status: 'finished', bundleId: null, strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] }];
      },
      async getRunSummary() {
        return { runId: 'r1', excludesReconcile: true, asOf: 2, closedTrades: 3, wins: 1, losses: 2, breakeven: 0, winratePct: 33.33, pnlUsd: '-20', avgPnl: '-6.66', exitReasons: { stop_loss: 2, take_profit: 1 } };
      },
      async getClosedTrades() {
        return [
          { tradeId: 't-win', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 1, closedAtMs: 2, realizedPnl: '5', pnlPct: '0.5', isWin: true, closeReason: 'take_profit_final', entryPrice: null, exitPrice: null, closeReasonRaw: null },
          { tradeId: 't-loss-1', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 1, closedAtMs: 4, realizedPnl: '-15', pnlPct: '-1.5', isWin: false, closeReason: 'stop_loss', entryPrice: null, exitPrice: null, closeReasonRaw: null },
          { tradeId: 't-loss-2', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 1, closedAtMs: 3, realizedPnl: '-8', pnlPct: '-0.8', isWin: false, closeReason: 'stop_loss', entryPrice: null, exitPrice: null, closeReasonRaw: null },
        ];
      },
      async getOperationalEvents() {
        return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' };
      },
      async getDecisionLog() {
        return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' };
      },
    };
    const services = makeServices({ researcher: cap.port, botResults, tradeEvidence });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);

    expect(cap.captured()?.tradeEvidence?.map((b) => b.tradeId)).toEqual(['t-loss-1', 't-loss-2']);
  });

  it('accrues $ cost from priced researcher usage', async () => {
    const tokenUsage = new InMemoryTokenUsageRepository();
    const modelPricing: ModelPricingPort = {
      async priceFor(id) { return id === 'm-test' ? { inputUsdPerToken: 0.00001, outputUsdPerToken: 0.00003 } : null; },
    };
    const researcher: ResearcherPort = {
      adapter: 'fake', model: 'test',
      async propose(_i, opts) {
        await opts?.onUsage?.({ modelId: 'm-test', inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
        return { researchSummary: 's', hypotheses: [] };
      },
    };
    const services = makeServices({ tokenUsage, modelPricing, researcher });
    const t = task({ strategyProfileId: 'p1' });
    await seedProfile(services);
    await researchRunCycleHandler(t, services);
    // 1000*0.00001 + 500*0.00003 = 0.01 + 0.015 = 0.025
    expect(await tokenUsage.getCost(t.correlationId)).toBeCloseTo(0.025, 10);
    expect(await tokenUsage.get(t.correlationId)).toBe(1500); // tokens still recorded
  });

  it('attaches marketContextMath to the researcher propose input when market history is available', async () => {
    const marketHistoryRows = Array.from({ length: 60 }, (_, i) => ({
      schema_version: 2 as const, minute_ts: i * 60_000, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    }));
    const marketHistory: MarketHistoryReadPort = { getRows: async () => marketHistoryRows };
    const cap = capturingResearcher({ hypotheses: [draft('thesis math')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
    expect(cap.captured()?.marketContextMath).toBeDefined();
    expect(cap.captured()?.marketContextMath?.terms.length).toBeGreaterThan(0);
  });

  it('is fail-soft: when marketHistory.getRows throws, propose is still called without marketContextMath and the unavailable event is emitted', async () => {
    const throwingHistory: MarketHistoryReadPort = {
      async getRows() { throw new Error('history down'); },
    };
    const cap = capturingResearcher({ hypotheses: [draft('thesis no-math')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port, marketHistory: throwingHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
    expect(cap.captured()?.marketContextMath).toBeUndefined();
    expect(await types(services)).toContain('researcher.market_history_unavailable');
  });

  it('commits market-context math markdown as an artifact when market history is available', async () => {
    const marketHistoryRows = Array.from({ length: 60 }, (_, i) => ({
      schema_version: 2 as const, minute_ts: i * 60_000, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    }));
    const marketHistory: MarketHistoryReadPort = { getRows: async () => marketHistoryRows };
    const artifactStore = new InMemoryArtifactStore();
    const putSpy = vi.spyOn(artifactStore, 'put');
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('thesis artifact')], researchSummary: 's' }),
      marketHistory,
      artifacts: artifactStore,
    });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    expect(putSpy).toHaveBeenCalledOnce();
    const [content, meta] = putSpy.mock.calls[0]!;
    expect(typeof content).toBe('string');
    expect(content as string).toContain('## Market Context:');
    expect(meta.kind).toBe('market-context-math');
    expect(meta.mime_type).toBe('text/markdown');
    expect(meta.producer).toBe('research-run-cycle');
  });

  it('is fail-soft: a throwing artifactStore.put never fails the research cycle', async () => {
    const marketHistoryRows = Array.from({ length: 60 }, (_, i) => ({
      schema_version: 2 as const, minute_ts: i * 60_000, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    }));
    const marketHistory: MarketHistoryReadPort = { getRows: async () => marketHistoryRows };
    const throwingStore: ArtifactStorePort = {
      async put() { throw new Error('storage down'); },
      async get() { throw new Error('storage down'); },
      resolveUri() { return ''; },
    };
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('thesis no-artifact')], researchSummary: 's' }),
      marketHistory,
      artifacts: throwingStore,
    });
    await seedProfile(services);
    await expect(researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services)).resolves.toBeUndefined();
    expect((await types(services)).at(-1)).toBe('research.run_cycle.completed');
  });

  it('I2: emits researcher.market_context_committed with artifactId, correlationId, symbol after successful artifact put', async () => {
    const marketHistoryRows = Array.from({ length: 60 }, (_, i) => ({
      schema_version: 2 as const, minute_ts: i * 60_000, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    }));
    const marketHistory: MarketHistoryReadPort = { getRows: async () => marketHistoryRows };
    const artifactStore = new InMemoryArtifactStore();
    const putSpy = vi.spyOn(artifactStore, 'put');
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('thesis I2')], researchSummary: 's' }),
      marketHistory,
      artifacts: artifactStore,
    });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    expect(putSpy).toHaveBeenCalledOnce();
    const ref = await (putSpy.mock.results[0]!.value as Promise<import('../../domain/types.ts').ArtifactRef>);
    const allEvents = await services.events.listByTask('t1');
    const commitEvent = allEvents.find((e) => e.type === 'researcher.market_context_committed');
    expect(commitEvent).toBeDefined();
    expect(commitEvent?.payload.artifactId).toBe(ref.artifact_id);
    expect(commitEvent?.payload.correlationId).toBe('c1');
    expect(commitEvent?.payload.symbol).toBe('BTCUSDT');
  });

  it('E3: passes tracingMetadata with the committed artifact id to propose when market history yields terms', async () => {
    const marketHistoryRows = Array.from({ length: 60 }, (_, i) => ({
      schema_version: 2 as const, minute_ts: i * 60_000, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    }));
    const marketHistory: MarketHistoryReadPort = { getRows: async () => marketHistoryRows };
    const artifactStore = new InMemoryArtifactStore();
    const putSpy = vi.spyOn(artifactStore, 'put');
    const cap = capturingResearcher({ hypotheses: [draft('thesis E3 tracing')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port, marketHistory, artifacts: artifactStore });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    expect(putSpy).toHaveBeenCalledOnce();
    const ref = await (putSpy.mock.results[0]!.value as Promise<import('../../domain/types.ts').ArtifactRef>);
    expect(cap.capturedOpts()?.tracingMetadata).toEqual({
      research_market_context_artifact_id: ref.artifact_id,
    });
  });

  it('M1: does not attach marketContextMath to propose when rows are too sparse to form any term (zero terms → raw fallback)', async () => {
    // 5 rows at 1h cadence: cadenceMs=3_600_000; barCount=5 < long.minBars(28) → all terms excluded → zero terms
    const sparseRows = Array.from({ length: 5 }, (_, i) => ({
      schema_version: 2 as const, minute_ts: i * 3_600_000, symbol: 'BTCUSDT',
      open: 100, high: 101, low: 99, close: 100, volume: 10, turnover: 1000,
      oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    }));
    const marketHistory: MarketHistoryReadPort = { getRows: async () => sparseRows };
    const cap = capturingResearcher({ hypotheses: [draft('thesis sparse')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
    expect(cap.captured()?.marketContextMath).toBeUndefined();
  });
});

describe('researchRunCycleHandler per-trade context', () => {
  const MIN = 60_000;
  function losingBotResults(): BotResultsReadPort {
    return {
      async listBotRuns() {
        return [{ runId: 'r1', mode: 'paper', status: 'finished', bundleId: null, strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] }];
      },
      async getRunSummary() {
        return { runId: 'r1', excludesReconcile: true, asOf: 2, closedTrades: 1, wins: 0, losses: 1, breakeven: 0, winratePct: 0, pnlUsd: '-15', avgPnl: '-15', exitReasons: { stop_loss: 1 } };
      },
      async getClosedTrades() {
        return [{ tradeId: 't-loss-1', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 200 * MIN, closedAtMs: 240 * MIN, realizedPnl: '-15', pnlPct: '-1.5', isWin: false, closeReason: 'stop_loss', entryPrice: null, exitPrice: null, closeReasonRaw: null }];
      },
      async getOperationalEvents() { return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' }; },
      async getDecisionLog() { return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' }; },
    };
  }
  function losingBundle() {
    return {
      tradeId: 't-loss-1', runId: 'r1', symbol: 'BTCUSDT', side: 'long' as const,
      enteredAtMs: 200 * MIN, closedAtMs: 240 * MIN, entryPrice: '1.0', exitPrice: '0.9',
      realizedPnl: '-15', pnlPct: '-1.5', holdingDurationMs: 40 * MIN, closeReason: 'stop_loss',
      lifecycleEvents: [], minuteContext: [],
    };
  }
  function malformedBotResults(): BotResultsReadPort {
    return {
      async listBotRuns() {
        return [{ runId: 'r1', mode: 'paper', status: 'finished', bundleId: null, strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] }];
      },
      async getRunSummary() {
        return { runId: 'r1', excludesReconcile: true, asOf: 2, closedTrades: 1, wins: 0, losses: 1, breakeven: 0, winratePct: 0, pnlUsd: '-Inf', avgPnl: '-Inf', exitReasons: { stop_loss: 1 } };
      },
      async getClosedTrades() {
        // -Infinity passes the < 0 filter but !isFinite → guard normalises to 0
        return [{ tradeId: 't-loss-1', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 200 * MIN, closedAtMs: 240 * MIN, realizedPnl: '-Infinity', pnlPct: '-1.5', isWin: false, closeReason: 'stop_loss', entryPrice: null, exitPrice: null, closeReasonRaw: null }];
      },
      async getOperationalEvents() { return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' }; },
      async getDecisionLog() { return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' }; },
    };
  }
  function historyRows(): CanonicalRowV2[] {
    return Array.from({ length: 260 }, (_, i) => ({
      schema_version: 2 as const, minute_ts: i * MIN, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    }));
  }

  it('builds per-trade contexts from the selected losing ClosedTrades even when trade-evidence is empty', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis ptc')], researchSummary: 's' });
    const tradeEvidence: TradeEvidenceReadPort = { async getTradeEvidence() { return []; } }; // mirrors the real stub
    const marketHistory: MarketHistoryReadPort = { async getRows() { return historyRows(); } };
    const services = makeServices({ researcher: cap.port, botResults: losingBotResults(), tradeEvidence, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);
    const ctxs = cap.captured()?.tradeContexts;
    expect(ctxs?.length).toBe(1);
    expect(ctxs?.[0]?.tradeId).toBe('t-loss-1');
    expect(ctxs?.[0]?.atExit.some((t) => t.config.key === 'micro')).toBe(true);
  });

  it('is fail-soft: a per-trade getRows failure skips that context + emits an event, cycle still completes', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis ptc-fail')], researchSummary: 's' });
    const tradeEvidence: TradeEvidenceReadPort = { async getTradeEvidence() { return [losingBundle()]; } };
    const marketHistory: MarketHistoryReadPort = { async getRows() { throw new Error('history down'); } };
    const services = makeServices({ researcher: cap.port, botResults: losingBotResults(), tradeEvidence, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);
    expect(cap.captured()?.tradeContexts).toBeUndefined();
    expect(await types(services)).toContain('researcher.trade_context_unavailable');
    expect((await types(services)).at(-1)).toBe('research.run_cycle.completed');
  });

  it('omits tradeContexts when there are no losing trades', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis no-losers')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port }); // default botResults → no trades
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
    expect(cap.captured()?.tradeContexts).toBeUndefined();
  });

  it('guards malformed realizedPnl: a non-finite parse falls back to 0 (not NaN)', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis malformed-pnl')], researchSummary: 's' });
    // Source is now the ClosedTrade; -Infinity passes the < 0 filter and triggers the isFinite guard → 0
    const tradeEvidence: TradeEvidenceReadPort = { async getTradeEvidence() { return []; } };
    const marketHistory: MarketHistoryReadPort = { async getRows() { return historyRows(); } };
    const services = makeServices({ researcher: cap.port, botResults: malformedBotResults(), tradeEvidence, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);
    const ctxs = cap.captured()?.tradeContexts;
    expect(ctxs?.length).toBe(1);
    expect(Number.isNaN(ctxs?.[0]?.realizedPnl)).toBe(false);
    expect(ctxs?.[0]?.realizedPnl).toBe(0);
  });

  it('extends the per-trade getRows window by the post-exit tail (default 60m)', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis tail')], researchSummary: 's' });
    const toMsSeen: number[] = [];
    const marketHistory: MarketHistoryReadPort = {
      async getRows(q) { toMsSeen.push(q.toMs); return historyRows(); },
    };
    const services = makeServices({ researcher: cap.port, botResults: losingBotResults(), tradeEvidence: { async getTradeEvidence() { return []; } }, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);
    expect(toMsSeen).toContain(240 * MIN + 60 * MIN); // per-trade window = closedAtMs + 60min tail
  });
});

describe('winner selection', () => {
  function trade(over: Partial<import('../../ports/bot-results-read.port.ts').ClosedTrade>): import('../../ports/bot-results-read.port.ts').ClosedTrade {
    return {
      tradeId: 't', runId: 'r', symbol: 'ESPORTSUSDT', side: 'long',
      openedAtMs: 1_000_000, closedAtMs: 2_000_000,
      realizedPnl: '1', pnlPct: '1', isWin: true, closeReason: 'take_profit_final',
      ...over,
      entryPrice: over.entryPrice ?? null,
      exitPrice: over.exitPrice ?? null,
      closeReasonRaw: over.closeReasonRaw ?? null,
    };
  }

  it('selectWinningTrades picks isWin===true and the realizedPnl>0 fallback, excludes losers/breakeven', () => {
    const details = [{ run: {} as any, summary: {} as any, trades: [
      trade({ tradeId: 'win-flag', isWin: true, realizedPnl: '5' }),
      trade({ tradeId: 'win-fallback', isWin: null, realizedPnl: '3' }),
      trade({ tradeId: 'loser', isWin: false, realizedPnl: '-2' }),
      trade({ tradeId: 'breakeven', isWin: null, realizedPnl: '0' }),
    ] }];
    const ids = selectWinningTrades(details).map((t) => t.tradeId).sort();
    expect(ids).toEqual(['win-fallback', 'win-flag']);
  });

  it('isTypedCloseReason recognizes canonical members only', () => {
    expect(isTypedCloseReason('take_profit_partial')).toBe(true);
    expect(isTypedCloseReason('TP2_hit_raw_strategy_string')).toBe(false);
    expect(isTypedCloseReason(null)).toBe(false);
  });

  it('rankWinnersTyped puts headroom-class reasons first and caps', () => {
    const ws = [
      trade({ tradeId: 'final', closeReason: 'take_profit_final', closedAtMs: 9 }),
      trade({ tradeId: 'partial', closeReason: 'take_profit_partial', closedAtMs: 8 }),
      trade({ tradeId: 'be', closeReason: 'breakeven', closedAtMs: 7 }),
    ];
    expect(rankWinnersTyped(ws, 2).map((t) => t.tradeId)).toEqual(['partial', 'be']);
  });

  it('postExitHeadroomPct measures favourable continuation after exit for a long', () => {
    const rows = [
      { minute_ts: 1, open: 0, high: 100, low: 100, close: 100 } as CanonicalRowV2,
      { minute_ts: 2, open: 0, high: 110, low: 90, close: 100 } as CanonicalRowV2,
    ];
    expect(postExitHeadroomPct(trade({ side: 'long', closedAtMs: 1 }), rows)).toBeCloseTo(0.10, 6);
    expect(postExitHeadroomPct(trade({ side: 'long', closedAtMs: 2 }), rows)).toBe(0);
  });

  it('postExitHeadroomPct measures favourable continuation after exit for a short (downward move)', () => {
    const rows = [
      { minute_ts: 1, open: 0, high: 100, low: 100, close: 100 } as CanonicalRowV2,
      { minute_ts: 2, open: 0, high: 110, low: 90, close: 100 } as CanonicalRowV2,
    ];
    // Short: favourable = price drops after exit; (exitClose − minLow)/exitClose = (100−90)/100 = 0.10
    expect(postExitHeadroomPct(trade({ side: 'short', closedAtMs: 1 }), rows)).toBeCloseTo(0.10, 6);
    // No post-exit bars → 0
    expect(postExitHeadroomPct(trade({ side: 'short', closedAtMs: 2 }), rows)).toBe(0);
  });

  it('rankWinnersByHeadroom orders by left-on-table and caps', () => {
    const big = trade({ tradeId: 'big', side: 'long', closedAtMs: 1 });
    const small = trade({ tradeId: 'small', side: 'long', closedAtMs: 1 });
    const map = new Map<string, readonly CanonicalRowV2[]>([
      ['big', [{ minute_ts: 1, high: 100, low: 100, close: 100 } as CanonicalRowV2, { minute_ts: 2, high: 130, low: 100, close: 120 } as CanonicalRowV2]],
      ['small', [{ minute_ts: 1, high: 100, low: 100, close: 100 } as CanonicalRowV2, { minute_ts: 2, high: 102, low: 100, close: 101 } as CanonicalRowV2]],
    ]);
    expect(rankWinnersByHeadroom([small, big], map, 1).map((t) => t.tradeId)).toEqual(['big']);
  });
});

describe('two-pass research', () => {
  const MIN = 60_000;

  function loserTrade(over: { tradeId: string }): import('../../ports/bot-results-read.port.ts').ClosedTrade {
    return {
      tradeId: over.tradeId, runId: 'r1', symbol: 'BTCUSDT', side: 'long',
      openedAtMs: 200 * MIN, closedAtMs: 240 * MIN,
      realizedPnl: '-5', pnlPct: '-0.5', isWin: false, closeReason: 'stop_loss',
      entryPrice: null, exitPrice: null, closeReasonRaw: null,
    };
  }

  function winnerTrade(over: { tradeId: string }): import('../../ports/bot-results-read.port.ts').ClosedTrade {
    return {
      tradeId: over.tradeId, runId: 'r1', symbol: 'BTCUSDT', side: 'long',
      openedAtMs: 200 * MIN, closedAtMs: 240 * MIN,
      realizedPnl: '5', pnlPct: '0.5', isWin: true, closeReason: 'take_profit_partial',
      entryPrice: null, exitPrice: null, closeReasonRaw: null,
    };
  }

  function twoPassBotResults(trades: import('../../ports/bot-results-read.port.ts').ClosedTrade[]): BotResultsReadPort {
    return {
      async listBotRuns() {
        return [{ runId: 'r1', mode: 'paper', status: 'finished', bundleId: null, strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] }];
      },
      async getRunSummary() {
        return { runId: 'r1', excludesReconcile: true, asOf: 2, closedTrades: trades.length, wins: 0, losses: 0, breakeven: 0, winratePct: 0, pnlUsd: '0', avgPnl: '0', exitReasons: {} };
      },
      async getClosedTrades() { return trades; },
      async getOperationalEvents() { return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' }; },
      async getDecisionLog() { return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' }; },
    };
  }

  function twoPassHistory(): MarketHistoryReadPort {
    return {
      async getRows() {
        return Array.from({ length: 260 }, (_, i) => ({
          schema_version: 2 as const, minute_ts: i * MIN, symbol: 'BTCUSDT',
          open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
          oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
          taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
          has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
        }));
      },
    };
  }

  function runCycleTask(): ResearchTask {
    return task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' });
  }

  it('runs loss then profit when winners exist, skips profit with none, merges drafts', async () => {
    const calls: string[] = [];
    const researcher: ResearcherPort = {
      adapter: 'fake' as const, model: 'fake',
      async propose(input: ResearcherInput) {
        calls.push(input.focus);
        return {
          hypotheses: [{
            thesis: `t-${input.focus}`, targetBehavior: 'b',
            ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: {} }] },
            requiredFeatures: ['oi'], validationPlan: 'p',
            expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['none'], confidence: 0.5,
          }],
          researchSummary: 's',
        };
      },
    };

    const services = makeServices({
      researcher,
      botResults: twoPassBotResults([loserTrade({ tradeId: 'L1' }), winnerTrade({ tradeId: 'W1' })]),
      marketHistory: twoPassHistory(),
    });
    await seedProfile(services);
    await researchRunCycleHandler(runCycleTask(), services);
    expect(calls).toEqual(['loss_reduction', 'profit_improvement']);

    // no winners -> profit skipped
    const calls2: string[] = [];
    const researcher2: ResearcherPort = {
      adapter: 'fake' as const, model: 'fake',
      async propose(input: ResearcherInput) {
        calls2.push(input.focus);
        return { hypotheses: [], researchSummary: 's' };
      },
    };
    const services2 = makeServices({
      researcher: researcher2,
      botResults: twoPassBotResults([loserTrade({ tradeId: 'L2' })]),
      marketHistory: twoPassHistory(),
    });
    await seedProfile(services2);
    await researchRunCycleHandler(runCycleTask(), services2);
    expect(calls2).toEqual(['loss_reduction']);
  });

  describe('activeOverlayRules (slice G3: sourced from the latest ACCEPTED revision)', () => {
    it('REGRESSION PIN: a validated-but-unmerged HypothesisProposal is NOT fed as an active overlay rule', async () => {
      const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
      const services = makeServices({ researcher: cap.port });
      await seedProfile(services);
      await services.hypotheses.create({
        id: 'h-validated', strategyProfileId: 'p1', thesis: 'unmerged thesis', targetBehavior: 'b',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: {} }] },
        requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
        invalidationCriteria: ['none'], confidence: 0.5, status: 'validated', fingerprint: 'sha256:h-validated',
        proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      });

      await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
      expect(cap.captured()?.activeOverlayRules).toEqual([]);
    });

    it('is empty when the latest accepted revision is a v1 bootstrap with empty rules', async () => {
      const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
      const services = makeServices({ researcher: cap.port });
      await seedProfile(services);
      const v1: StrategyRevision = {
        id: 'rev-1', strategyProfileId: 'p1', version: 1, hypothesisIds: [],
        mergedRuleSet: { order: [], rules: [] }, status: 'accepted',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      };
      await services.revisions.create(v1);

      await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
      expect(cap.captured()?.activeOverlayRules).toEqual([]);
    });

    it('reflects the latest accepted revision mergedRuleSet rules + theses (status accepted_revision)', async () => {
      const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
      const services = makeServices({ researcher: cap.port });
      await seedProfile(services);
      const v1: StrategyRevision = {
        id: 'rev-1', strategyProfileId: 'p1', version: 1, hypothesisIds: [],
        mergedRuleSet: { order: [], rules: [] }, status: 'accepted',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      };
      await services.revisions.create(v1);
      const v2: StrategyRevision = {
        id: 'rev-2', strategyProfileId: 'p1', version: 2, baseRevisionId: 'rev-1', hypothesisIds: ['h1'],
        mergedRuleSet: {
          order: ['h1'],
          rules: [{ appliesTo: 'long', rules: [{ when: 'oi trend', action: 'skip_entry', params: { bars: 2 } }] }],
          theses: ['merged thesis h1'],
        },
        status: 'accepted',
        createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
      };
      await services.revisions.create(v2);

      await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
      expect(cap.captured()?.activeOverlayRules).toEqual([
        {
          thesis: 'merged thesis h1',
          ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend', action: 'skip_entry', params: { bars: 2 } }] },
          status: 'accepted_revision',
        },
      ]);
    });

    it('is fail-soft: a throwing revisions repo yields an empty activeOverlayRules', async () => {
      const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
      const throwing: AppServices['revisions'] = {
        async create() { throw new Error('db down'); },
        async findById() { throw new Error('db down'); },
        async findLatestAccepted() { throw new Error('db down'); },
        async updateStatus() { throw new Error('db down'); },
        async listByProfile() { throw new Error('db down'); },
        async findConsolidatedOf() { throw new Error('db down'); },
      };
      const services = makeServices({ researcher: cap.port, revisions: throwing });
      await seedProfile(services);

      await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
      expect(cap.captured()?.activeOverlayRules).toEqual([]);
    });
  });
});
