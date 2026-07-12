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
    const identity = (): Promise<StrategyBacktestRun | null> =>
      this.d.strategyBacktests.findByBundleAndParams(req.strategyBundle.manifest.id, paramsHash, req.strategyBundle.bundleHash);

    // Idempotency — reuse ANY existing row for this identity, not just a completed one. A prior
    // attempt whose bounded poll parked the run as `submitted` (or a rejected/failed one) must NOT
    // be resubmitted: the resumeToken embeds the (fresh-per-attempt) revisionId, so a resubmit mints
    // a DUPLICATE platform run and then throws on the strategy_backtest_run_idem_uq index — stranding
    // the row and wedging the revision lane (P0-4). Resume the existing row instead.
    const existing = await identity();
    if (existing) {
      const adopted = await this.adoptExisting(existing);
      if (adopted) return adopted;
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
    try {
      await this.d.strategyBacktests.createSubmitted(row);
    } catch (err) {
      // Backstop: a concurrent execute() for the same identity won the idem unique index between
      // our findByBundleAndParams and this insert. Re-read and adopt the winner rather than throwing
      // (which would wedge the lane). Our just-submitted platform run is orphaned — acceptable under
      // the per-profile serialization that must gate concurrency > 1.
      const winner = await identity();
      const adopted = winner ? await this.adoptExisting(winner) : null;
      if (adopted) return adopted;
      throw err;
    }

    // 3. Bounded poll — NO comparison gate (unlike pollOverlayRun): a revision-combo run is standalone.
    const outcome = await pollResearchRun(this.d.platform, handle.runId, this.d.poll);
    return this.finalize(labRunId, handle.runId, outcome);
  }

  /**
   * Reuse an existing run row for this identity without resubmitting. Completed → return its metrics;
   * a non-terminal (submitted/running/queued) row → resume by re-polling its platform run; a terminal
   * rejected/failed row → surface rejected (it already ran and produced no reusable metrics). Returns
   * null only for an unexpected status, letting the caller fall through to a fresh submit.
   */
  private async adoptExisting(existing: StrategyBacktestRun): Promise<RevisionRunResult | null> {
    if (existing.status === 'completed' && existing.metrics) {
      return {
        status: 'completed', runId: existing.id, platformRunId: existing.platformRunId,
        metrics: existing.metrics, totalTrades: existing.metrics.totalTrades,
      };
    }
    if (existing.status === 'rejected' || existing.status === 'failed') {
      return { status: 'rejected', runId: existing.id, platformRunId: existing.platformRunId };
    }
    if (existing.status === 'submitted' || existing.status === 'running' || existing.status === 'queued') {
      const outcome = await pollResearchRun(this.d.platform, existing.platformRunId, this.d.poll);
      return this.finalize(existing.id, existing.platformRunId, outcome);
    }
    return null;
  }

  /** Marks a run row terminal from a poll outcome and maps the result into a RevisionRunResult. */
  private async finalize(runId: string, platformRunId: string, outcome: Awaited<ReturnType<typeof pollResearchRun>>): Promise<RevisionRunResult> {
    if (outcome.status === 'rejected') {
      await this.d.strategyBacktests.markRejected(runId);
      return { status: 'rejected', runId, platformRunId };
    }
    if (outcome.status === 'pending') {
      return { status: 'pending', runId, platformRunId };
    }

    let metrics;
    try {
      metrics = mapStrategyMetrics(outcome.summary);
    } catch (err) {
      if (err instanceof MetricMappingError) {
        await this.d.strategyBacktests.markFailed(runId);
        return { status: 'rejected', runId, platformRunId };
      }
      throw err;
    }

    await this.d.strategyBacktests.markCompleted(runId, {
      metrics,
      artifactRefs: [...outcome.artifactIds],
      platformContractVersion: outcome.summary.evidence?.contractVersion ?? 'unknown',
      finishedAt: this.d.now(),
    });
    return { status: 'completed', runId, platformRunId, metrics, totalTrades: metrics.totalTrades };
  }
}
