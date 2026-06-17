import type { AppServices } from '../../src/orchestrator/app-services.ts';
import { InMemoryResearchTaskRepository } from '../../src/adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../../src/adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryAgentEventRepository } from '../../src/adapters/repository/in-memory-agent-event.repository.ts';
import { InMemoryArtifactStore } from '../../src/adapters/artifact/in-memory-artifact-store.ts';
import { FakeStrategyAnalyst } from '../../src/adapters/analyst/fake-strategy-analyst.ts';
import { MockPlatformGatewayAdapter } from '../../src/adapters/platform/mock-platform-gateway.adapter.ts';
import { MockResearchPlatformAdapter } from '../../src/adapters/platform/mock-research-platform.adapter.ts';
import { MockBotResultsAdapter } from '../../src/adapters/platform/mock-bot-results.adapter.ts';
import { FakeResearcher } from '../../src/adapters/researcher/fake-researcher.ts';
import { InMemoryHypothesisProposalRepository } from '../../src/adapters/repository/in-memory-hypothesis-proposal.repository.ts';
import { InMemoryHypothesisReviewRepository } from '../../src/adapters/repository/in-memory-hypothesis-review.repository.ts';
import { InMemoryLexicalSimilarHypothesisSearch } from '../../src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts';
import { FakeBuilder } from '../../src/adapters/builder/fake-builder.ts';
import { InMemoryHypothesisBuildRepository } from '../../src/adapters/repository/in-memory-hypothesis-build.repository.ts';
import { InMemoryBacktestRunRepository } from '../../src/adapters/repository/in-memory-backtest-run.repository.ts';
import { InMemoryEvaluationRepository } from '../../src/adapters/repository/in-memory-evaluation.repository.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../../src/validation/evaluator.ts';
import { InMemoryChatSessionRepository } from '../../src/adapters/repository/in-memory-chat-session.repository.ts';
import { InMemoryChatPlanRepository } from '../../src/adapters/repository/in-memory-chat-plan.repository.ts';

export function makeServices(overrides: Partial<AppServices> = {}): AppServices {
  const hypotheses = new InMemoryHypothesisProposalRepository();
  return {
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    analyst: new FakeStrategyAnalyst(),
    artifacts: new InMemoryArtifactStore(),
    events: new InMemoryAgentEventRepository(),
    platform: new MockPlatformGatewayAdapter(),
    researchPlatform: new MockResearchPlatformAdapter(),
    botResults: new MockBotResultsAdapter(),
    researcher: new FakeResearcher(),
    critic: null, // base happy-path does not invoke Critic; tests opt in via overrides
    hypotheses,
    hypothesisReviews: new InMemoryHypothesisReviewRepository(),
    similarHypotheses: new InMemoryLexicalSimilarHypothesisSearch(hypotheses),
    maxHypothesesPerCycle: 5,
    builder: new FakeBuilder(),
    builds: new InMemoryHypothesisBuildRepository(),
    backtests: new InMemoryBacktestRunRepository(),
    evaluations: new InMemoryEvaluationRepository(),
    evaluatorThresholds: DEFAULT_EVALUATOR_THRESHOLDS,
    chatSessions: new InMemoryChatSessionRepository(),
    chatPlans: new InMemoryChatPlanRepository(),
    backtestBackend: 'sp4_mock',
    platformPoll: { maxPolls: 5, pollDelayMs: 0 },
    baselineVersion: 'v1',
    ...overrides,
  };
}
