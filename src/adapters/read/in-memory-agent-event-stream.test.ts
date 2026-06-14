import { describe, it, expect } from 'vitest';
import { InMemoryAgentEventStream } from './in-memory-agent-event-stream.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

const row = (id: string): AgentEventRow => ({ id, taskId: 't', type: 'researcher.started', payload: {}, createdAt: `2026-01-01T00:00:0${id}.000Z` });

describe('InMemoryAgentEventStream', () => {
  it('fans pushed rows to all subscribers until unsubscribed', async () => {
    const s = new InMemoryAgentEventStream();
    await s.start();
    const a: string[] = []; const b: string[] = [];
    const offA = s.subscribe((r) => a.push(r.id));
    s.subscribe((r) => b.push(r.id));
    s.push(row('1'));
    offA();
    s.push(row('2'));
    expect(a).toEqual(['1']);
    expect(b).toEqual(['1', '2']);
    await s.stop();
  });
});
