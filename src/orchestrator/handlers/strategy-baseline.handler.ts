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
  // When set, the baseline outcome is written back onto this consolidated revision.
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

  if (parsed.data.consolidatedRevisionId) {
    // Verdict -> baselineValidationStatus: PASS and PAPER_CANDIDATE are both positive outcomes
    // that map to 'passed'; INCONCLUSIVE stays inconclusive; everything else (FAIL / MODIFY)
    // is not a clean baseline pass for the consolidated revision, so it lands in 'failed'.
    const baselineValidationStatus =
      verdict === 'PASS' || verdict === 'PAPER_CANDIDATE' ? 'passed'
      : verdict === 'INCONCLUSIVE' ? 'inconclusive'
      : 'failed';
    await services.revisions.updateStatus(parsed.data.consolidatedRevisionId, {
      baselineValidationStatus,
      baselineExperimentId: experimentId,
      baselineTaskId: task.id,
      updatedAt: new Date().toISOString(),
    });
  }

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

  await services.events.append(event(task.id, 'strategy.baseline.completed', {
    strategyProfileId, experimentId, verdict, bundleHash: bundle.bundleHash,
  }));
};
