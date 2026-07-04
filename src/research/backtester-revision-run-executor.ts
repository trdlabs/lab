import { randomUUID, createHash } from 'node:crypto';
import type { ResearchPlatformPort } from '../ports/research-platform.port.ts';
import type { StrategyBacktestRunRepository } from '../ports/strategy-backtest-run.repository.ts';
import type { StrategyBacktestRun } from '../domain/strategy-backtest-run.ts';
import { REVISION_COMBO_RUN_KIND } from '../domain/strategy-backtest-run.ts';
import { pollResearchRun, type PollOptions } from './run-backtest.ts';
import { mapStrategyMetrics } from '../domain/strategy-metrics.ts';
import { MetricMappingError } from '../domain/platform-comparison.ts';
import { computeStrategyParamsHash } from './strategy-run-identity.ts';
import { SDK_CONTRACT_VERSION } from '../domain/module-bundle.ts';
import type {
  StrategyRevisionRunExecutor,
  RevisionRunRequest,
  RevisionRunResult,
} from '../ports/strategy-revision-run-executor.ts';

export interface BacktesterRevisionRunExecutorDeps {
  platform: ResearchPlatformPort;
  strategyBacktests: StrategyBacktestRunRepository;
  poll: PollOptions;
  callbackUrl?: string;
  now: () => string;
}

/**
 * Strategy-lane sibling of `BacktesterStrategyExperimentRunExecutor`, keyed by
 * revisionId/label (candidate | comparison_baseline) instead of experimentId/role: submits an
 * `engine:'strategy'` run via `ResearchPlatformPort.submitStrategyResearchRun`, persists a
 * `StrategyBacktestRun` with `runKind: 'revision_combo'`, bounded-polls, and maps the completed
 * `RunResultSummary` into a `BacktestMetricBlock`. Adds a by-key dedup short-circuit before
 * submitting: an existing COMPLETED row with metrics for the same
 * (strategyBundleId, paramsHash, bundleHash) is returned as-is — this is what makes the
 * same-run-context comparison-baseline reuse idempotent (never resubmits a baseline that already
 * ran for this bundle/params combo).
 *
 * Deliberately duplicates (rather than shares) the submit/poll/persist core of
 * `BacktesterStrategyExperimentRunExecutor`: the dedup step and the differing resumeToken/row-key
 * shape (revisionId+label vs experimentId+role) meant a shared helper would have reached into the
 * sibling executor's behavior for a low payoff. follow-up: extract shared core.
 */
export class BacktesterRevisionRunExecutor implements StrategyRevisionRunExecutor {
  private readonly d: BacktesterRevisionRunExecutorDeps;
  constructor(deps: BacktesterRevisionRunExecutorDeps) { this.d = deps; }

  async execute(req: RevisionRunRequest): Promise<RevisionRunResult> {
    const paramsHash = computeStrategyParamsHash({
      bundleHash: req.strategyBundle.bundleHash, platformRun: req.run, params: {},
    });

    // Dedup — an existing COMPLETED row with metrics for this identity is reused as-is (no resubmit).
    const existing = await this.d.strategyBacktests.findByBundleAndParams(
      req.strategyBundle.manifest.id, paramsHash, req.strategyBundle.bundleHash,
    );
    if (existing && existing.status === 'completed' && existing.metrics) {
      return {
        status: 'completed',
        runId: existing.id,
        platformRunId: existing.platformRunId,
        metrics: existing.metrics,
        totalTrades: existing.metrics.totalTrades,
      };
    }

    const resumeToken = createHash('sha256')
      .update(JSON.stringify({ v: 1, revisionId: req.revisionId, label: req.label, paramsHash, bundleHash: req.strategyBundle.bundleHash }))
      .digest('hex');

    // 1. Submit — transport / GatewayRunError propagate → caller retries; resumeToken makes replay idempotent.
    const handle = await this.d.platform.submitStrategyResearchRun(req.strategyBundle, {
      run: req.run,
      correlationId: req.correlationId,
      metrics: req.metrics,
      params: {},
      resumeToken,
      workflowId: req.revisionId,
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
      runKind: REVISION_COMBO_RUN_KIND,
      platformRunId: handle.runId,
      correlationId: req.correlationId,
      taskId: req.revisionId,
      resumeToken,
      params: {},
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

    // 3. Bounded poll — NO comparison gate (unlike pollOverlayRun): a revision-combo run is standalone.
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
