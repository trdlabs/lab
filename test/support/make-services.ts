import type { AppServices } from '../../src/orchestrator/app-services.ts';
import { InMemoryResearchTaskRepository } from '../../src/adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../../src/adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryAgentEventRepository } from '../../src/adapters/repository/in-memory-agent-event.repository.ts';
import { InMemoryArtifactStore } from '../../src/adapters/artifact/in-memory-artifact-store.ts';
import { FakeStrategyAnalyst } from '../../src/adapters/analyst/fake-strategy-analyst.ts';
import { MockPlatformGatewayAdapter } from '../../src/adapters/platform/mock-platform-gateway.adapter.ts';
import { MockResearchPlatformAdapter } from '../../src/adapters/platform/mock-research-platform.adapter.ts';
import { MockBotResultsAdapter } from '../../src/adapters/platform/mock-bot-results.adapter.ts';
import { MockTradeEvidenceAdapter } from '../../src/adapters/platform/mock-trade-evidence.adapter.ts';
import { FakeResearcher } from '../../src/adapters/researcher/fake-researcher.ts';
import { InMemoryHypothesisProposalRepository } from '../../src/adapters/repository/in-memory-hypothesis-proposal.repository.ts';
import { InMemoryHypothesisReviewRepository } from '../../src/adapters/repository/in-memory-hypothesis-review.repository.ts';
import { InMemoryLexicalSimilarHypothesisSearch } from '../../src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts';
import { FakeBuilder } from '../../src/adapters/builder/fake-builder.ts';
import { FakeStrategyBuilder } from '../../src/adapters/builder/fake-strategy-builder.ts';
import { InMemoryHypothesisBuildRepository } from '../../src/adapters/repository/in-memory-hypothesis-build.repository.ts';
import { InMemoryBacktestRunRepository } from '../../src/adapters/repository/in-memory-backtest-run.repository.ts';
import { InMemoryStrategyBacktestRunRepository } from '../../src/adapters/repository/in-memory-strategy-backtest-run.repository.ts';
import { InMemoryEvaluationRepository } from '../../src/adapters/repository/in-memory-evaluation.repository.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../../src/validation/evaluator.ts';
import { InMemoryChatSessionRepository } from '../../src/adapters/repository/in-memory-chat-session.repository.ts';
import { InMemoryChatPlanRepository } from '../../src/adapters/repository/in-memory-chat-plan.repository.ts';
import { InMemoryActionProposalRepository } from '../../src/adapters/repository/in-memory-action-proposal.repository.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { NoopStrategyRetrievalIndexer } from '../../src/operator/noop-strategy-retrieval-indexer.ts';
import { InMemoryTokenUsageRepository } from '../../src/adapters/repository/in-memory-token-usage.repository.ts';
import { NullModelPricing } from '../../src/adapters/pricing/null-model-pricing.ts';
import { InMemoryResearchExperimentRepository } from '../../src/adapters/repository/in-memory-research-experiment.repository.ts';
import { MockRunTradesAdapter } from '../../src/adapters/platform/mock-run-trades.adapter.ts';
import { ExperimentService } from '../../src/research/experiment-service.ts';
import { comparisonSummary } from '../../src/validation/__fixtures__/comparison-summary.ts';
import { ParamGridRunner } from '../../src/research/param-grid-runner.ts';
import { FakeGate1 } from '../../src/adapters/wfo/fake-gate1.ts';
import { FakeSweepDesigner } from '../../src/adapters/wfo/fake-sweep-designer.ts';
import { FakeResultInterpreter } from '../../src/adapters/wfo/fake-result-interpreter.ts';
import type { StrategyExperimentRunExecutor } from '../../src/research/strategy-experiment-run-executor.ts';

export function makeServices(overrides: Partial<AppServices> = {}): AppServices {
  const hypotheses = new InMemoryHypothesisProposalRepository();
  const experiments = new InMemoryResearchExperimentRepository();
  const runTrades = new MockRunTradesAdapter();
  const events = overrides.events ?? new InMemoryAgentEventRepository();
  const strategyBacktests = new InMemoryStrategyBacktestRunRepository();
  let _id = 0;
  const strategyRunExecutor: StrategyExperimentRunExecutor = {
    execute: async (req) => ({
      status: 'completed' as const,
      runId: `sr-${req.role}`,
      platformRunId: 'plat-strategy-fake',
      totalTrades: 90,
    }),
  };
  const experimentService = new ExperimentService({
    experiments: overrides.experiments ?? experiments,
    runTrades: overrides.runTrades ?? runTrades,
    runExecutor: {
      execute: async (req) => ({
        status: 'completed' as const,
        runId: `r-${req.role}`,
        platformRunId: 'plat-fake',
        totalTrades: 90,
        comparison: comparisonSummary('strong'),
      }),
    },
    strategyRunExecutor,
    newId: (p) => `${p}-${++_id}`,
    now: () => new Date().toISOString(),
    events,
    gate1: new FakeGate1(),
    sweepDesigner: new FakeSweepDesigner(),
    resultInterpreter: new FakeResultInterpreter(),
    paramGridRunner: new ParamGridRunner({ strategyRunExecutor }),
    strategyBacktests,
  });
  return {
    taskQueue: new InMemoryQueueAdapter(),
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    analyst: new FakeStrategyAnalyst(),
    artifacts: new InMemoryArtifactStore(),
    events,
    platform: new MockPlatformGatewayAdapter(),
    researchPlatform: new MockResearchPlatformAdapter(),
    researchIntegration: 'mock',
    botResults: new MockBotResultsAdapter(),
    marketHistory: { getRows: async () => [] },
    tradeEvidence: new MockTradeEvidenceAdapter(),
    researcher: new FakeResearcher(),
    critic: null, // base happy-path does not invoke Critic; tests opt in via overrides
    strategyCritic: null, // base happy-path skips the pre-flight critic; tests opt in via overrides
    hypotheses,
    hypothesisReviews: new InMemoryHypothesisReviewRepository(),
    similarHypotheses: new InMemoryLexicalSimilarHypothesisSearch(hypotheses),
    maxHypothesesPerCycle: 5,
    tokenUsage: new InMemoryTokenUsageRepository(),
    modelPricing: new NullModelPricing(),
    researchTaskTokenBudget: 0, // unlimited by default in tests; budget-gate tests override
    builder: new FakeBuilder(),
    builds: new InMemoryHypothesisBuildRepository(),
    backtests: new InMemoryBacktestRunRepository(),
    evaluations: new InMemoryEvaluationRepository(),
    evaluatorThresholds: DEFAULT_EVALUATOR_THRESHOLDS,
    chatSessions: new InMemoryChatSessionRepository(),
    chatPlans: new InMemoryChatPlanRepository(),
    actionProposals: new InMemoryActionProposalRepository(),
    strategyRetrievalIndexer: new NoopStrategyRetrievalIndexer(),
    experiments,
    runTrades,
    experimentService,
    strategyBuilder: new FakeStrategyBuilder(),
    strategyBacktests,
    backtestBackend: 'research_platform',
    platformPoll: { maxPolls: 5, pollDelayMs: 0 },
    baselineVersion: 'v1',
    defaultPlatformRun: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 },
    ...overrides,
  };
}
