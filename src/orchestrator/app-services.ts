import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { StrategyAnalystPort } from '../ports/strategy-analyst.port.ts';
import type { ArtifactStorePort } from '../ports/artifact-store.port.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { PlatformGatewayPort } from '../ports/platform-gateway.port.ts';
import type { ResearchPlatformPort } from '../ports/research-platform.port.ts';
import type { BotResultsReadPort } from '../ports/bot-results-read.port.ts';
import type { MarketHistoryReadPort } from '../ports/market-history-read.port.ts';
import type { TradeEvidenceReadPort } from '../ports/trade-evidence-read.port.ts';
import type { ResearcherPort } from '../ports/researcher.port.ts';
import type { CriticPort } from '../ports/critic.port.ts';
import type { StrategyCriticPort } from '../ports/strategy-critic.port.ts';
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
import type { TokenUsageRepository } from '../ports/token-usage.repository.ts';
import type { ModelPricingPort } from '../ports/model-pricing.port.ts';
import type { ResearchExperimentRepository } from '../ports/research-experiment.repository.ts';
import type { RunTradesPort } from '../ports/run-trades.port.ts';
import type { ExperimentService } from '../research/experiment-service.ts';
import type { StrategyBuilder } from '../ports/strategy-builder.port.ts';
import type { StrategyBacktestRunRepository } from '../ports/strategy-backtest-run.repository.ts';
import type { StrategyRevisionRepository } from '../ports/strategy-revision.repository.ts';
import type { PaperIntakePort } from '../adapters/platform/paper-intake.port.ts';
import type { PaperSubmissionRepository } from '../ports/paper-submission.repository.ts';
import type { PaperWindowPolicy } from '../domain/paper-window.ts';
import type { PaperRunLocatorPort } from '../ports/paper-run-locator.port.ts';

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
  /** Which research-platform integration is wired — selects the overlay-run target in runPlatformBacktest. */
  researchIntegration: 'mock' | 'backtester';
  botResults: BotResultsReadPort;
  marketHistory: MarketHistoryReadPort;
  tradeEvidence: TradeEvidenceReadPort;
  researcher: ResearcherPort;
  critic: CriticPort | null;          // null when ENABLE_CRITIC_AGENT=false
  /** Pre-flight strategy critic; null when STRATEGY_PREFLIGHT_CRITIQUE=false. */
  strategyCritic: StrategyCriticPort | null;
  hypotheses: HypothesisProposalRepository;
  hypothesisReviews: HypothesisReviewRepository;
  similarHypotheses: SimilarHypothesisSearchPort;
  maxHypothesesPerCycle: number;      // budget guardrail injected from env
  tokenUsage: TokenUsageRepository;
  modelPricing: ModelPricingPort;
  /** Cumulative token budget per research chain; 0 = unlimited. */
  researchTaskTokenBudget: number;
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
  /** Symbol the research cycle defaults to when the task payload omits one. Demo sets this to a fixture symbol; production falls back to RESEARCH_DEFAULT_SYMBOL. */
  researchDefaultSymbol?: string;
  experiments: ResearchExperimentRepository;
  runTrades: RunTradesPort;
  experimentService: ExperimentService;
  strategyBuilder: StrategyBuilder;
  strategyBacktests: StrategyBacktestRunRepository;
  /** Strategy revisions ledger (slice G3); threaded through composition for revision.build (task-9+). */
  revisions: StrategyRevisionRepository;
  /** #127 platform paper-intake — proven-champion submission. */
  paperIntake: PaperIntakePort;
  paperSubmissions: PaperSubmissionRepository;
  /** Trade-count adaptive paper-observation window policy (§2.5); validated fail-fast at composition. */
  paperWindowPolicy: PaperWindowPolicy;
  /** Delay (ms) between paper.monitor self-reschedule polls. */
  paperMonitorPollMs: number;
  /** Locates the live paper-mode run for a submitted champion (candidateId->runId seam, §2). */
  paperRunLocator: PaperRunLocatorPort;
}
