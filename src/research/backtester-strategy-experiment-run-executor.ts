import { randomUUID, createHash } from 'node:crypto';
import type { ResearchPlatformPort } from '../ports/research-platform.port.ts';
import type { StrategyBacktestRunRepository } from '../ports/strategy-backtest-run.repository.ts';
import type { StrategyBacktestRun } from '../domain/strategy-backtest-run.ts';
import { STRATEGY_RUN_KIND } from '../domain/strategy-backtest-run.ts';
import { pollResearchRun, type PollOptions } from './run-backtest.ts';
import { mapStrategyMetrics } from '../domain/strategy-metrics.ts';
import { MetricMappingError } from '../domain/platform-comparison.ts';
import { computeStrategyParamsHash } from './strategy-run-identity.ts';
import { SDK_CONTRACT_VERSION } from '../domain/module-bundle.ts';
import type {
  StrategyExperimentRunExecutor,
  StrategyExperimentRunRequest,
  StrategyExperimentRunResult,
} from './strategy-experiment-run-executor.ts';

export interface BacktesterStrategyExperimentRunExecutorDeps {
  platform: ResearchPlatformPort;
  strategyBacktests: StrategyBacktestRunRepository;
  poll: PollOptions;
  callbackUrl?: string;
  now: () => string;
}

/**
 * Strategy-lane sibling of `BacktesterExperimentRunExecutor` (overlay lane): submits an
 * `engine:'strategy'` run for a standalone `AssembledStrategyBundle` via
 * `ResearchPlatformPort.submitStrategyResearchRun` (no baseline/comparison target), persists a
 * `StrategyBacktestRun`, bounded-polls via `pollResearchRun`, and maps the completed
 * `RunResultSummary` into a `BacktestMetricBlock` via `mapStrategyMetrics`.
 */
export class BacktesterStrategyExperimentRunExecutor implements StrategyExperimentRunExecutor {
  private readonly d: BacktesterStrategyExperimentRunExecutorDeps;
  constructor(deps: BacktesterStrategyExperimentRunExecutorDeps) { this.d = deps; }

  async execute(req: StrategyExperimentRunRequest): Promise<StrategyExperimentRunResult> {
    const paramsHash = computeStrategyParamsHash({
      bundleHash: req.strategyBundle.bundleHash, platformRun: req.run, params: req.params,
    });
    const resumeToken = createHash('sha256')
      .update(JSON.stringify({ v: 1, experimentId: req.experimentId, role: req.role, paramsHash, bundleHash: req.strategyBundle.bundleHash }))
      .digest('hex');

    // 1. Submit — transport / GatewayRunError propagate → caller retries; resumeToken makes replay idempotent.
    const handle = await this.d.platform.submitStrategyResearchRun(req.strategyBundle, {
      run: req.run,
      correlationId: req.role,
      metrics: req.metrics,
      params: req.params,
      resumeToken,
      workflowId: req.experimentId,
      ...(this.d.callbackUrl !== undefined ? { callbackUrl: this.d.callbackUrl } : {}),
    });
    const labRunId = randomUUID();

    // 2. Persist immediately so an accepted run is never lost before the poll resolves.
    const row: StrategyBacktestRun = {
      id: labRunId,
      strategyProfileId: req.strategyProfileId,
      strategyBundleId: req.strategyBundle.manifest.id,
      bundleHash: req.strategyBundle.bundleHash,
      paramsHash,
      runKind: STRATEGY_RUN_KIND,
      platformRunId: handle.runId,
      correlationId: req.role,
      taskId: req.experimentId,
      resumeToken,
      params: req.params,
      status: 'submitted',
      metrics: null,
      platformRun: req.run,
      artifactRefs: [],
      platformContractVersion: 'pending',
      sdkContractVersion: SDK_CONTRACT_VERSION,
      backend: 'research_platform',
      submittedAt: this.d.now(),
      finishedAt: null,
      createdAt: this.d.now(),
      updatedAt: this.d.now(),
    };
    await this.d.strategyBacktests.createSubmitted(row);

    // 3. Bounded poll — NO comparison gate (unlike pollOverlayRun): a strategy run is standalone.
    const outcome = await pollResearchRun(this.d.platform, handle.runId, this.d.poll);

    // 4. Mark terminal.
    if (outcome.status === 'rejected') {
      await this.d.strategyBacktests.markRejected(labRunId);
      return { status: 'rejected', runId: labRunId, platformRunId: handle.runId };
    }
    if (outcome.status === 'pending') {
      return { status: 'pending', runId: labRunId, platformRunId: handle.runId };
    }

    let metrics;
    try {
      metrics = mapStrategyMetrics(outcome.summary);
    } catch (err) {
      if (err instanceof MetricMappingError) {
        await this.d.strategyBacktests.markFailed(labRunId);
        return { status: 'rejected', runId: labRunId, platformRunId: handle.runId };
      }
      throw err;
    }

    await this.d.strategyBacktests.markCompleted(labRunId, {
      metrics,
      artifactRefs: [...outcome.artifactIds],
      platformContractVersion: outcome.summary.evidence?.contractVersion ?? 'unknown',
      finishedAt: this.d.now(),
    });
    return { status: 'completed', runId: labRunId, platformRunId: handle.runId, metrics, totalTrades: metrics.totalTrades };
  }
}
