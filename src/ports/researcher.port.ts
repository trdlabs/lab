import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { ResearcherOutput, SimilarHypothesisSummary } from '../domain/hypothesis.ts';
import type { MarketContext, MarketRegime } from './platform-gateway.port.ts';

export interface ResearcherInput {
  profile: StrategyProfile;
  marketContext: MarketContext;
  marketRegime: MarketRegime;
  similarHypotheses: SimilarHypothesisSummary[];
  maxHypotheses: number;
}

export interface ResearcherPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  propose(input: ResearcherInput): Promise<ResearcherOutput>;
}
