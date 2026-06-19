import { describe, it, expect, vi } from 'vitest';
import { buildOperatorRag } from './composition.ts';
import { loadEnv } from './config/env.ts';
import { DisabledOperatorRetrieval } from './operator/disabled-operator-retrieval.ts';
import { NoopStrategyRetrievalIndexer } from './operator/noop-strategy-retrieval-indexer.ts';
import { OperatorRetrieval } from './operator/operator-retrieval.ts';
import { StrategyRetrievalIndexer } from './operator/strategy-retrieval-indexer.ts';
import { InMemoryStrategyProfileRepository } from './adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryAgentEventRepository } from './adapters/repository/in-memory-agent-event.repository.ts';
import type { Db } from './db/client.ts';

// The disabled path must touch neither the db nor an embedding provider, so a poisoned db
// proxy (any access throws) proves no DB handle is read when OPERATOR_RAG_ENABLED=false.
const poisonedDb = new Proxy({}, {
  get() { throw new Error('db must not be accessed when OPERATOR_RAG_ENABLED=false'); },
}) as unknown as Db;

describe('buildOperatorRag — gating on OPERATOR_RAG_ENABLED', () => {
  it('disabled (default): injects DisabledOperatorRetrieval + no-op indexer, touches no db/embedding', () => {
    const env = loadEnv({ OPERATOR_RAG_ENABLED: 'false' });
    const profiles = new InMemoryStrategyProfileRepository();
    const events = new InMemoryAgentEventRepository();

    const rag = buildOperatorRag(env, poisonedDb, profiles, events);

    expect(rag.retrieval).toBeInstanceOf(DisabledOperatorRetrieval);
    expect(rag.indexer).toBeInstanceOf(NoopStrategyRetrievalIndexer);
    // The real (embedding-backed) implementations were NOT constructed.
    expect(rag.retrieval).not.toBeInstanceOf(OperatorRetrieval);
    expect(rag.indexer).not.toBeInstanceOf(StrategyRetrievalIndexer);
  });

  it('disabled path performs zero embedding calls when collect()/index() run', async () => {
    const env = loadEnv({ OPERATOR_RAG_ENABLED: 'false' });
    const profiles = new InMemoryStrategyProfileRepository();
    const events = new InMemoryAgentEventRepository();
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const rag = buildOperatorRag(env, poisonedDb, profiles, events);
      const evidence = await rag.retrieval.collect({
        turn: { subject: 'strategy', constraints: {}, references: [], confidence: 0.9 },
        message: 'лонг при росте OI', sessionId: 's1', retrievalId: 'r1',
      });
      expect(evidence.status).toBe('disabled');
      await rag.indexer.index({
        id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:x',
        direction: 'long', coreIdea: 'idea', requiredMarketFeatures: [], confidence: 0.5, unknowns: [],
        profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      });
      // No HTTP egress at all — the embedding provider was never reached.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('enabled but missing OPENROUTER_API_KEY -> throws (does not silently downgrade)', () => {
    const env = loadEnv({ OPERATOR_RAG_ENABLED: 'true', OPENROUTER_API_KEY: '' });
    const profiles = new InMemoryStrategyProfileRepository();
    const events = new InMemoryAgentEventRepository();
    expect(() => buildOperatorRag(env, poisonedDb, profiles, events)).toThrow(/OPENROUTER_API_KEY is required/);
  });
});
