import { describe, it, expect } from 'vitest';
import { cycleScorecardHandler } from './cycle-scorecard.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';
import { comparisonSummary } from '../../validation/__fixtures__/comparison-summary.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../../validation/evaluator.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from '../../domain/cycle-scorecard.ts';

const T = (n: number) => `2026-07-14T00:00:${String(n).padStart(2, '0')}.000Z`;

function buildTask(id: string, hypId: string, correlationId: string): ResearchTask {
  return {
    id, taskType: 'hypothesis.build', source: 'operator', correlationId, status: 'completed',
    payload: { hypothesisId: hypId }, createdAt: T(0), updatedAt: T(0),
  };
}

function hypothesis(id: string, over: Partial<HypothesisProposal> = {}): HypothesisProposal {
  return {
    id, strategyProfileId: 'p1', thesis: 'thesis', targetBehavior: 'tb',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: {} }] },
    requiredFeatures: [], validationPlan: 'p', expectedEffect: { metric: 'pnl', direction: 'increase' },
    invalidationCriteria: [], confidence: 0.6, status: 'merged', fingerprint: `fp-${id}`,
    proposal: {} as never, issues: [], contractVersion: 'v1', createdAt: T(0), updatedAt: T(0),
    ...over,
  };
}

function backtestRun(id: string, hypId: string, correlationId: string, over: Partial<BacktestRun> = {}): BacktestRun {
  return {
    id, hypothesisBuildId: `build-${hypId}`, hypothesisId: hypId, strategyProfileId: 'p1',
    platformRunId: `plat-${id}`, correlationId, params: {}, paramsHash: `hash-${id}`, bundleHash: `bundle-${id}`,
    status: 'completed', baselineModuleId: 'base', variantModuleId: 'variant', backend: 'research_platform',
    resumeToken: null, platformRun: null, metrics: null, baselineMetrics: null,
    deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null, artifactRefs: [],
    platformContractVersion: 'test.1', sdkContractVersion: 'test.1',
    submittedAt: T(0), finishedAt: T(0), createdAt: T(0), updatedAt: T(0),
    ...over,
  };
}

function evaluation(id: string, backtestRunId: string, hypId: string, decision: Evaluation['decision'], createdAt: string, over: Partial<Evaluation> = {}): Evaluation {
  return {
    id, backtestRunId, hypothesisId: hypId, decision, reasons: [], metricsSnapshot: comparisonSummary('pass'),
    thresholds: DEFAULT_EVALUATOR_THRESHOLDS, createdAt,
    ...over,
  };
}

function revision(over: Partial<StrategyRevision> = {}): StrategyRevision {
  return {
    id: 'r1', strategyProfileId: 'p1', version: 2, hypothesisIds: [], dropped: [],
    mergedRuleSet: { order: [], rules: [] }, status: 'rejected', createdAt: T(0), updatedAt: T(0), ...over,
  };
}

function scorecardTask(payload: Record<string, unknown>, overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 'sc-task-1', taskType: 'cycle.scorecard', source: 'cron',
    correlationId: payload.correlationId as string, status: 'running',
    payload, createdAt: T(9), updatedAt: T(9), ...overrides,
  };
}

describe('cycleScorecardHandler', () => {
  it('gathers an authoritative snapshot, builds and upserts — counts/champion/roster', async () => {
    const services = makeServices();
    await services.researchTasks.create(buildTask('bt-h1', 'h1', 'c1'));
    await services.researchTasks.create(buildTask('bt-h2', 'h2', 'c1'));
    await services.hypotheses.create(hypothesis('h1', { status: 'merged' }));
    await services.hypotheses.create(hypothesis('h2', { status: 'proxy_passed' }));

    const run1 = backtestRun('run-h1', 'h1', 'c1');
    const run2 = backtestRun('run-h2', 'h2', 'c1');
    await services.backtests.createSubmitted(run1);
    await services.backtests.createSubmitted(run2);
    await services.evaluations.create(evaluation('e-h1', 'run-h1', 'h1', 'PASS', T(1)));
    await services.evaluations.create(evaluation('e-h2', 'run-h2', 'h2', 'PASS', T(1)));

    // A DIFFERENT correlation's run for h1, with a later evaluation that must be ignored by scoping.
    const foreignRun = backtestRun('run-h1-foreign', 'h1', 'c-foreign');
    await services.backtests.createSubmitted(foreignRun);
    await services.evaluations.create(evaluation('e-h1-foreign', 'run-h1-foreign', 'h1', 'FAIL', T(99)));

    await services.revisions.create(revision({
      id: 'r1', strategyProfileId: 'p1', version: 2, status: 'accepted', hypothesisIds: ['h1', 'h2'],
    }));

    const task = scorecardTask({
      correlationId: 'c1', strategyProfileId: 'p1', sourceTaskId: 'src-1',
      terminalOutcome: { kind: 'accepted', reason: 'pnl_improved' },
      revisionId: 'r1', eligibleHypIds: ['h1', 'h2'], consideredHypIds: ['h1', 'h2'],
    });

    await cycleScorecardHandler(task, services);

    const row = await services.cycleScorecards.findByCorrelationAndSchema('c1', CYCLE_SCORECARD_SCHEMA_VERSION);
    expect(row).not.toBeNull();
    const sc = row!.payload;
    expect(sc.counts.built).toBe(2);
    expect(sc.champion).toEqual({ revisionId: 'r1', version: 2 });

    const h1Roster = sc.roster.find((r) => r.hypId === 'h1');
    expect(h1Roster?.lastDecision).toBe('PASS'); // NOT 'FAIL' from the foreign-correlation run
    const h2Roster = sc.roster.find((r) => r.hypId === 'h2');
    expect(h2Roster?.lastDecision).toBe('PASS');
  });

  it('picks the LAST completed evaluation deterministically (max by createdAt, then id)', async () => {
    const services = makeServices();
    await services.researchTasks.create(buildTask('bt-h1', 'h1', 'c1'));
    await services.hypotheses.create(hypothesis('h1'));
    const run1 = backtestRun('run-h1', 'h1', 'c1');
    await services.backtests.createSubmitted(run1);
    // Same createdAt, different id — deterministic id tiebreak.
    await services.evaluations.create(evaluation('e-a', 'run-h1', 'h1', 'PASS', T(2)));
    await services.evaluations.create(evaluation('e-b', 'run-h1', 'h1', 'FAIL', T(2)));
    // A strictly earlier evaluation that must lose regardless of id ordering.
    await services.evaluations.create(evaluation('e-z', 'run-h1', 'h1', 'PASS', T(1)));

    const task = scorecardTask({
      correlationId: 'c1', strategyProfileId: 'p1', sourceTaskId: 'src-1',
      terminalOutcome: { kind: 'skipped', reason: 'no_baseline' },
    });
    await cycleScorecardHandler(task, services);

    const row = await services.cycleScorecards.findByCorrelationAndSchema('c1', CYCLE_SCORECARD_SCHEMA_VERSION);
    const h1Roster = row!.payload.roster.find((r) => r.hypId === 'h1');
    expect(h1Roster?.lastDecision).toBe('FAIL'); // e-b: same createdAt as e-a, 'e-b' > 'e-a' lexicographically
  });

  it('dispatching the SAME task twice upserts to exactly ONE row (idempotency)', async () => {
    const services = makeServices();
    await services.researchTasks.create(buildTask('bt-h1', 'h1', 'c1'));
    await services.hypotheses.create(hypothesis('h1'));

    const task = scorecardTask({
      correlationId: 'c1', strategyProfileId: 'p1', sourceTaskId: 'src-1',
      terminalOutcome: { kind: 'skipped', reason: 'no_baseline' },
    });

    await cycleScorecardHandler(task, services);
    await cycleScorecardHandler(task, services);

    const rows = await services.cycleScorecards.findByCorrelation('c1');
    expect(rows).toHaveLength(1);
  });

  it('a gather failure (throwing hypotheses.findById) propagates — the handler THROWS', async () => {
    const services = makeServices();
    await services.researchTasks.create(buildTask('bt-h1', 'h1', 'c1'));
    services.hypotheses.findById = async () => { throw new Error('boom'); };

    const task = scorecardTask({
      correlationId: 'c1', strategyProfileId: 'p1', sourceTaskId: 'src-1',
      terminalOutcome: { kind: 'skipped', reason: 'no_baseline' },
    });

    await expect(cycleScorecardHandler(task, services)).rejects.toThrow('boom');
    expect(await services.cycleScorecards.findByCorrelation('c1')).toHaveLength(0);
  });

  it('a present-but-NOT-FOUND revisionId THROWS (stale pointer, no partial snapshot)', async () => {
    const services = makeServices();
    const task = scorecardTask({
      correlationId: 'c1', strategyProfileId: 'p1', sourceTaskId: 'src-1',
      terminalOutcome: { kind: 'accepted', reason: 'pnl_improved' },
      revisionId: 'ghost',
    });

    await expect(cycleScorecardHandler(task, services)).rejects.toThrow(/ghost/);
    expect(await services.cycleScorecards.findByCorrelation('c1')).toHaveLength(0);
  });

  it('a revisionId whose strategyProfileId MISMATCHES the payload THROWS', async () => {
    const services = makeServices();
    await services.revisions.create(revision({ id: 'r-wrong-profile', strategyProfileId: 'p-other' }));

    const task = scorecardTask({
      correlationId: 'c1', strategyProfileId: 'p1', sourceTaskId: 'src-1',
      terminalOutcome: { kind: 'accepted', reason: 'pnl_improved' },
      revisionId: 'r-wrong-profile',
    });

    await expect(cycleScorecardHandler(task, services)).rejects.toThrow();
    expect(await services.cycleScorecards.findByCorrelation('c1')).toHaveLength(0);
  });
});
