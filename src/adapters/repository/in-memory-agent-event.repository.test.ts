import { describe, it, expect } from 'vitest';
import { InMemoryAgentEventRepository } from './in-memory-agent-event.repository.ts';
import type { AgentEvent } from '../../ports/agent-event.repository.ts';

const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({
  id: 'e1', taskId: 't1', type: 'strategy_analyst.started', payload: { model: 'fake' },
  createdAt: '2026-06-11T00:00:00Z', ...over,
});

describe('InMemoryAgentEventRepository', () => {
  it('appends and lists events by task in insertion order', async () => {
    const repo = new InMemoryAgentEventRepository();
    await repo.append(ev({ id: 'a', taskId: 't1', type: 'strategy_analyst.started' }));
    await repo.append(ev({ id: 'b', taskId: 't1', type: 'strategy_analyst.completed' }));
    await repo.append(ev({ id: 'c', taskId: 't2', type: 'strategy_analyst.started' }));
    const t1 = await repo.listByTask('t1');
    expect(t1.map((e) => e.type)).toEqual(['strategy_analyst.started', 'strategy_analyst.completed']);
    expect(await repo.listByTask('none')).toEqual([]);
  });
});
