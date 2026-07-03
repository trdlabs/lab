// src/orchestrator/handlers/strategy-wfo.handler.ts
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import { reconstructStrategyBundle } from '../../research/reconstruct-strategy-bundle.ts';
import { makeOnUsage } from '../make-on-usage.ts';
import { createAndEnqueueTask } from '../task-intake.ts';
import { event } from './backtest-support.ts';

export const StrategyWfoPayloadSchema = z.object({ baselineExperimentId: z.string().min(1) });

export const strategyWfoHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(StrategyWfoPayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid strategy.wfo payload: ${JSON.stringify(parsed.issues)}`);
  const { baselineExperimentId } = parsed.data;

  const baseline = await services.experiments.findById(baselineExperimentId);
  if (!baseline) throw new Error(`research_experiment ${baselineExperimentId} not found`);
  if (!baseline.bundleArtifactRef) {
    throw new Error(
      `baseline experiment ${baselineExperimentId} has no bundleArtifactRef — re-run the baseline `
      + '(strategy.baseline) to persist the bundle; WFO never rebuilds via the LLM builder.',
    );
  }
  const profile = await services.strategyProfiles.findById(baseline.strategyProfileId);
  if (!profile) throw new Error(`strategy_profile ${baseline.strategyProfileId} not found`);

  await services.events.append(event(task.id, 'strategy.wfo.started', { baselineExperimentId }));

  const strategyBundle = await reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef);
  const scope = baseline.datasetScope;
  const { experimentId, verdict, terminalReason } = await services.experimentService.runWalkForwardOptimization({
    baselineExperimentId,
    strategyBundle,
    profile,
    strategyProfileId: baseline.strategyProfileId,
    datasetScope: scope,
    runConfig: { datasetId: scope.datasetId, symbols: scope.symbols, timeframe: scope.timeframe, seed: services.defaultPlatformRun.seed },
    metrics: RESEARCH_RUN_METRICS,
    taskId: task.id,
    correlationId: task.correlationId,
    agentOpts: makeOnUsage(task, services),
  });

  await services.events.append(event(task.id, 'strategy.wfo.completed', {
    baselineExperimentId, experimentId, verdict, terminalReason,
  }));

  if (verdict === 'PAPER_CANDIDATE') {
    await createAndEnqueueTask(
      {
        taskType: 'paper.start',
        source: task.source,
        payload: { experimentId, baselineExperimentId },
        correlationId: task.correlationId,
        dedupeKey: `paper.start:${experimentId}`,
      },
      { repo: services.researchTasks, queue: services.taskQueue },
    );
  }
};
