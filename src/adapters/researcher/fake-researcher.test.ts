// src/adapters/researcher/fake-researcher.test.ts
import { describe, it, expect } from 'vitest';
import { FakeResearcher } from './fake-researcher.ts';
import { ResearcherOutputSchema } from '../../domain/hypothesis.ts';
import type { ResearcherInput } from '../../ports/researcher.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

function profile(): StrategyProfile {
  return {
    id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:abc',
    direction: 'long', coreIdea: 'Long OI divergence', requiredMarketFeatures: ['oi'],
    confidence: 0.5, unknowns: [], profile: {} as never,
    sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function input(maxHypotheses: number): ResearcherInput {
  return {
    profile: profile(),
    marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: { oi: 1 } },
    marketRegime: 'ranging',
    similarHypotheses: [],
    maxHypotheses,
  };
}

describe('FakeResearcher', () => {
  it('reports fake adapter identity', () => {
    const r = new FakeResearcher();
    expect(r.adapter).toBe('fake');
    expect(r.model).toBe('fake');
  });

  it('returns schema-valid output bounded by maxHypotheses', async () => {
    const out = await new FakeResearcher().propose(input(5));
    expect(ResearcherOutputSchema.safeParse(out).success).toBe(true);
    expect(out.hypotheses.length).toBe(2);
  });

  it('never exceeds maxHypotheses', async () => {
    const out = await new FakeResearcher().propose(input(1));
    expect(out.hypotheses.length).toBe(1);
  });

  it('produces distinct fingerprintable theses', async () => {
    const out = await new FakeResearcher().propose(input(2));
    expect(out.hypotheses[0]!.thesis).not.toBe(out.hypotheses[1]!.thesis);
  });
});
