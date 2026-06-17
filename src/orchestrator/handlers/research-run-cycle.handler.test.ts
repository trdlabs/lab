// src/orchestrator/handlers/research-run-cycle.handler.test.ts
import { describe, it, expect } from 'vitest';
import { researchRunCycleHandler } from './research-run-cycle.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { FakeCritic } from '../../adapters/critic/fake-critic.ts';
import type { HypothesisProposalDraft, ResearcherOutput } from '../../domain/hypothesis.ts';
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { AppServices } from '../app-services.ts';
import type { BotResultsReadPort } from '../../ports/bot-results-read.port.ts';

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

function capturingResearcher(out: ResearcherOutput): { port: ResearcherPort; captured: () => ResearcherInput | undefined } {
  let cap: ResearcherInput | undefined;
  return {
    port: { adapter: 'fake', model: 'stub', async propose(inp: ResearcherInput) { cap = inp; return out; } },
    captured: () => cap,
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

  it('gathers live bot-results (status=finished, symbol-filtered) and passes them to the researcher', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis BR')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port }); // default MockBotResultsAdapter -> finished BTCUSDT run
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);

    const input = cap.captured();
    expect(input?.botResults?.length).toBe(1);
    expect(input?.botResults?.[0]?.run.symbols).toContain('BTCUSDT');
    expect(typeof input?.botResults?.[0]?.summary.pnlUsd).toBe('string');
    expect(Array.isArray(input?.botResults?.[0]?.trades)).toBe(true);
  });

  it('filters out runs whose symbols do not include the cycle symbol', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis BR2')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port }); // mock run is BTCUSDT only
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
        return [{ runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] }];
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
});
