import type { Ref, PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type {
  ResearchExperiment, ExperimentRunMember, ExperimentEvaluation, ExperimentVerdict,
  MemberRole, DatasetScope, HoldoutPolicy,
} from '../domain/research-experiment.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../domain/research-experiment.ts';
import type { ResearchExperimentRepository } from '../ports/research-experiment.repository.ts';
import type { RunTradesPort } from '../ports/run-trades.port.ts';
import type { ExperimentRunExecutor, ExperimentRunResult } from './experiment-run-executor.ts';
import type { StrategyExperimentRunExecutor, StrategyExperimentRunResult } from './strategy-experiment-run-executor.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import { resolveHoldoutBoundary } from './holdout-boundary-resolver.ts';
import { evaluateExperiment, EXPERIMENT_EVALUATOR_VERSION } from '../validation/experiment-evaluator.ts';
import { evaluateStrategyBaseline, STRATEGY_BASELINE_EVALUATOR_VERSION } from '../validation/strategy-baseline-evaluator.ts';
import { computeExperimentKey } from './experiment-identity.ts';
import { computeStrategyExperimentKey } from './strategy-run-identity.ts';
import { encodeTrainPeriod, encodeHoldoutPeriod } from './period-encoding.ts';

export interface ExperimentServiceDeps {
  experiments: ResearchExperimentRepository;
  runTrades: RunTradesPort;
  runExecutor: ExperimentRunExecutor;
  strategyRunExecutor: StrategyExperimentRunExecutor;
  newId: (prefix: string) => string;
  now: () => string; // ISO
  events: AgentEventRepository;
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

export class ExperimentService {
  private readonly d: ExperimentServiceDeps;
  constructor(deps: ExperimentServiceDeps) { this.d = deps; }

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
    const fail = async (verdict: ExperimentVerdict, reason: string): Promise<{ experimentId: string; verdict: ExperimentVerdict }> => {
      await this.d.experiments.updateExperiment(experimentId, {
        status: 'completed', verdict, verdictReason: reason,
        completedAt: this.d.now(), updatedAt: this.d.now(),
      });
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.completed',
        payload: { experimentId, verdict, verdictReason: reason },
        createdAt: this.d.now(),
      });
      return { experimentId, verdict };
    };

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
    if (existing && existing.status === 'completed') return { experimentId: existing.id, verdict: existing.verdict ?? 'INCONCLUSIVE' };

    const now = this.d.now();
    const experimentId = existing?.id ?? this.d.newId('exp');
    if (!existing) {
      const exp: ResearchExperiment = {
        id: experimentId, experimentKey, experimentType: 'strategy_baseline_validation',
        strategyProfileId: input.strategyProfileId,
        bundleHash: input.strategyBundle.bundleHash, objective: input.objective,
        datasetScope: input.datasetScope, holdoutPolicy: policy, status: 'running',
        createdAt: now, updatedAt: now,
      };
      await this.d.experiments.createExperiment(exp);
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.started',
        payload: { experimentId, strategyProfileId: input.strategyProfileId, experimentType: 'strategy_baseline_validation' },
        createdAt: this.d.now(),
      });
    }

    const fullPeriod = input.datasetScope.period;
    const fail = async (verdict: ExperimentVerdict, reason: string): Promise<{ experimentId: string; verdict: ExperimentVerdict }> => {
      await this.d.experiments.updateExperiment(experimentId, {
        status: 'completed', verdict, verdictReason: reason,
        completedAt: this.d.now(), updatedAt: this.d.now(),
      });
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.completed',
        payload: { experimentId, verdict, verdictReason: reason, experimentType: 'strategy_baseline_validation' },
        createdAt: this.d.now(),
      });
      return { experimentId, verdict };
    };

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

    // --- TRAIN [from, T) ---
    const trainPeriod = encodeTrainPeriod(fullPeriod.from, boundary.t, input.runConfig.timeframe);
    const train = await this.runStrategyMember(experimentId, 'train', input, { ...input.runConfig, period: trainPeriod });
    if (train.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    if (train.status !== 'completed') return fail('INCONCLUSIVE', 'train_not_run');

    // --- HOLDOUT [T, to] (period.from = T = no-leakage) ---
    const holdoutPeriod = encodeHoldoutPeriod(boundary.t, fullPeriod.to);
    const holdout = await this.runStrategyMember(experimentId, 'holdout', input, { ...input.runConfig, period: holdoutPeriod });
    if (holdout.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    if (holdout.status !== 'completed' || !holdout.metrics) return fail('INCONCLUSIVE', 'holdout_not_run');

    // --- EVALUATE (holdout only; sanity/train are gates, not the verdict source) ---
    const result = evaluateStrategyBaseline({ holdout: holdout.metrics, boundary });
    const evaluation: ExperimentEvaluation = {
      id: this.d.newId('expeval'), experimentId, evaluatorVersion: STRATEGY_BASELINE_EVALUATOR_VERSION,
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
      payload: { experimentId, verdict: result.verdict, verdictReason: result.verdictReason, experimentType: 'strategy_baseline_validation' },
      createdAt: this.d.now(),
    });
    return { experimentId, verdict: result.verdict };
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
}
