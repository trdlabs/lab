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
});
