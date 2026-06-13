import { describe, it, expect } from 'vitest';
import { resolveStatusTask, resolveResearchProfile, resolveBuildableHypothesis, type RefResolverDeps } from './ref-resolver.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryHypothesisProposalRepository } from '../adapters/repository/in-memory-hypothesis-proposal.repository.ts';
import type { ChatSessionContext } from '../ports/chat-session.repository.ts';
import type { ResearchTask } from '../domain/types.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { ChatIntent } from './intent.ts';

const session = (over: Partial<ChatSessionContext> = {}): ChatSessionContext => ({
  sessionId: 's1', updatedAt: '2026-06-13T00:00:00Z', ...over,
});
const task = (id: string): ResearchTask => ({
  id, taskType: 'strategy.onboard', source: 'web', correlationId: 'c1', status: 'running',
  payload: {}, createdAt: '2026-06-13T00:00:00Z', updatedAt: '2026-06-13T00:00:00Z',
});
const hyp = (id: string, profileId: string, status: HypothesisProposal['status']): HypothesisProposal => ({
  id, strategyProfileId: profileId, thesis: 't', targetBehavior: 'b',
  ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
  requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
  invalidationCriteria: ['x'], confidence: 0.5, status, fingerprint: `sha256:${id}`,
  proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

function deps(): RefResolverDeps & {
  researchTasks: InMemoryResearchTaskRepository;
  strategyProfiles: InMemoryStrategyProfileRepository;
  hypotheses: InMemoryHypothesisProposalRepository;
} {
  return {
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    hypotheses: new InMemoryHypothesisProposalRepository(),
  };
}

const noHint: ChatIntent = { intent: 'task.status', confidence: 0.9 };

describe('resolveStatusTask', () => {
  it('resolves the session pointer when the task exists', async () => {
    const d = deps();
    await d.researchTasks.create(task('t1'));
    expect((await resolveStatusTask(noHint, session({ lastResearchTaskId: 't1' }), d))?.id).toBe('t1');
  });

  it('verifies an untrusted taskIdHint against the repo', async () => {
    const d = deps();
    await d.researchTasks.create(task('t9'));
    const intent: ChatIntent = { intent: 'task.status', confidence: 0.9, taskIdHint: 't9' };
    expect((await resolveStatusTask(intent, session(), d))?.id).toBe('t9');
  });

  it('returns null when neither pointer nor hint resolves', async () => {
    const d = deps();
    const intent: ChatIntent = { intent: 'task.status', confidence: 0.9, taskIdHint: 'ghost' };
    expect(await resolveStatusTask(intent, session(), d)).toBeNull();
  });
});

describe('resolveResearchProfile', () => {
  it('returns null without a session pointer', async () => {
    const d = deps();
    expect(await resolveResearchProfile(session(), d)).toBeNull();
  });
});

describe('resolveBuildableHypothesis', () => {
  it('returns the validated hypothesis the pointer names', async () => {
    const d = deps();
    await d.hypotheses.create(hyp('h1', 'p1', 'validated'));
    expect((await resolveBuildableHypothesis(session({ lastHypothesisId: 'h1' }), d))?.id).toBe('h1');
  });

  it('returns null when the pointed hypothesis is not validated (no silent fallback)', async () => {
    const d = deps();
    await d.hypotheses.create(hyp('h1', 'p1', 'rejected'));
    expect(await resolveBuildableHypothesis(session({ lastHypothesisId: 'h1' }), d)).toBeNull();
  });

  it('falls back to latest validated by profile when no hypothesis pointer is set', async () => {
    const d = deps();
    await d.hypotheses.create(hyp('h1', 'p1', 'validated'));
    expect((await resolveBuildableHypothesis(session({ lastStrategyProfileId: 'p1' }), d))?.id).toBe('h1');
  });

  it('returns null when nothing is resolvable', async () => {
    const d = deps();
    expect(await resolveBuildableHypothesis(session(), d)).toBeNull();
  });
});
