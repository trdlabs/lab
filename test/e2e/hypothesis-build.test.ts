// test/e2e/hypothesis-build.test.ts
import { describe, it, expect } from 'vitest';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { hypothesisBuildHandler } from '../../src/orchestrator/handlers/hypothesis-build.handler.ts';
import { makeServices } from '../support/make-services.ts';
import type { ResearchTask } from '../../src/domain/types.ts';
import type { HypothesisProposal } from '../../src/domain/hypothesis.ts';
import type { StrategyProfile } from '../../src/domain/strategy-profile.ts';

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return { id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:s', direction: 'long', coreIdea: 'oi filter', requiredMarketFeatures: ['oi', 'funding'], confidence: 0.6, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1', createdAt: now, updatedAt: now };
}
function hypothesis(over: Partial<HypothesisProposal> = {}): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return { id: 'h1', strategyProfileId: 'p1', thesis: 'Skip entries when oi trend persists', targetBehavior: 'filter entries', ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend persists for 2 bars', action: 'skip_entry', params: { bars: 2 } }] }, requiredFeatures: ['oi', 'funding'], validationPlan: 'backtest 90d', expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['no improvement'], confidence: 0.5, status: 'validated', fingerprint: 'sha256:abc', proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now, ...over };
}
function task(): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  const platformRun = { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 };
  return { id: 't1', taskType: 'hypothesis.build', source: 'operator', correlationId: 'c1', status: 'running', payload: { hypothesisId: 'h1', platformRun }, createdAt: now, updatedAt: now };
}

describe('e2e hypothesis.build', () => {
  it('routes through the router and evaluates to a decision', async () => {
    const s = makeServices();
    await s.strategyProfiles.create(profile());
    await s.hypotheses.create(hypothesis());
    const router = new WorkflowRouter();
    router.register('hypothesis.build', hypothesisBuildHandler);

    await router.dispatch(task(), s);

    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs[0]?.status).toBe('evaluated');
    expect((await s.evaluations.listByBacktestRun(runs[0]!.id))[0]?.decision).toBe('PAPER_CANDIDATE');
  });
});
