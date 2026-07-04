import type { ExperimentRunMember, ResearchExperiment } from '../domain/research-experiment.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { StrategyBacktestRun } from '../domain/strategy-backtest-run.ts';
import type { SubmitProvenCandidateArgs } from '../adapters/platform/paper-intake.port.ts';
import { deriveProposedRiskProfile } from './proposed-risk-profile.ts';

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
  /**
   * The assembled bundle's manifest.id — human-readable module identity (e.g.
   * 'long_oi_dump_reversal_v1'); the platform projects it into bot_bundle.metadata. Never pass
   * profile.id — it is a UUID and is not fit for operator-facing display.
   */
  bundleManifestId: string;
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

  if (!input.bundleManifestId || input.bundleManifestId.trim() === '') {
    throw new Error(`experiment ${wfoExperiment.id}: bundleManifestId missing`);
  }

  const scope = wfoExperiment.datasetScope;

  // 088 (profile-mgmt 3): full risk proposal = WFO-tuned stops over neutral defaults (sizing/dca
  // runner-owned). Absent when no tuned stop recognized. Platform clamps into guardrails on promotion.
  const proposedRiskProfile = deriveProposedRiskProfile({ tunedParams: wfoHoldout.params, profileParams: profile.profile.parameters });

  return {
    bundle: { bundleHash: wfoExperiment.bundleHash },
    identity: {
      // Human-readable module identity from the assembled bundle's manifest — NOT profile.id
      // (that is a UUID; see ChampionSubmissionInput.bundleManifestId doc comment).
      strategyName: input.bundleManifestId,
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
    ...(proposedRiskProfile ? { proposedRiskProfile } : {}),
  };
}
