import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { StrategyAnalystPort } from '../ports/strategy-analyst.port.ts';
import type { ArtifactStorePort } from '../ports/artifact-store.port.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { PlatformGatewayPort } from '../ports/platform-gateway.port.ts';
import type { ResearchPlatformPort } from '../ports/research-platform.port.ts';
import type { BotResultsReadPort } from '../ports/bot-results-read.port.ts';
import type { TradeEvidenceReadPort } from '../ports/trade-evidence-read.port.ts';
import type { ResearcherPort } from '../ports/researcher.port.ts';
import type { CriticPort } from '../ports/critic.port.ts';
import type { HypothesisProposalRepository } from '../ports/hypothesis-proposal.repository.ts';
import type { HypothesisReviewRepository } from '../ports/hypothesis-review.repository.ts';
import type { SimilarHypothesisSearchPort } from '../ports/similar-hypothesis-search.port.ts';
import type { BuilderPort } from '../ports/builder.port.ts';
import type { HypothesisBuildRepository } from '../ports/hypothesis-build.repository.ts';
import type { BacktestRunRepository } from '../ports/backtest-run.repository.ts';
import type { EvaluationRepository } from '../ports/evaluation.repository.ts';
import type { EvaluatorThresholds } from '../validation/evaluator.ts';
import type { ChatSessionRepository } from '../ports/chat-session.repository.ts';
import type { ChatPlanRepository } from '../ports/chat-plan.repository.ts';
import type { ActionProposalRepository } from '../ports/action-proposal.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';

/**
 * Fail-soft retrieval indexer seam. The concrete StrategyRetrievalIndexer satisfies it;
 * a no-op implementation is injected when OPERATOR_RAG_ENABLED=false. index() NEVER throws —
 * onboarding completes whether or not the projection lands.
 */
export interface StrategyRetrievalIndexerPort {
  index(profile: StrategyProfile): Promise<void>;
}

export interface AppServices {
  taskQueue: TaskQueuePort;
  researchTasks: ResearchTaskRepository;
  strategyProfiles: StrategyProfileRepository;
  analyst: StrategyAnalystPort;
  artifacts: ArtifactStorePort;
  events: AgentEventRepository;
  platform: PlatformGatewayPort;
  researchPlatform: ResearchPlatformPort;
  botResults: BotResultsReadPort;
  tradeEvidence: TradeEvidenceReadPort;
  researcher: ResearcherPort;
  critic: CriticPort | null;          // null when ENABLE_CRITIC_AGENT=false
  hypotheses: HypothesisProposalRepository;
  hypothesisReviews: HypothesisReviewRepository;
  similarHypotheses: SimilarHypothesisSearchPort;
  maxHypothesesPerCycle: number;      // budget guardrail injected from env
  builder: BuilderPort;
  builds: HypothesisBuildRepository;
  backtests: BacktestRunRepository;
  evaluations: EvaluationRepository;
  evaluatorThresholds: EvaluatorThresholds;
  chatSessions: ChatSessionRepository;
  chatPlans: ChatPlanRepository;
  actionProposals: ActionProposalRepository;
  /** Fail-soft retrieval indexer invoked after a strategy profile is persisted (onboarding). */
  strategyRetrievalIndexer: StrategyRetrievalIndexerPort;
  backtestBackend: 'research_platform';
  platformPoll: { maxPolls: number; pollDelayMs: number };
  /** When set, passed to platform/backtester submit as completion webhook URL. */
  backtestCallbackUrl?: string;
  baselineVersion: string;
  defaultPlatformRun: { datasetId: string; symbols: string[]; timeframe: string; period: { from: string; to: string }; seed: number };
}
