// src/orchestrator/handlers/strategy-wfo.handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { strategyWfoHandler } from './strategy-wfo.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchExperiment } from '../../domain/research-experiment.ts';
import type { RunWfoInput } from '../../research/experiment-service.ts';
import { FakeStrategyBuilder } from '../../adapters/builder/fake-strategy-builder.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';

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
  return { id: 't1', taskType: 'strategy.wfo', source: 'operator', correlationId: 'c1', status: 'running', payload, createdAt: now, updatedAt: now };
}

async function makeTestStrategyBundle(): Promise<AssembledStrategyBundle> {
  const builder = new FakeStrategyBuilder();
  const out = await builder.build({ spec: { description: 'test' }, authoringDoc: '' });
  return assembleStrategyBundle(out);
}

function datasetScope() {
  return {
    datasetId: 'ds-1', symbols: ['BTCUSDT'], timeframe: '1h',
    period: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
  };
}

async function makeFakeServices(opts: {
  baselineExperiment: 'withRef' | 'withoutRef';
}): Promise<{
  services: AppServices;
  wfoCalls: RunWfoInput[];
  persistedBundleHash: string;
}> {
  const services = makeServices();
  await services.strategyProfiles.create(profile());

  const bundle = await makeTestStrategyBundle();
  let bundleArtifactRef;
  if (opts.baselineExperiment === 'withRef') {
    bundleArtifactRef = await services.artifacts.put(
      JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
      { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
    );
  }

  const now = '2026-01-01T00:00:00Z';
  const baseline: ResearchExperiment = {
    id: 'exp-base', experimentKey: 'key-exp-base', experimentType: 'strategy_baseline_validation',
    strategyProfileId: 'prof-1', bundleHash: bundle.bundleHash,
    ...(bundleArtifactRef ? { bundleArtifactRef } : {}),
    datasetScope: datasetScope(),
    holdoutPolicy: { mode: 'none', minTradesTrain: 0, minTradesHoldout: 0, lowConfidenceThreshold: 0, minHistoryDays: 0 },
    status: 'completed', createdAt: now, updatedAt: now,
  };
  await services.experiments.createExperiment(baseline);

  const wfoCalls: RunWfoInput[] = [];
  vi.spyOn(services.experimentService, 'runWalkForwardOptimization').mockImplementation(async (input) => {
    wfoCalls.push(input);
    return { experimentId: 'exp-wfo-1', verdict: 'PAPER_CANDIDATE' as const, terminalReason: 'paper_candidate' };
  });

  return { services, wfoCalls, persistedBundleHash: bundle.bundleHash };
}

describe('strategyWfoHandler', () => {
  it('reconstructs the baseline bundle from bundleArtifactRef and runs WFO with task.correlationId', async () => {
    const { services, wfoCalls, persistedBundleHash } = await makeFakeServices({ baselineExperiment: 'withRef' });
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const originalAppend = services.events.append.bind(services.events);
    services.events.append = async (evt) => {
      events.push({ type: evt.type, payload: evt.payload });
      return originalAppend(evt);
    };

    await strategyWfoHandler(taskOf({ baselineExperimentId: 'exp-base' }), services);

    expect(wfoCalls[0]?.correlationId).toBe(taskOf({}).correlationId);
    expect(wfoCalls[0]?.strategyBundle.bundleHash).toBe(persistedBundleHash);
    expect(wfoCalls[0]?.agentOpts?.onUsage).toBeTypeOf('function');
    expect(wfoCalls[0]?.strategyProfileId).toBe('prof-1');
    expect(wfoCalls[0]?.baselineExperimentId).toBe('exp-base');
    expect(wfoCalls[0]?.taskId).toBe('t1');

    expect(events).toContainEqual({ type: 'strategy.wfo.started', payload: { baselineExperimentId: 'exp-base' } });
    expect(events).toContainEqual({
      type: 'strategy.wfo.completed',
      payload: { baselineExperimentId: 'exp-base', experimentId: 'exp-wfo-1', verdict: 'PAPER_CANDIDATE', terminalReason: 'paper_candidate' },
    });
  });

  it('fails with an actionable error when the baseline experiment has no bundleArtifactRef', async () => {
    const { services } = await makeFakeServices({ baselineExperiment: 'withoutRef' });
    await expect(strategyWfoHandler(taskOf({ baselineExperimentId: 'exp-base' }), services))
      .rejects.toThrow(/re-run baseline|bundleArtifactRef/i);
  });

  it('rejects an invalid payload', async () => {
    const { services } = await makeFakeServices({ baselineExperiment: 'withRef' });
    await expect(strategyWfoHandler(taskOf({}), services)).rejects.toThrow(/invalid strategy\.wfo payload/);
  });
});
