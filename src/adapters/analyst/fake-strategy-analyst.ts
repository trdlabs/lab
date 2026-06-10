import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';

export class FakeStrategyAnalyst implements StrategyAnalystPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  private readonly canned: AnalystProfileOutput | undefined;

  constructor(canned?: AnalystProfileOutput) {
    this.canned = canned;
  }

  async analyze(input: StrategyAnalystInput): Promise<AnalystProfileOutput> {
    if (this.canned) return this.canned;
    return {
      direction: 'unknown',
      coreIdea: `Strategy onboarded from ${input.kind}`,
      summary: input.title ?? `Source of kind ${input.kind}`,
      requiredMarketFeatures: [],
      entryConditions: [],
      exitConditions: [],
      timeframes: [],
      indicators: [],
      parameters: [],
      watchLifecycleSummary: null,
      positionManagementSummary: null,
      riskManagementSummary: null,
      runnerOwnedAuthorities: [],
      confidence: 0.5,
      unknowns: ['fake-analyst: no real analysis performed'],
      evidence: [],
    };
  }
}
