import { describe, expect, it } from 'vitest';
import { buildChampionSubmission } from './champion-evidence.ts';
import type { ChampionSubmissionInput } from './champion-evidence.ts';
import type { ExperimentRunMember, ResearchExperiment } from '../domain/research-experiment.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { StrategyBacktestRun } from '../domain/strategy-backtest-run.ts';

const NOW = '2026-07-03T00:00:00.000Z';

const DATASET_SCOPE = {
  datasetId: 'ds-1',
  symbols: ['ESPORTSUSDT'],
  timeframe: '1h',
  period: { from: '2026-06-12T00:00:00.000Z', to: '2026-06-19T00:00:00.000Z' },
};

const HOLDOUT_POLICY = {
  mode: 'trade_based' as const,
  minTradesTrain: 20,
  minTradesHoldout: 10,
  lowConfidenceThreshold: 0.5,
  minHistoryDays: 30,
};

function wfoExperiment(): ResearchExperiment {
  return {
    id: 'exp-wfo-1',
    experimentKey: 'key-wfo-1',
    experimentType: 'walk_forward_optimization',
    strategyProfileId: 'p1',
    bundleHash: 'sha256:wfo-champ',
    datasetScope: DATASET_SCOPE,
    holdoutPolicy: HOLDOUT_POLICY,
    status: 'completed',
    verdict: 'PAPER_CANDIDATE',
    verdictReason: 'variant beats baseline on holdout',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function baselineExperiment(): ResearchExperiment {
  return {
    id: 'exp-base-1',
    experimentKey: 'key-base-1',
    experimentType: 'strategy_baseline_validation',
    strategyProfileId: 'p1',
    bundleHash: 'sha256:base-champ',
    datasetScope: DATASET_SCOPE,
    holdoutPolicy: HOLDOUT_POLICY,
    status: 'completed',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function wfoMembers(): ExperimentRunMember[] {
  return [
    {
      id: 'm-wfo-train', experimentId: 'exp-wfo-1', role: 'train',
      periodFrom: '2026-06-01T00:00:00.000Z', periodTo: '2026-06-12T00:00:00.000Z',
      symbols: ['ESPORTSUSDT'], paramsHash: 'ph-train', bundleHash: 'sha256:wfo-champ', createdAt: NOW,
    },
    {
      id: 'm-wfo-holdout', experimentId: 'exp-wfo-1', strategyBacktestRunId: 'run-var-lab',
      role: 'holdout', oos: true,
      periodFrom: '2026-06-12T00:00:00.000Z', periodTo: '2026-06-19T00:00:00.000Z',
      symbols: ['ESPORTSUSDT'], paramsHash: 'ph-holdout', params: { dumpPct: 8 },
      bundleHash: 'sha256:wfo-champ', createdAt: NOW,
    },
  ];
}

function baselineMembers(): ExperimentRunMember[] {
  return [
    {
      id: 'm-base-holdout', experimentId: 'exp-base-1', strategyBacktestRunId: 'run-base-lab',
      role: 'holdout',
      periodFrom: '2026-06-12T00:00:00.000Z', periodTo: '2026-06-19T00:00:00.000Z',
      symbols: ['ESPORTSUSDT'], paramsHash: 'ph-base', bundleHash: 'sha256:base-champ', createdAt: NOW,
    },
  ];
}

// NOTE (verify-point, not one of the two flagged in the brief): StrategyProfile has NO `name`
// field (verified via the domain source — id/version/sourceKind/sourceFingerprint/direction/
// coreIdea/requiredMarketFeatures/confidence/unknowns/profile/sourceArtifactRef/contractVersion/
// createdAt/updatedAt only). `profile.id` is the closest existing identity-anchor field, so the
// implementation reads strategyName from `profile.id` instead of the brief's `profile.name`.
function profile(): StrategyProfile {
  return {
    id: 'long_oi',
    version: 1,
    sourceKind: 'bot_code',
    sourceFingerprint: 'fp',
    direction: 'long',
    coreIdea: 'x',
    requiredMarketFeatures: [],
    confidence: 0.8,
    unknowns: [],
    profile: {} as never,
    sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function backtestRun(over: Partial<StrategyBacktestRun>): StrategyBacktestRun {
  return {
    id: 'run-lab',
    strategyProfileId: 'p1',
    strategyBundleId: 'sb-1',
    bundleHash: 'sha256:base-champ',
    paramsHash: 'ph',
    runKind: 'strategy_baseline',
    platformRunId: 'plat-run-base',
    correlationId: 'corr-1',
    params: {},
    status: 'completed',
    metrics: {
      netPnlUsd: 10, netPnlPct: 1, totalTrades: 5, winRate: 0.6, profitFactor: 1.5,
      maxDrawdownPct: 2, expectancyUsd: 2, sharpe: 1.1, topTradeContributionPct: 10,
    },
    platformRun: null,
    artifactRefs: [],
    platformContractVersion: 'v1',
    sdkContractVersion: 'v1',
    backend: 'research_platform',
    submittedAt: NOW,
    finishedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function fixture(): ChampionSubmissionInput {
  return {
    wfoExperiment: wfoExperiment(),
    wfoMembers: wfoMembers(),
    baselineExperiment: baselineExperiment(),
    baselineMembers: baselineMembers(),
    profile: profile(),
    baselineRun: backtestRun({ id: 'run-base-lab', platformRunId: 'plat-run-base' }),
    variantRun: backtestRun({ id: 'run-var-lab', platformRunId: 'plat-run-var' }),
    correlationId: 'corr-champion-1',
  };
}

describe('buildChampionSubmission', () => {
  it('maps a champion into SubmitProvenCandidateArgs with PLATFORM run ids', () => {
    const args = buildChampionSubmission(fixture());
    expect(args.evidence.baselineRunId).toBe('plat-run-base'); // platformRunId, NOT lab id
    expect(args.evidence.variantRunId).toBe('plat-run-var');
    expect(args.bundle.bundleHash).toBe(fixture().wfoExperiment.bundleHash);
    expect(args.identity).toEqual({ strategyName: 'long_oi', side: 'long', params: { dumpPct: 8 } });
    expect(args.evidence.window).toEqual({
      fromMs: Date.parse('2026-06-12T00:00:00.000Z'),
      toMs: Date.parse('2026-06-19T00:00:00.000Z'),
    });
    expect(args.evidence.symbols).toEqual(['ESPORTSUSDT']);
    expect(args.idempotencyKey).toBe(`wfo-champion:${fixture().wfoExperiment.id}`);
    expect(args.workflowId).toBe(fixture().wfoExperiment.id);
  });

  it.each([
    [
      'wfo holdout member missing',
      (f: ChampionSubmissionInput) => ({ ...f, wfoMembers: f.wfoMembers.filter((m) => m.role !== 'holdout') }),
      /wfo holdout member/i,
    ],
    [
      'baseline holdout member missing',
      (f: ChampionSubmissionInput) => ({ ...f, baselineMembers: [] }),
      /baseline holdout member/i,
    ],
    [
      'variant run metrics missing',
      (f: ChampionSubmissionInput) => ({ ...f, variantRun: { ...f.variantRun, metrics: null } }),
      /variant run metrics/i,
    ],
    [
      // Real DIRECTIONS enum member (src/domain/strategy-profile.ts) that is neither 'long' nor
      // 'short' — no cast needed, 'both' is a genuine Direction value.
      'unsupported direction',
      (f: ChampionSubmissionInput) => ({ ...f, profile: { ...f.profile, direction: 'both' as const } }),
      /long\|short/i,
    ],
  ])('fails fast: %s', (_name, mutate, re) => {
    expect(() => buildChampionSubmission(mutate(fixture()))).toThrow(re);
  });
});
