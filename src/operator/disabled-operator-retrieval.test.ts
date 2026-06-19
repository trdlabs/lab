import { describe, it, expect } from 'vitest';
import { DisabledOperatorRetrieval } from './disabled-operator-retrieval.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import type { EmbeddingPort } from '../ports/embedding.port.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { StrategySimilarityPort } from '../ports/strategy-similarity.port.ts';
import type { InterpretedTurn } from '../chat/turn-interpretation.ts';

const strategyTurn: InterpretedTurn = {
  subject: 'strategy',
  goal: 'analyze',
  constraints: {},
  references: [],
  confidence: 0.9,
};

// Throwing fakes prove the disabled path performs NO I/O.
const throwingEmbedding: EmbeddingPort = {
  model: 'throwing',
  dimensions: 3,
  embed() {
    throw new Error('embedding must not be called when retrieval is disabled');
  },
};

const throwingProfiles: StrategyProfileRepository = {
  create() {
    throw new Error('repository must not be called when retrieval is disabled');
  },
  findById() {
    throw new Error('repository must not be called when retrieval is disabled');
  },
  findByFingerprint() {
    throw new Error('repository must not be called when retrieval is disabled');
  },
  listAll() {
    throw new Error('repository must not be called when retrieval is disabled');
  },
};

const throwingSimilarity: StrategySimilarityPort = {
  search() {
    throw new Error('similarity must not be called when retrieval is disabled');
  },
};

describe('DisabledOperatorRetrieval', () => {
  it('returns disabled evidence without calling any dependency', async () => {
    const retrieval = new DisabledOperatorRetrieval({
      embedding: throwingEmbedding,
      strategyProfiles: throwingProfiles,
      similarity: throwingSimilarity,
    });

    const evidence = await retrieval.collect({
      turn: strategyTurn,
      message: 'buy capitulation wicks on high OI',
      sessionId: 's1',
      retrievalId: 'r1',
    });

    expect(evidence.status).toBe('disabled');
    expect(evidence.exactLookup).toBe('not_run');
    expect(evidence.exactMatch).toBeUndefined();
    expect(evidence.similarStrategies).toEqual([]);
    expect(evidence.evidenceRefs).toEqual([]);
    expect(evidence.warningCodes).toEqual([]);
  });

  it('produces a deterministic subjectHash from the trimmed message', async () => {
    const retrieval = new DisabledOperatorRetrieval({
      embedding: throwingEmbedding,
      strategyProfiles: throwingProfiles,
      similarity: throwingSimilarity,
    });

    const message = '  buy capitulation wicks on high OI  ';
    const evidence = await retrieval.collect({
      turn: strategyTurn,
      message,
      sessionId: 's1',
      retrievalId: 'r1',
    });

    expect(evidence.subjectHash).toBe(
      sourceFingerprint('manual_description', message.trim()),
    );
  });

  it('can be constructed with no dependencies at all', async () => {
    const retrieval = new DisabledOperatorRetrieval();
    const evidence = await retrieval.collect({
      turn: strategyTurn,
      message: 'anything',
      sessionId: 's1',
      retrievalId: 'r1',
    });
    expect(evidence.status).toBe('disabled');
  });
});
