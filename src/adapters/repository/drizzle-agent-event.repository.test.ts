import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleAgentEventRepository } from './drizzle-agent-event.repository.ts';
import { agentEvent } from '../../db/schema.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('DrizzleAgentEventRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleAgentEventRepository(db);
  beforeAll(async () => { await db.delete(agentEvent); });
  afterAll(async () => { await pool.end(); });

  it('lists events by task ordered by created_at (not insertion order)', async () => {
    // Insert out of chronological order to prove the ORDER BY created_at clause:
    // 'completed' (later) is appended BEFORE 'started' (earlier).
    await repo.append({ id: crypto.randomUUID(), taskId: 'tA', type: 'strategy_analyst.completed', payload: {}, createdAt: '2026-06-11T00:00:02.000Z' });
    await repo.append({ id: crypto.randomUUID(), taskId: 'tA', type: 'strategy_analyst.started', payload: { model: 'm' }, createdAt: '2026-06-11T00:00:01.000Z' });
    await repo.append({ id: crypto.randomUUID(), taskId: 'tB', type: 'strategy_analyst.started', payload: {}, createdAt: '2026-06-11T00:00:01.000Z' });
    const a = await repo.listByTask('tA');
    expect(a.map((e) => e.type)).toEqual(['strategy_analyst.started', 'strategy_analyst.completed']);
    expect(a[0]!.payload).toEqual({ model: 'm' });
  });
});
