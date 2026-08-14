import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InMemoryResearchExperimentRepository } from '../../adapters/repository/in-memory-research-experiment.repository.ts';
import { InMemoryStrategyBacktestRunRepository } from '../../adapters/repository/in-memory-strategy-backtest-run.repository.ts';
import { InMemoryStrategyProfileRepository } from '../../adapters/repository/in-memory-strategy-profile.repository.ts';
import { STRATEGY_RUN_KIND } from '../../domain/strategy-backtest-run.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../../domain/research-experiment.ts';
import type { ResearchExperiment, ExperimentRunMember } from '../../domain/research-experiment.ts';
import type { StrategyBacktestRun } from '../../domain/strategy-backtest-run.ts';
import type { StrategyProfile, StrategyParameter } from '../../domain/strategy-profile.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';

import { DbCaseSource, SnapshotCaseSource, reconstructGate1Input } from './case-source.ts';
import type { RawCase } from './types.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const DATASET_SCOPE = {
  datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
  period: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
};

function metrics(over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock {
  return {
    netPnlUsd: 0, netPnlPct: 0, totalTrades: 0, winRate: 0, profitFactor: 0,
    maxDrawdownPct: 0, expectancyUsd: 0, sharpe: 0, topTradeContributionPct: 0,
    ...over,
  };
}

function param(over: Partial<StrategyParameter> & { name: string }): StrategyParameter {
  return { value: 1, unit: null, description: '', tunable: true, ...over };
}

function profile(id: string, parameters: StrategyParameter[]): StrategyProfile {
  return {
    id, version: 1, sourceKind: 'bot_code', sourceFingerprint: `fp-${id}`,
    direction: 'long', coreIdea: 'x', requiredMarketFeatures: [], confidence: 0.8, unknowns: [],
    profile: {
      direction: 'long', coreIdea: 'x', summary: 's', requiredMarketFeatures: [],
      entryConditions: [], exitConditions: [], timeframes: ['1h'], indicators: [],
      parameters, watchLifecycleSummary: null, positionManagementSummary: null,
      riskManagementSummary: null, runnerOwnedAuthorities: [], confidence: 0.8, unknowns: [], evidence: [],
    },
    sourceArtifactRef: {} as never, contractVersion: 'v1', createdAt: NOW, updatedAt: NOW,
  };
}

function run(id: string, over: Partial<StrategyBacktestRun> = {}): StrategyBacktestRun {
  return {
    id, strategyProfileId: 'p1', strategyBundleId: 'sb', bundleHash: 'bh', paramsHash: 'ph',
    runKind: STRATEGY_RUN_KIND, platformRunId: `plat-${id}`, correlationId: 'c', taskId: 't',
    params: {}, status: 'submitted', metrics: null,
    platformRun: null, artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: '1',
    admission: null,
    backend: 'research_platform', submittedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW,
    ...over,
  };
}

function baselineExperiment(id: string, over: Partial<ResearchExperiment> = {}): ResearchExperiment {
  return {
    id, experimentKey: `key-${id}`, experimentType: 'strategy_baseline_validation',
    strategyProfileId: 'p1', datasetScope: DATASET_SCOPE, holdoutPolicy: DEFAULT_HOLDOUT_POLICY,
    status: 'completed', createdAt: NOW, updatedAt: NOW,
    ...over,
  };
}

function member(
  id: string, experimentId: string, role: ExperimentRunMember['role'], over: Partial<ExperimentRunMember> = {},
): ExperimentRunMember {
  return {
    id, experimentId, role,
    periodFrom: DATASET_SCOPE.period.from, periodTo: DATASET_SCOPE.period.to,
    symbols: [...DATASET_SCOPE.symbols], paramsHash: '', bundleHash: 'bh', createdAt: NOW,
    ...over,
  };
}

async function seedCompletedRun(
  strategyBacktests: InMemoryStrategyBacktestRunRepository, id: string, m?: Partial<BacktestMetricBlock>,
): Promise<void> {
  await strategyBacktests.createSubmitted(run(id));
  await strategyBacktests.markCompleted(id, {
    metrics: metrics(m), artifactRefs: [], platformContractVersion: 'v1', finishedAt: NOW,
  });
}

function buildRepos() {
  return {
    experiments: new InMemoryResearchExperimentRepository(),
    strategyBacktests: new InMemoryStrategyBacktestRunRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
  };
}

describe('DbCaseSource', () => {
  it('reconstructs a Gate1 case from a baseline experiment train member', async () => {
    const { experiments, strategyBacktests, strategyProfiles } = buildRepos();

    await strategyProfiles.create(profile('p1', [param({ name: 'dump.minDropPct', description: 'entry filter' })]));
    await seedCompletedRun(strategyBacktests, 'sbr-1', { totalTrades: 5, profitFactor: 1.2, sharpe: 1 });

    await experiments.createExperiment(baselineExperiment('exp-1'));
    await experiments.addMember(member('mem-1', 'exp-1', 'train', { strategyBacktestRunId: 'sbr-1' }));

    const cases = await new DbCaseSource({ experiments, strategyBacktests, strategyProfiles }).load();

    expect(cases).toHaveLength(1);
    expect(cases[0]!.input.baselineMetrics.totalTrades).toBe(5);
    expect(cases[0]!.meta.experimentId).toBe('exp-1');
    expect(cases[0]!.input.entryAffecting).toEqual(['dump.minDropPct']);
    expect(cases[0]!.input.hasEntrySignalEvidence).toBe(true);
    expect(cases[0]!.id).toBe('case-exp-1');
    expect(cases[0]!.meta.sourceRef).toBe('db');
  });

  it('picks the sanity member when no train member exists', async () => {
    const { experiments, strategyBacktests, strategyProfiles } = buildRepos();

    await strategyProfiles.create(profile('p1', []));
    await seedCompletedRun(strategyBacktests, 'sbr-sanity', { totalTrades: 0 });

    await experiments.createExperiment(baselineExperiment('exp-sanity'));
    await experiments.addMember(member('mem-sanity', 'exp-sanity', 'sanity', { strategyBacktestRunId: 'sbr-sanity' }));

    const cases = await new DbCaseSource({ experiments, strategyBacktests, strategyProfiles }).load();

    expect(cases).toHaveLength(1);
    expect(cases[0]!.meta.experimentId).toBe('exp-sanity');
  });

  it('skips a non-completed baseline experiment (quietly)', async () => {
    const { experiments, strategyBacktests, strategyProfiles } = buildRepos();

    await strategyProfiles.create(profile('p1', []));
    await seedCompletedRun(strategyBacktests, 'sbr-1', { totalTrades: 5 });
    await experiments.createExperiment(baselineExperiment('exp-1'));
    await experiments.addMember(member('mem-1', 'exp-1', 'train', { strategyBacktestRunId: 'sbr-1' }));

    await experiments.createExperiment(baselineExperiment('exp-running', { status: 'running' }));
    await experiments.addMember(member('mem-running', 'exp-running', 'train', { strategyBacktestRunId: 'sbr-1' }));

    const cases = await new DbCaseSource({ experiments, strategyBacktests, strategyProfiles }).load();

    expect(cases).toHaveLength(1);
    expect(cases.every((c) => c.meta.experimentId !== 'exp-running')).toBe(true);
  });

  it('skips (does not throw) a completed experiment whose chosen member has no metrics', async () => {
    const { experiments, strategyBacktests, strategyProfiles } = buildRepos();

    await strategyProfiles.create(profile('p1', []));
    // run created but never marked completed -> metrics stays null
    await strategyBacktests.createSubmitted(run('sbr-no-metrics'));

    await experiments.createExperiment(baselineExperiment('exp-no-metrics'));
    await experiments.addMember(member('mem-1', 'exp-no-metrics', 'train', { strategyBacktestRunId: 'sbr-no-metrics' }));

    const cases = await new DbCaseSource({ experiments, strategyBacktests, strategyProfiles }).load();

    expect(cases).toHaveLength(0);
  });

  it('skips (does not throw) when the chosen member has no strategyBacktestRunId', async () => {
    const { experiments, strategyBacktests, strategyProfiles } = buildRepos();

    await strategyProfiles.create(profile('p1', []));
    await experiments.createExperiment(baselineExperiment('exp-no-run'));
    await experiments.addMember(member('mem-1', 'exp-no-run', 'train'));

    const cases = await new DbCaseSource({ experiments, strategyBacktests, strategyProfiles }).load();

    expect(cases).toHaveLength(0);
  });

  it('skips (does not throw) when the strategy profile is missing', async () => {
    const { experiments, strategyBacktests, strategyProfiles } = buildRepos();

    await seedCompletedRun(strategyBacktests, 'sbr-1', { totalTrades: 5 });
    await experiments.createExperiment(baselineExperiment('exp-no-profile', { strategyProfileId: 'missing' }));
    await experiments.addMember(member('mem-1', 'exp-no-profile', 'train', { strategyBacktestRunId: 'sbr-1' }));

    const cases = await new DbCaseSource({ experiments, strategyBacktests, strategyProfiles }).load();

    expect(cases).toHaveLength(0);
  });
});

describe('reconstructGate1Input', () => {
  it('sets hasEntrySignalEvidence=false at 0 trades', () => {
    const input = reconstructGate1Input({
      profile: profile('p1', [param({ name: 'dump.minDropPct', description: 'entry filter' })]),
      baselineMetrics: metrics({ totalTrades: 0 }),
    });
    expect(input.hasEntrySignalEvidence).toBe(false);
    expect(input.entryAffecting).toEqual(['dump.minDropPct']);
  });

  it('sets hasEntrySignalEvidence=true when totalTrades > 0', () => {
    const input = reconstructGate1Input({
      profile: profile('p1', []),
      baselineMetrics: metrics({ totalTrades: 3 }),
    });
    expect(input.hasEntrySignalEvidence).toBe(true);
    expect(input.entryAffecting).toEqual([]);
  });
});

describe('SnapshotCaseSource', () => {
  it('loads and validates an array of RawCase from a JSON file', async () => {
    const cases: RawCase[] = [{
      id: 'case-1',
      input: {
        profile: profile('p1', [param({ name: 'dump.minDropPct', description: 'entry filter' })]),
        baselineMetrics: metrics({ totalTrades: 5 }),
        entryAffecting: ['dump.minDropPct'],
        hasEntrySignalEvidence: true,
      },
      meta: { experimentId: 'exp-1', sourceRef: 'snapshot' },
    }];
    const filePath = join(tmpdir(), `wfo-gate1-snapshot-${Date.now()}.json`);
    writeFileSync(filePath, JSON.stringify(cases));
    try {
      const loaded = await new SnapshotCaseSource(filePath).load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.input.baselineMetrics.totalTrades).toBe(5);
    } finally {
      unlinkSync(filePath);
    }
  });

  it('rejects a payload missing a real Gate1Input shape', async () => {
    const filePath = join(tmpdir(), `wfo-gate1-snapshot-bad-${Date.now()}.json`);
    writeFileSync(filePath, JSON.stringify([{
      id: 'case-1',
      input: { profile: {}, baselineMetrics: { totalTrades: 'not-a-number' }, entryAffecting: 'not-an-array', hasEntrySignalEvidence: 'nope' },
      meta: { experimentId: 'exp-1', sourceRef: 'snapshot' },
    }]));
    try {
      await expect(new SnapshotCaseSource(filePath).load()).rejects.toThrow();
    } finally {
      unlinkSync(filePath);
    }
  });
});
