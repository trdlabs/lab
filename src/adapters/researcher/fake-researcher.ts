import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import type { ResearcherOutput } from '../../domain/hypothesis.ts';

/** Deterministic stub: emits up to two clean, Validator-passing hypotheses derived from the
 *  profile. Uses only LAB_FEATURE_CATALOG features and avoids all denylist markers. No network. */
export class FakeResearcher implements ResearcherPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';

  async propose(input: ResearcherInput): Promise<ResearcherOutput> {
    const n = Math.max(0, Math.min(2, input.maxHypotheses));
    const hypotheses = Array.from({ length: n }, (_unused, i) => ({
      thesis: `Hypothesis ${i + 1}: ${input.profile.coreIdea} conditioned on ${input.marketRegime} regime`,
      targetBehavior: 'Adjust entry filtering using open interest trend',
      ruleAction: {
        appliesTo: input.profile.direction,
        rules: [{ when: `oi trend persists for ${i + 1} bars`, action: 'skip_entry' as const, params: { bars: i + 1 } }],
      },
      requiredFeatures: ['oi', 'funding'],
      validationPlan: 'Backtest baseline vs variant over the last 90 days',
      expectedEffect: { metric: 'win_rate', direction: 'increase' as const },
      invalidationCriteria: ['No win_rate improvement vs baseline'],
      confidence: 0.5,
    }));
    return { hypotheses, researchSummary: `Fake researcher produced ${n} hypotheses` };
  }
}
