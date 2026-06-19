import { describe, it, expect } from 'vitest';
import { strategyOnboardHandler } from './strategy-onboard.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { sourceFingerprint } from '../../domain/fingerprint.ts';
import { FakeStrategyAnalyst } from '../../adapters/analyst/fake-strategy-analyst.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { StrategyRetrievalIndexerPort } from '../app-services.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchTask } from '../../domain/types.ts';

const task = (payload: Record<string, unknown>): ResearchTask => ({
  id: 'task-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'running', payload, createdAt: '2026-06-11T00:00:00Z', updatedAt: '2026-06-11T00:00:00Z',
});
const validPayload = { kind: 'article', content: 'buy dips on capitulation', title: 'Dip buyer' };

describe('strategyOnboardHandler', () => {
  it('analyzes, persists a profile, and records started+completed audit events', async () => {
    const services = makeServices();
    await strategyOnboardHandler(task(validPayload), services);
    const fp = sourceFingerprint('article', validPayload.content);
    const profile = await services.strategyProfiles.findByFingerprint(fp);
    expect(profile).not.toBeNull();
    expect(profile?.contractVersion).toBe('strategy-profile-v1');
    expect(profile?.sourceArtifactRef.content_hash).toMatch(/^sha256:/);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toEqual(['strategy_analyst.started', 'strategy_analyst.completed']);
  });

  it('is idempotent: a duplicate source is deduped without calling the LLM', async () => {
    let calls = 0;
    const spy: StrategyAnalystPort = {
      adapter: 'fake', model: 'fake',
      analyze: async (input) => { calls += 1; return new FakeStrategyAnalyst().analyze(input); },
    };
    const services = makeServices({ analyst: spy });
    await strategyOnboardHandler(task(validPayload), services);
    expect(calls).toBe(1);
    await strategyOnboardHandler(task(validPayload), services);
    expect(calls).toBe(1);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toContain('strategy.onboard.deduped');
  });

  it('throws on an invalid payload', async () => {
    const services = makeServices();
    await expect(strategyOnboardHandler(task({ kind: 'tweet' }), services)).rejects.toThrow(/invalid strategy.onboard payload/);
  });

  it('invokes the retrieval indexer with the persisted profile after onboarding', async () => {
    const indexed: StrategyProfile[] = [];
    const indexer: StrategyRetrievalIndexerPort = { index: async (p) => { indexed.push(p); } };
    const services = makeServices({ strategyRetrievalIndexer: indexer });
    await strategyOnboardHandler(task(validPayload), services);
    const fp = sourceFingerprint('article', validPayload.content);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.sourceFingerprint).toBe(fp);
  });

  it('completes onboarding even if the indexer is fail-soft (never throws)', async () => {
    // The real indexer never throws; this asserts the handler does not depend on its outcome.
    const indexer: StrategyRetrievalIndexerPort = { index: async () => { /* swallow, fail-soft */ } };
    const services = makeServices({ strategyRetrievalIndexer: indexer });
    await expect(strategyOnboardHandler(task(validPayload), services)).resolves.toBeUndefined();
    const fp = sourceFingerprint('article', validPayload.content);
    expect(await services.strategyProfiles.findByFingerprint(fp)).not.toBeNull();
  });

  it('records a failed audit event and rethrows when the analyst throws', async () => {
    const analyst: StrategyAnalystPort = {
      adapter: 'fake', model: 'fake',
      analyze: async () => { throw new Error('llm exploded'); },
    };
    const services = makeServices({ analyst });
    await expect(strategyOnboardHandler(task(validPayload), services)).rejects.toThrow('llm exploded');
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toEqual(['strategy_analyst.started', 'strategy_analyst.failed']);
  });
});
