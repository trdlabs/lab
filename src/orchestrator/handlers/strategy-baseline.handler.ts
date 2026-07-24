// src/orchestrator/handlers/strategy-baseline.handler.ts
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';
import { reconstructStrategyBundle } from '../../research/reconstruct-strategy-bundle.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import { getAuthoringDoc } from '@trdlabs/backtester-sdk/builder';
import { createAndEnqueueTask } from '../task-intake.ts';
import { event } from './backtest-support.ts';
import {
  buildOnboardBatteryGrid,
  summarizeOnboardBatteryRun,
  ONBOARD_BATTERY_MAX_POINTS,
} from '../../research/onboard-battery.ts';
import type { AppServices } from '../app-services.ts';
import type { ArtifactRef, ResearchTask } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { PlatformRunConfig } from '../../ports/research-platform.port.ts';

export const StrategyBaselinePayloadSchema = z.object({
  strategyProfileId: z.string().min(1),
  sourceTaskId: z.string().optional(),
  // Ready-bundle mode (G3b re-baseline of a consolidated clean source): reconstruct
  // deterministically instead of an LLM rebuild, which would drift the bundleHash.
  bundleArtifactRef: z.custom<ArtifactRef>((v) => typeof v === 'object' && v !== null).optional(),
  // When set, the baseline outcome is written back onto this revision (consolidated OR composed accepted).
  revisionId: z.string().optional(),
  /** @deprecated transient alias for `revisionId`; drop in a follow-up once the queue drains past this deploy. */
  consolidatedRevisionId: z.string().optional(),
});

/**
 * R13 log-only onboarding battery: after a fresh strategy's baseline passes and BEFORE the first
 * full WFO, sweep a small DETERMINISTIC grid around the profile's baseline param values (built
 * mechanically from SWEEP_AXIS_CATALOG — no LLM), submitting each point through ParamGridRunner so
 * every run lands in the backtester's server-side trial ledger. Emits
 * `strategy.onboard_battery.completed` with counts + lone-peak evidence (NO magnitudes), persists
 * a summary artifact, and NEVER changes a verdict/status/the baseline→wfo chain.
 *
 * FAIL-SOFT + FAIL-CLOSED: only runs when `onboardBatteryMode === 'log'` ('off' default is
 * byte-identical to pre-R13). Any error — no eligible axes, runner throw — degrades to a
 * `strategy.onboard_battery.skipped` event; this function NEVER throws, so the caller's WFO
 * enqueue is unaffected.
 */
async function runOnboardBattery(
  task: ResearchTask,
  services: AppServices,
  ctx: { profile: StrategyProfile; strategyBundle: AssembledStrategyBundle; experimentId: string; run: AppServices['defaultPlatformRun'] },
): Promise<void> {
  if (services.onboardBatteryMode !== 'log') return;
  const { profile, strategyBundle, experimentId, run } = ctx;
  try {
    const built = buildOnboardBatteryGrid(profile.profile?.parameters);
    if (built.axes.length === 0) {
      await services.events.append(event(task.id, 'strategy.onboard_battery.skipped', {
        strategyProfileId: profile.id, experimentId, reason: 'no_eligible_axes',
      }));
      return;
    }

    const trainRun: PlatformRunConfig = {
      datasetId: run.datasetId, symbols: run.symbols, timeframe: run.timeframe,
      period: { from: run.period.from, to: run.period.to }, seed: run.seed,
    };
    const output = await services.paramGridRunner.runGrid({
      experimentId,
      strategyBundle,
      strategyProfileId: profile.id,
      trainRun,
      grid: built.grid,
      metrics: RESEARCH_RUN_METRICS,
      maxPoints: ONBOARD_BATTERY_MAX_POINTS,
      topN: built.pointCount,
      minTradesTrain: 1,
      foldId: 0,
    });

    const summary = summarizeOnboardBatteryRun(output);
    const summaryRef = await services.artifacts.put(
      JSON.stringify({ strategyProfileId: profile.id, experimentId, axes: built.axes, ...summary }),
      { kind: 'onboard_battery_summary', mime_type: 'application/json', producer: 'strategy-baseline-handler' },
    );
    await services.events.append(event(task.id, 'strategy.onboard_battery.completed', {
      strategyProfileId: profile.id, experimentId, axes: built.axes, summaryRef, ...summary,
    }));
  } catch (err) {
    try {
      await services.events.append(event(task.id, 'strategy.onboard_battery.skipped', {
        strategyProfileId: profile.id, experimentId,
        reason: err instanceof Error ? err.message : String(err),
      }));
    } catch {
      /* swallow — the onboarding battery must never break the baseline→wfo chain */
    }
  }
}

export const strategyBaselineHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(StrategyBaselinePayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid strategy.baseline payload: ${JSON.stringify(parsed.issues)}`);
  const { strategyProfileId } = parsed.data;

  const profile = await services.strategyProfiles.findById(strategyProfileId);
  if (!profile) throw new Error(`strategy_profile ${strategyProfileId} not found`);

  await services.events.append(event(task.id, 'strategy.baseline.started', { strategyProfileId }));

  let bundle: AssembledStrategyBundle;
  let bundleArtifactRef: ArtifactRef;
  if (parsed.data.bundleArtifactRef) {
    // Ready-bundle mode: reconstruct the already-built clean bundle deterministically.
    // NEVER call strategyBuilder.build here — a non-deterministic LLM rebuild would drift
    // the bundleHash, which self-blocked WFO in G1.
    bundleArtifactRef = parsed.data.bundleArtifactRef;
    bundle = await reconstructStrategyBundle(services.artifacts, bundleArtifactRef);
  } else {
    const out = await services.strategyBuilder.build({
      spec: { description: `baseline validation for profile ${profile.id}` },
      authoringDoc: getAuthoringDoc('strategy'),
      profile,
    });
    bundle = await assembleStrategyBundle(out);
    bundleArtifactRef = await services.artifacts.put(
      JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
      { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'strategy-baseline-handler' },
    );
  }

  const run = services.defaultPlatformRun;
  const { experimentId, verdict } = await services.experimentService.runStrategyBaselineValidation({
    strategyProfileId: profile.id,
    strategyBundle: bundle,
    bundleArtifactRef,
    datasetScope: { datasetId: run.datasetId, symbols: run.symbols, timeframe: run.timeframe, period: run.period },
    runConfig: { datasetId: run.datasetId, symbols: run.symbols, timeframe: run.timeframe, seed: run.seed },
    metrics: RESEARCH_RUN_METRICS,
    taskId: task.id,
  });

  const revisionId = parsed.data.revisionId ?? parsed.data.consolidatedRevisionId;

  // Verdict -> baselineValidationStatus, computed for EVERY run so the W4 gate below is uniform.
  // PASS/PAPER_CANDIDATE -> 'passed'; INCONCLUSIVE -> 'inconclusive'; FAIL/MODIFY -> 'failed'.
  const baselineValidationStatus =
    verdict === 'PASS' || verdict === 'PAPER_CANDIDATE' ? 'passed'
    : verdict === 'INCONCLUSIVE' ? 'inconclusive'
    : 'failed';

  if (revisionId) {
    await services.revisions.updateStatus(revisionId, {
      baselineValidationStatus,
      baselineExperimentId: experimentId,
      baselineTaskId: task.id,
      updatedAt: new Date().toISOString(),
    });
  }

  // W4: only a passing baseline earns the expensive WFO sweep. failed/inconclusive stop here —
  // EXCEPT fresh-profile Cycle-1 onboarding on an INCONCLUSIVE baseline (too few trades to validate,
  // e.g. long_oi on the demo fixture), where the WFO sweep is the intended rescue to find params
  // that generate enough trades. Revision re-baselines (revisionId present) stay strict.
  const allowWfoOnInconclusiveForFreshProfile = !revisionId && baselineValidationStatus === 'inconclusive';
  if (baselineValidationStatus === 'passed' || allowWfoOnInconclusiveForFreshProfile) {
    // R13: log-only onboarding battery between the passing baseline and the WFO enqueue. Fail-soft
    // and never throws — the strategy.wfo enqueue below runs regardless of the battery's outcome.
    await runOnboardBattery(task, services, { profile, strategyBundle: bundle, experimentId, run });
    await createAndEnqueueTask(
      {
        taskType: 'strategy.wfo',
        source: task.source,
        payload: { baselineExperimentId: experimentId },
        correlationId: task.correlationId,
        dedupeKey: `strategy.wfo:${experimentId}`,
      },
      { repo: services.researchTasks, queue: services.taskQueue },
    );
  } else {
    await services.events.append(event(task.id, 'strategy.baseline.wfo_skipped', {
      strategyProfileId, experimentId, verdict, reason: 'baseline_not_passed',
    }));
  }

  await services.events.append(event(task.id, 'strategy.baseline.completed', {
    strategyProfileId, experimentId, verdict, bundleHash: bundle.bundleHash,
  }));
};
