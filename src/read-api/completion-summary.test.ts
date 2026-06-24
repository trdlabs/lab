import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCompletionSummary, type CompletionSummaryDeps } from './completion-summary.ts';

// Minimal in-memory deps. Each method returns canned data; override per test.
function fakeDeps(over: Partial<Record<string, unknown>> = {}): CompletionSummaryDeps {
  const base = {
    researchTasks: { findById: async () => null },
    strategyProfiles: { findById: async () => null },
    hypotheses: { list: async () => [], getById: async () => null },
    backtests: { list: async () => [], getById: async () => null },
    agentEvents: { list: async () => [] },
  };
  return { ...base, ...over } as unknown as CompletionSummaryDeps;
}

const completedTask = (over: Record<string, unknown>) => ({
  id: 't1', taskType: 'backtest.completed', source: 'operator', correlationId: 'c1',
  status: 'completed', payload: {}, createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z',
  ...over,
});

describe('buildCompletionSummary — backtest.completed', () => {
  it('maps decision, metrics, hypothesis, profile and willRetry', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({
        payload: { backtestRunId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1', decision: 'FAIL', reasons: ['low sharpe'], cycleDepth: 0 },
      }) },
      backtests: { getById: async (id: string) => id === 'b1' ? {
        id: 'b1', metrics: { netPnlUsd: -10, netPnlPct: -1, totalTrades: 20, winRate: 0.4, profitFactor: 0.8, maxDrawdownPct: 15, expectancyUsd: -0.5, sharpe: -0.2, topTradeContributionPct: 30 },
      } : null },
      hypotheses: { list: async () => [], getById: async (id: string) => id === 'h1' ? { id: 'h1', thesis: 'short the pump', confidence: 0.6, status: 'validated' } : null },
      strategyProfiles: { findById: async (id: string) => id === 'p1' ? { id: 'p1', coreIdea: 'fade pumps', direction: 'short' } : null },
    });

    const s = await buildCompletionSummary(deps, 't1');

    expect(s?.kind).toBe('backtest.completed');
    if (s?.kind !== 'backtest.completed') throw new Error('wrong kind');
    expect(s.decision).toBe('FAIL');
    expect(s.metrics.netPnlUsd).toBe(-10);
    expect(s.metrics.winRate).toBe(0.4);
    expect(s.metrics.sharpe).toBe(-0.2);
    expect(s.hypothesis).toEqual({ id: 'h1', thesis: 'short the pump', confidence: 0.6, status: 'validated' });
    expect(s.profile).toEqual({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' });
    expect(s.reasons).toEqual(['low sharpe']);
    expect(s.willRetry).toBe(true); // FAIL && cycleDepth 0 < 2
    expect(s.links).toEqual({ taskId: 't1', profileId: 'p1', hypothesisId: 'h1', backtestRunId: 'b1' });
  });

  it('all-null metrics when the backtest run has no metric block', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({ payload: { backtestRunId: 'b1', decision: 'INCONCLUSIVE' } }) },
      backtests: { getById: async () => ({ id: 'b1', metrics: null }) },
    });
    const s = await buildCompletionSummary(deps, 't1');
    if (s?.kind !== 'backtest.completed') throw new Error('wrong kind');
    expect(s.metrics).toEqual({ netPnlUsd: null, netPnlPct: null, winRate: null, profitFactor: null, maxDrawdownPct: null, sharpe: null, totalTrades: null });
    expect(s.willRetry).toBe(false);
  });
});

describe('buildCompletionSummary — research.run_cycle', () => {
  const runCycleTask = (over: Record<string, unknown> = {}) => ({
    id: 'rc1', taskType: 'research.run_cycle', source: 'operator', correlationId: 'c1',
    status: 'completed', payload: { strategyProfileId: 'p1' },
    createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z', ...over,
  });

  it('pulls counts from the run_cycle.completed event and top-3 validated hypotheses by confidence', async () => {
    const hyps = [
      { id: 'hA', thesis: 'A', confidence: 0.5, status: 'validated' },
      { id: 'hB', thesis: 'B', confidence: 0.9, status: 'validated' },
      { id: 'hC', thesis: 'C', confidence: 0.7, status: 'validated' },
      { id: 'hD', thesis: 'D', confidence: 0.1, status: 'validated' },
    ];
    const deps = fakeDeps({
      researchTasks: { findById: async () => runCycleTask() },
      strategyProfiles: { findById: async () => ({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' }) },
      agentEvents: { list: async (q: { type?: string }) => q.type === 'research.run_cycle.completed'
        ? [{ id: 'e1', taskId: 'rc1', type: 'research.run_cycle.completed', payload: { proposed: 5, validated: 4, rejected: 1, deduped: 0, criticReviews: 4 }, createdAt: '2026-06-19T00:00:00.000Z' }]
        : [] },
      hypotheses: { list: async (q: { profileId?: string; status?: string }) => q.profileId === 'p1' && q.status === 'validated' ? hyps : [], getById: async () => null },
    });

    const s = await buildCompletionSummary(deps, 'rc1');
    if (s?.kind !== 'research.run_cycle') throw new Error('wrong kind');
    expect(s.counts).toEqual({ proposed: 5, validated: 4, rejected: 1, deduped: 0, criticReviews: 4, backtestsEnqueued: 4 });
    expect(s.topHypotheses.map((h) => h.id)).toEqual(['hB', 'hC', 'hA']); // by confidence desc, top 3
    expect(s.profile?.coreIdea).toBe('fade pumps');
    expect(s.links).toEqual({ taskId: 'rc1', profileId: 'p1' });
  });

  it('zero counts + empty top when no completion event and no hypotheses', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => runCycleTask({ payload: {} }) } });
    const s = await buildCompletionSummary(deps, 'rc1');
    if (s?.kind !== 'research.run_cycle') throw new Error('wrong kind');
    expect(s.counts).toEqual({ proposed: 0, validated: 0, rejected: 0, deduped: 0, criticReviews: 0, backtestsEnqueued: 0 });
    expect(s.topHypotheses).toEqual([]);
    expect(s.profile).toBeNull();
  });
});

describe('buildCompletionSummary — degradation observability', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records a privacy-safe warning code + warns + does not throw when a sub-read fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({ payload: { backtestRunId: 'b1', strategyProfileId: 'p1', decision: 'PASS' } }) },
      backtests: { getById: async () => { throw new Error('db down'); } },
      strategyProfiles: { findById: async () => ({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' }) },
    });

    const s = await buildCompletionSummary(deps, 't1');
    if (s?.kind !== 'backtest.completed') throw new Error('wrong kind');
    // degraded gracefully: the failed read becomes null, the rest of the summary is intact
    expect(s.metrics.netPnlUsd).toBeNull();
    expect(s.profile).toEqual({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' });
    // observable: a code in warnings + a structured log line
    expect(s.warnings).toContain('backtest_read_failed');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('code=backtest_read_failed');
  });

  it('clean build leaves warnings empty', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({ payload: { backtestRunId: 'b1', decision: 'PASS' } }) },
      backtests: { getById: async () => ({ id: 'b1', metrics: null }) },
    });
    const s = await buildCompletionSummary(deps, 't1');
    if (s?.kind !== 'backtest.completed') throw new Error('wrong kind');
    expect(s.warnings).toEqual([]);
  });

  it('run_cycle: records events_read_failed + warns when the event read throws; counts fall back to zero', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = fakeDeps({
      researchTasks: { findById: async () => ({
        id: 'rc1', taskType: 'research.run_cycle', source: 'operator', correlationId: 'c1',
        status: 'completed', payload: { strategyProfileId: 'p1' },
        createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z',
      }) },
      strategyProfiles: { findById: async () => ({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' }) },
      agentEvents: { list: async () => { throw new Error('stream down'); } },
      hypotheses: { list: async () => [], getById: async () => null },
    });

    const s = await buildCompletionSummary(deps, 'rc1');
    if (s?.kind !== 'research.run_cycle') throw new Error('wrong kind');
    // events read failed → observable code + zero counts, but the profile (a separate read) survives
    expect(s.warnings).toContain('events_read_failed');
    expect(s.counts).toEqual({ proposed: 0, validated: 0, rejected: 0, deduped: 0, criticReviews: 0, backtestsEnqueued: 0 });
    expect(s.profile).toEqual({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('onboard: records events_read_failed + warns when the event read throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = fakeDeps({
      researchTasks: { findById: async () => ({
        id: 'ob1', taskType: 'strategy.onboard', source: 'operator', correlationId: 'c1',
        status: 'completed', payload: {}, createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z',
      }) },
      agentEvents: { list: async () => { throw new Error('stream down'); } },
    });
    const s = await buildCompletionSummary(deps, 'ob1');
    if (s?.kind !== 'strategy.onboard') throw new Error('wrong kind');
    expect(s.warnings).toContain('events_read_failed');
    expect(s.profile).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('buildCompletionSummary — strategy.onboard', () => {
  const onboardTask = (over: Record<string, unknown> = {}) => ({
    id: 'ob1', taskType: 'strategy.onboard', source: 'operator', correlationId: 'c1',
    status: 'completed', payload: {}, createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z', ...over,
  });

  it('resolves the created profile from a task event payload (profileId or strategyId) and sets nextStep', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => onboardTask() },
      agentEvents: { list: async () => [
        { id: 'e1', taskId: 'ob1', type: 'strategy_analyst.started', payload: {}, createdAt: '2026-06-19T00:00:00.000Z' },
        { id: 'e2', taskId: 'ob1', type: 'strategy_analyst.completed', payload: { profileId: 'p9', direction: 'long' }, createdAt: '2026-06-19T00:00:01.000Z' },
      ] },
      strategyProfiles: { findById: async (id: string) => id === 'p9' ? { id: 'p9', coreIdea: 'breakout', direction: 'long' } : null },
    });
    const s = await buildCompletionSummary(deps, 'ob1');
    if (s?.kind !== 'strategy.onboard') throw new Error('wrong kind');
    expect(s.profile).toEqual({ id: 'p9', coreIdea: 'breakout', direction: 'long' });
    expect(s.nextStep).toEqual({ taskType: 'research.run_cycle' });
    expect(s.links).toEqual({ taskId: 'ob1', profileId: 'p9' });
  });

  it('back-compat: resolves profileId from legacy strategyId field in persisted deduped events', async () => {
    // Pre-fix events stored the id as `strategyId`; completion-summary must still resolve them.
    const deps = fakeDeps({
      researchTasks: { findById: async () => onboardTask() },
      agentEvents: { list: async () => [
        { id: 'e1', taskId: 'ob1', type: 'strategy.onboard.deduped', payload: { strategyId: 'p-old', fingerprint: 'fp1' }, createdAt: '2026-06-19T00:00:00.000Z' },
      ] },
      strategyProfiles: { findById: async (id: string) => id === 'p-old' ? { id: 'p-old', coreIdea: 'legacy', direction: 'long' } : null },
    });
    const s = await buildCompletionSummary(deps, 'ob1');
    if (s?.kind !== 'strategy.onboard') throw new Error('wrong kind');
    expect(s.profile).toEqual({ id: 'p-old', coreIdea: 'legacy', direction: 'long' });
    expect(s.links.profileId).toBe('p-old');
  });

  it('new shape: resolves profileId from profileId field in new deduped events', async () => {
    // Post-fix events emit `profileId`; this asserts the primary (new) path works.
    const deps = fakeDeps({
      researchTasks: { findById: async () => onboardTask() },
      agentEvents: { list: async () => [
        { id: 'e1', taskId: 'ob1', type: 'strategy.onboard.deduped', payload: { profileId: 'p-new', fingerprint: 'fp2' }, createdAt: '2026-06-19T00:00:00.000Z' },
      ] },
      strategyProfiles: { findById: async (id: string) => id === 'p-new' ? { id: 'p-new', coreIdea: 'breakout v2', direction: 'short' } : null },
    });
    const s = await buildCompletionSummary(deps, 'ob1');
    if (s?.kind !== 'strategy.onboard') throw new Error('wrong kind');
    expect(s.profile).toEqual({ id: 'p-new', coreIdea: 'breakout v2', direction: 'short' });
    expect(s.links.profileId).toBe('p-new');
  });

  it('degrades to profile:null when no event carries a profile id', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => onboardTask() } });
    const s = await buildCompletionSummary(deps, 'ob1');
    if (s?.kind !== 'strategy.onboard') throw new Error('wrong kind');
    expect(s.profile).toBeNull();
    expect(s.links.profileId).toBeUndefined();
  });
});

describe('buildCompletionSummary — token budget exhausted', () => {
  it('marks willRetry false and surfaces the reason when the token budget was exhausted', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({
        payload: { decision: 'FAIL', cycleDepth: 0, strategyProfileId: 'p1', reasons: ['profit factor low'] },
      }) },
      agentEvents: { list: async ({ type }: { type?: string }) =>
        type === 'research.token_budget_exhausted'
          ? [{ payload: { cumulativeTokens: 5000, budgetTokens: 1000 } }]
          : [] },
    });
    const summary = await buildCompletionSummary(deps, 't1');
    expect(summary?.kind).toBe('backtest.completed');
    expect((summary as unknown as { willRetry: boolean }).willRetry).toBe(false);
    expect((summary as unknown as { reasons: string[] }).reasons).toContain('token_budget_exhausted');
  });

  it('leaves willRetry and reasons unchanged when no token budget event exists', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({
        payload: { decision: 'FAIL', cycleDepth: 0, reasons: ['profit factor low'] },
      }) },
      agentEvents: { list: async () => [] },
    });
    const summary = await buildCompletionSummary(deps, 't1');
    expect(summary?.kind).toBe('backtest.completed');
    expect((summary as unknown as { willRetry: boolean }).willRetry).toBe(true); // FAIL && depth 0 < 2
    expect((summary as unknown as { reasons: string[] }).reasons).not.toContain('token_budget_exhausted');
  });
});

describe('buildCompletionSummary — null contract', () => {
  it('returns null for an unknown task', async () => {
    expect(await buildCompletionSummary(fakeDeps(), 'missing')).toBeNull();
  });
  it('returns null for a non-completed task', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => ({ id: 't', taskType: 'research.run_cycle', status: 'running', payload: {}, source: 'operator', correlationId: 'c', createdAt: '', updatedAt: '' }) } });
    expect(await buildCompletionSummary(deps, 't')).toBeNull();
  });
  it('returns null for a completed but unsupported task type', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => ({ id: 't', taskType: 'hypothesis.build', status: 'completed', payload: {}, source: 'operator', correlationId: 'c', createdAt: '', updatedAt: '' }) } });
    expect(await buildCompletionSummary(deps, 't')).toBeNull();
  });
  it('does not throw when researchTasks.findById rejects (graceful)', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => { throw new Error('db down'); } } });
    expect(await buildCompletionSummary(deps, 't')).toBeNull();
  });
});
