import { describe, it, expect } from 'vitest';
import { FakeStrategyAnalyst } from './fake-strategy-analyst.ts';
import { AnalystProfileOutputSchema } from '../../domain/strategy-profile.ts';

describe('FakeStrategyAnalyst', () => {
  it('reports adapter=fake and returns a schema-valid output', async () => {
    const a = new FakeStrategyAnalyst();
    expect(a.adapter).toBe('fake');
    expect(a.model).toBe('fake');
    const out = await a.analyze({ kind: 'article', content: 'x' });
    expect(AnalystProfileOutputSchema.safeParse(out).success).toBe(true);
  });
  it('returns canned output when provided', async () => {
    const canned = AnalystProfileOutputSchema.parse({
      direction: 'short', coreIdea: 'c', summary: 's', requiredMarketFeatures: [], entryConditions: [],
      exitConditions: [], timeframes: [], indicators: [], parameters: [], watchLifecycleSummary: null,
      positionManagementSummary: null, riskManagementSummary: null, runnerOwnedAuthorities: [],
      confidence: 0.9, unknowns: [], evidence: [],
    });
    const out = await new FakeStrategyAnalyst(canned).analyze({ kind: 'article', content: 'x' });
    expect(out.direction).toBe('short');
  });
});
