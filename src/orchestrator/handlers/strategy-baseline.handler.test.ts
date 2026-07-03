// src/orchestrator/handlers/strategy-baseline.handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { strategyBaselineHandler } from './strategy-baseline.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { RunStrategyBaselineValidationInput } from '../../research/experiment-service.ts';

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'prof-1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:s', direction: 'long',
    coreIdea: 'oi-based entry filter', requiredMarketFeatures: ['oi', 'funding'], confidence: 0.6, unknowns: [],
    profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1', createdAt: now, updatedAt: now,
  };
}

function taskOf(payload: Record<string, unknown>): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  return { id: 't1', taskType: 'strategy.baseline', source: 'operator', correlationId: 'c1', status: 'running', payload, createdAt: now, updatedAt: now };
}

async function makeFakeServices(opts: { baselineThrows?: boolean } = {}): Promise<{
  services: AppServices;
  queued: AppServices['taskQueue'] extends { queued: infer Q } ? Q : never;
  puts: { content: string; meta: { kind: string; mime_type: string; producer: string } }[];
  experimentCalls: (RunStrategyBaselineValidationInput & { returnedExperimentId?: string })[];
}> {
  const puts: { content: string; meta: { kind: string; mime_type: string; producer: string } }[] = [];
  const services = makeServices();
  const originalPut = services.artifacts.put.bind(services.artifacts);
  services.artifacts.put = async (content, meta) => {
    puts.push({ content: content.toString(), meta });
    return originalPut(content, meta);
  };

  await services.strategyProfiles.create(profile());

  const experimentCalls: (RunStrategyBaselineValidationInput & { returnedExperimentId?: string })[] = [];
  let counter = 0;
  vi.spyOn(services.experimentService, 'runStrategyBaselineValidation').mockImplementation(async (input) => {
    if (opts.baselineThrows) throw new Error('baseline lane boom');
    const returnedExperimentId = `exp-${++counter}`;
    experimentCalls.push({ ...input, returnedExperimentId });
    return { experimentId: returnedExperimentId, verdict: 'PAPER_CANDIDATE' as const };
  });

  return {
    services,
    queued: (services.taskQueue as unknown as { queued: unknown[] }).queued as never,
    puts,
    experimentCalls,
  };
}

describe('strategyBaselineHandler', () => {
  it('builds, persists ref, runs baseline validation, enqueues strategy.wfo with the task correlationId', async () => {
    const { services, queued, puts, experimentCalls } = await makeFakeServices();
    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1' }), services);

    expect(experimentCalls[0]?.bundleArtifactRef).toBeDefined();
    expect(puts[0]?.meta.kind).toBe('strategy_bundle');
    expect(queued as unknown[]).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      taskType: 'strategy.wfo',
      correlationId: taskOf({}).correlationId,
      dedupeKey: expect.stringMatching(/^strategy\.wfo:/),
    });
  });

  it('does not enqueue strategy.wfo when the baseline lane throws', async () => {
    const { services, queued } = await makeFakeServices({ baselineThrows: true });
    await expect(strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1' }), services)).rejects.toThrow();
    expect(queued as unknown[]).toHaveLength(0);
  });

  it('rejects an invalid payload', async () => {
    const { services } = await makeFakeServices();
    await expect(strategyBaselineHandler(taskOf({}), services)).rejects.toThrow(/invalid strategy\.baseline payload/);
  });
});
