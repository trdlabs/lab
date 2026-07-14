import { describe, it, expect } from 'vitest';
import { InMemoryResearchTaskRepository } from './in-memory-research-task.repository.ts';
import type { ResearchTask } from '../../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'accepted', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});

describe('InMemoryResearchTaskRepository', () => {
  it('creates and finds by id', async () => {
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task({ id: 'a' }));
    expect((await repo.findById('a'))?.id).toBe('a');
    expect(await repo.findById('missing')).toBeNull();
  });

  it('finds by dedupeKey', async () => {
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task({ id: 'a', dedupeKey: 'k' }));
    expect((await repo.findByDedupeKey('k'))?.id).toBe('a');
    expect(await repo.findByDedupeKey('nope')).toBeNull();
  });

  it('updates status', async () => {
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task({ id: 'a' }));
    await repo.updateStatus('a', 'completed');
    expect((await repo.findById('a'))?.status).toBe('completed');
  });

  it('throws when creating a duplicate id', async () => {
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task({ id: 'a' }));
    await expect(repo.create(task({ id: 'a' }))).rejects.toThrow(/already exists/);
  });

  it('throws when updating a missing id', async () => {
    const repo = new InMemoryResearchTaskRepository();
    await expect(repo.updateStatus('missing', 'completed')).rejects.toThrow(/not found/);
  });

  it('refreshes updatedAt on status change', async () => {
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task({ id: 'a', updatedAt: '2026-06-10T00:00:00Z' }));
    await repo.updateStatus('a', 'completed');
    expect((await repo.findById('a'))?.updatedAt).not.toBe('2026-06-10T00:00:00Z');
  });

  describe('startRunUnlessTerminal (P1-3 terminal fence)', () => {
    it('transitions a non-terminal task → true, status becomes running', async () => {
      const repo = new InMemoryResearchTaskRepository();
      for (const status of ['accepted', 'queued', 'running', 'failed'] as const) {
        await repo.create(task({ id: status, status }));
        expect(await repo.startRunUnlessTerminal(status)).toBe(true);
        expect((await repo.findById(status))?.status).toBe('running');
      }
    });

    it('refuses a terminal task → false, status unchanged', async () => {
      const repo = new InMemoryResearchTaskRepository();
      for (const status of ['completed', 'rejected'] as const) {
        await repo.create(task({ id: status, status }));
        expect(await repo.startRunUnlessTerminal(status)).toBe(false);
        expect((await repo.findById(status))?.status).toBe(status);
      }
    });

    it('throws when the task does not exist', async () => {
      const repo = new InMemoryResearchTaskRepository();
      await expect(repo.startRunUnlessTerminal('missing')).rejects.toThrow(/not found/);
    });
  });

  describe('listQueued (P1-1)', () => {
    it('returns only queued rows, ordered by createdAt then id', async () => {
      const repo = new InMemoryResearchTaskRepository();
      await repo.create(task({ id: 'b', status: 'queued', createdAt: '2026-01-01T00:00:02Z' }));
      await repo.create(task({ id: 'a', status: 'queued', createdAt: '2026-01-01T00:00:02Z' }));
      await repo.create(task({ id: 'early', status: 'queued', createdAt: '2026-01-01T00:00:01Z' }));
      await repo.create(task({ id: 'done', status: 'completed', createdAt: '2026-01-01T00:00:00Z' }));
      await repo.create(task({ id: 'run', status: 'running', createdAt: '2026-01-01T00:00:00Z' }));
      const ids = (await repo.listQueued()).map((t) => t.id);
      expect(ids).toEqual(['early', 'a', 'b']); // createdAt asc, then id asc; non-queued excluded
    });
  });
});
