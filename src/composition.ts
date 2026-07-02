import { loadEnv } from './config/env.ts';
import { BullMqQueueAdapter } from './adapters/queue/bullmq-queue.adapter.ts';
import { DrizzleResearchTaskRepository } from './adapters/repository/drizzle-research-task.repository.ts';
import { DrizzleStrategyProfileRepository } from './adapters/repository/drizzle-strategy-profile.repository.ts';
import { DrizzleAgentEventRepository } from './adapters/repository/drizzle-agent-event.repository.ts';
import { DrizzleTokenUsageRepository } from './adapters/repository/drizzle-token-usage.repository.ts';
import { OpenRouterModelPricing } from './adapters/pricing/openrouter-model-pricing.ts';
import { LocalFileArtifactStore } from './adapters/artifact/local-file-artifact-store.adapter.ts';
import { FakeStrategyAnalyst } from './adapters/analyst/fake-strategy-analyst.ts';
import { MastraStrategyAnalyst } from './adapters/analyst/mastra-strategy-analyst.ts';
import { createDbClient } from './db/client.ts';
import { WorkflowRouter } from './orchestrator/workflow-router.ts';
import { strategyOnboardHandler } from './orchestrator/handlers/strategy-onboard.handler.ts';
import { researchRunCycleHandler } from './orchestrator/handlers/research-run-cycle.handler.ts';
import { hypothesisBuildHandler } from './orchestrator/handlers/hypothesis-build.handler.ts';
import { backtestCompletedHandler } from './orchestrator/handlers/backtest-completed.handler.ts';
import { strategyBaselineHandler } from './orchestrator/handlers/strategy-baseline.handler.ts';
import { strategyWfoHandler } from './orchestrator/handlers/strategy-wfo.handler.ts';
import { backtestResumeHandler } from './orchestrator/handlers/backtest-resume.handler.ts';
import { buildBacktestCallbackUrl } from './config/backtest-callback-url.ts';
import type { AppServices } from './orchestrator/app-services.ts';
import type { StrategyAnalystPort } from './ports/strategy-analyst.port.ts';
import { MockPlatformGatewayAdapter } from './adapters/platform/mock-platform-gateway.adapter.ts';
import { selectResearchPlatform } from './adapters/platform/select-research-platform.ts';
import { selectRunTrades } from './adapters/platform/select-run-trades.ts';
import { selectBotResults } from './adapters/platform/select-bot-results.ts';
import { selectMarketHistory } from './adapters/platform/select-market-history.ts';
import { selectTradeEvidence } from './adapters/platform/select-trade-evidence.ts';
import { FakeResearcher } from './adapters/researcher/fake-researcher.ts';
import { MastraResearcher } from './adapters/researcher/mastra-researcher.ts';
import { FakeCritic } from './adapters/critic/fake-critic.ts';
import { MastraCritic } from './adapters/critic/mastra-critic.ts';
import type { StrategyCriticPort } from './ports/strategy-critic.port.ts';
import { FakeStrategyCritic } from './adapters/strategy-critic/fake-strategy-critic.ts';
import { SingleStageStrategyCritic } from './adapters/strategy-critic/single-stage-strategy-critic.ts';
import { TwoStageStrategyCritic } from './adapters/strategy-critic/two-stage-strategy-critic.ts';
import { DrizzleHypothesisProposalRepository } from './adapters/repository/drizzle-hypothesis-proposal.repository.ts';
import { DrizzleHypothesisReviewRepository } from './adapters/repository/drizzle-hypothesis-review.repository.ts';
import { InMemoryLexicalSimilarHypothesisSearch } from './adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts';
import type { ResearcherPort } from './ports/researcher.port.ts';
import type { CriticPort } from './ports/critic.port.ts';
import { FakeBuilder } from './adapters/builder/fake-builder.ts';
import { MastraBuilder } from './adapters/builder/mastra-builder.ts';
import { FakeStrategyBuilder } from './adapters/builder/fake-strategy-builder.ts';
import { MastraStrategyBuilder } from './adapters/builder/mastra-strategy-builder.ts';
import { createStrategyBuilderAgent } from './mastra/agents/strategy-builder.agent.ts';
import { getAuthoringDoc } from '@trading-backtester/sdk/builder';
import type { StrategyBuilder } from './ports/strategy-builder.port.ts';
import { DrizzleHypothesisBuildRepository } from './adapters/repository/drizzle-hypothesis-build.repository.ts';
import { DrizzleBacktestRunRepository } from './adapters/repository/drizzle-backtest-run.repository.ts';
import { DrizzleStrategyBacktestRunRepository } from './adapters/repository/drizzle-strategy-backtest-run.repository.ts';
import { DrizzleEvaluationRepository } from './adapters/repository/drizzle-evaluation.repository.ts';
import type { BuilderPort } from './ports/builder.port.ts';
import { composeMastra } from './mastra/compose-mastra.ts';
import type { MastraRuntime } from './mastra/compose-mastra.ts';
import { FakeTurnInterpreter } from './adapters/intent/fake-turn-interpreter.ts';
import { MastraTurnInterpreter } from './adapters/intent/mastra-turn-interpreter.ts';
import { DrizzleChatSessionRepository } from './adapters/repository/drizzle-chat-session.repository.ts';
import { DrizzleChatPlanRepository } from './adapters/repository/drizzle-chat-plan.repository.ts';
import { DrizzleActionProposalRepository } from './adapters/repository/drizzle-action-proposal.repository.ts';
import type { TurnInterpreterPort } from './ports/turn-interpreter.port.ts';
import type { OperatorRetrievalPort } from './ports/operator-retrieval.port.ts';
import type { StrategyRetrievalIndexerPort } from './orchestrator/app-services.ts';
import { OpenRouterEmbeddingAdapter } from './adapters/embedding/openrouter-embedding.adapter.ts';
import { PgStrategyRetrievalIndexAdapter } from './adapters/repository/pg-strategy-retrieval-index.adapter.ts';
import { PgHybridStrategySimilarityAdapter } from './adapters/similarity/pg-hybrid-strategy-similarity.adapter.ts';
import { resolveLanguageModel } from './adapters/llm/model-provider.ts';
import { createRerankerScorer } from './mastra/agents/reranker.agent.ts';
import { MastraRerankerAdapter } from './adapters/reranker/mastra-reranker.adapter.ts';
import type { RerankerPort } from './ports/strategy-similarity.port.ts';
import type { RerankConfig } from './operator/rerank-policy.ts';
import { OperatorRetrieval, realScheduler } from './operator/operator-retrieval.ts';
import { DisabledOperatorRetrieval } from './operator/disabled-operator-retrieval.ts';
import { StrategyRetrievalIndexer } from './operator/strategy-retrieval-indexer.ts';
import { NoopStrategyRetrievalIndexer } from './operator/noop-strategy-retrieval-indexer.ts';
import type { Db } from './db/client.ts';
import type { StrategyProfileRepository } from './ports/strategy-profile.repository.ts';
import type { AgentEventRepository } from './ports/agent-event.repository.ts';
import type { ChatAppDeps } from './chat/chat-app.ts';
import { sql } from 'drizzle-orm';
import { DrizzleHypothesisReadAdapter } from './adapters/read/drizzle-hypothesis-read.adapter.ts';
import { DrizzleBacktestReadAdapter } from './adapters/read/drizzle-backtest-read.adapter.ts';
import { DrizzleAgentEventReadAdapter } from './adapters/read/drizzle-agent-event-read.adapter.ts';
import { DrizzleExperimentReadAdapter } from './adapters/read/drizzle-experiment-read.adapter.ts';
import { DrizzleResearchExperimentRepository } from './adapters/repository/drizzle-research-experiment.repository.ts';
import { AgentActivityProjection } from './read-api/projection.ts';
import { PgNotifyAgentEventStream } from './adapters/read/pg-notify-agent-event-stream.ts';
import type { ReadApiDeps } from './read-api/deps.ts';
import { PhoenixTraceReader } from './read-api/phoenix/phoenix-trace-reader.ts';
import { randomUUID } from 'node:crypto';
import { BacktesterExperimentRunExecutor } from './research/backtester-experiment-run-executor.ts';
import { BacktesterStrategyExperimentRunExecutor } from './research/backtester-strategy-experiment-run-executor.ts';
import { ExperimentService, DEFAULT_WFO_BUDGET } from './research/experiment-service.ts';
import { ParamGridRunner } from './research/param-grid-runner.ts';
import { FakeGate1 } from './adapters/wfo/fake-gate1.ts';
import { MastraGate1 } from './adapters/wfo/mastra-gate1.ts';
import { FakeSweepDesigner } from './adapters/wfo/fake-sweep-designer.ts';
import { MastraSweepDesigner } from './adapters/wfo/mastra-sweep-designer.ts';
import { FakeResultInterpreter } from './adapters/wfo/fake-result-interpreter.ts';
import { MastraResultInterpreter } from './adapters/wfo/mastra-result-interpreter.ts';
import type { Gate1DecisionPort, SweepDesignerPort, ResultInterpreterPort } from './ports/wfo-agents.port.ts';

function buildAnalyst(rt: MastraRuntime): StrategyAnalystPort {
  const e = rt.agents.analyst;
  if (e) return new MastraStrategyAnalyst(e.agent, e.label);
  console.warn('[composition] STRATEGY_ANALYST_ADAPTER is not "mastra"; using FakeStrategyAnalyst (stub analysis)');
  return new FakeStrategyAnalyst();
}

function buildResearcher(rt: MastraRuntime): ResearcherPort {
  const e = rt.agents.researcher;
  if (e) return new MastraResearcher(e.agent, e.label);
  console.warn('[composition] RESEARCHER_ADAPTER is not "mastra"; using FakeResearcher (stub hypotheses)');
  return new FakeResearcher();
}

function buildCritic(env: ReturnType<typeof loadEnv>, rt: MastraRuntime): CriticPort | null {
  if (!env.ENABLE_CRITIC_AGENT) return null;
  const e = rt.agents.critic;
  if (e) return new MastraCritic(e.agent, e.label);
  console.warn('[composition] ENABLE_CRITIC_AGENT=true but CRITIC_ADAPTER is not "mastra"; using FakeCritic');
  return new FakeCritic();
}

export function buildStrategyCritic(env: ReturnType<typeof loadEnv>, rt: MastraRuntime): StrategyCriticPort | null {
  if (!env.STRATEGY_PREFLIGHT_CRITIQUE) return null;
  if (env.STRATEGY_CRITIC_ADAPTER === 'mastra') {
    if (env.STRATEGY_CRITIC_MODE === 'two_stage') {
      const critic = rt.agents.strategyCritic;
      const refiner = rt.agents.strategyRefiner;
      if (critic && refiner) return new TwoStageStrategyCritic(critic.agent, refiner.agent, critic.label, refiner.label);
      console.warn('[composition] STRATEGY_CRITIC_ADAPTER=mastra (two_stage) but agents missing; using FakeStrategyCritic');
      return new FakeStrategyCritic('two_stage');
    }
    const combined = rt.agents.strategyCriticCombined;
    if (combined) return new SingleStageStrategyCritic(combined.agent, combined.label);
    console.warn('[composition] STRATEGY_CRITIC_ADAPTER=mastra (single) but agent missing; using FakeStrategyCritic');
    return new FakeStrategyCritic('single');
  }
  return new FakeStrategyCritic(env.STRATEGY_CRITIC_MODE);
}

export function buildGate1(env: ReturnType<typeof loadEnv>, rt: MastraRuntime): Gate1DecisionPort {
  const e = rt.agents.gate1;
  if (env.WFO_GATE1_ADAPTER === 'mastra' && e) return new MastraGate1(e.agent, e.label);
  console.warn('[composition] WFO_GATE1_ADAPTER is not "mastra"; using FakeGate1');
  return new FakeGate1();
}

export function buildSweepDesigner(env: ReturnType<typeof loadEnv>, rt: MastraRuntime): SweepDesignerPort {
  const e = rt.agents.sweepDesigner;
  if (env.WFO_SWEEP_DESIGNER_ADAPTER === 'mastra' && e) return new MastraSweepDesigner(e.agent, e.label);
  console.warn('[composition] WFO_SWEEP_DESIGNER_ADAPTER is not "mastra"; using FakeSweepDesigner');
  return new FakeSweepDesigner();
}

export function buildResultInterpreter(env: ReturnType<typeof loadEnv>, rt: MastraRuntime): ResultInterpreterPort {
  const e = rt.agents.resultInterpreter;
  if (env.WFO_RESULT_INTERPRETER_ADAPTER === 'mastra' && e) return new MastraResultInterpreter(e.agent, e.label);
  console.warn('[composition] WFO_RESULT_INTERPRETER_ADAPTER is not "mastra"; using FakeResultInterpreter');
  return new FakeResultInterpreter();
}

function buildTurnInterpreter(rt: MastraRuntime): TurnInterpreterPort {
  const e = rt.agents.turnInterpreter;
  if (e) return new MastraTurnInterpreter(e.agent, e.label);
  console.warn('[composition] TURN_INTERPRETER_ADAPTER is not "mastra"; using FakeTurnInterpreter (rule-based)');
  return new FakeTurnInterpreter();
}

export interface OperatorRag {
  retrieval: OperatorRetrievalPort;
  indexer: StrategyRetrievalIndexerPort;
}

/**
 * Operator RAG wiring, gated on OPERATOR_RAG_ENABLED.
 *
 * Disabled (default): inject DisabledOperatorRetrieval + a no-op indexer. ZERO embedding
 * calls, no OPENROUTER_API_KEY required — the embedding adapter is never constructed.
 *
 * Enabled: require OPENROUTER_API_KEY (DATABASE_URL is already required upstream), then
 * construct the OpenRouter embedding adapter, pg index + hybrid similarity adapters, and
 * the deadline-aware OperatorRetrieval + fail-soft StrategyRetrievalIndexer.
 */
export function buildOperatorRag(
  env: ReturnType<typeof loadEnv>,
  db: Db,
  strategyProfiles: StrategyProfileRepository,
  events: AgentEventRepository,
): OperatorRag {
  if (!env.OPERATOR_RAG_ENABLED) {
    return { retrieval: new DisabledOperatorRetrieval(), indexer: new NoopStrategyRetrievalIndexer() };
  }

  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required when OPERATOR_RAG_ENABLED=true');

  const embedding = new OpenRouterEmbeddingAdapter(env.OPERATOR_EMBEDDING_MODEL, env.OPENROUTER_API_KEY);
  const indexPort = new PgStrategyRetrievalIndexAdapter(db, {
    embeddingModel: env.OPERATOR_EMBEDDING_MODEL,
    indexVersion: env.OPERATOR_RETRIEVAL_INDEX_VERSION,
  });
  const similarity = new PgHybridStrategySimilarityAdapter(db);

  // §7 conditional reranker — scaffold, OFF unless OPERATOR_RERANKER=mastra. RRF stays the baseline +
  // fallback. Scaffold note: reuses the operator interpreter model for the relevance scorer and
  // metadata-only candidate text; a dedicated reranker model + richer candidate text are finalized in
  // the future enable-slice (gated on an independent eval corpus).
  let reranker: RerankerPort | undefined;
  if (env.OPERATOR_RERANKER === 'mastra') {
    const scorer = createRerankerScorer(resolveLanguageModel(env, env.TURN_INTERPRETER_MODEL).model);
    reranker = new MastraRerankerAdapter(scorer);
  }
  const rerankConfig: RerankConfig = {
    timeoutMs: env.OPERATOR_RERANK_TIMEOUT_MS,
    limit: env.OPERATOR_RERANK_LIMIT,
    minCandidates: env.OPERATOR_RERANK_MIN_CANDIDATES,
    rrfMargin: env.OPERATOR_RERANK_RRF_MARGIN,
  };

  const retrieval = new OperatorRetrieval({
    embedding,
    strategyProfiles,
    similarity,
    ...(reranker ? { reranker } : {}),
    rerankConfig,
    clock: () => performance.now(),
    scheduler: realScheduler,
    isoNow: () => new Date().toISOString(),
    softDeadlineMs: env.OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS,
    hardDeadlineMs: env.OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS,
    lexicalLimit: env.OPERATOR_RETRIEVAL_LEXICAL_LIMIT,
    vectorLimit: env.OPERATOR_RETRIEVAL_VECTOR_LIMIT,
    fusedLimit: env.OPERATOR_RETRIEVAL_FUSED_LIMIT,
  });

  const indexer = new StrategyRetrievalIndexer(
    embedding,
    indexPort,
    { embeddingModel: env.OPERATOR_EMBEDDING_MODEL, indexVersion: env.OPERATOR_RETRIEVAL_INDEX_VERSION },
    () => new Date().toISOString(),
    events,
  );

  return { retrieval, indexer };
}

function buildBuilder(rt: MastraRuntime): BuilderPort {
  const e = rt.agents.builder;
  if (e) return new MastraBuilder(e.agent, e.label);
  console.warn('[composition] BUILDER_ADAPTER is not "mastra"; using FakeBuilder (template bundles)');
  return new FakeBuilder();
}

/**
 * Strategy-bundle-authoring builder for the strategy-baseline experiment lane. Reuses the SAME
 * BUILDER_ADAPTER / BUILDER_MODEL env as the legacy `buildBuilder` overlay wiring above — no new
 * env var, no second model-selection knob. Mirrors scripts/code-analyst-roundtrip.mts /
 * scripts/prove-builder-loop.mts.
 */
function buildStrategyBuilder(env: ReturnType<typeof loadEnv>): StrategyBuilder {
  if (env.BUILDER_ADAPTER === 'mastra') {
    const resolved = resolveLanguageModel(env, env.BUILDER_MODEL);
    const strategyBuilderAgent = createStrategyBuilderAgent({ model: resolved.model, authoringDoc: getAuthoringDoc('strategy') });
    return new MastraStrategyBuilder(strategyBuilderAgent, resolved.label);
  }
  console.warn('[composition] BUILDER_ADAPTER is not "mastra"; using FakeStrategyBuilder (template bundle)');
  return new FakeStrategyBuilder();
}

/** Operator confirmation window for a proposed chat action — policy, not deployment tuning. */
const CHAT_PROPOSAL_TTL_MS = 10 * 60 * 1000;

export function composeRuntime() {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');

  const mastraRuntime = composeMastra(env);

  const { db, pool } = createDbClient(env.DATABASE_URL);
  const queue = new BullMqQueueAdapter(env.REDIS_URL);

  const hypotheses = new DrizzleHypothesisProposalRepository(db);
  const strategyProfiles = new DrizzleStrategyProfileRepository(db);
  const events = new DrizzleAgentEventRepository(db);

  // Operator RAG (retrieval + fail-soft indexer), gated on OPERATOR_RAG_ENABLED.
  const operatorRag = buildOperatorRag(env, db, strategyProfiles, events);

  const researchPlatform = selectResearchPlatform(env.TRADING_PLATFORM_INTEGRATION);
  const researchIntegration = env.TRADING_PLATFORM_INTEGRATION;
  const backtests = new DrizzleBacktestRunRepository(db);
  const experiments = new DrizzleResearchExperimentRepository(db);
  const runTrades = selectRunTrades(env.TRADING_PLATFORM_INTEGRATION);
  const platformPoll = { maxPolls: env.PLATFORM_RUN_MAX_POLLS, pollDelayMs: env.PLATFORM_RUN_POLL_DELAY_MS };
  const backtestCallbackUrl = buildBacktestCallbackUrl(env.TRADING_LAB_CALLBACK_PUBLIC_URL, env.TRADING_LAB_CALLBACK_TOKEN);
  const now = () => new Date().toISOString();

  const experimentRunExecutor = new BacktesterExperimentRunExecutor({
    platform: researchPlatform,
    backtests,
    researchIntegration,
    fragilityTopTradePct: env.evaluatorThresholds.fragilityTopTradePct,
    poll: platformPoll,
    ...(backtestCallbackUrl !== undefined ? { callbackUrl: backtestCallbackUrl } : {}),
    now,
  });
  const strategyBacktests = new DrizzleStrategyBacktestRunRepository(db);
  const strategyRunExecutor = new BacktesterStrategyExperimentRunExecutor({
    platform: researchPlatform,
    strategyBacktests,
    poll: platformPoll,
    ...(backtestCallbackUrl !== undefined ? { callbackUrl: backtestCallbackUrl } : {}),
    now,
  });
  // WFO agent adapters: env-driven mastra/fake adapter selection, mirroring buildCritic/buildStrategyCritic.
  const paramGridRunner = new ParamGridRunner({ strategyRunExecutor });
  const tokenUsage = new DrizzleTokenUsageRepository(db);
  const experimentService = new ExperimentService({
    experiments,
    runTrades,
    runExecutor: experimentRunExecutor,
    strategyRunExecutor,
    newId: (p) => `${p}-${randomUUID()}`,
    now,
    events,
    gate1: buildGate1(env, mastraRuntime),
    sweepDesigner: buildSweepDesigner(env, mastraRuntime),
    resultInterpreter: buildResultInterpreter(env, mastraRuntime),
    paramGridRunner,
    strategyBacktests,
    wfoBudget: DEFAULT_WFO_BUDGET,
    tokenUsage,
    researchTaskTokenBudget: env.RESEARCH_TASK_TOKEN_BUDGET,
  });

  const services: AppServices = {
    taskQueue: queue,
    researchTasks: new DrizzleResearchTaskRepository(db),
    strategyProfiles,
    analyst: buildAnalyst(mastraRuntime),
    artifacts: new LocalFileArtifactStore(env.ARTIFACT_DIR),
    events,
    platform: new MockPlatformGatewayAdapter(),
    researchPlatform,
    researchIntegration,
    botResults: selectBotResults(process.env),
    marketHistory: selectMarketHistory(process.env),
    tradeEvidence: selectTradeEvidence(process.env),
    researcher: buildResearcher(mastraRuntime),
    critic: buildCritic(env, mastraRuntime),
    strategyCritic: buildStrategyCritic(env, mastraRuntime),
    hypotheses,
    hypothesisReviews: new DrizzleHypothesisReviewRepository(db),
    similarHypotheses: new InMemoryLexicalSimilarHypothesisSearch(hypotheses),
    maxHypothesesPerCycle: env.MAX_HYPOTHESES_PER_CYCLE,
    tokenUsage,
    modelPricing: new OpenRouterModelPricing(),
    researchTaskTokenBudget: env.RESEARCH_TASK_TOKEN_BUDGET,
    builder: buildBuilder(mastraRuntime),
    builds: new DrizzleHypothesisBuildRepository(db),
    backtests,
    evaluations: new DrizzleEvaluationRepository(db),
    evaluatorThresholds: env.evaluatorThresholds,
    chatSessions: new DrizzleChatSessionRepository(db),
    chatPlans: new DrizzleChatPlanRepository(db),
    actionProposals: new DrizzleActionProposalRepository(db),
    strategyRetrievalIndexer: operatorRag.indexer,
    backtestBackend: env.BACKTEST_BACKEND,
    platformPoll,
    backtestCallbackUrl,
    baselineVersion: env.TRADING_PLATFORM_BASELINE_VERSION,
    defaultPlatformRun: { datasetId: 'ESPORTSUSDT:1h', symbols: ['ESPORTSUSDT'], timeframe: '1h', period: { from: '2026-06-12', to: '2026-06-19' }, seed: 42 },
    researchDefaultSymbol: 'ESPORTSUSDT',
    experiments,
    runTrades,
    experimentService,
    strategyBuilder: buildStrategyBuilder(env),
    strategyBacktests,
  };

  const router = new WorkflowRouter();
  router.register('strategy.onboard', strategyOnboardHandler);
  router.register('research.run_cycle', researchRunCycleHandler);
  router.register('hypothesis.build', hypothesisBuildHandler);
  router.register('backtest.resume', backtestResumeHandler());
  router.register('backtest.completed', backtestCompletedHandler);
  router.register('strategy.baseline', strategyBaselineHandler);
  router.register('strategy.wfo', strategyWfoHandler);

  const chat: ChatAppDeps = {
    interpreter: buildTurnInterpreter(mastraRuntime),
    retrieval: operatorRag.retrieval,
    sessions: services.chatSessions,
    plans: services.chatPlans,
    researchTasks: services.researchTasks,
    strategyProfiles: services.strategyProfiles,
    hypotheses: services.hypotheses,
    events: services.events,
    queue,
    proposals: services.actionProposals,
    strategyCritic: services.strategyCritic,
    proposalTtlMs: CHAT_PROPOSAL_TTL_MS,
    minConfidence: env.TURN_INTERPRETER_MIN_CONFIDENCE,
    defaultPlatformRun: services.defaultPlatformRun,
    maxMessageChars: env.CHAT_MAX_MESSAGE_CHARS,
    authToken: env.TRADING_LAB_CHAT_TOKEN,
  };

  const agentEventsRead = new DrizzleAgentEventReadAdapter(db);
  const projection = new AgentActivityProjection(env.AGENT_ACTIVITY_TRACE_LIMIT);
  const agentStream = new PgNotifyAgentEventStream(pool, agentEventsRead, {
    safetyTickMs: env.AGENT_EVENT_STREAM_SAFETY_TICK_MS,
  });

  const read: ReadApiDeps = {
    hypotheses: new DrizzleHypothesisReadAdapter(db),
    backtests: new DrizzleBacktestReadAdapter(db),
    agentEvents: agentEventsRead,
    projection,
    agentStream,
    streamHeartbeatMs: env.AGENT_EVENT_STREAM_HEARTBEAT_MS,
    checkReadiness: async () => {
      try { await db.execute(sql`select 1`); return true; } catch { return false; }
    },
    token: env.TRADING_LAB_READ_TOKEN ?? '',
    researchTasks: services.researchTasks,
    strategyProfiles,
    tokenUsage: services.tokenUsage,
    phoenixTraces: new PhoenixTraceReader({
      enabled: env.PHOENIX_ENABLED,
      baseUrl: env.PHOENIX_READ_BASE_URL,
      projectName: env.PHOENIX_PROJECT_NAME,
      apiKey: env.PHOENIX_API_KEY,
    }),
    experiments: new DrizzleExperimentReadAdapter(db),
  };

  return { env, db, pool, queue, router, services, chat, read, mastraRuntime };
}
