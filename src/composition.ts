import { loadEnv } from './config/env.ts';
import { BullMqQueueAdapter } from './adapters/queue/bullmq-queue.adapter.ts';
import { DrizzleResearchTaskRepository } from './adapters/repository/drizzle-research-task.repository.ts';
import { DrizzleStrategyProfileRepository } from './adapters/repository/drizzle-strategy-profile.repository.ts';
import { DrizzleAgentEventRepository } from './adapters/repository/drizzle-agent-event.repository.ts';
import { LocalFileArtifactStore } from './adapters/artifact/local-file-artifact-store.adapter.ts';
import { FakeStrategyAnalyst } from './adapters/analyst/fake-strategy-analyst.ts';
import { MastraStrategyAnalyst } from './adapters/analyst/mastra-strategy-analyst.ts';
import { createDbClient } from './db/client.ts';
import { WorkflowRouter } from './orchestrator/workflow-router.ts';
import { strategyOnboardHandler } from './orchestrator/handlers/strategy-onboard.handler.ts';
import { researchRunCycleHandler } from './orchestrator/handlers/research-run-cycle.handler.ts';
import { hypothesisBuildHandler } from './orchestrator/handlers/hypothesis-build.handler.ts';
import { backtestCompletedHandler } from './orchestrator/handlers/backtest-completed.handler.ts';
import { backtestResumeHandler } from './orchestrator/handlers/backtest-resume.handler.ts';
import { buildBacktestCallbackUrl } from './config/backtest-callback-url.ts';
import type { AppServices } from './orchestrator/app-services.ts';
import type { StrategyAnalystPort } from './ports/strategy-analyst.port.ts';
import { MockPlatformGatewayAdapter } from './adapters/platform/mock-platform-gateway.adapter.ts';
import { selectResearchPlatform } from './adapters/platform/select-research-platform.ts';
import { selectBotResults } from './adapters/platform/select-bot-results.ts';
import { MockTradeEvidenceAdapter } from './adapters/platform/mock-trade-evidence.adapter.ts';
import { FakeResearcher } from './adapters/researcher/fake-researcher.ts';
import { MastraResearcher } from './adapters/researcher/mastra-researcher.ts';
import { FakeCritic } from './adapters/critic/fake-critic.ts';
import { MastraCritic } from './adapters/critic/mastra-critic.ts';
import { DrizzleHypothesisProposalRepository } from './adapters/repository/drizzle-hypothesis-proposal.repository.ts';
import { DrizzleHypothesisReviewRepository } from './adapters/repository/drizzle-hypothesis-review.repository.ts';
import { InMemoryLexicalSimilarHypothesisSearch } from './adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts';
import type { ResearcherPort } from './ports/researcher.port.ts';
import type { CriticPort } from './ports/critic.port.ts';
import { FakeBuilder } from './adapters/builder/fake-builder.ts';
import { MastraBuilder } from './adapters/builder/mastra-builder.ts';
import { DrizzleHypothesisBuildRepository } from './adapters/repository/drizzle-hypothesis-build.repository.ts';
import { DrizzleBacktestRunRepository } from './adapters/repository/drizzle-backtest-run.repository.ts';
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
import { AgentActivityProjection } from './read-api/projection.ts';
import { PgNotifyAgentEventStream } from './adapters/read/pg-notify-agent-event-stream.ts';
import type { ReadApiDeps } from './read-api/deps.ts';

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

function buildTurnInterpreter(rt: MastraRuntime): TurnInterpreterPort {
  const e = rt.agents.turnInterpreter;
  if (e) return new MastraTurnInterpreter(e.agent, e.label);
  console.warn('[composition] INTENT_CLASSIFIER_ADAPTER is not "mastra"; using FakeTurnInterpreter (rule-based)');
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
    const scorer = createRerankerScorer(resolveLanguageModel(env, env.INTENT_CLASSIFIER_MODEL).model);
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

  const services: AppServices = {
    taskQueue: queue,
    researchTasks: new DrizzleResearchTaskRepository(db),
    strategyProfiles,
    analyst: buildAnalyst(mastraRuntime),
    artifacts: new LocalFileArtifactStore(env.ARTIFACT_DIR),
    events,
    platform: new MockPlatformGatewayAdapter(),
    researchPlatform: selectResearchPlatform(env.TRADING_PLATFORM_INTEGRATION),
    botResults: selectBotResults(process.env),
    tradeEvidence: new MockTradeEvidenceAdapter(),
    researcher: buildResearcher(mastraRuntime),
    critic: buildCritic(env, mastraRuntime),
    hypotheses,
    hypothesisReviews: new DrizzleHypothesisReviewRepository(db),
    similarHypotheses: new InMemoryLexicalSimilarHypothesisSearch(hypotheses),
    maxHypothesesPerCycle: env.MAX_HYPOTHESES_PER_CYCLE,
    builder: buildBuilder(mastraRuntime),
    builds: new DrizzleHypothesisBuildRepository(db),
    backtests: new DrizzleBacktestRunRepository(db),
    evaluations: new DrizzleEvaluationRepository(db),
    evaluatorThresholds: env.evaluatorThresholds,
    chatSessions: new DrizzleChatSessionRepository(db),
    chatPlans: new DrizzleChatPlanRepository(db),
    actionProposals: new DrizzleActionProposalRepository(db),
    strategyRetrievalIndexer: operatorRag.indexer,
    backtestBackend: env.BACKTEST_BACKEND,
    platformPoll: { maxPolls: env.PLATFORM_RUN_MAX_POLLS, pollDelayMs: env.PLATFORM_RUN_POLL_DELAY_MS },
    backtestCallbackUrl: buildBacktestCallbackUrl(env.TRADING_LAB_CALLBACK_PUBLIC_URL, env.TRADING_LAB_CALLBACK_TOKEN),
    baselineVersion: env.TRADING_PLATFORM_BASELINE_VERSION,
    defaultPlatformRun: { datasetId: 'default', symbols: ['ESPORTSUSDT'], timeframe: '1h', period: { from: '2026-06-12', to: '2026-06-18' }, seed: 42 },
    researchDefaultSymbol: 'ESPORTSUSDT',
  };

  const router = new WorkflowRouter();
  router.register('strategy.onboard', strategyOnboardHandler);
  router.register('research.run_cycle', researchRunCycleHandler);
  router.register('hypothesis.build', hypothesisBuildHandler);
  router.register('backtest.resume', backtestResumeHandler());
  router.register('backtest.completed', backtestCompletedHandler);

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
    proposalTtlMs: CHAT_PROPOSAL_TTL_MS,
    minConfidence: env.INTENT_CLASSIFIER_MIN_CONFIDENCE,
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
  };

  return { env, db, pool, queue, router, services, chat, read, mastraRuntime };
}
