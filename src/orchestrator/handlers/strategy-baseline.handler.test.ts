// src/orchestrator/handlers/strategy-baseline.handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { strategyBaselineHandler } from './strategy-baseline.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { FakeStrategyBuilder } from '../../adapters/builder/fake-strategy-builder.ts';
import { assembleStrategyBundle } from '../../domain/strategy-bundle.ts';
import { InMemoryStrategyRevisionRepository } from '../../adapters/repository/in-memory-strategy-revision.repository.ts';
import { getAuthoringDoc } from '@trdlabs/backtester-sdk/builder';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';
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

async function makeFakeServices(opts: {
  baselineThrows?: boolean;
  strategyBuilder?: AppServices['strategyBuilder'];
  revisions?: AppServices['revisions'];
  verdict?: 'PASS' | 'FAIL' | 'MODIFY' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';
} = {}): Promise<{
  services: AppServices;
  queued: AppServices['taskQueue'] extends { queued: infer Q } ? Q : never;
  puts: { content: string; meta: { kind: string; mime_type: string; producer: string } }[];
  experimentCalls: (RunStrategyBaselineValidationInput & { returnedExperimentId?: string })[];
}> {
  const puts: { content: string; meta: { kind: string; mime_type: string; producer: string } }[] = [];
  const services = makeServices({
    ...(opts.strategyBuilder ? { strategyBuilder: opts.strategyBuilder } : {}),
    ...(opts.revisions ? { revisions: opts.revisions } : {}),
  });
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
    return { experimentId: returnedExperimentId, verdict: opts.verdict ?? ('PAPER_CANDIDATE' as const) };
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

  it('ready-bundle mode reconstructs the given bundle and skips the builder', async () => {
    // Build a realistic AssembledStrategyBundle via the same builder+assemble path the handler's
    // build-mode uses, so `persistedBundleJson` round-trips through reconstructStrategyBundle
    // (which re-assembles and hash-compares) without drift.
    const out = await new FakeStrategyBuilder().build({
      spec: { description: 'consolidated clean source' },
      authoringDoc: getAuthoringDoc('strategy'),
      profile: profile(),
    });
    const built = await assembleStrategyBundle(out);
    const persistedBundleJson = { source: built.source, manifest: built.manifest, bundleHash: built.bundleHash };

    const throwingBuilder: AppServices['strategyBuilder'] = {
      adapter: 'throws',
      model: 'throws',
      build: vi.fn(async () => {
        throw new Error('strategyBuilder.build must not be called in ready-bundle mode');
      }),
    };

    const { services, experimentCalls } = await makeFakeServices({ strategyBuilder: throwingBuilder });
    const ref = await services.artifacts.put(JSON.stringify(persistedBundleJson), {
      kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test',
    });

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1', bundleArtifactRef: ref }), services);

    expect(throwingBuilder.build).not.toHaveBeenCalled();
    expect(experimentCalls[0]?.bundleArtifactRef).toEqual(ref);
    expect(experimentCalls[0]?.strategyBundle.bundleHash).toBe(built.bundleHash);
  });

  it('patches consolidated revision baseline status on completion', async () => {
    const now = '2026-01-01T00:00:00Z';
    const revisions = new InMemoryStrategyRevisionRepository();
    const consolidatedRevision: StrategyRevision = {
      id: 'C', strategyProfileId: 'prof-1', version: 1, hypothesisIds: [], mergedRuleSet: {},
      status: 'accepted', kind: 'consolidated', baselineValidationStatus: 'pending',
      createdAt: now, updatedAt: now,
    };
    await revisions.create(consolidatedRevision);

    const { services } = await makeFakeServices({ revisions, verdict: 'PASS' });

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1', consolidatedRevisionId: 'C' }), services);

    const patched = await revisions.findById('C');
    expect(patched?.baselineValidationStatus).toBe('passed');
    expect(patched?.baselineExperimentId).toBe('exp-1');
    expect(patched?.baselineTaskId).toBe('t1');
  });

  it('maps PAPER_CANDIDATE verdict to passed status', async () => {
    const now = '2026-01-01T00:00:00Z';
    const revisions = new InMemoryStrategyRevisionRepository();
    const consolidatedRevision: StrategyRevision = {
      id: 'C', strategyProfileId: 'prof-1', version: 1, hypothesisIds: [], mergedRuleSet: {},
      status: 'accepted', kind: 'consolidated', baselineValidationStatus: 'pending',
      createdAt: now, updatedAt: now,
    };
    await revisions.create(consolidatedRevision);

    const { services } = await makeFakeServices({ revisions, verdict: 'PAPER_CANDIDATE' });

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1', consolidatedRevisionId: 'C' }), services);

    const patched = await revisions.findById('C');
    expect(patched?.baselineValidationStatus).toBe('passed');
    expect(patched?.baselineExperimentId).toBe('exp-1');
    expect(patched?.baselineTaskId).toBe('t1');
  });

  it('does NOT enqueue strategy.wfo on a FAIL baseline; emits wfo_skipped + writes failed status', async () => {
    const now = '2026-01-01T00:00:00Z';
    const revisions = new InMemoryStrategyRevisionRepository();
    await revisions.create({
      id: 'R', strategyProfileId: 'prof-1', version: 2, hypothesisIds: [], mergedRuleSet: {},
      status: 'accepted', kind: 'composed', baselineValidationStatus: 'pending', createdAt: now, updatedAt: now,
    } as StrategyRevision);
    const { services, queued } = await makeFakeServices({ revisions, verdict: 'FAIL' });
    const appendSpy = vi.spyOn(services.events, 'append');

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1', revisionId: 'R' }), services);

    expect((queued as unknown[]).filter((t) => (t as { taskType: string }).taskType === 'strategy.wfo')).toHaveLength(0);
    expect(appendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'strategy.baseline.wfo_skipped' }));
    expect((await revisions.findById('R'))?.baselineValidationStatus).toBe('failed');
  });

  it('does NOT enqueue strategy.wfo on an INCONCLUSIVE baseline; writes inconclusive status', async () => {
    const now = '2026-01-01T00:00:00Z';
    const revisions = new InMemoryStrategyRevisionRepository();
    await revisions.create({
      id: 'R', strategyProfileId: 'prof-1', version: 2, hypothesisIds: [], mergedRuleSet: {},
      status: 'accepted', kind: 'composed', baselineValidationStatus: 'pending', createdAt: now, updatedAt: now,
    } as StrategyRevision);
    const { services, queued } = await makeFakeServices({ revisions, verdict: 'INCONCLUSIVE' });

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1', revisionId: 'R' }), services);

    expect((queued as unknown[]).filter((t) => (t as { taskType: string }).taskType === 'strategy.wfo')).toHaveLength(0);
    expect((await revisions.findById('R'))?.baselineValidationStatus).toBe('inconclusive');
  });

  it('writes back via the new revisionId field and enqueues wfo on PASS', async () => {
    const now = '2026-01-01T00:00:00Z';
    const revisions = new InMemoryStrategyRevisionRepository();
    await revisions.create({
      id: 'R', strategyProfileId: 'prof-1', version: 2, hypothesisIds: [], mergedRuleSet: {},
      status: 'accepted', kind: 'composed', baselineValidationStatus: 'pending', createdAt: now, updatedAt: now,
    } as StrategyRevision);
    const { services, queued } = await makeFakeServices({ revisions, verdict: 'PASS' });

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1', revisionId: 'R' }), services);

    expect((await revisions.findById('R'))?.baselineValidationStatus).toBe('passed');
    expect((queued as unknown[]).filter((t) => (t as { taskType: string }).taskType === 'strategy.wfo')).toHaveLength(1);
  });

  it('fresh-profile FAIL baseline (no revisionId) also skips wfo (uniform W4 scope)', async () => {
    const { services, queued } = await makeFakeServices({ verdict: 'FAIL' });
    const appendSpy = vi.spyOn(services.events, 'append');

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1' }), services);

    expect((queued as unknown[]).filter((t) => (t as { taskType: string }).taskType === 'strategy.wfo')).toHaveLength(0);
    expect(appendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'strategy.baseline.wfo_skipped' }));
  });

  it('fresh-profile INCONCLUSIVE baseline (no revisionId) still enqueues wfo (rescue hatch)', async () => {
    const { services, queued } = await makeFakeServices({ verdict: 'INCONCLUSIVE' });
    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1' }), services);
    expect((queued as unknown[]).filter((t) => (t as { taskType: string }).taskType === 'strategy.wfo')).toHaveLength(1);
  });
});
