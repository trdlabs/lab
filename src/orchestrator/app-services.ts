import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { StrategyAnalystPort } from '../ports/strategy-analyst.port.ts';
import type { ArtifactStorePort } from '../ports/artifact-store.port.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { PlatformGatewayPort } from '../ports/platform-gateway.port.ts';
import type { ResearcherPort } from '../ports/researcher.port.ts';
import type { CriticPort } from '../ports/critic.port.ts';
import type { HypothesisProposalRepository } from '../ports/hypothesis-proposal.repository.ts';
import type { HypothesisReviewRepository } from '../ports/hypothesis-review.repository.ts';
import type { SimilarHypothesisSearchPort } from '../ports/similar-hypothesis-search.port.ts';

export interface AppServices {
  researchTasks: ResearchTaskRepository;
  strategyProfiles: StrategyProfileRepository;
  analyst: StrategyAnalystPort;
  artifacts: ArtifactStorePort;
  events: AgentEventRepository;
  platform: PlatformGatewayPort;
  researcher: ResearcherPort;
  critic: CriticPort | null;          // null when ENABLE_CRITIC_AGENT=false
  hypotheses: HypothesisProposalRepository;
  hypothesisReviews: HypothesisReviewRepository;
  similarHypotheses: SimilarHypothesisSearchPort;
  maxHypothesesPerCycle: number;      // budget guardrail injected from env
}
