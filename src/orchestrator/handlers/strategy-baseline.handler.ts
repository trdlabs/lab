// src/orchestrator/handlers/strategy-baseline.handler.ts
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';
import { reconstructStrategyBundle } from '../../research/reconstruct-strategy-bundle.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import { getAuthoringDoc } from '@trading-backtester/sdk/builder';
import { createAndEnqueueTask } from '../task-intake.ts';
import { event } from './backtest-support.ts';
import type { ArtifactRef } from '../../domain/types.ts';

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
