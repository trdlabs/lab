import { describe, it, expect } from 'vitest';
import { renderOperatorResponse } from './operator-response.ts';
import type { OperatorEvidence } from '../domain/strategy-retrieval.ts';
import type { InterpretedTurn } from '../chat/turn-interpretation.ts';

const baseTurn: InterpretedTurn = {
  subject: 'strategy',
  goal: 'analyze',
  constraints: { market: 'crypto', symbol: 'BTCUSDT', timeframe: '1m', direction: 'long' },
  references: [],
  confidence: 0.9,
};

const proposedAction = 'strategy.analyze' as const;

function candidate(over: Partial<Parameters<typeof Object>[0]> = {}): any {
  return {
    strategyProfileId: 'p-sim-1',
    lexicalRank: 1,
    lexicalScore: 0.8,
    vectorRank: 1,
    vectorDistance: 0.2,
    rrfScore: 0.5,
    metadata: {
      market: 'crypto',
      symbol: 'BTCUSDT',
      timeframe: '1m',
      direction: 'long',
      label: 'Long after flush',
      createdAt: '2026-06-15T00:00:00.000Z',
    },
    ...over,
  };
}

describe('renderOperatorResponse', () => {
  it('renders four blocks: interpretation, exact status, similar, next action', () => {
    const evidence: OperatorEvidence = {
      subjectHash: 'sha256:abc',
      status: 'complete',
      exactLookup: 'miss',
      similarStrategies: [candidate()],
      evidenceRefs: [
        { sourceType: 'retrieval_projection', sourceId: 'p-sim-1', retrievalMethod: 'rrf', observedAt: '2026-06-19T00:00:00.000Z' },
      ],
      warningCodes: [],
      timingsMs: { totalMs: 12 },
    };

    const text = renderOperatorResponse({ turn: baseTurn, evidence, proposedAction });

    // Four labelled blocks present.
    expect(text).toContain('Как я понял запрос');
    expect(text).toContain('Точное совпадение');
    expect(text).toContain('Похожие стратегии');
    expect(text).toContain('Предлагаю');

    // Interpretation reflects the turn.
    expect(text).toContain('BTCUSDT');
    expect(text).toContain('1m');

    // Similar profile shows label, source id and freshness.
    expect(text).toContain('Long after flush');
    expect(text).toContain('p-sim-1');
    expect(text).toContain('2026-06-15');

    // Proposed next action surfaced.
    expect(text).toContain('strategy.analyze');
  });

  it('says no exact match ONLY on a real miss', () => {
    const evidence: OperatorEvidence = {
      subjectHash: 'sha256:abc',
      status: 'complete',
      exactLookup: 'miss',
      similarStrategies: [],
      evidenceRefs: [],
      warningCodes: [],
      timingsMs: {},
    };
    const text = renderOperatorResponse({ turn: baseTurn, evidence, proposedAction });
    expect(text).toContain('точного совпадения нет');
  });

  it('makes NO database-absence claim when exactLookup is not_run', () => {
    const evidence: OperatorEvidence = {
      subjectHash: 'sha256:abc',
      status: 'complete',
      exactLookup: 'not_run',
      similarStrategies: [],
      evidenceRefs: [],
      warningCodes: [],
      timingsMs: {},
    };
    const text = renderOperatorResponse({ turn: baseTurn, evidence, proposedAction });
    expect(text).not.toContain('точного совпадения нет');
    // It must not imply absence; it should say the check did not run.
    expect(text.toLowerCase()).toContain('не выполн');
  });

  it('makes NO database-absence claim when exactLookup failed', () => {
    const evidence: OperatorEvidence = {
      subjectHash: 'sha256:abc',
      status: 'degraded',
      exactLookup: 'failed',
      similarStrategies: [],
      evidenceRefs: [],
      warningCodes: ['exact_lookup_failed'],
      timingsMs: {},
    };
    const text = renderOperatorResponse({ turn: baseTurn, evidence, proposedAction });
    expect(text).not.toContain('точного совпадения нет');
  });

  it('labels an exact hit distinctly from similar candidates (duplicate detection)', () => {
    const evidence: OperatorEvidence = {
      subjectHash: 'sha256:abc',
      status: 'complete',
      exactLookup: 'hit',
      exactMatch: { strategyProfileId: 'p-exact-9', label: 'Identical strategy', observedAt: '2026-06-19T00:00:00.000Z' },
      similarStrategies: [],
      evidenceRefs: [
        { sourceType: 'strategy_profile', sourceId: 'p-exact-9', retrievalMethod: 'exact', observedAt: '2026-06-19T00:00:00.000Z' },
      ],
      warningCodes: [],
      timingsMs: {},
    };
    const text = renderOperatorResponse({ turn: baseTurn, evidence, proposedAction });
    // Exact hit is reported as a duplicate, with the matched id/label.
    expect(text).toContain('p-exact-9');
    expect(text).toContain('Identical strategy');
    expect(text).not.toContain('точного совпадения нет');
  });

  it('renders at most five similar profiles', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      candidate({ strategyProfileId: `p-sim-${i}`, metadata: { ...candidate().metadata, label: `S${i}` } }),
    );
    const evidence: OperatorEvidence = {
      subjectHash: 'sha256:abc',
      status: 'complete',
      exactLookup: 'miss',
      similarStrategies: many,
      evidenceRefs: [],
      warningCodes: [],
      timingsMs: {},
    };
    const text = renderOperatorResponse({ turn: baseTurn, evidence, proposedAction });
    for (let i = 0; i < 5; i++) expect(text).toContain(`p-sim-${i}`);
    expect(text).not.toContain('p-sim-5');
    expect(text).not.toContain('p-sim-7');
  });

  it('adds an explicit limitation sentence when a source is degraded', () => {
    const evidence: OperatorEvidence = {
      subjectHash: 'sha256:abc',
      status: 'degraded',
      exactLookup: 'miss',
      similarStrategies: [candidate()],
      evidenceRefs: [],
      warningCodes: ['vector_failed'],
      timingsMs: {},
    };
    const text = renderOperatorResponse({ turn: baseTurn, evidence, proposedAction });
    expect(text.toLowerCase()).toContain('ограничен');
    // The specific degraded code is surfaced so the operator can see what failed.
    expect(text).toContain('vector_failed');
  });

  it('does not add a limitation sentence when complete', () => {
    const evidence: OperatorEvidence = {
      subjectHash: 'sha256:abc',
      status: 'complete',
      exactLookup: 'miss',
      similarStrategies: [candidate()],
      evidenceRefs: [],
      warningCodes: [],
      timingsMs: {},
    };
    const text = renderOperatorResponse({ turn: baseTurn, evidence, proposedAction });
    expect(text.toLowerCase()).not.toContain('ограничен');
  });
});
