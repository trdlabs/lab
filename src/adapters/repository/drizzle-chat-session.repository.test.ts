import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleChatSessionRepository } from './drizzle-chat-session.repository.ts';
import { chatSession } from '../../db/schema.ts';
import type { ChatSessionContext } from '../../ports/chat-session.repository.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const sessionId = 'test-session-fixed';
const ctx = (over: Partial<ChatSessionContext> = {}): ChatSessionContext => ({
  sessionId, updatedAt: new Date().toISOString(), ...over,
});

d('DrizzleChatSessionRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleChatSessionRepository(db);

  beforeAll(async () => {
    // This suite only touches chat_session. Clean just that table so it stays isolated
    // from the action_proposal suite when vitest runs DB suites in parallel (no FK links them).
    await db.delete(chatSession);
  });
  afterAll(async () => { await pool.end(); });

  it('returns null for an unknown session', async () => {
    expect(await repo.get('does-not-exist')).toBeNull();
  });

  it('upserts then reads back, and a second upsert overwrites', async () => {
    const c = ctx({ lastStrategyProfileId: 'p1', lastUserGoal: 'strategy.onboard' });
    await repo.upsert(c);
    expect((await repo.get(c.sessionId))?.lastStrategyProfileId).toBe('p1');

    await repo.upsert({ ...c, lastStrategyProfileId: 'p2', lastHypothesisId: 'h9', updatedAt: new Date().toISOString() });
    const got = await repo.get(c.sessionId);
    expect(got?.lastStrategyProfileId).toBe('p2');
    expect(got?.lastHypothesisId).toBe('h9');
  });

  it('persists and returns pendingInteraction round-trip', async () => {
    const pendingInteraction = {
      kind: 'action_confirmation' as const,
      proposalId: 'proposal-1',
      expiresAt: '2026-06-18T12:10:00.000Z',
    };
    await repo.upsert(ctx({ pendingInteraction }));
    expect((await repo.get(sessionId))?.pendingInteraction).toEqual(pendingInteraction);
  });

  it('clears pendingInteraction when upserted without it', async () => {
    const pendingInteraction = {
      kind: 'action_confirmation' as const,
      proposalId: 'proposal-2',
      expiresAt: '2026-06-18T12:10:00.000Z',
    };
    await repo.upsert(ctx({ pendingInteraction }));
    // upsert again without pendingInteraction — should clear to undefined
    await repo.upsert(ctx({ updatedAt: new Date().toISOString() }));
    expect((await repo.get(sessionId))?.pendingInteraction).toBeUndefined();
  });
});
