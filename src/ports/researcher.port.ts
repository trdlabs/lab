import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { ResearcherOutput, SimilarHypothesisSummary, RuleAction } from '../domain/hypothesis.ts';
import type { MarketContext, MarketRegime } from './platform-gateway.port.ts';
import type { BotRunResultDetail } from './bot-results-read.port.ts';
import type { TradeEvidenceBundle } from './trade-evidence-read.port.ts';

import type { MarketContextMath } from '../research-math/market-context-math.ts';
import type { TradeContextMath } from '../research-math/trade-context-math.ts';
import type { AgentCallOpts } from './agent-call-opts.ts';
export type { AgentCallOpts };

export type ResearcherFocus = 'loss_reduction' | 'profit_improvement';

export interface ActiveOverlayRuleSummary {
  readonly thesis: string;
  readonly ruleAction: RuleAction;
  readonly status: 'validated' | 'rejected';
}

export interface ResearcherInput {
  profile: StrategyProfile;
  marketContext: MarketContext;
  marketContextMath?: MarketContextMath;
  marketRegime: MarketRegime;
  similarHypotheses: SimilarHypothesisSummary[];
  botResults?: readonly BotRunResultDetail[];
  tradeEvidence?: readonly TradeEvidenceBundle[];
  tradeContexts?: readonly TradeContextMath[];
  maxHypotheses: number;
  focus: ResearcherFocus;
  activeOverlayRules?: readonly ActiveOverlayRuleSummary[];
}

export interface ResearcherPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  propose(input: ResearcherInput, opts?: AgentCallOpts): Promise<ResearcherOutput>;
}
