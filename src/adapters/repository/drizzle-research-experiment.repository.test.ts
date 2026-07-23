// src/adapters/repository/drizzle-research-experiment.repository.test.ts
//
// research-validation-hardening R1 (lab side): DrizzleResearchExperimentRepository.addEvaluation
// must persist (and the trial_context column must round-trip) the advisory E2 trial-ledger data —
// and a row written WITHOUT trialContext must persist exactly as before (nullable column, no backfill).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { DrizzleResearchExperimentRepository } from './drizzle-research-experiment.repository.ts';
import type { ResearchExperiment, ExperimentEvaluation } from '../../domain/research-experiment.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../../domain/research-experiment.ts';
import { createDbClient } from '../../db/client.ts';
import { experimentEvaluation } from '../../db/schema.ts';

const NOW = '2026-01-01T00:00:00.000Z';

function experimentFixture(id: string): ResearchExperiment {
  return {
    id, experimentKey: `key-${id}`, experimentType: 'strategy_baseline_validation',
    strategyProfileId: 'p1', bundleHash: 'sha256:bundle',
    datasetScope: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2026-01-01', to: '2026-02-01' } },
    holdoutPolicy: DEFAULT_HOLDOUT_POLICY, status: 'running', createdAt: NOW, updatedAt: NOW,
  };
}

const url = process.env.DATABASE_URL;
(url ? describe : describe.skip)('DrizzleResearchExperimentRepository.addEvaluation — trial_context (integration)', () => {
  let repo: DrizzleResearchExperimentRepository;
  let pool: Pool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    const client = createDbClient(url as string);
    pool = client.pool;
    db = client.db;
    repo = new DrizzleResearchExperimentRepository(client.db);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('persists evaluation.trialContext into the trial_context jsonb column', async () => {
    const experimentId = `exp-int-${randomUUID()}`;
    await repo.createExperiment(experimentFixture(experimentId));

    const trialContext = {
      familyKey: 'fam-1', familyHint: 'ema-cross', trialCount: 8,
      deflatedSharpe: 0.55, sr0: 0.1, vSR: 0.03, vSRBasis: 'asymptotic' as const, tCount: 8,
    };
    const evaluation: ExperimentEvaluation = {
      id: `expeval-int-${randomUUID()}`, experimentId, evaluatorVersion: 'v-test',
      rawScores: { x: 1 }, flags: { lowConfidenceHoldout: false, overfit: false, fragility: [], coverageWarnings: [] },
      verdict: 'PAPER_CANDIDATE', createdAt: NOW, trialContext,
    };

    await repo.addEvaluation(evaluation);

    const rows = await db.select().from(experimentEvaluation).where(eq(experimentEvaluation.id, evaluation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.trialContext).toEqual(trialContext);
  });

  it('backward compat: an evaluation without trialContext persists trial_context as null', async () => {
    const experimentId = `exp-int-${randomUUID()}`;
    await repo.createExperiment(experimentFixture(experimentId));

    const evaluation: ExperimentEvaluation = {
      id: `expeval-int-${randomUUID()}`, experimentId, evaluatorVersion: 'v-test',
      rawScores: { x: 1 }, flags: { lowConfidenceHoldout: false, overfit: false, fragility: [], coverageWarnings: [] },
      verdict: 'FAIL', createdAt: NOW,
    };

    await repo.addEvaluation(evaluation);

    const rows = await db.select().from(experimentEvaluation).where(eq(experimentEvaluation.id, evaluation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.trialContext).toBeNull();
  });
});
