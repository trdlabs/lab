import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleResearchTaskRepository } from './drizzle-research-task.repository.ts';
import { researchTask } from '../../db/schema.ts';
import type { ResearchTask } from '../../domain/types.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: crypto.randomUUID(), taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'accepted', payload: { a: 1 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
});

d('DrizzleResearchTaskRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleResearchTaskRepository(db);

  beforeAll(async () => { await db.delete(researchTask); });
  afterAll(async () => { await pool.end(); });

  it('creates, finds, and updates status', async () => {
    const t = task({ dedupeKey: 'dk-1' });
    await repo.create(t);
    expect((await repo.findById(t.id))?.payload).toEqual({ a: 1 });
    expect((await repo.findByDedupeKey('dk-1'))?.id).toBe(t.id);
    await repo.updateStatus(t.id, 'completed');
    expect((await repo.findById(t.id))?.status).toBe('completed');
  });

  it('throws when updating a missing id', async () => {
    await expect(repo.updateStatus('does-not-exist', 'completed')).rejects.toThrow(/not found/);
  });

  describe('startRunUnlessTerminal (P1-3 terminal fence — the load-bearing conditional UPDATE)', () => {
    it('transitions a non-terminal task (accepted/queued/running/failed) to running → true', async () => {
      for (const status of ['accepted', 'queued', 'running', 'failed'] as const) {
        const t = task({ status });
        await repo.create(t);
        expect(await repo.startRunUnlessTerminal(t.id)).toBe(true);
        expect((await repo.findById(t.id))?.status).toBe('running');
      }
    });

    it('refuses a terminal task (completed/rejected) → false, status unchanged', async () => {
      for (const status of ['completed', 'rejected'] as const) {
        const t = task({ status });
        await repo.create(t);
        expect(await repo.startRunUnlessTerminal(t.id)).toBe(false);
        expect((await repo.findById(t.id))?.status).toBe(status);
      }
    });

    it('throws when the task does not exist', async () => {
      await expect(repo.startRunUnlessTerminal('p13-missing')).rejects.toThrow(/not found/);
    });
  });

  it('[P1-1] listQueued returns only queued rows ordered by (createdAt, id)', async () => {
    await db.delete(researchTask);
    const mk = (id: string, status: ResearchTask['status'], createdAt: string) => repo.create(task({ id, status, createdAt }));
    await mk('b', 'queued', '2026-01-01T00:00:02.000Z');
    await mk('a', 'queued', '2026-01-01T00:00:02.000Z');
    await mk('early', 'queued', '2026-01-01T00:00:01.000Z');
    await mk('done', 'completed', '2026-01-01T00:00:00.000Z');
    expect((await repo.listQueued()).map((t) => t.id)).toEqual(['early', 'a', 'b']);
  });

  it('[P1-1] round-trips availableAt and maps SQL NULL to undefined', async () => {
    const withAt = task({ status: 'queued', availableAt: '2026-07-14T00:00:05.000Z' });
    const without = task({ status: 'queued' }); // availableAt undefined
    await repo.create(withAt);
    await repo.create(without);
    expect((await repo.findById(withAt.id))?.availableAt).toBe('2026-07-14T00:00:05.000Z');
    expect((await repo.findById(without.id))?.availableAt).toBeUndefined();
  });
});
