import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleActionProposalRepository } from './drizzle-action-proposal.repository.ts';
import { actionProposal, chatSession } from '../../db/schema.ts';
import type { ActionProposal } from '../../domain/action-proposal.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const baseProposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
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

d('DrizzleActionProposalRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleActionProposalRepository(db);

  beforeAll(async () => {
    // action_proposal has no FK to chat_session, but delete proposal rows first anyway
    await db.delete(actionProposal);
  });

  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    await db.delete(actionProposal);
  });

  // ---- create + findById defensive copy ----

  it('creates and returns defensive copies', async () => {
    await repo.create(baseProposal());
    const found = await repo.findById('p1');
    expect(found).toEqual(baseProposal());
    // mutating the returned object must not affect the stored row
    found!.task.payload.content = 'mutated';
    const again = await repo.findById('p1');
    expect(again?.task.payload.content).toBe('лонг после пролива');
  });

  it('findById returns null for unknown id', async () => {
    expect(await repo.findById('does-not-exist')).toBeNull();
  });

  // ---- confirm once then already_confirmed ----

  it('confirms a live pending proposal once, then already_confirmed', async () => {
    await repo.create(baseProposal());
    const r1 = await repo.confirmPending('p1', 's1', '2026-06-18T12:05:00.000Z');
    expect(r1.kind).toBe('confirmed_now');
    const r2 = await repo.confirmPending('p1', 's1', '2026-06-18T12:05:01.000Z');
    expect(r2.kind).toBe('already_confirmed');
    expect(r2).toHaveProperty('proposal');
  });

  // ---- not_found for other session + expired for past now ----

  it('returns not_found for wrong session', async () => {
    await repo.create(baseProposal());
    const r = await repo.confirmPending('p1', 'other-session', '2026-06-18T12:05:00.000Z');
    expect(r.kind).toBe('not_found');
  });

  it('returns expired when now is past expiresAt', async () => {
    await repo.create(baseProposal());
    const r = await repo.confirmPending('p1', 's1', '2026-06-18T12:11:00.000Z');
    expect(r.kind).toBe('expired');
    expect(r).toHaveProperty('proposal');
  });

  // ---- cancel only live pending ----

  it('cancels only a live pending proposal', async () => {
    await repo.create(baseProposal());
    expect(await repo.cancelPending('p1', 's1', '2026-06-18T12:05:00.000Z')).toBe(true);
    // second cancel should fail (already cancelled)
    expect(await repo.cancelPending('p1', 's1', '2026-06-18T12:05:01.000Z')).toBe(false);
  });

  it('cancelPending returns false for wrong session', async () => {
    await repo.create(baseProposal());
    expect(await repo.cancelPending('p1', 'other', '2026-06-18T12:05:00.000Z')).toBe(false);
  });

  it('cancelPending returns false for expired proposal', async () => {
    await repo.create(baseProposal());
    expect(await repo.cancelPending('p1', 's1', '2026-06-18T12:11:00.000Z')).toBe(false);
  });

  // ---- totality: confirmPending after cancel -> not_found ----

  it('confirmPending after cancel returns not_found (totality)', async () => {
    await repo.create(baseProposal());
    await repo.cancelPending('p1', 's1', '2026-06-18T12:05:00.000Z');
    const r = await repo.confirmPending('p1', 's1', '2026-06-18T12:06:00.000Z');
    expect(r.kind).toBe('not_found');
  });

  // ---- totality: attachTask throws on missing / not-confirmed ----

  it('attachTask throws when proposal not found', async () => {
    await expect(repo.attachTask('missing', 'task-1', '2026-06-18T12:05:00.000Z')).rejects.toThrow();
  });

  it('attachTask throws when proposal is not confirmed (still pending)', async () => {
    await repo.create(baseProposal());
    await expect(repo.attachTask('p1', 'task-1', '2026-06-18T12:05:00.000Z')).rejects.toThrow();
  });

  // ---- attachTask sets confirmedTaskId on a confirmed proposal ----

  it('attachTask sets confirmedTaskId on a confirmed proposal', async () => {
    await repo.create(baseProposal());
    await repo.confirmPending('p1', 's1', '2026-06-18T12:05:00.000Z');
    await repo.attachTask('p1', 'task-1', '2026-06-18T12:05:01.000Z');
    const found = await repo.findById('p1');
    expect(found?.confirmedTaskId).toBe('task-1');
  });
});
