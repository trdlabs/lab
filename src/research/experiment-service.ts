import type { Ref, PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type {
  ResearchExperiment, ExperimentRunMember, ExperimentEvaluation, ExperimentVerdict,
  MemberRole, DatasetScope, HoldoutPolicy, ParameterGrid, ExperimentFlags,
} from '../domain/research-experiment.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../domain/research-experiment.ts';
import { requiredTierForDays } from './snapshot-tier-catalog.ts';
import type { ResearchExperimentRepository } from '../ports/research-experiment.repository.ts';
import type { RunTradesPort } from '../ports/run-trades.port.ts';
import type { ExperimentRunExecutor, ExperimentRunResult } from './experiment-run-executor.ts';
import type { StrategyExperimentRunExecutor, StrategyExperimentRunResult } from './strategy-experiment-run-executor.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import { resolveHoldoutBoundary } from './holdout-boundary-resolver.ts';
import { evaluateExperiment, EXPERIMENT_EVALUATOR_VERSION } from '../validation/experiment-evaluator.ts';
import { evaluateStrategyBaseline, computeOosDegradation, STRATEGY_BASELINE_EVALUATOR_VERSION } from '../validation/strategy-baseline-evaluator.ts';
import {
  runBreakBattery, buildBreakBatteryRetryFeedback,
  type BreakBatteryMode, type BreakBatteryReport, type PlateauSignal,
} from './break-battery.ts';
import { computeExperimentKey } from './experiment-identity.ts';
import { computeStrategyExperimentKey, computeStrategyParamsHash } from './strategy-run-identity.ts';
import { computeWfoExperimentKey } from './wfo-experiment-identity.ts';
import { encodeTrainPeriod, encodeHoldoutPeriod } from './period-encoding.ts';
import { classifyEntryAffectingParams, validateSweepGrid } from '../domain/wfo.ts';
import type { Gate1DecisionPort, SweepDesignerPort, ResultInterpreterPort } from '../ports/wfo-agents.port.ts';
import type { ParamGridRunner } from './param-grid-runner.ts';
import type { StrategyBacktestRunRepository } from '../ports/strategy-backtest-run.repository.ts';
import type { StrategyRevisionRepository } from '../ports/strategy-revision.repository.ts';
import type { StrategyRevision } from '../domain/strategy-revision.ts';
import type { GridPoint } from './param-grid.ts';
import { GridTooLargeError } from './param-grid.ts';
import type { GridResult, RankedPoint } from './top-n-prefilter.ts';
import { stableStringify } from '../orchestrator/handlers/backtest-support.ts';
import type { ArtifactRef } from '../domain/types.ts';
import type { AgentCallOpts } from '../ports/agent-call-opts.ts';
import type { TokenUsageRepository } from '../ports/token-usage.repository.ts';
import { withinTokenBudget } from '../orchestrator/token-budget.ts';
import { scrubMetricsBag } from './outcome-embargo.ts';

export interface WfoBudget {
  maxRounds: number;
  maxPointsPerRound: number;
  minTradesTrain: number;
  topN: number;
}

export const DEFAULT_WFO_BUDGET: WfoBudget = { maxRounds: 2, maxPointsPerRound: 8, minTradesTrain: 3, topN: 3 };

const DAY_MS = 86_400_000; // mirrors holdout-boundary-resolver.ts's own span math — must never disagree

export interface ExperimentServiceDeps {
  experiments: ResearchExperimentRepository;
  runTrades: RunTradesPort;
  runExecutor: ExperimentRunExecutor;
  strategyRunExecutor: StrategyExperimentRunExecutor;
  newId: (prefix: string) => string;
  now: () => string; // ISO
  events: AgentEventRepository;
  gate1: Gate1DecisionPort;
  sweepDesigner: SweepDesignerPort;
  resultInterpreter: ResultInterpreterPort;
  paramGridRunner: ParamGridRunner;
  strategyBacktests: StrategyBacktestRunRepository;
  wfoBudget?: WfoBudget;
  tokenUsage?: Pick<TokenUsageRepository, 'get'>;
  researchTaskTokenBudget?: number;
  /** Optional — absent means the strategy_revision v1 bootstrap tail is a no-op (task-8 wiring). */
  revisions?: StrategyRevisionRepository;
  /** R11 break_battery@1 stage between the WFO verdict and paper.start. Default 'off' — the
   *  battery is never invoked; 'log' runs it, persists + logs, and NEVER changes any verdict. */
  breakBatteryMode?: BreakBatteryMode;
}

/** Merges a newly-designed round grid into the running union (dedupes values per key by stable-stringify identity). */
function mergeGrids(base: ParameterGrid, addition: Record<string, unknown[]>): ParameterGrid {
  const out: ParameterGrid = { ...base };
  for (const [key, values] of Object.entries(addition)) {
    const existingValues = out[key] ?? [];
    const seen = new Set(existingValues.map((v) => stableStringify(v)));
    const merged = [...existingValues];
    for (const v of values) {
      const s = stableStringify(v);
      if (!seen.has(s)) { seen.add(s); merged.push(v); }
    }
    out[key] = merged;
  }
  return out;
}

export interface RunStrategyBaselineValidationInput {
  strategyProfileId: string;
  strategyBundle: AssembledStrategyBundle;
  datasetScope: DatasetScope;
  runConfig: Omit<PlatformRunConfig, 'period'>; // datasetId, symbols, timeframe, seed
  metrics: readonly string[];
  holdoutPolicy?: HoldoutPolicy;
  objective?: string;
  taskId: string;
  bundleArtifactRef?: ArtifactRef;
}

export interface RunNewStrategyValidationInput {
  strategyProfileId: string;
  hypothesisId: string;   // REQUIRED for new-strategy validation (initial as-authored hypothesis)
  buildId: string;        // REQUIRED (the assembled build)
  bundle: ModuleBundle;
  baselineRef: Ref;
  datasetScope: DatasetScope;
  holdoutPolicy?: HoldoutPolicy;
  objective?: string;
  runConfig: Omit<PlatformRunConfig, 'period'>; // datasetId, symbols, timeframe, seed
  params: Record<string, unknown>;              // request.params overlay ({} if none)
  taskId: string;
}

export interface RunWfoInput {
  baselineExperimentId: string;         // an existing completed strategy_baseline experiment
  strategyBundle: AssembledStrategyBundle;
  profile: StrategyProfile;
  strategyProfileId: string;
  datasetScope: DatasetScope;
  runConfig: Omit<PlatformRunConfig, 'period'>;
  metrics: readonly string[];
  entrySignalEvidence?: boolean;        // GATE1 evidence flag for a 0-trade baseline; defaults false
  taskId: string;
  correlationId: string;
  agentOpts?: AgentCallOpts;
}

export class ExperimentService {
  private readonly d: ExperimentServiceDeps;
  constructor(deps: ExperimentServiceDeps) { this.d = deps; }

  /**
   * Up-front span check (wfo-extended-fixture item 4). `resolveHoldoutBoundary` already rejects
   * any period < `policy.minHistoryDays` — but only AFTER an expensive sanity/GATE1 step has
   * already paid for it, and without saying what depth WOULD have worked. This mirrors that same
   * span math exactly (`(to - from) / DAY_MS`) so the two checks can never disagree, and — when
   * the period is too short — names the minimal `snapshot-tiers.json` tier that clears the floor.
   * Returns undefined when the period already clears `policy.minHistoryDays` (resolveHoldoutBoundary
   * remains the deep, authoritative gate either way — this is purely an earlier short-circuit).
   */
  private tierFailFastMessage(period: { from: string; to: string }, policy: HoldoutPolicy): string | undefined {
    const spanDays = (Date.parse(period.to) - Date.parse(period.from)) / DAY_MS;
    if (spanDays >= policy.minHistoryDays) return undefined;
    const required = requiredTierForDays(policy.minHistoryDays);
    const tierNote = required
      ? `use tier ${required.tierId} (${required.ref})`
      : `no snapshot-tiers.json tier clears ${policy.minHistoryDays}d`;
    return `insufficient_history: period spans ${spanDays.toFixed(1)}d < ${policy.minHistoryDays}d required; ${tierNote}`;
  }

  /** Builds the ExperimentFlags patch a fail-fast path stores on `aggregateMetrics.flags` — the
   * same slot the happy-path evaluators use for `flags.coverageWarnings`, just reached without
   * ever creating an ExperimentEvaluation row. */
  private tierFailFastFlags(message: string): ExperimentFlags {
    return { lowConfidenceHoldout: false, overfit: false, fragility: [], coverageWarnings: [message] };
  }

  async runNewStrategyValidation(input: RunNewStrategyValidationInput): Promise<{ experimentId: string; verdict: ExperimentVerdict }> {
    const policy = input.holdoutPolicy ?? DEFAULT_HOLDOUT_POLICY;
    const experimentKey = computeExperimentKey({
      strategyProfileId: input.strategyProfileId, buildId: input.buildId,
      bundleHash: input.bundle.bundleHash, datasetScope: input.datasetScope, holdoutPolicy: policy,
    });
    const existing = await this.d.experiments.findByKey(experimentKey);
    if (existing && existing.status === 'completed') return { experimentId: existing.id, verdict: existing.verdict ?? 'INCONCLUSIVE' };

    const now = this.d.now();
    const experimentId = existing?.id ?? this.d.newId('exp');
    if (!existing) {
      const exp: ResearchExperiment = {
        id: experimentId, experimentKey, experimentType: 'new_strategy_validation',
        strategyProfileId: input.strategyProfileId, hypothesisId: input.hypothesisId,
        buildId: input.buildId, bundleHash: input.bundle.bundleHash, objective: input.objective,
        datasetScope: input.datasetScope, holdoutPolicy: policy, status: 'running',
        createdAt: now, updatedAt: now,
      };
      await this.d.experiments.createExperiment(exp);
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.started',
        payload: { experimentId, strategyProfileId: input.strategyProfileId },
        createdAt: this.d.now(),
      });
    }

    const fullPeriod = input.datasetScope.period;
    const fail = async (
      verdict: ExperimentVerdict, reason: string, flags?: ExperimentFlags,
    ): Promise<{ experimentId: string; verdict: ExperimentVerdict }> => {
      await this.d.experiments.updateExperiment(experimentId, {
        status: 'completed', verdict, verdictReason: reason,
        completedAt: this.d.now(), updatedAt: this.d.now(),
        ...(flags ? { aggregateMetrics: { flags } } : {}),
      });
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.completed',
        payload: { experimentId, verdict, verdictReason: reason },
        createdAt: this.d.now(),
      });
      return { experimentId, verdict };
    };

    // --- FAIL-FAST (wfo-extended-fixture item 4): before the sanity run pays for it, reject any
    // period too short for holdoutPolicy.minHistoryDays and name the required snapshot-tiers tier.
    // resolveHoldoutBoundary below remains the deep, unmodified safety net. ---
    const tierMessage = this.tierFailFastMessage(fullPeriod, policy);
    if (tierMessage) return fail('INCONCLUSIVE', 'insufficient_history', this.tierFailFastFlags(tierMessage));

    // --- SANITY (gate + trade-distribution source; never the edge verdict) ---
    const sanity = await this.runMember(experimentId, 'sanity', input, { ...input.runConfig, period: fullPeriod });
    if (sanity.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    if (sanity.status === 'rejected') return fail('FAIL', 'sanity_failed');
    if ((sanity.totalTrades ?? 0) <= 0) return fail('FAIL', 'sanity_failed');

    // --- RESOLVE T (from REAL trades of the sanity run; uses platformRunId) ---
    const tradesData = await this.d.runTrades.getRunTrades(sanity.platformRunId);
    const boundary = resolveHoldoutBoundary(tradesData, fullPeriod, policy);
    await this.d.experiments.updateExperiment(experimentId, { holdoutBoundary: boundary, updatedAt: this.d.now() });
    if (boundary.mode === 'none' || !boundary.t) return fail('INCONCLUSIVE', boundary.reason ?? 'insufficient');

    // --- TRAIN [from, T) ---
    const trainPeriod = encodeTrainPeriod(fullPeriod.from, boundary.t, input.runConfig.timeframe);
    const train = await this.runMember(experimentId, 'train', input, { ...input.runConfig, period: trainPeriod });
    if (train.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    if (train.status !== 'completed' || !train.comparison) return fail('INCONCLUSIVE', 'train_not_run');
    const trainComparison = train.comparison;

    // --- HOLDOUT [T, to] (period.from = T = no-leakage) ---
    const holdoutPeriod = encodeHoldoutPeriod(boundary.t, fullPeriod.to);
    const holdout = await this.runMember(experimentId, 'holdout', input, { ...input.runConfig, period: holdoutPeriod });
    if (holdout.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    const holdoutComparison = holdout.status === 'completed' ? holdout.comparison : undefined;

    // --- EVALUATE (composite; sanity excluded) ---
    const result = evaluateExperiment({ train: trainComparison, holdout: holdoutComparison, boundary });
    const evaluation: ExperimentEvaluation = {
      id: this.d.newId('expeval'), experimentId, evaluatorVersion: EXPERIMENT_EVALUATOR_VERSION,
      rawScores: result.rawScores, flags: result.flags, verdict: result.verdict,
      verdictReason: result.verdictReason, createdAt: this.d.now(),
    };
    await this.d.experiments.addEvaluation(evaluation);
    await this.d.experiments.updateExperiment(experimentId, {
      status: 'completed', verdict: result.verdict, verdictReason: result.verdictReason,
      aggregateMetrics: { trainTrades: boundary.trainTrades, holdoutTrades: boundary.holdoutTrades, flags: result.flags },
      completedAt: this.d.now(), updatedAt: this.d.now(),
    });
    await this.d.events.append({
      id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.completed',
      payload: { experimentId, verdict: result.verdict, verdictReason: result.verdictReason },
      createdAt: this.d.now(),
    });
    return { experimentId, verdict: result.verdict };
  }

  private async runMember(experimentId: string, role: MemberRole, input: RunNewStrategyValidationInput, run: PlatformRunConfig): Promise<ExperimentRunResult> {
    const memberId = this.d.newId('mem');
    const member: ExperimentRunMember = {
      id: memberId, experimentId, role, periodFrom: run.period.from, periodTo: run.period.to,
      symbols: [...run.symbols], paramsHash: '', bundleHash: input.bundle.bundleHash, createdAt: this.d.now(),
    };
    await this.d.experiments.addMember(member);
    const outcome = await this.d.runExecutor.execute({
      experimentId, role, bundle: input.bundle, baselineRef: input.baselineRef,
      strategyProfileId: input.strategyProfileId, hypothesisId: input.hypothesisId, buildId: input.buildId,
      run, params: input.params,
    });
    await this.d.experiments.updateMember(memberId, {
      backtestRunId: outcome.runId, tradeCount: outcome.totalTrades,
      resultSummary: { totalTrades: outcome.totalTrades },
    });
    await this.d.events.append({
      id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.member.completed',
      payload: { experimentId, role, status: outcome.status, tradeCount: outcome.totalTrades, backtestRunId: outcome.runId },
      createdAt: this.d.now(),
    });
    return outcome;
  }

  async runStrategyBaselineValidation(input: RunStrategyBaselineValidationInput): Promise<{ experimentId: string; verdict: ExperimentVerdict }> {
    const policy = input.holdoutPolicy ?? DEFAULT_HOLDOUT_POLICY;
    const strategyBundleId = input.strategyBundle.manifest.id;
    const experimentKey = computeStrategyExperimentKey({
      strategyProfileId: input.strategyProfileId, strategyBundleId, bundleHash: input.strategyBundle.bundleHash,
      datasetScope: input.datasetScope, holdoutPolicy: policy,
    });
    const existing = await this.d.experiments.findByKey(experimentKey);
    if (existing && existing.status === 'completed') {
      if (!existing.bundleArtifactRef && input.bundleArtifactRef) {
        await this.d.experiments.updateExperiment(existing.id, {
          bundleArtifactRef: input.bundleArtifactRef,
          updatedAt: this.d.now(),
        });
      }
      return { experimentId: existing.id, verdict: existing.verdict ?? 'INCONCLUSIVE' };
    }

    const now = this.d.now();
    const experimentId = existing?.id ?? this.d.newId('exp');
    if (!existing) {
      const exp: ResearchExperiment = {
        id: experimentId, experimentKey, experimentType: 'strategy_baseline_validation',
        strategyProfileId: input.strategyProfileId,
        bundleHash: input.strategyBundle.bundleHash, objective: input.objective,
        datasetScope: input.datasetScope, holdoutPolicy: policy, status: 'running',
        createdAt: now, updatedAt: now,
        ...(input.bundleArtifactRef !== undefined ? { bundleArtifactRef: input.bundleArtifactRef } : {}),
      };
      await this.d.experiments.createExperiment(exp);
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.started',
        payload: { experimentId, strategyProfileId: input.strategyProfileId, experimentType: 'strategy_baseline_validation' },
        createdAt: this.d.now(),
      });
    }

    const fullPeriod = input.datasetScope.period;
    const fail = async (
      verdict: ExperimentVerdict, reason: string, flags?: ExperimentFlags,
    ): Promise<{ experimentId: string; verdict: ExperimentVerdict }> => {
      await this.d.experiments.updateExperiment(experimentId, {
        status: 'completed', verdict, verdictReason: reason,
        completedAt: this.d.now(), updatedAt: this.d.now(),
        ...(flags ? { aggregateMetrics: { flags } } : {}),
      });
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.completed',
        payload: { experimentId, verdict, verdictReason: reason, experimentType: 'strategy_baseline_validation' },
        createdAt: this.d.now(),
      });
      await this.bootstrapRevisionV1(input, experimentId);
      return { experimentId, verdict };
    };

    // --- FAIL-FAST (wfo-extended-fixture item 4): before the sanity run pays for it, reject any
    // period too short for holdoutPolicy.minHistoryDays and name the required snapshot-tiers tier.
    // resolveHoldoutBoundary below remains the deep, unmodified safety net. ---
    const tierMessage = this.tierFailFastMessage(fullPeriod, policy);
    if (tierMessage) return fail('INCONCLUSIVE', 'insufficient_history', this.tierFailFastFlags(tierMessage));

    // --- SANITY (gate + trade-distribution source; never the edge verdict) ---
    const sanity = await this.runStrategyMember(experimentId, 'sanity', input, { ...input.runConfig, period: fullPeriod });
    if (sanity.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    if (sanity.status === 'rejected') return fail('FAIL', 'sanity_failed');
    if ((sanity.totalTrades ?? 0) <= 0) return fail('FAIL', 'sanity_failed');

    // --- RESOLVE T (from REAL trades of the sanity run; uses platformRunId) ---
    const tradesData = await this.d.runTrades.getRunTrades(sanity.platformRunId);
    const boundary = resolveHoldoutBoundary(tradesData, fullPeriod, policy);
    await this.d.experiments.updateExperiment(experimentId, { holdoutBoundary: boundary, updatedAt: this.d.now() });
    // sanity-only cap (§6): a full-period-only baseline never reaches PAPER_CANDIDATE
    if (boundary.mode === 'none' || !boundary.t) return fail('INCONCLUSIVE', boundary.reason ?? 'insufficient');

    // --- TRAIN [from, T) ∥ HOLDOUT [T, to] (both depend only on the boundary; run concurrently.
    //     Checks stay in train-first order so failure reasons are deterministic.
    //     Trade-off: when train fails, a holdout run was already submitted — one extra
    //     backtester run on a failure path, absorbed by server-side dedup/coalescing.
    //     A THROWN member error (transport) rejects the Promise.all and fails the task
    //     (previously holdout was never submitted after a train failure); the surviving
    //     in-flight member finishes in the background and its replay is idempotent via
    //     experimentKey/resumeToken.) ---
    const trainPeriod = encodeTrainPeriod(fullPeriod.from, boundary.t, input.runConfig.timeframe);
    const holdoutPeriod = encodeHoldoutPeriod(boundary.t, fullPeriod.to);
    const [train, holdout] = await Promise.all([
      this.runStrategyMember(experimentId, 'train', input, { ...input.runConfig, period: trainPeriod }),
      this.runStrategyMember(experimentId, 'holdout', input, { ...input.runConfig, period: holdoutPeriod }),
    ]);
    if (train.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    if (train.status !== 'completed') return fail('INCONCLUSIVE', 'train_not_run');
    if (holdout.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    if (holdout.status !== 'completed' || !holdout.metrics) return fail('INCONCLUSIVE', 'holdout_not_run');

    // --- EVALUATE (holdout is the verdict source; train is passed ONLY as the R2 IS→OOS
    // degradation baseline — sanity/train remain gates, never the verdict) ---
    const result = evaluateStrategyBaseline({ holdout: holdout.metrics, boundary, train: train.metrics });
    const evaluation: ExperimentEvaluation = {
      id: this.d.newId('expeval'), experimentId, evaluatorVersion: STRATEGY_BASELINE_EVALUATOR_VERSION,
      rawScores: result.rawScores, flags: result.flags, verdict: result.verdict,
      verdictReason: result.verdictReason, createdAt: this.d.now(),
      // R1 (research-validation-hardening): advisory E2 DSR + trial ledger from the holdout run
      // (verdict source) — absent when the backtester's trial ledger is disabled.
      ...(holdout.trialContext !== undefined ? { trialContext: holdout.trialContext } : {}),
    };
    await this.d.experiments.addEvaluation(evaluation);
    await this.d.experiments.updateExperiment(experimentId, {
      status: 'completed', verdict: result.verdict, verdictReason: result.verdictReason,
      aggregateMetrics: { trainTrades: boundary.trainTrades, holdoutTrades: boundary.holdoutTrades, flags: result.flags },
      completedAt: this.d.now(), updatedAt: this.d.now(),
    });
    await this.d.events.append({
      id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.completed',
      payload: { experimentId, verdict: result.verdict, verdictReason: result.verdictReason, experimentType: 'strategy_baseline_validation' },
      createdAt: this.d.now(),
    });
    await this.bootstrapRevisionV1(input, experimentId);
    return { experimentId, verdict: result.verdict };
  }

  /**
   * Bootstraps `strategy_revision` v1 from a just-finalized G1 baseline experiment (spec §1):
   * no-op when the `revisions` dep is absent, when the profile already has an accepted revision
   * (idempotent — UNIQUE(profileId, version) is the backstop), or when no member run exists yet
   * to anchor comboBacktestRunId on. Fail-soft: any error emits `revision.bootstrap_failed` and
   * is swallowed — the baseline verdict this runs after must never be affected.
   */
  private async bootstrapRevisionV1(input: RunStrategyBaselineValidationInput, experimentId: string): Promise<void> {
    if (!this.d.revisions) return;
    try {
      const existing = await this.d.revisions.findLatestAccepted(input.strategyProfileId);
      if (existing) return;

      const members = await this.d.experiments.listMembers(experimentId);
      const comboMember = members.find((m) => m.role === 'holdout') ?? members.find((m) => m.role === 'sanity');
      const comboBacktestRunId = comboMember?.strategyBacktestRunId;
      if (!comboBacktestRunId) return;

      const run = await this.d.strategyBacktests.findById(comboBacktestRunId);
      const now = this.d.now();
      const revision: StrategyRevision = {
        id: this.d.newId('rev'), strategyProfileId: input.strategyProfileId, version: 1,
        hypothesisIds: [], mergedRuleSet: { order: [], rules: [] }, status: 'accepted',
        bundleHash: input.strategyBundle.bundleHash, comboBacktestRunId,
        ...(input.bundleArtifactRef !== undefined ? { bundleArtifactRef: input.bundleArtifactRef } : {}),
        ...(run?.metrics ? { metrics: run.metrics as unknown as Record<string, unknown> } : {}),
        createdAt: now, updatedAt: now,
      };
      await this.d.revisions.create(revision);
    } catch (err) {
      try {
        await this.d.events.append({
          id: this.d.newId('evt'), taskId: input.taskId, type: 'revision.bootstrap_failed',
          payload: {
            strategyProfileId: input.strategyProfileId, experimentId,
            error: err instanceof Error ? err.message : String(err),
          },
          createdAt: this.d.now(),
        });
      } catch {
        /* swallow event append failure — baseline verdict must not be affected */
      }
    }
  }

  private async runStrategyMember(
    experimentId: string, role: MemberRole, input: RunStrategyBaselineValidationInput, run: PlatformRunConfig,
  ): Promise<StrategyExperimentRunResult> {
    // Executor runs FIRST: if it throws, no member row is ever written (member XOR invariant —
    // a persisted member must reference exactly one of backtestRunId / strategyBacktestRunId).
    const outcome = await this.d.strategyRunExecutor.execute({
      experimentId, role, strategyBundle: input.strategyBundle, strategyProfileId: input.strategyProfileId,
      run, params: {}, metrics: [...input.metrics],
    });
    const memberId = this.d.newId('mem');
    const member: ExperimentRunMember = {
      id: memberId, experimentId, role, periodFrom: run.period.from, periodTo: run.period.to,
      symbols: [...run.symbols], paramsHash: '', bundleHash: input.strategyBundle.bundleHash,
      strategyBacktestRunId: outcome.runId, tradeCount: outcome.totalTrades,
      resultSummary: { totalTrades: outcome.totalTrades }, createdAt: this.d.now(),
    };
    await this.d.experiments.addMember(member);
    await this.d.events.append({
      id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.member.completed',
      payload: {
        experimentId, role, status: outcome.status, tradeCount: outcome.totalTrades,
        strategyBacktestRunId: outcome.runId, experimentType: 'strategy_baseline_validation',
      },
      createdAt: this.d.now(),
    });
    return outcome;
  }

  /**
   * 1-fold walk-forward optimization decision contour: GATE1 → LLM-designed sweep round(s) →
   * ParamGridRunner (ledgers every point) → result-interpreter select/extend/stop → one OOS
   * holdout run → evaluateStrategyBaseline verdict. Mirrors runStrategyBaselineValidation's
   * dedup/create/finalize structure; leaves the baseline lane (runStrategyMember) untouched.
   */
  async runWalkForwardOptimization(
    input: RunWfoInput,
  ): Promise<{ experimentId: string; verdict: ExperimentVerdict; terminalReason: string }> {
    const budget = this.d.wfoBudget ?? DEFAULT_WFO_BUDGET;
    const bundleHash = input.strategyBundle.bundleHash;

    // --- Baseline metrics + boundary source (§ brief) ---
    const baseline = await this.d.experiments.findById(input.baselineExperimentId);
    if (!baseline) throw new Error(`runWalkForwardOptimization: baseline experiment not found: ${input.baselineExperimentId}`);
    // Fail fast: WFO must optimize the exact bundle the baseline validated — otherwise the
    // agent-facing baseline metrics + no-leakage boundary below would describe a different bundle.
    if (baseline.bundleHash !== bundleHash) {
      throw new Error(`runWalkForwardOptimization: bundle mismatch — baseline bundleHash ${baseline.bundleHash} != input ${bundleHash}; WFO must optimize the SAME bundle the baseline validated`);
    }
    const baselineMembers = await this.d.experiments.listMembers(input.baselineExperimentId);
    const baselineRunMember = baselineMembers.find((m) => m.role === 'sanity') ?? baselineMembers.find((m) => m.role === 'holdout');
    if (!baselineRunMember?.strategyBacktestRunId) {
      throw new Error('runWalkForwardOptimization: baseline experiment has no sanity/holdout member with a strategyBacktestRunId');
    }
    const baselineRun = await this.d.strategyBacktests.findById(baselineRunMember.strategyBacktestRunId);
    if (!baselineRun?.metrics) throw new Error('runWalkForwardOptimization: baseline strategy backtest run has no metrics');

    // --- Resolve the split boundary FIRST (sanity/holdout run is the trades/boundary source —
    // unchanged), so we know whether a valid split exists before choosing which member's metrics
    // the agents are allowed to see. ---
    let boundary = baseline.holdoutBoundary;
    if (!boundary) {
      const trades = await this.d.runTrades.getRunTrades(baselineRun.platformRunId);
      boundary = resolveHoldoutBoundary(trades, input.datasetScope.period, baseline.holdoutPolicy);
    }

    // --- Agent-facing baseline metrics: no-leakage requires the TRAIN-window ([from, T)) metrics,
    // never the sanity/holdout run's FULL-PERIOD metrics (which include the future holdout window).
    // Only meaningful when a valid split exists; with mode:'none' there is no split/no leakage
    // concept, so fall back to the sanity/holdout member's metrics (pre-existing behavior). ---
    let baselineMetrics: NonNullable<typeof baselineRun.metrics>;
    if (boundary.mode !== 'none') {
      const baselineTrainMember = baselineMembers.find((m) => m.role === 'train');
      if (!baselineTrainMember?.strategyBacktestRunId) {
        throw new Error('runWalkForwardOptimization: baseline experiment has a valid split but no train member with a strategyBacktestRunId');
      }
      const baselineTrainRun = await this.d.strategyBacktests.findById(baselineTrainMember.strategyBacktestRunId);
      if (!baselineTrainRun?.metrics) throw new Error('runWalkForwardOptimization: baseline train strategy backtest run has no metrics');
      baselineMetrics = baselineTrainRun.metrics;
    } else {
      baselineMetrics = baselineRun.metrics;
    }

    // --- Dedup / create (mirrors runStrategyBaselineValidation) ---
    const experimentKey = computeWfoExperimentKey({ baselineExperimentId: input.baselineExperimentId, bundleHash });
    const existing = await this.d.experiments.findByKey(experimentKey);
    if (existing && existing.status === 'completed') {
      return { experimentId: existing.id, verdict: existing.verdict ?? 'INCONCLUSIVE', terminalReason: existing.verdictReason ?? 'inconclusive' };
    }

    const now = this.d.now();
    const experimentId = existing?.id ?? this.d.newId('exp');
    if (!existing) {
      const exp: ResearchExperiment = {
        id: experimentId, experimentKey, experimentType: 'walk_forward_optimization',
        strategyProfileId: input.strategyProfileId, bundleHash, parameterGrid: {},
        datasetScope: input.datasetScope, holdoutPolicy: baseline.holdoutPolicy, holdoutBoundary: boundary,
        status: 'running', createdAt: now, updatedAt: now,
      };
      await this.d.experiments.createExperiment(exp);
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.started',
        payload: { experimentId, strategyProfileId: input.strategyProfileId, experimentType: 'walk_forward_optimization' },
        createdAt: this.d.now(),
      });
    }

    const finalize = async (
      verdict: ExperimentVerdict, terminalReason: string, flags?: ExperimentFlags,
    ): Promise<{ experimentId: string; verdict: ExperimentVerdict; terminalReason: string }> => {
      await this.d.experiments.updateExperiment(experimentId, {
        status: 'completed', verdict, verdictReason: terminalReason, completedAt: this.d.now(), updatedAt: this.d.now(),
        ...(flags ? { aggregateMetrics: { flags } } : {}),
      });
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.completed',
        payload: { experimentId, verdict, verdictReason: terminalReason, experimentType: 'walk_forward_optimization' },
        createdAt: this.d.now(),
      });
      return { experimentId, verdict, terminalReason };
    };

    // --- FAIL-FAST (wfo-extended-fixture item 4): before GATE1 / sweep / paramGridRunner pay for
    // it, reject any period too short for the baseline's holdoutPolicy.minHistoryDays and name the
    // required snapshot-tiers tier. The mode:'none' cap further below (after GATE1) remains as-is —
    // this is purely an earlier short-circuit for the span case specifically. ---
    const tierMessage = this.tierFailFastMessage(input.datasetScope.period, baseline.holdoutPolicy);
    if (tierMessage) return finalize('INCONCLUSIVE', 'insufficient_history', this.tierFailFastFlags(tierMessage));

    // --- Budget gate (BEFORE GATE1 — a spent correlation never even reaches the first LLM call) ---
    if (await this.budgetExhausted(input.correlationId)) {
      return finalize('INCONCLUSIVE', 'budget_exhausted');
    }

    // Outcome Embargo (S1): generation-lane egress scrub. Defense-in-depth — today these
    // blocks come from closed typed projections; the scrub guards against SDK/mapper widening.
    // Spec: docs/superpowers/specs/2026-07-17-outcome-embargo-design.md §6.2.
    const emitScrubbed = async (site: string, removedKeys: string[]): Promise<void> => {
      if (removedKeys.length === 0) return;
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'outcome_embargo.scrubbed',
        payload: { site, removedKeys },
        createdAt: this.d.now(),
      });
    };

    // --- GATE1 ---
    const { entryAffecting } = classifyEntryAffectingParams(input.profile.profile.parameters);
    const hasEntrySignalEvidence = baselineMetrics.totalTrades > 0 || input.entrySignalEvidence === true;
    const gate1Baseline = scrubMetricsBag(baselineMetrics);
    await emitScrubbed('wfo.gate1.baselineMetrics', gate1Baseline.removedKeys);
    const gate1Decision = await this.d.gate1.decide({
      profile: input.profile, baselineMetrics: gate1Baseline.scrubbed, entryAffecting, hasEntrySignalEvidence,
    }, input.agentOpts);
    if (gate1Decision.decision === 'stop_not_worth' || gate1Decision.decision === 'stop_insufficient_evidence') {
      return finalize('INCONCLUSIVE', gate1Decision.decision);
    }

    // --- mode:'none' cap: no valid split boundary → no OOS possible (live 6-day-slice path) ---
    if (boundary.mode === 'none' || !boundary.t) {
      return finalize('INCONCLUSIVE', 'inconclusive');
    }
    const T = boundary.t;

    // --- Round loop ---
    let unionGrid: ParameterGrid = existing?.parameterGrid ? { ...existing.parameterGrid } : {};
    // trainMetrics: the SAME point's train-window run metrics (from this round's grid sweep) —
    // the R2 IS→OOS degradation baseline for the eventual holdout evaluation below.
    // plateau: the SAME point's R3 lone-peak/plateau evidence, captured at ranking time — the
    // break-battery (R11) plateau input for the champion.
    let selected: { point: GridPoint; foldId: number; trainMetrics: BacktestMetricBlock; plateau: PlateauSignal } | undefined;
    let budgetExhaustedMidLoop = false;

    for (let r = 1; r <= budget.maxRounds; r += 1) {
      // Budget gate at the TOP of every round — before the next sweepDesigner (LLM) call. A run
      // already 'select'-ed out of the loop never reaches here (the loop already broke), so the
      // post-loop holdout backtest below is unaffected — it is not an LLM call.
      if (await this.budgetExhausted(input.correlationId)) {
        budgetExhaustedMidLoop = true;
        break;
      }
      const tunableParams = input.profile.profile.parameters.filter((p) => p.tunable);
      const restrictToEntryParams = gate1Decision.decision === 'allow_exploratory_sweep';
      const sweepBaseline = scrubMetricsBag(baselineMetrics);
      await emitScrubbed('wfo.sweepDesigner.baselineTrainSummary', sweepBaseline.removedKeys);
      const sweep = await this.d.sweepDesigner.design({
        profile: input.profile, baselineTrainSummary: sweepBaseline.scrubbed, tunableParams,
        restrictToEntryParams, maxPoints: budget.maxPointsPerRound,
      }, input.agentOpts);

      const gridValidation = validateSweepGrid(sweep.grid, {
        tunableParamNames: tunableParams.map((p) => p.name), restrictToEntryParams, entryAffecting,
      });
      if (!gridValidation.ok) return finalize('INCONCLUSIVE', 'grid_invalid');

      unionGrid = mergeGrids(unionGrid, sweep.grid);
      await this.d.experiments.updateExperiment(experimentId, { parameterGrid: unionGrid, updatedAt: this.d.now() });

      const trainRun: PlatformRunConfig = {
        ...input.runConfig, period: encodeTrainPeriod(input.datasetScope.period.from, T, input.runConfig.timeframe),
      };

      let allResults: GridResult[];
      let ranked: RankedPoint[];
      try {
        ({ allResults, ranked } = await this.d.paramGridRunner.runGrid({
          experimentId, strategyBundle: input.strategyBundle, strategyProfileId: input.strategyProfileId,
          trainRun, grid: sweep.grid, metrics: input.metrics, maxPoints: budget.maxPointsPerRound,
          topN: budget.topN, minTradesTrain: budget.minTradesTrain, foldId: r - 1,
        }));
      } catch (err) {
        if (err instanceof GridTooLargeError) return finalize('INCONCLUSIVE', 'grid_too_large');
        throw err;
      }

      // Ledger invariant: ONE member per allResults element (incl. rejected/zero-trade) — the
      // top-N (`ranked`) is passed ONLY to the result-interpreter below, never gates the ledger.
      for (const result of allResults) {
        await this.writeStrategyMember({
          experimentId, role: 'train', run: trainRun, params: result.point, oos: false,
          foldId: r - 1, strategyBacktestRunId: result.strategyBacktestRunId,
          tradeCount: result.tradeCount, bundleHash, taskId: input.taskId,
        });
      }

      if (ranked.length === 0) return finalize('INCONCLUSIVE', 'sweep_failed');

      const interpretTopN = scrubMetricsBag(ranked);
      await emitScrubbed('wfo.resultInterpreter.topN', interpretTopN.removedKeys);
      const interpretation = await this.d.resultInterpreter.interpret({
        topN: interpretTopN.scrubbed, roundsSoFar: r, maxRounds: budget.maxRounds,
      }, input.agentOpts);

      if (interpretation.decision === 'select') {
        const chosen = ranked.find((res) => res.paramsHash === interpretation.chosenParamsHash);
        if (!chosen) return finalize('INCONCLUSIVE', 'sweep_failed');
        selected = {
          point: chosen.point, foldId: r - 1, trainMetrics: chosen.metrics,
          plateau: {
            lonePeak: chosen.lonePeak,
            ...(chosen.neighborSharpeMedian !== undefined ? { neighborSharpeMedian: chosen.neighborSharpeMedian } : {}),
            ...(chosen.neighborCount !== undefined ? { neighborCount: chosen.neighborCount } : {}),
            ...(chosen.plateauEvidence !== undefined ? { plateauEvidence: chosen.plateauEvidence } : {}),
          },
        };
        break;
      }
      if (interpretation.decision === 'stop') return finalize('INCONCLUSIVE', 'stop');
      // extend
      if (r >= budget.maxRounds) return finalize('INCONCLUSIVE', 'round_limit_reached');
    }
    if (!selected) {
      return finalize('INCONCLUSIVE', budgetExhaustedMidLoop ? 'budget_exhausted' : 'round_limit_reached');
    }

    // --- On select: ONE holdout OOS run ---
    const holdoutRun: PlatformRunConfig = {
      ...input.runConfig, period: encodeHoldoutPeriod(T, input.datasetScope.period.to),
    };
    const holdoutOutcome = await this.d.strategyRunExecutor.execute({
      experimentId, role: 'holdout', strategyBundle: input.strategyBundle, strategyProfileId: input.strategyProfileId,
      run: holdoutRun, params: selected.point, metrics: [...input.metrics],
    });
    await this.writeStrategyMember({
      experimentId, role: 'holdout', run: holdoutRun, params: selected.point, oos: true,
      foldId: selected.foldId, strategyBacktestRunId: holdoutOutcome.runId,
      tradeCount: holdoutOutcome.totalTrades, bundleHash, taskId: input.taskId,
    });

    if (holdoutOutcome.status !== 'completed' || !holdoutOutcome.metrics) {
      return finalize('INCONCLUSIVE', 'inconclusive');
    }

    // R2: train is the SELECTED point's own train-window metrics (chosen.metrics captured
    // above as selected.trainMetrics) — the correct IS baseline for THIS specific point, not
    // the original (pre-optimization) baseline experiment's train metrics.
    const result = evaluateStrategyBaseline({ holdout: holdoutOutcome.metrics, boundary, train: selected.trainMetrics });
    const evaluation: ExperimentEvaluation = {
      id: this.d.newId('expeval'), experimentId, evaluatorVersion: STRATEGY_BASELINE_EVALUATOR_VERSION,
      rawScores: result.rawScores, flags: result.flags, verdict: result.verdict,
      verdictReason: result.verdictReason, createdAt: this.d.now(),
      // R1 (research-validation-hardening): advisory E2 DSR + trial ledger from the OOS holdout
      // run — absent when the backtester's trial ledger is disabled.
      ...(holdoutOutcome.trialContext !== undefined ? { trialContext: holdoutOutcome.trialContext } : {}),
    };
    await this.d.experiments.addEvaluation(evaluation);

    const terminalReason = result.verdict === 'PAPER_CANDIDATE' ? 'paper_candidate'
      : result.verdict === 'FAIL' ? 'holdout_failed'
      : 'inconclusive';

    // --- R11 break_battery@1 (log-mode): the deterministic "break the result" stage between
    // this WFO verdict and the paper.start enqueue (strategy-wfo.handler acts on the returned
    // verdict AFTER this method). Mode 'off' (default) never invokes the battery. LOG-MODE
    // INVARIANT: computed fail-soft from the same persisted inputs the evaluation used —
    // it never changes verdict/terminalReason/status, adds no runs, no retries. ---
    let breakBattery: BreakBatteryReport | undefined;
    if ((this.d.breakBatteryMode ?? 'off') === 'log') {
      try {
        breakBattery = runBreakBattery({
          ...(holdoutOutcome.trialContext !== undefined ? { trialContext: holdoutOutcome.trialContext } : {}),
          // Same IS/OOS inputs as evaluateStrategyBaseline above — computeOosDegradation is pure,
          // so this is byte-identical to the persisted rawScores.oosDegradation.
          oosDegradation: computeOosDegradation(selected.trainMetrics, holdoutOutcome.metrics),
          plateau: selected.plateau,
        });
      } catch { breakBattery = undefined; /* fail-soft: a battery bug must never fail the task */ }
    }

    await this.d.experiments.updateExperiment(experimentId, {
      status: 'completed', verdict: result.verdict, verdictReason: terminalReason,
      aggregateMetrics: {
        trainTrades: boundary.trainTrades, holdoutTrades: boundary.holdoutTrades, flags: result.flags,
        // Persistence lane (full report incl. observed values) — Outcome Embargo does not scrub
        // deterministic persistence; only generation-lane egress is sanitized.
        ...(breakBattery !== undefined ? { breakBattery } : {}),
      },
      completedAt: this.d.now(), updatedAt: this.d.now(),
    });
    await this.d.events.append({
      id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.completed',
      payload: { experimentId, verdict: result.verdict, verdictReason: terminalReason, experimentType: 'walk_forward_optimization' },
      createdAt: this.d.now(),
    });
    if (breakBattery !== undefined) {
      try {
        // Event log entry is STRUCTURAL only (check/status/reasonCode/severity — no observed
        // magnitudes); the retry-cycle feedback shape is pre-sanitized through the Outcome-Embargo
        // allowlist here, so any future consumer picks up the sanitized form, never the raw report.
        const sanitized = buildBreakBatteryRetryFeedback(breakBattery, experimentId);
        await this.d.events.append({
          id: this.d.newId('evt'), taskId: input.taskId, type: 'break_battery.completed',
          payload: {
            experimentId, experimentType: 'walk_forward_optimization',
            batteryVersion: breakBattery.batteryVersion, policyVersion: breakBattery.policyVersion,
            mode: 'log', outcome: breakBattery.outcome, verdict: result.verdict,
            checks: breakBattery.checks.map(({ check, status, reasonCode, severity }) => ({ check, status, reasonCode, severity })),
            sanitizedRetryFeedback: sanitized.feedback, feedbackRemovedKeys: sanitized.removedKeys,
          },
          createdAt: this.d.now(),
        });
      } catch { /* fail-soft: log-mode must never affect the pipeline */ }
    }
    return { experimentId, verdict: result.verdict, terminalReason };
  }

  /**
   * Persisted-counter budget gate for the WFO agent lane: true once the correlation's cumulative
   * token spend has reached (or exceeds) the research-task budget. Absent tokenUsage/budget deps
   * (backward-compat default) means unlimited — never trips.
   */
  private async budgetExhausted(correlationId: string): Promise<boolean> {
    if (!this.d.tokenUsage || this.d.researchTaskTokenBudget === undefined) return false;
    const cumulative = await this.d.tokenUsage.get(correlationId);
    return !withinTokenBudget(cumulative, this.d.researchTaskTokenBudget);
  }

  /** WFO-only member writer (train ledger + the single holdout row); baseline's runStrategyMember is untouched. */
  private async writeStrategyMember(args: {
    experimentId: string; role: MemberRole; run: PlatformRunConfig;
    params: Record<string, unknown>; oos: boolean; foldId: number;
    strategyBacktestRunId: string; tradeCount?: number; bundleHash: string; taskId: string;
  }): Promise<void> {
    const paramsHash = computeStrategyParamsHash({ bundleHash: args.bundleHash, platformRun: args.run, params: args.params });
    const memberId = this.d.newId('mem');
    const member: ExperimentRunMember = {
      id: memberId, experimentId: args.experimentId, role: args.role,
      periodFrom: args.run.period.from, periodTo: args.run.period.to,
      symbols: [...args.run.symbols], paramsHash, params: args.params, oos: args.oos, foldId: args.foldId,
      bundleHash: args.bundleHash, strategyBacktestRunId: args.strategyBacktestRunId, backtestRunId: undefined,
      tradeCount: args.tradeCount,
      resultSummary: args.tradeCount !== undefined ? { totalTrades: args.tradeCount } : undefined,
      createdAt: this.d.now(),
    };
    await this.d.experiments.addMember(member);
    await this.d.events.append({
      id: this.d.newId('evt'), taskId: args.taskId, type: 'experiment.member.completed',
      payload: {
        experimentId: args.experimentId, role: args.role, oos: args.oos, foldId: args.foldId,
        tradeCount: args.tradeCount, strategyBacktestRunId: args.strategyBacktestRunId,
        experimentType: 'walk_forward_optimization',
      },
      createdAt: this.d.now(),
    });
  }
}
