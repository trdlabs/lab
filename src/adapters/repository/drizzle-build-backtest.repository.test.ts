// src/adapters/repository/drizzle-build-backtest.repository.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createDbClient } from '../../db/client.ts';
import { DrizzleHypothesisBuildRepository } from './drizzle-hypothesis-build.repository.ts';
import { DrizzleBacktestRunRepository } from './drizzle-backtest-run.repository.ts';
import { DrizzleEvaluationRepository } from './drizzle-evaluation.repository.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../../validation/evaluator.ts';
import { SDK_CONTRACT_VERSION, MODULE_BUNDLE_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { BacktestRun, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import type { BacktestMetricBlock, ComparisonSummary } from '../../ports/platform-gateway.port.ts';

const url = process.env.DATABASE_URL;
const uid = () => `sp4-${Math.random().toString(36).slice(2)}`;
const manifest: ModuleManifest = { moduleId: 'm', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION };
const ref: ArtifactRef = { artifact_id: 'a1', uri: 'file://a', content_hash: 'sha256:x', kind: 'module_bundle', size_bytes: 1, mime_type: 'application/json', created_at: '2026-01-01T00:00:00Z', producer: 'builder', metadata: {} };
const block = (o: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock => ({ netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.6, profitFactor: 2, maxDrawdownPct: 8, expectancyUsd: 8, sharpe: 1.4, topTradeContributionPct: 22, ...o });

(url ? describe : describe.skip)('Drizzle SP-4 repositories (integration)', () => {
  let pool: Pool;
  let builds: DrizzleHypothesisBuildRepository;
  let runs: DrizzleBacktestRunRepository;
  let evals: DrizzleEvaluationRepository;

  beforeAll(() => {
    const client = createDbClient(url!);
    pool = client.pool;
    builds = new DrizzleHypothesisBuildRepository(client.db);
    runs = new DrizzleBacktestRunRepository(client.db);
    evals = new DrizzleEvaluationRepository(client.db);
  });
  afterAll(async () => { await pool.end(); });

  it('hypothesis_build lifecycle round-trips', async () => {
    const id = uid(); const hid = uid(); const now = new Date().toISOString();
    const b: HypothesisBuild = { id, hypothesisId: hid, strategyProfileId: 'p1', status: 'generating', builderAdapter: 'fake', builderModel: 'fake', bundleHash: null, bundleArtifactRef: null, manifest: null, sdkContractVersion: SDK_CONTRACT_VERSION, bundleContractVersion: MODULE_BUNDLE_CONTRACT_VERSION, issues: [], attempt: 1, createdAt: now, updatedAt: now };
    await builds.createGenerating(b);
    await builds.markCandidate(id, { bundleHash: 'sha256:zz', bundleArtifactRef: ref, manifest });
    const row = await builds.findById(id);
    expect(row?.status).toBe('candidate');
    expect(row?.manifest?.moduleId).toBe('m');
  });

  it('backtest_run completes + enforces idempotency', async () => {
    const hid = uid(); const now = new Date().toISOString();
    const base: BacktestRun = { id: uid(), hypothesisBuildId: 'b1', hypothesisId: hid, strategyProfileId: 'p1', platformRunId: 'mock-run-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh', status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1', metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null, artifactRefs: [], platformContractVersion: 'mock-0', sdkContractVersion: SDK_CONTRACT_VERSION, submittedAt: now, finishedAt: null, createdAt: now, updatedAt: now };
    await runs.createSubmitted(base);
    const completion: BacktestCompletion = { metrics: block(), baselineMetrics: block({ netPnlUsd: 100, winRate: 0.5, maxDrawdownPct: 7 }), deltaNetPnlUsd: 150, deltaMaxDrawdownPct: 1, isFragile: false, artifactRefs: [], platformContractVersion: 'mock-0', finishedAt: new Date().toISOString() };
    await runs.markCompleted(base.id, completion);
    const row = await runs.findById(base.id);
    expect(row?.status).toBe('completed');
    expect(row?.metrics?.netPnlUsd).toBe(250);
    expect(row?.deltaNetPnlUsd).toBe(150);
    expect((await runs.findByIdentity(hid, 'sha256:p', 'sha256:bh'))?.id).toBe(base.id);
    await expect(runs.createSubmitted({ ...base, id: uid() })).rejects.toThrow();
  });

  it('evaluation round-trips', async () => {
    const summary: ComparisonSummary = { baseline: block({ netPnlUsd: 100 }), variant: block(), sampleSize: { baselineTrades: 28, variantTrades: 30 }, platformContractVersion: 'mock-0' };
    const e: Evaluation = { id: uid(), backtestRunId: uid(), hypothesisId: uid(), decision: 'PAPER_CANDIDATE', reasons: ['strong_robust_edge'], metricsSnapshot: summary, thresholds: DEFAULT_EVALUATOR_THRESHOLDS, createdAt: new Date().toISOString() };
    await evals.create(e);
    const list = await evals.listByBacktestRun(e.backtestRunId);
    expect(list[0]?.decision).toBe('PAPER_CANDIDATE');
  });
});
