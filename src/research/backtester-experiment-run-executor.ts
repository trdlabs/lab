import { randomUUID, createHash } from 'node:crypto';
import type { ResearchPlatformPort, SubmitOverlayRunOptions } from '../ports/research-platform.port.ts';
import type { BacktestRun, BacktestCompletion } from '../domain/backtest-run.ts';
import type { BacktestRunRepository } from '../ports/backtest-run.repository.ts';
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';
import { pollOverlayRun, type PollOptions } from './run-backtest.ts';
import { mapPlatformComparison, MetricMappingError } from '../domain/platform-comparison.ts';
import { computeParamsHash } from '../orchestrator/handlers/backtest-support.ts';
import { SDK_CONTRACT_VERSION } from '../domain/module-bundle.ts';
import type { ExperimentRunExecutor, ExperimentRunRequest, ExperimentRunResult } from './experiment-run-executor.ts';

export interface BacktesterExperimentRunExecutorDeps {
  platform: ResearchPlatformPort;
  backtests: BacktestRunRepository;
  researchIntegration: string;
  fragilityTopTradePct: number;
  poll: PollOptions;
  callbackUrl?: string;
  now: () => string;
}

export class BacktesterExperimentRunExecutor implements ExperimentRunExecutor {
  private readonly d: BacktesterExperimentRunExecutorDeps;
  constructor(deps: BacktesterExperimentRunExecutorDeps) { this.d = deps; }

  async execute(req: ExperimentRunRequest): Promise<ExperimentRunResult> {
    const paramsHash = computeParamsHash(req.params, { platformRun: req.run, baselineRef: req.baselineRef });
    const resumeToken = createHash('sha256')
      .update(JSON.stringify({ v: 1, experimentId: req.experimentId, role: req.role, paramsHash, bundleHash: req.bundle.bundleHash }))
      .digest('hex');

    const opts: SubmitOverlayRunOptions = {
      target: this.d.researchIntegration === 'backtester'
        ? { kind: 'registry_preset' }
        : { kind: 'baseline_ref', moduleRef: req.baselineRef },
      run: req.run,
      correlationId: req.role,
      resumeToken,
      workflowId: req.experimentId,
      ...(this.d.callbackUrl !== undefined ? { callbackUrl: this.d.callbackUrl } : {}),
      ...(req.trialFamilyHint !== undefined ? { trialFamilyHint: req.trialFamilyHint } : {}),
    };

    // 1. Submit — transport / GatewayRunError propagate → caller retries; resumeToken makes replay idempotent.
    const handle = await this.d.platform.submitOverlayRun(req.bundle, opts);
    const labRunId = randomUUID();

    // 2. Persist immediately so an accepted run is never lost before the poll resolves.
    const run: BacktestRun = {
      id: labRunId,
      hypothesisBuildId: req.buildId,
      hypothesisId: req.hypothesisId,
      strategyProfileId: req.strategyProfileId,
      platformRunId: handle.runId,
      correlationId: req.role,
      params: req.params,
      paramsHash,
      bundleHash: req.bundle.bundleHash,
      status: 'submitted',
      baselineModuleId: req.baselineRef.id,
      variantModuleId: req.bundle.manifest.moduleId,
      metrics: null,
      baselineMetrics: null,
      deltaNetPnlUsd: null,
      deltaMaxDrawdownPct: null,
      isFragile: null,
      artifactRefs: [],
      platformContractVersion: 'pending',
      sdkContractVersion: SDK_CONTRACT_VERSION,
      backend: 'research_platform',
      taskId: req.experimentId,
      resumeToken,
      platformRun: req.run,
      submittedAt: this.d.now(),
      finishedAt: null,
      createdAt: this.d.now(),
      updatedAt: this.d.now(),
    };
    await this.d.backtests.createSubmitted(run);

    // 3. Bounded poll.
    const outcome = await pollOverlayRun(this.d.platform, handle.runId, this.d.poll);

    // 4. Mark terminal.
    if (outcome.status === 'rejected') {
      await this.d.backtests.markRejected(labRunId);
      return { status: 'rejected', runId: labRunId, platformRunId: handle.runId };
    }
    if (outcome.status === 'pending') {
      return { status: 'pending', runId: labRunId, platformRunId: handle.runId };
    }

    let c: ComparisonSummary;
    try {
      c = mapPlatformComparison(outcome.summary);
    } catch (err) {
      if (err instanceof MetricMappingError) {
        await this.d.backtests.markFailed(labRunId);
        return { status: 'rejected', runId: labRunId, platformRunId: handle.runId };
      }
      throw err;
    }

    const completion: BacktestCompletion = {
      metrics: c.variant,
      baselineMetrics: c.baseline,
      deltaNetPnlUsd: c.variant.netPnlUsd - c.baseline.netPnlUsd,
      deltaMaxDrawdownPct: c.variant.maxDrawdownPct - c.baseline.maxDrawdownPct,
      isFragile: c.variant.topTradeContributionPct >= this.d.fragilityTopTradePct,
      artifactRefs: [...outcome.artifactIds],
      platformContractVersion: c.platformContractVersion,
      finishedAt: this.d.now(),
    };
    await this.d.backtests.markCompleted(labRunId, completion);
    return { status: 'completed', runId: labRunId, platformRunId: handle.runId, comparison: c, totalTrades: c.variant.totalTrades };
  }
}
