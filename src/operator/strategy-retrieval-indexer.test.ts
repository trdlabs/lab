import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrategyRetrievalIndexer } from './strategy-retrieval-indexer.ts';
import type { EmbeddingPort } from '../ports/embedding.port.ts';
import type { StrategyRetrievalIndexPort } from '../ports/strategy-retrieval-index.port.ts';
import type { AgentEventRepository, AgentEvent } from '../ports/agent-event.repository.ts';
import type { StrategyProfile, AnalystProfileOutput } from '../domain/strategy-profile.ts';
import type { StrategyRetrievalDocument } from '../domain/strategy-retrieval.ts';
import type { ArtifactRef } from '../domain/types.ts';

// ---- test doubles ----

function makeEmbeddingPort(overrides: Partial<EmbeddingPort> = {}): EmbeddingPort {
  return {
    model: 'test-model',
    dimensions: 3,
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    ...overrides,
  };
}

function makeIndexPort(existing: StrategyRetrievalDocument | null = null): StrategyRetrievalIndexPort & { upserted: StrategyRetrievalDocument[] } {
  const upserted: StrategyRetrievalDocument[] = [];
  return {
    upserted,
    findByProfileId: vi.fn().mockResolvedValue(existing),
    upsert: vi.fn().mockImplementation(async (doc: StrategyRetrievalDocument) => { upserted.push(doc); }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEventRepo(): AgentEventRepository & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    append: vi.fn().mockImplementation(async (ev: AgentEvent) => { events.push(ev); }),
    listByTask: vi.fn().mockResolvedValue([]),
  };
}

// ---- fixtures ----

const ref: ArtifactRef = {
  artifact_id: 'sha256:aa', uri: 'memory://aa', content_hash: 'sha256:aa', kind: 'strategy_source',
  size_bytes: 1, mime_type: 'text/plain', created_at: '2026-06-11T00:00:00Z', producer: 'test', metadata: {},
};

const sampleAnalystOutput: AnalystProfileOutput = {
  direction: 'long',
  coreIdea: 'Buy on OI spike',
  summary: 'Momentum strategy',
  requiredMarketFeatures: ['oi'],
  entryConditions: ['OI +5%'],
  exitConditions: ['TP 2R'],
  timeframes: ['1h'],
  indicators: [],
  parameters: [],
  watchLifecycleSummary: null,
  positionManagementSummary: null,
  riskManagementSummary: null,
  runnerOwnedAuthorities: [],
  confidence: 0.7,
  unknowns: [],
  evidence: [],
};

const makeProfile = (over: Partial<StrategyProfile> = {}): StrategyProfile => ({
  id: 'p1',
  version: 1,
  sourceKind: 'article',
  sourceFingerprint: 'sha256:fp1',
  direction: 'long',
  coreIdea: 'Buy on OI spike',
  requiredMarketFeatures: ['oi'],
  confidence: 0.7,
  unknowns: [],
  profile: sampleAnalystOutput,
  sourceArtifactRef: ref,
  contractVersion: 'strategy-profile-v1',
  createdAt: '2026-06-11T00:00:00Z',
  updatedAt: '2026-06-11T00:00:00Z',
  ...over,
});

const CONFIG = { embeddingModel: 'test-model', indexVersion: 1 };
const CLOCK = () => '2026-06-11T00:00:00Z';

// ---- tests ----

describe('StrategyRetrievalIndexer.index', () => {
  it('embeds text, upserts document, emits retrieval.strategy_indexed event', async () => {
    const embedding = makeEmbeddingPort();
    const indexPort = makeIndexPort();
    const events = makeEventRepo();
    const indexer = new StrategyRetrievalIndexer(embedding, indexPort, CONFIG, CLOCK, events);

    await indexer.index(makeProfile());

    expect(embedding.embed).toHaveBeenCalledOnce();
    expect(indexPort.upsert).toHaveBeenCalledOnce();
    expect(events.events).toHaveLength(1);
    const ev = events.events[0]!;
    expect(ev.type).toBe('retrieval.strategy_indexed');
    // event must NOT carry embedding or raw content
    expect(JSON.stringify(ev.payload)).not.toContain('0.1');
    expect(JSON.stringify(ev.payload)).not.toContain('Buy on OI spike');
    // event MUST carry ids/hash/model/version
    expect(ev.payload.profileId).toBe('p1');
    expect(ev.payload.embeddingModel).toBe('test-model');
    expect(ev.payload.indexVersion).toBe(1);
    expect(typeof ev.payload.contentHash).toBe('string');
  });

  it('validates embedding dimensions: rejects if wrong dim count', async () => {
    const embedding = makeEmbeddingPort({
      dimensions: 3,
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]), // only 2 dims instead of 3
    });
    const indexPort = makeIndexPort();
    const events = makeEventRepo();
    const indexer = new StrategyRetrievalIndexer(embedding, indexPort, CONFIG, CLOCK, events);

    // fail-soft: should NOT throw
    await expect(indexer.index(makeProfile())).resolves.toBeUndefined();
    expect(indexPort.upsert).not.toHaveBeenCalled();
    expect(events.events).toHaveLength(1);
    expect(events.events[0]!.type).toBe('retrieval.strategy_index_failed');
    expect(events.events[0]!.payload.reasonCode).toBe('dimension_mismatch');
    expect(events.events[0]!.payload.profileId).toBe('p1');
  });

  it('embedding failure emits retrieval.strategy_index_failed without throwing', async () => {
    const embedding = makeEmbeddingPort({
      embed: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const indexPort = makeIndexPort();
    const events = makeEventRepo();
    const indexer = new StrategyRetrievalIndexer(embedding, indexPort, CONFIG, CLOCK, events);

    // fail-soft: must NOT throw
    await expect(indexer.index(makeProfile())).resolves.toBeUndefined();
    expect(indexPort.upsert).not.toHaveBeenCalled();
    expect(events.events).toHaveLength(1);
    expect(events.events[0]!.type).toBe('retrieval.strategy_index_failed');
    expect(events.events[0]!.payload.reasonCode).toBe('embed_failed');
  });

  it('upsert failure emits retrieval.strategy_index_failed without throwing', async () => {
    const embedding = makeEmbeddingPort();
    const indexPort = makeIndexPort();
    (indexPort.upsert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const events = makeEventRepo();
    const indexer = new StrategyRetrievalIndexer(embedding, indexPort, CONFIG, CLOCK, events);

    await expect(indexer.index(makeProfile())).resolves.toBeUndefined();
    expect(events.events).toHaveLength(1);
    expect(events.events[0]!.type).toBe('retrieval.strategy_index_failed');
    expect(events.events[0]!.payload.reasonCode).toBe('upsert_failed');
  });
});

describe('StrategyRetrievalIndexer.reindex', () => {
  it('skips profiles whose contentHash and model/version are current', async () => {
    const profile = makeProfile();
    // Pre-build the expected doc to get the real contentHash
    const { buildStrategyRetrievalText } = await import('./strategy-retrieval-document.ts');
    const { createHash } = await import('node:crypto');
    const text = buildStrategyRetrievalText(profile);
    const hash = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

    const existingDoc: StrategyRetrievalDocument = {
      strategyProfileId: 'p1',
      content: text,
      contentHash: hash,
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: 'test-model', // matches config
      indexVersion: 1,              // matches config
      metadata: {},
      indexedAt: '2026-06-11T00:00:00Z',
    };

    const embedding = makeEmbeddingPort();
    const indexPort = makeIndexPort(existingDoc);
    const events = makeEventRepo();
    const indexer = new StrategyRetrievalIndexer(embedding, indexPort, CONFIG, CLOCK, events);

    const summary = await indexer.reindex([profile]);
    expect(summary.skipped).toBe(1);
    expect(summary.indexed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('reindexes profiles with stale contentHash', async () => {
    const profile = makeProfile();
    const staleDoc: StrategyRetrievalDocument = {
      strategyProfileId: 'p1',
      content: 'old text',
      contentHash: 'sha256:stale',
      embedding: [0.9, 0.9, 0.9],
      embeddingModel: 'test-model',
      indexVersion: 1,
      metadata: {},
      indexedAt: '2026-06-10T00:00:00Z',
    };

    const embedding = makeEmbeddingPort();
    const indexPort = makeIndexPort(staleDoc);
    const events = makeEventRepo();
    const indexer = new StrategyRetrievalIndexer(embedding, indexPort, CONFIG, CLOCK, events);

    const summary = await indexer.reindex([profile]);
    expect(summary.indexed).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(indexPort.upsert).toHaveBeenCalledOnce();
  });

  it('reindexes profiles with stale embeddingModel', async () => {
    const profile = makeProfile();
    const { buildStrategyRetrievalText } = await import('./strategy-retrieval-document.ts');
    const { createHash } = await import('node:crypto');
    const text = buildStrategyRetrievalText(profile);
    const hash = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

    const staleDoc: StrategyRetrievalDocument = {
      strategyProfileId: 'p1',
      content: text,
      contentHash: hash,
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: 'old-model', // stale model
      indexVersion: 1,
      metadata: {},
      indexedAt: '2026-06-10T00:00:00Z',
    };

    const embedding = makeEmbeddingPort();
    const indexPort = makeIndexPort(staleDoc);
    const events = makeEventRepo();
    const indexer = new StrategyRetrievalIndexer(embedding, indexPort, CONFIG, CLOCK, events);

    const summary = await indexer.reindex([profile]);
    expect(summary.indexed).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('counts failures in summary and does not throw', async () => {
    const embedding = makeEmbeddingPort({
      embed: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const indexPort = makeIndexPort();
    const events = makeEventRepo();
    const indexer = new StrategyRetrievalIndexer(embedding, indexPort, CONFIG, CLOCK, events);

    const summary = await indexer.reindex([makeProfile(), makeProfile({ id: 'p2', sourceFingerprint: 'sha256:fp2' })]);
    expect(summary.failed).toBe(2);
    expect(summary.indexed).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it('returns correct summary for mixed results', async () => {
    // p1: no existing doc → will embed+upsert
    // p2: current doc → skip
    // p3: embedding will fail → fail
    const profile1 = makeProfile({ id: 'p1', sourceFingerprint: 'sha256:fp1' });
    const profile2 = makeProfile({ id: 'p2', sourceFingerprint: 'sha256:fp2' });
    const profile3 = makeProfile({ id: 'p3', sourceFingerprint: 'sha256:fp3' });

    const { buildStrategyRetrievalText } = await import('./strategy-retrieval-document.ts');
    const { createHash } = await import('node:crypto');
    const text2 = buildStrategyRetrievalText(profile2);
    const hash2 = `sha256:${createHash('sha256').update(text2, 'utf8').digest('hex')}`;

    const currentDoc: StrategyRetrievalDocument = {
      strategyProfileId: 'p2',
      content: text2,
      contentHash: hash2,
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: 'test-model',
      indexVersion: 1,
      metadata: {},
      indexedAt: '2026-06-11T00:00:00Z',
    };

    let callCount = 0;
    const embedding = makeEmbeddingPort({
      embed: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return [[0.1, 0.2, 0.3]]; // p1 succeeds
        throw new Error('p3 fails');
      }),
    });

    const indexPort: StrategyRetrievalIndexPort & { upserted: StrategyRetrievalDocument[] } = {
      upserted: [],
      findByProfileId: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'p2') return currentDoc;
        return null;
      }),
      upsert: vi.fn().mockImplementation(async (doc: StrategyRetrievalDocument) => {
        (indexPort as { upserted: StrategyRetrievalDocument[] }).upserted.push(doc);
      }),
      delete: vi.fn(),
    };

    const events = makeEventRepo();
    const indexer = new StrategyRetrievalIndexer(embedding, indexPort, CONFIG, CLOCK, events);
    const summary = await indexer.reindex([profile1, profile2, profile3]);

    expect(summary.indexed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(1);
  });
});
