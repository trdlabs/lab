import { describe, it, expect } from 'vitest';
import { parseTurn, planChatAction, type PlanArgs } from './guard.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryHypothesisProposalRepository } from '../adapters/repository/in-memory-hypothesis-proposal.repository.ts';
import type { ChatSessionContext } from '../ports/chat-session.repository.ts';
import type { InterpretedTurn } from './turn-interpretation.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { ResearchTask } from '../domain/types.ts';

const session = (over: Partial<ChatSessionContext> = {}): ChatSessionContext => ({
  sessionId: 's1', updatedAt: '2026-06-13T00:00:00Z', ...over,
});

/** Build a valid InterpretedTurn with sensible defaults. */
const turn = (over: Partial<InterpretedTurn> = {}): InterpretedTurn => ({
  subject: 'strategy', constraints: {}, references: [], confidence: 0.9, ...over,
});

function mkDeps() {
  return {
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    hypotheses: new InMemoryHypothesisProposalRepository(),
  };
}

const defaultPlatformRun = { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 };

function args(over: Partial<PlanArgs> = {}, deps = mkDeps()): { plan: PlanArgs; deps: ReturnType<typeof mkDeps> } {
  return {
    plan: { message: 'm', session: session(), minConfidence: 0.6, deps, defaultPlatformRun, ...over },
    deps,
  };
}

const profile = (id: string): StrategyProfile => ({
  id, version: 1, sourceKind: 'manual_description', sourceFingerprint: `sha256:${id}`,
  direction: 'long', coreIdea: 'idea', requiredMarketFeatures: [], confidence: 0.5, unknowns: [],
  profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const validatedHyp = (id: string, profileId: string): HypothesisProposal => ({
  id, strategyProfileId: profileId, thesis: 't', targetBehavior: 'b',
  ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
  requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
  invalidationCriteria: ['x'], confidence: 0.5, status: 'validated', fingerprint: `sha256:${id}`,
  proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const task = (id: string): ResearchTask => ({
  id, taskType: 'strategy.onboard', source: 'web', correlationId: 'c1', status: 'running',
  payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

describe('parseTurn (schema gate)', () => {
  it('accepts a valid interpreted turn', () => {
    const r = parseTurn({ subject: 'strategy', strategyText: 'x', constraints: {}, references: [], confidence: 0.9 });
    expect(r.ok).toBe(true);
  });
  it('normalizes provider null optionals before validation', () => {
    const r = parseTurn({
      subject: 'strategy', goal: null, strategyText: 'x',
      constraints: { market: null, timeframe: '1m', symbol: null, direction: null },
      references: [], confidence: 0.9,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turn.goal).toBeUndefined();
      expect(r.turn.constraints).toEqual({ timeframe: '1m' });
    }
  });
  it('rejects malformed interpreter output', () => {
    const r = parseTurn({ subject: 'transfer.funds', confidence: 2 });
    expect(r.ok).toBe(false);
  });
});

describe('planChatAction', () => {
  it('unknown subject -> out_of_scope', async () => {
    const { plan } = args();
    const d = await planChatAction(turn({ subject: 'unknown', confidence: 0.95 }), plan);
    expect(d.kind).toBe('respond');
    if (d.kind === 'respond') {
      expect(d.response.kind).toBe('out_of_scope');
      expect(d.auditReason).toBe('interpreter_unknown_subject');
    }
  });

  it('low confidence -> needs_clarification, no task', async () => {
    const { plan } = args();
    const d = await planChatAction(turn({ subject: 'strategy', confidence: 0.2, strategyText: 'x' }), plan);
    expect(d.kind).toBe('respond');
    if (d.kind === 'respond') {
      expect(d.response.kind).toBe('needs_clarification');
      expect(d.auditReason).toBe('low_confidence');
    }
  });

  it('results subject -> capability_not_available with capability results.trading', async () => {
    const { plan } = args();
    const d = await planChatAction(turn({ subject: 'results', confidence: 0.9 }), plan);
    expect(d.kind).toBe('respond');
    if (d.kind === 'respond') {
      expect(d.response.kind).toBe('capability_not_available');
      if (d.response.kind === 'capability_not_available') {
        expect(d.response.capability).toBe('results.trading');
      }
    }
  });

  it('bot subject -> capability_not_available with capability bot.status', async () => {
    const { plan } = args();
    const d = await planChatAction(turn({ subject: 'bot', confidence: 0.9 }), plan);
    expect(d.kind).toBe('respond');
    if (d.kind === 'respond') {
      expect(d.response.kind).toBe('capability_not_available');
      if (d.response.kind === 'capability_not_available') {
        expect(d.response.capability).toBe('bot.status');
      }
    }
  });

  it('task subject with a resolvable session pointer -> task_status', async () => {
    const { plan, deps } = args({ session: session({ lastResearchTaskId: 't1' }) });
    await deps.researchTasks.create(task('t1'));
    const d = await planChatAction(turn({ subject: 'task', confidence: 0.9 }), plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('task_status');
  });

  it('task subject resolves an untrusted reference id via findById', async () => {
    const { plan, deps } = args();
    await deps.researchTasks.create(task('t9'));
    const d = await planChatAction(turn({ subject: 'task', confidence: 0.9, references: ['t9'] }), plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('task_status');
  });

  it('task subject with nothing resolvable -> needs_clarification', async () => {
    const { plan } = args();
    const d = await planChatAction(turn({ subject: 'task', confidence: 0.9 }), plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('needs_clarification');
  });

  it('strategy subject (goal undefined) -> propose_task, action=strategy.analyze, no chain', async () => {
    const { plan } = args();
    const d = await planChatAction(turn({ subject: 'strategy', confidence: 0.9, strategyText: 'go long on oi' }), plan);
    expect(d.kind).toBe('propose_task');
    if (d.kind === 'propose_task') {
      expect(d.action).toBe('strategy.analyze');
      expect(d.taskType).toBe('strategy.onboard');
      expect(d.payload).toEqual({ kind: 'manual_description', content: 'go long on oi' });
      expect(d.chain).toBeUndefined();
    }
  });

  it('strategy subject goal=analyze -> propose_task action=strategy.analyze, no chain', async () => {
    const { plan } = args();
    const d = await planChatAction(turn({ subject: 'strategy', goal: 'analyze', confidence: 0.9, strategyText: 'go long on oi' }), plan);
    expect(d.kind).toBe('propose_task');
    if (d.kind === 'propose_task') {
      expect(d.action).toBe('strategy.analyze');
      expect(d.chain).toBeUndefined();
    }
  });

  it('strategy subject falls back to the raw message when strategyText is absent', async () => {
    const { plan } = args({ message: 'standalone strategy body' });
    const d = await planChatAction(turn({ subject: 'strategy', confidence: 0.9 }), plan);
    expect(d.kind).toBe('propose_task');
    if (d.kind === 'propose_task') {
      expect(d.payload).toEqual({ kind: 'manual_description', content: 'standalone strategy body' });
    }
  });

  it('strategy subject + goal=research -> propose_task action=research.run_cycle taskType=strategy.onboard with chain', async () => {
    const { plan } = args();
    const text = 'go long on oi spike';
    const d = await planChatAction(turn({ subject: 'strategy', goal: 'research', confidence: 0.9, strategyText: text }), plan);
    expect(d).toMatchObject({ kind: 'propose_task', action: 'research.run_cycle', taskType: 'strategy.onboard', chain: { nextTaskType: 'research.run_cycle' } });
    if (d.kind === 'propose_task') {
      expect(d.chain?.resolveProfileByFingerprint).toBe(sourceFingerprint('manual_description', text));
    }
  });

  it('hypothesis subject via latest validated by profile -> propose_task action=hypothesis.build', async () => {
    const { plan, deps } = args({ session: session({ lastStrategyProfileId: 'p1' }) });
    await deps.hypotheses.create(validatedHyp('h1', 'p1'));
    await deps.strategyProfiles.create(profile('p1'));
    const d = await planChatAction(turn({ subject: 'hypothesis', confidence: 0.9 }), plan);
    expect(d.kind).toBe('propose_task');
    if (d.kind === 'propose_task') {
      expect(d.action).toBe('hypothesis.build');
      expect(d.taskType).toBe('hypothesis.build');
      expect(d.payload).toEqual({ hypothesisId: 'h1', cycleDepth: 0, platformRun: defaultPlatformRun });
    }
  });

  it('hypothesis subject includes defaultPlatformRun in payload', async () => {
    const defaultPlatformRun = { datasetId: 'D:1h', symbols: ['D'], timeframe: '1h', period: { from: 'a', to: 'b' }, seed: 7 };
    const { plan, deps } = args({ session: session({ lastStrategyProfileId: 'p1' }), defaultPlatformRun });
    await deps.hypotheses.create(validatedHyp('h1', 'p1'));
    await deps.strategyProfiles.create(profile('p1'));
    const d = await planChatAction(turn({ subject: 'hypothesis', confidence: 0.9 }), plan);
    expect(d.kind).toBe('propose_task');
    if (d.kind === 'propose_task') {
      expect(d.taskType).toBe('hypothesis.build');
      expect(d.payload.hypothesisId).toBe('h1');
      expect(d.payload.platformRun).toEqual(defaultPlatformRun);
    }
  });

  it('hypothesis subject with no resolvable hypothesis -> needs_clarification', async () => {
    const { plan } = args();
    const d = await planChatAction(turn({ subject: 'hypothesis', confidence: 0.9 }), plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('needs_clarification');
  });
});
