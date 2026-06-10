// src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryLexicalSimilarHypothesisSearch } from './in-memory-lexical-similar-hypothesis-search.ts';
import { InMemoryHypothesisProposalRepository } from '../repository/in-memory-hypothesis-proposal.repository.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';

function hyp(id: string, thesis: string): HypothesisProposal {
  return {
    id, strategyProfileId: 'p1', thesis, targetBehavior: 'b',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
    requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'], confidence: 0.5, status: 'validated', fingerprint: `sha256:${id}`,
    proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('InMemoryLexicalSimilarHypothesisSearch', () => {
  it('ranks by token overlap and respects limit', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'skip entries when open interest is falling'));
    await repo.create(hyp('h2', 'buy capitulation wicks on high volume'));
    const search = new InMemoryLexicalSimilarHypothesisSearch(repo);
    const results = await search.search('p1', 'skip entries when open interest falls', 1);
    expect(results.length).toBe(1);
    expect(results[0]!.hypothesisId).toBe('h1');
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('returns empty when the profile has no hypotheses', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    const search = new InMemoryLexicalSimilarHypothesisSearch(repo);
    expect(await search.search('p1', 'anything', 5)).toEqual([]);
  });
});
