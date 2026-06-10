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
import type { AppServices } from './orchestrator/app-services.ts';
import type { StrategyAnalystPort } from './ports/strategy-analyst.port.ts';

function buildAnalyst(env: ReturnType<typeof loadEnv>): StrategyAnalystPort {
  if (env.STRATEGY_ANALYST_ADAPTER === 'mastra') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required when STRATEGY_ANALYST_ADAPTER=mastra');
    return new MastraStrategyAnalyst(env.STRATEGY_ANALYST_MODEL);
  }
  // Make the no-op default loud: a deploy that forgot STRATEGY_ANALYST_ADAPTER=mastra
  // would otherwise silently return stub profiles for every onboarding.
  console.warn('[composition] STRATEGY_ANALYST_ADAPTER is not "mastra"; using FakeStrategyAnalyst (stub analysis)');
  return new FakeStrategyAnalyst();
}

export function composeRuntime() {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');

  const { db, pool } = createDbClient(env.DATABASE_URL);
  const queue = new BullMqQueueAdapter(env.REDIS_URL);

  const services: AppServices = {
    researchTasks: new DrizzleResearchTaskRepository(db),
    strategyProfiles: new DrizzleStrategyProfileRepository(db),
    analyst: buildAnalyst(env),
    artifacts: new LocalFileArtifactStore(env.ARTIFACT_DIR),
    events: new DrizzleAgentEventRepository(db),
  };

  const router = new WorkflowRouter();
  router.register('strategy.onboard', strategyOnboardHandler);

  return { env, db, pool, queue, router, services };
}
