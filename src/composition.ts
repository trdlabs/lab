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
import { resolveLanguageModel } from './adapters/llm/model-provider.ts';

function buildAnalyst(env: ReturnType<typeof loadEnv>): StrategyAnalystPort {
  if (env.STRATEGY_ANALYST_ADAPTER === 'mastra') {
    const r = resolveLanguageModel(env, env.STRATEGY_ANALYST_MODEL);
    return new MastraStrategyAnalyst(r.model, r.label);
  }
  console.warn('[composition] STRATEGY_ANALYST_ADAPTER is not "mastra"; using FakeStrategyAnalyst (stub analysis)');
  return new FakeStrategyAnalyst();
}

function buildResearcher(env: ReturnType<typeof loadEnv>): ResearcherPort {
  if (env.RESEARCHER_ADAPTER === 'mastra') {
    const r = resolveLanguageModel(env, env.RESEARCHER_MODEL);
    return new MastraResearcher(r.model, r.label);
  }
  console.warn('[composition] RESEARCHER_ADAPTER is not "mastra"; using FakeResearcher (stub hypotheses)');
  return new FakeResearcher();
}

function buildCritic(env: ReturnType<typeof loadEnv>): CriticPort | null {
  if (!env.ENABLE_CRITIC_AGENT) return null;
  if (env.CRITIC_ADAPTER === 'mastra') {
    const r = resolveLanguageModel(env, env.CRITIC_MODEL);
    return new MastraCritic(r.model, r.label);
  }
  console.warn('[composition] ENABLE_CRITIC_AGENT=true but CRITIC_ADAPTER is not "mastra"; using FakeCritic');
  return new FakeCritic();
}

function buildBuilder(env: ReturnType<typeof loadEnv>): BuilderPort {
  if (env.BUILDER_ADAPTER === 'mastra') {
    const r = resolveLanguageModel(env, env.BUILDER_MODEL);
    return new MastraBuilder(r.model, r.label);
  }
  console.warn('[composition] BUILDER_ADAPTER is not "mastra"; using FakeBuilder (template bundles)');
  return new FakeBuilder();
}

export function composeRuntime() {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');

  const { db, pool } = createDbClient(env.DATABASE_URL);
  const queue = new BullMqQueueAdapter(env.REDIS_URL);

  const hypotheses = new DrizzleHypothesisProposalRepository(db);

  const services: AppServices = {
    researchTasks: new DrizzleResearchTaskRepository(db),
    strategyProfiles: new DrizzleStrategyProfileRepository(db),
    analyst: buildAnalyst(env),
    artifacts: new LocalFileArtifactStore(env.ARTIFACT_DIR),
    events: new DrizzleAgentEventRepository(db),
    platform: new MockPlatformGatewayAdapter(),
    researcher: buildResearcher(env),
    critic: buildCritic(env),
    hypotheses,
    hypothesisReviews: new DrizzleHypothesisReviewRepository(db),
    similarHypotheses: new InMemoryLexicalSimilarHypothesisSearch(hypotheses),
    maxHypothesesPerCycle: env.MAX_HYPOTHESES_PER_CYCLE,
    builder: buildBuilder(env),
    builds: new DrizzleHypothesisBuildRepository(db),
    backtests: new DrizzleBacktestRunRepository(db),
    evaluations: new DrizzleEvaluationRepository(db),
    evaluatorThresholds: env.evaluatorThresholds,
  };

  const router = new WorkflowRouter();
  router.register('strategy.onboard', strategyOnboardHandler);
  router.register('research.run_cycle', researchRunCycleHandler);
  router.register('hypothesis.build', hypothesisBuildHandler);

  return { env, db, pool, queue, router, services };
}
