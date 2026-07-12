import { randomUUID } from 'node:crypto';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import type { PlatformRunConfig, Ref, SubmitOverlayRunOptions } from '../../ports/research-platform.port.ts';
import { pollOverlayRun } from '../../research/run-backtest.ts';
import { event, applyPlatformTerminalOutcome, enqueueBacktestCompleted } from './backtest-support.ts';

export interface RunPlatformBacktestInput {
  services: AppServices;
  task: ResearchTask;
  buildId: string;
  bundle: ModuleBundle;
  profile: StrategyProfile;
  hypothesisId: string;
  params: Record<string, unknown>;
  platformRun: PlatformRunConfig;
  paramsHash: string;
  baselineRef: Ref;
  resumeToken: string;
  /** Depth in the research→build→backtest cycle chain (0 = first run). */
  cycleDepth: number;
}

/**
 * research_platform backtest branch: platform validate gate → submit → persist
 * immediately → bounded poll → outcome. Transport/Gateway errors throw (worker retries);
 * platform rejection + MetricMappingError are recorded business/data failures (no throw).
 */
export async function runPlatformBacktest(input: RunPlatformBacktestInput): Promise<void> {
  const { services, task, buildId, bundle, profile, hypothesisId, params, platformRun, paramsHash, baselineRef, resumeToken, cycleDepth } = input;
  const now = () => new Date().toISOString();

  // 1. Pre-submit platform validation gate (fail-closed into the build-failure path; no submit).
  const report = await services.researchPlatform.validateModule(bundle);
  if (report.status === 'rejected') {
    const issues: ValidationIssue[] = report.issues.map((i) => ({ code: i.code, severity: i.severity, path: i.path, message: i.message }));
    await services.builds.markBuildFailed(buildId, issues);
    await services.events.append(event(task.id, 'build_failed', { buildId, codes: issues.map((i) => i.code), source: 'platform_validate' }));
    return;
  }
  await services.events.append(event(task.id, 'build.platform_validated', { buildId, status: report.status }));

  // 2. Submit (transport / GatewayRunError propagate → worker retry; resumeToken makes the replay idempotent).
  const opts: SubmitOverlayRunOptions = {
    // Per-integration overlay-run target: the backtester/HTTP path needs a COMPLETE request
    // (risk/exec/metrics) that only a registry preset supplies; the platform/MCP path compares
    // against a baseline ref. The mock accepts either (it ignores the target).
    target:
      services.researchIntegration === 'backtester'
        ? { kind: 'registry_preset' }
        : { kind: 'baseline_ref', moduleRef: baselineRef },
    run: platformRun,
    correlationId: task.correlationId,
    resumeToken,
    ...(services.backtestCallbackUrl !== undefined ? { callbackUrl: services.backtestCallbackUrl } : {}),
  };
  const handle = await services.researchPlatform.submitOverlayRun(bundle, opts);

  // 3. Persist immediately so an accepted run is never lost before the poll resolves (SP-7.3 resumes from here).
  const runId = randomUUID();
  const run: BacktestRun = {
    id: runId, hypothesisBuildId: buildId, hypothesisId, strategyProfileId: profile.id,
    platformRunId: handle.runId, correlationId: task.correlationId, params, paramsHash, bundleHash: bundle.bundleHash,
    status: 'submitted', baselineModuleId: baselineRef.id, variantModuleId: bundle.manifest.moduleId,
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: SDK_CONTRACT_VERSION,
    backend: 'research_platform', taskId: task.id, resumeToken, platformRun,
    submittedAt: now(), finishedAt: null, createdAt: now(), updatedAt: now(),
  };
  await services.backtests.createSubmitted(run);
  await services.builds.markSubmitted(buildId);
  await services.events.append(event(task.id, 'backtest.submitted', { runId, platformRunId: handle.runId, backend: 'research_platform' }));

  // 4. Bounded poll + resolve (reuses the SP-7.2a capability).
  const outcome = await pollOverlayRun(services.researchPlatform, handle.runId, {
    maxPolls: services.platformPoll.maxPolls, pollDelayMs: services.platformPoll.pollDelayMs,
  });

  if (outcome.status === 'pending') {
    await services.events.append(event(task.id, 'backtest.pending', { runId, platformRunId: handle.runId, resumeToken }));
    return;
  }

  // Race guard: a concurrent webhook resume may have finalized this run while we polled.
  const again = await services.backtests.findById(runId);
  if (!again || again.status !== 'submitted') {
    await services.events.append(event(task.id, 'backtest.poll.skipped', { runId, reason: 'already_terminalized' }));
    return;
  }
  if ((await services.evaluations.listByBacktestRun(runId)).length > 0) {
    await services.events.append(event(task.id, 'backtest.poll.skipped', { runId, reason: 'already_evaluated' }));
    return;
  }

  const result = await applyPlatformTerminalOutcome(services, task, { runId, hypothesisId, platformRunId: again.platformRunId }, outcome);
  if (result.kind === 'completed') {
    await enqueueBacktestCompleted(services, task, {
      backtestRunId: runId,
      hypothesisId,
      strategyProfileId: profile.id,
      decision: result.decision,
      reasons: result.reasons,
      cycleDepth,
      deltaNetPnlUsd: result.deltaNetPnlUsd,
      deltaMaxDrawdownPct: result.deltaMaxDrawdownPct,
      // Sourced from the input PlatformRunConfig (always present for a research_platform submit) —
      // cheaper and more reliable than re-reading it back off the persisted run.
      symbol: platformRun.symbols[0],
    });
  }
}
