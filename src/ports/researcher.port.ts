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
  /** 'accepted_revision': rule sourced from the latest accepted strategy_revision's mergedRuleSet
   *  (slice G3 — schema-validated-but-unmerged proposals are no longer fed to the researcher). */
  readonly status: 'validated' | 'rejected' | 'accepted_revision';
}

/** Narrow lab-local excerpt of a decision-log entry, scoped to a losing trade's window.
 *  Never exposes the raw SDK DecisionLogEntry DTO to the researcher prompt layer. */
export interface DecisionExcerpt {
  runId: string;
  timestampMs?: number;
  action?: string;
  reason?: string;
  summary?: string;
  relatedTradeId?: string;
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
  retryFeedback?: { decision: string; reasons: readonly string[] };
  decisionExcerpts?: readonly DecisionExcerpt[];
}

export interface ResearcherPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  propose(input: ResearcherInput, opts?: AgentCallOpts): Promise<ResearcherOutput>;
}
