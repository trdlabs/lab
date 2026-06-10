import type { AppServices } from '../../src/orchestrator/app-services.ts';
import { InMemoryResearchTaskRepository } from '../../src/adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../../src/adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryAgentEventRepository } from '../../src/adapters/repository/in-memory-agent-event.repository.ts';
import { InMemoryArtifactStore } from '../../src/adapters/artifact/in-memory-artifact-store.ts';
import { FakeStrategyAnalyst } from '../../src/adapters/analyst/fake-strategy-analyst.ts';
import { MockPlatformGatewayAdapter } from '../../src/adapters/platform/mock-platform-gateway.adapter.ts';
import { FakeResearcher } from '../../src/adapters/researcher/fake-researcher.ts';
import { InMemoryHypothesisProposalRepository } from '../../src/adapters/repository/in-memory-hypothesis-proposal.repository.ts';
import { InMemoryHypothesisReviewRepository } from '../../src/adapters/repository/in-memory-hypothesis-review.repository.ts';
import { InMemoryLexicalSimilarHypothesisSearch } from '../../src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts';

export function makeServices(overrides: Partial<AppServices> = {}): AppServices {
  const hypotheses = new InMemoryHypothesisProposalRepository();
  return {
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    analyst: new FakeStrategyAnalyst(),
    artifacts: new InMemoryArtifactStore(),
    events: new InMemoryAgentEventRepository(),
    platform: new MockPlatformGatewayAdapter(),
    researcher: new FakeResearcher(),
    critic: null, // base happy-path does not invoke Critic; tests opt in via overrides
    hypotheses,
    hypothesisReviews: new InMemoryHypothesisReviewRepository(),
    similarHypotheses: new InMemoryLexicalSimilarHypothesisSearch(hypotheses),
    maxHypothesesPerCycle: 5,
    ...overrides,
  };
}
