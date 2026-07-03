import type { ExperimentRunMember, ResearchExperiment } from '../domain/research-experiment.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { StrategyBacktestRun } from '../domain/strategy-backtest-run.ts';
import type { SubmitProvenCandidateArgs } from '../adapters/platform/paper-intake.port.ts';

/**
 * Pure mapper: lab research artifacts (WFO + baseline experiments, their run members, run rows,
 * strategy profile) → the platform paper-intake #127 `SubmitProvenCandidateArgs` shape. The only
 * judgment-free translation point in the paper-bridge (G2) slice — no I/O, no services; the
 * caller (Task 3's paperStartHandler) supplies every row already looked up.
 */
export interface ChampionSubmissionInput {
  wfoExperiment: ResearchExperiment; // type walk_forward_optimization, verdict PAPER_CANDIDATE
  wfoMembers: ExperimentRunMember[]; // must contain role 'holdout' with oos true
  baselineExperiment: ResearchExperiment;
  baselineMembers: ExperimentRunMember[]; // must contain role 'holdout'
  profile: StrategyProfile;
  baselineRun: StrategyBacktestRun; // looked up by caller from baseline holdout member's strategyBacktestRunId
  variantRun: StrategyBacktestRun; // looked up from WFO holdout member's strategyBacktestRunId
  correlationId: string;
}

export function buildChampionSubmission(input: ChampionSubmissionInput): SubmitProvenCandidateArgs {
  const { wfoExperiment, baselineExperiment, profile, baselineRun, variantRun } = input;

  const wfoHoldout = input.wfoMembers.find((m) => m.role === 'holdout' && m.oos === true);
  if (!wfoHoldout) throw new Error(`experiment ${wfoExperiment.id}: wfo holdout member (oos) not found`);

  const baseHoldout = input.baselineMembers.find((m) => m.role === 'holdout');
  if (!baseHoldout) throw new Error(`experiment ${baselineExperiment.id}: baseline holdout member not found`);

  if (!variantRun.metrics) throw new Error(`run ${variantRun.id}: variant run metrics missing (not completed?)`);

  if (profile.direction !== 'long' && profile.direction !== 'short') {
    throw new Error(`profile ${profile.id}: direction '${profile.direction}' cannot be papered — platform accepts long|short only`);
  }

  if (!wfoExperiment.bundleHash) throw new Error(`experiment ${wfoExperiment.id}: bundleHash missing`);

  const scope = wfoExperiment.datasetScope;

  return {
    bundle: { bundleHash: wfoExperiment.bundleHash },
    identity: {
      // StrategyProfile has no `name` field — `id` is the closest identity-anchor field the
      // domain actually exposes (see champion-evidence.test.ts fixture comment).
      strategyName: profile.id,
      side: profile.direction,
      ...(wfoHoldout.params ? { params: wfoHoldout.params } : {}),
    },
    evidence: {
      baselineRunId: baselineRun.platformRunId,
      variantRunId: variantRun.platformRunId,
      datasetRef: scope.datasetId,
      window: { fromMs: Date.parse(scope.period.from), toMs: Date.parse(scope.period.to) },
      symbols: scope.symbols,
      timeframe: scope.timeframe,
      metricsSnapshot: {
        ...variantRun.metrics,
        ...(wfoHoldout.resultSummary ? { resultSummary: wfoHoldout.resultSummary } : {}),
      },
      improvementSummary: wfoExperiment.verdictReason ?? 'wfo champion',
    },
    idempotencyKey: `wfo-champion:${wfoExperiment.id}`,
    workflowId: wfoExperiment.id,
    correlationId: input.correlationId,
  };
}
