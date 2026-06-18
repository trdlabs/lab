import { describe, expect, it } from 'vitest';
import { InMemoryActionProposalRepository } from './in-memory-action-proposal.repository.ts';
import type { ActionProposal } from '../../domain/action-proposal.ts';

const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
  id: 'p1',
  sessionId: 's1',
  subjectHash: 'sha256:subject',
  action: 'strategy.analyze',
  source: 'web',
  task: {
    taskType: 'strategy.onboard',
    payload: { kind: 'manual_description', content: 'лонг после пролива' },
    dedupeKey: 'chat-proposal:p1',
    userGoal: 'strategy.onboard',
  },
  status: 'pending',
  expiresAt: '2026-06-18T12:10:00.000Z',
  createdAt: '2026-06-18T12:00:00.000Z',
  updatedAt: '2026-06-18T12:00:00.000Z',
  ...over,
});

describe('InMemoryActionProposalRepository', () => {
  it('creates and returns defensive copies', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    const found = await repo.findById('p1');
    expect(found).toEqual(proposal());
    found!.task.payload.content = 'mutated';
    expect((await repo.findById('p1'))?.task.payload.content).toBe('лонг после пролива');
  });

  it('confirms a live pending proposal once', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    expect((await repo.confirmPending('p1', 's1', '2026-06-18T12:05:00.000Z')).kind).toBe('confirmed_now');
    expect((await repo.confirmPending('p1', 's1', '2026-06-18T12:05:01.000Z')).kind).toBe('already_confirmed');
  });

  it('does not confirm another session or an expired proposal', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    expect((await repo.confirmPending('p1', 'other', '2026-06-18T12:05:00.000Z')).kind).toBe('not_found');
    expect((await repo.confirmPending('p1', 's1', '2026-06-18T12:11:00.000Z')).kind).toBe('expired');
  });

  it('cancels only a live pending proposal', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    expect(await repo.cancelPending('p1', 's1', '2026-06-18T12:05:00.000Z')).toBe(true);
    expect(await repo.cancelPending('p1', 's1', '2026-06-18T12:05:01.000Z')).toBe(false);
  });
});
