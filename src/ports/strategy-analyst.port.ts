import type { StrategyAnalystInput } from '../domain/strategy-source.ts';
import type { AnalystProfileOutput } from '../domain/strategy-profile.ts';

export interface StrategyAnalystPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  analyze(input: StrategyAnalystInput): Promise<AnalystProfileOutput>;
}
