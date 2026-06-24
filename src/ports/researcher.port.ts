import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { ResearcherOutput, SimilarHypothesisSummary } from '../domain/hypothesis.ts';
import type { MarketContext, MarketRegime } from './platform-gateway.port.ts';
import type { BotRunResultDetail } from './bot-results-read.port.ts';
import type { TradeEvidenceBundle } from './trade-evidence-read.port.ts';

/** Optional per-call hooks. onUsage reports the LLM token usage of this call (0 when unknown). */
export interface AgentCallOpts {
  onUsage?: (totalTokens: number) => void | Promise<void>;
}

export interface ResearcherInput {
  profile: StrategyProfile;
  marketContext: MarketContext;
  marketRegime: MarketRegime;
  similarHypotheses: SimilarHypothesisSummary[];
  botResults?: readonly BotRunResultDetail[];
  tradeEvidence?: readonly TradeEvidenceBundle[];
  maxHypotheses: number;
}

export interface ResearcherPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  propose(input: ResearcherInput, opts?: AgentCallOpts): Promise<ResearcherOutput>;
}
