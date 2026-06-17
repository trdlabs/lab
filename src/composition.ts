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
import type { AppServices } from './orchestrator/app-services.ts';
import type { StrategyAnalystPort } from './ports/strategy-analyst.port.ts';
import { MockPlatformGatewayAdapter } from './adapters/platform/mock-platform-gateway.adapter.ts';
import { selectResearchPlatform } from './adapters/platform/select-research-platform.ts';
import { selectBotResults } from './adapters/platform/select-bot-results.ts';
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
import { FakeIntentClassifier } from './adapters/intent/fake-intent-classifier.ts';
import { MastraIntentClassifier } from './adapters/intent/mastra-intent-classifier.ts';
import { DrizzleChatSessionRepository } from './adapters/repository/drizzle-chat-session.repository.ts';
import { DrizzleChatPlanRepository } from './adapters/repository/drizzle-chat-plan.repository.ts';
import type { IntentClassifierPort } from './ports/intent-classifier.port.ts';
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

function buildIntentClassifier(rt: MastraRuntime): IntentClassifierPort {
  const e = rt.agents.intentClassifier;
  if (e) return new MastraIntentClassifier(e.agent, e.label);
  console.warn('[composition] INTENT_CLASSIFIER_ADAPTER is not "mastra"; using FakeIntentClassifier (rule-based)');
  return new FakeIntentClassifier();
}

function buildBuilder(rt: MastraRuntime): BuilderPort {
  const e = rt.agents.builder;
  if (e) return new MastraBuilder(e.agent, e.label);
  console.warn('[composition] BUILDER_ADAPTER is not "mastra"; using FakeBuilder (template bundles)');
  return new FakeBuilder();
}

export function composeRuntime() {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');

  const mastraRuntime = composeMastra(env);

  const { db, pool } = createDbClient(env.DATABASE_URL);
  const queue = new BullMqQueueAdapter(env.REDIS_URL);

  const hypotheses = new DrizzleHypothesisProposalRepository(db);

  const services: AppServices = {
    researchTasks: new DrizzleResearchTaskRepository(db),
    strategyProfiles: new DrizzleStrategyProfileRepository(db),
    analyst: buildAnalyst(mastraRuntime),
    artifacts: new LocalFileArtifactStore(env.ARTIFACT_DIR),
    events: new DrizzleAgentEventRepository(db),
    platform: new MockPlatformGatewayAdapter(),
    researchPlatform: selectResearchPlatform(env.TRADING_PLATFORM_INTEGRATION),
    botResults: selectBotResults(process.env),
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
    backtestBackend: env.BACKTEST_BACKEND,
    platformPoll: { maxPolls: env.PLATFORM_RUN_MAX_POLLS, pollDelayMs: env.PLATFORM_RUN_POLL_DELAY_MS },
    baselineVersion: env.TRADING_PLATFORM_BASELINE_VERSION,
  };

  const router = new WorkflowRouter();
  router.register('strategy.onboard', strategyOnboardHandler);
  router.register('research.run_cycle', researchRunCycleHandler);
  router.register('hypothesis.build', hypothesisBuildHandler);

  const chat: ChatAppDeps = {
    classifier: buildIntentClassifier(mastraRuntime),
    sessions: services.chatSessions,
    plans: services.chatPlans,
    researchTasks: services.researchTasks,
    strategyProfiles: services.strategyProfiles,
    hypotheses: services.hypotheses,
    events: services.events,
    queue,
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
  };

  return { env, db, pool, queue, router, services, chat, read, mastraRuntime };
}
