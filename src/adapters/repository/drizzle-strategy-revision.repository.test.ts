import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { strategyRevisionToDomain, DrizzleStrategyRevisionRepository, type StrategyRevisionRow } from './drizzle-strategy-revision.repository.ts';
import type { PreservationMetadata } from '../../validation/trade-preservation.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import { DEFAULT_REVISION_EVALUATOR_POLICY } from '../../validation/revision-evaluator.ts';
import type { SelectionEvaluation, StrategyRevision } from '../../domain/strategy-revision.ts';
import { createDbClient } from '../../db/client.ts';

const metrics = (over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock => ({
  netPnlUsd: 100, netPnlPct: 1, totalTrades: 25, winRate: 0.5, profitFactor: 1.5,
  maxDrawdownPct: 5, expectancyUsd: 4, sharpe: 1.2, topTradeContributionPct: 20,
  ...over,
});

const baseRow = (): StrategyRevisionRow => ({
  id: 'rev-1', strategyProfileId: 'profile-1', version: 1,
  baseRevisionId: null,
  hypothesisIds: ['h1'],
  dropped: null,
  mergedRuleSet: { order: ['h1'], rules: [] },
  bundleArtifactRef: null,
  bundleHash: null,
  comboBacktestRunId: null,
  status: 'candidate',
  metrics: null,
  verdictReason: null,
  preservationGate: null,
  holdoutValidation: null,
  selectionEvaluation: null,
  kind: 'composed',
  consolidatedFromRevisionId: null,
  semanticParentRevisionId: null,
  compositionDepth: 1,
  baselineValidationStatus: null,
  baselineExperimentId: null,
  baselineTaskId: null,
  createdAt: new Date('2026-07-11T00:00:00Z'),
  updatedAt: new Date('2026-07-11T00:00:00Z'),
});

describe('strategyRevisionToDomain (preservationGate mapping)', () => {
  it('maps a NULL preservation_gate column to undefined', () => {
    const domain = strategyRevisionToDomain(baseRow());
    expect(domain.preservationGate).toBeUndefined();
  });

  it('maps a populated preservation_gate column through verbatim', () => {
    const gate: PreservationMetadata = {
      fired: false,
      reason: null,
      metrics: {
        totalDelta: 0, matchedCount: 3, disappearedCount: 0, newCount: 0, baselineWinnerCount: 2,
      },
      thresholds: {
        winnerRetention: 0.9, maxTradeDropPct: 20, abstentionShare: 0.7, eodShare: 0.5,
        matchToleranceMs: 0, minWinnerSample: 3,
      },
    };
    const domain = strategyRevisionToDomain({ ...baseRow(), preservationGate: gate });
    expect(domain.preservationGate?.fired).toBe(false);
    expect(domain.preservationGate).toEqual(gate);
  });
});

describe('strategyRevisionToDomain (holdoutValidation mapping)', () => {
  it('maps a NULL holdout_validation column to undefined', () => {
    const domain = strategyRevisionToDomain(baseRow());
    expect(domain.holdoutValidation).toBeUndefined();
  });

  it('maps a populated holdout_validation column through verbatim', () => {
    const hv: NonNullable<StrategyRevisionRow['holdoutValidation']> = {
      mode: 'trade_based',
      t: '2026-06-25T00:00:00Z',
      reason: 'holdout_passed',
      lowConfidence: false,
      trainMetrics: { netPnlUsd: 10 },
      holdoutMetrics: { netPnlUsd: 8 },
    };
    const domain = strategyRevisionToDomain({ ...baseRow(), holdoutValidation: hv });
    expect(domain.holdoutValidation?.reason).toBe('holdout_passed');
    expect(domain.holdoutValidation).toEqual(hv);
  });
});

describe('strategyRevisionToDomain (selectionEvaluation mapping)', () => {
  it('maps a NULL selection_evaluation column to undefined', () => {
    const domain = strategyRevisionToDomain(baseRow());
    expect(domain.selectionEvaluation).toBeUndefined();
  });

  it('round-trips a present selectionEvaluation', () => {
    const se: SelectionEvaluation = {
      evaluatorVersion: 'revision-combo-v1',
      baselineMetrics: metrics(),
      candidateMetrics: metrics({ netPnlUsd: 50 }),
      thresholds: DEFAULT_REVISION_EVALUATOR_POLICY,
      decision: 'REJECT',
      reasons: ['drawdown_regression'],
    };
    const domain = strategyRevisionToDomain({ ...baseRow(), selectionEvaluation: se });
    expect(domain.selectionEvaluation).toEqual(se);
  });
});

const url = process.env.DATABASE_URL;
(url ? describe : describe.skip)('DrizzleStrategyRevisionRepository — selectionEvaluation persistence (integration)', () => {
  let repo: DrizzleStrategyRevisionRepository;
  let pool: Pool;

  const revisionFixture = (over: Partial<StrategyRevision> = {}): StrategyRevision => ({
    id: 'rev-int-1', strategyProfileId: 'profile-int-1', version: 1,
    hypothesisIds: ['h1'],
    mergedRuleSet: { order: ['h1'], rules: [] },
    status: 'candidate',
    createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
    ...over,
  });

  beforeAll(() => {
    const client = createDbClient(url as string);
    pool = client.pool;
    repo = new DrizzleStrategyRevisionRepository(client.db);
  });

  afterAll(async () => {
    await pool.end(); // close the Postgres pool so the test process exits cleanly
  });

  it('persists selectionEvaluation through create → updateStatus → findById', async () => {
    const id = 'rev-int-' + Date.now();
    const se: SelectionEvaluation = {
      evaluatorVersion: 'revision-combo-v1',
      baselineMetrics: metrics(),
      candidateMetrics: metrics({ netPnlUsd: 50 }),
      thresholds: DEFAULT_REVISION_EVALUATOR_POLICY,
      decision: 'REJECT',
      reasons: ['drawdown_regression'],
    };
    await repo.create(revisionFixture({ id, strategyProfileId: 'profile-int-' + Date.now() })); // no selectionEvaluation yet
    await repo.updateStatus(id, { status: 'rejected', selectionEvaluation: se, updatedAt: '2026-07-11T01:00:00.000Z' });
    const back = await repo.findById(id);
    expect(back!.selectionEvaluation).toEqual(se); // survived a real DB insert+update+read
  });
});
