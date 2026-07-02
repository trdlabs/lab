// src/orchestrator/handlers/strategy-baseline.handler.ts
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { assembleStrategyBundle } from '../../domain/strategy-bundle.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import { getAuthoringDoc } from '@trading-backtester/sdk/builder';
import { createAndEnqueueTask } from '../task-intake.ts';
import { event } from './backtest-support.ts';

export const StrategyBaselinePayloadSchema = z.object({
  strategyProfileId: z.string().min(1),
  sourceTaskId: z.string().optional(),
});

export const strategyBaselineHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(StrategyBaselinePayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid strategy.baseline payload: ${JSON.stringify(parsed.issues)}`);
  const { strategyProfileId } = parsed.data;

  const profile = await services.strategyProfiles.findById(strategyProfileId);
  if (!profile) throw new Error(`strategy_profile ${strategyProfileId} not found`);

  await services.events.append(event(task.id, 'strategy.baseline.started', { strategyProfileId }));

  const out = await services.strategyBuilder.build({
    spec: { description: `baseline validation for profile ${profile.id}` },
    authoringDoc: getAuthoringDoc('strategy'),
    profile,
  });
  const bundle = await assembleStrategyBundle(out);
  const bundleArtifactRef = await services.artifacts.put(
    JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'strategy-baseline-handler' },
  );

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
