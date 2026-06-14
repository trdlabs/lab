import { describe, it, expect } from 'vitest';
import { AgentActivityProjection } from './projection.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';

function ev(id: string, type: string, over: Partial<AgentEventRow> = {}): AgentEventRow {
  return { id, taskId: 't1', type, payload: {}, createdAt: `2026-01-01T00:00:${id.padStart(2, '0')}.000Z`, ...over };
}

describe('AgentActivityProjection', () => {
  it('boots known agents idle with null currentTask and empty trace', () => {
    const p = new AgentActivityProjection(50);
    const snap = p.snapshot();
    expect(snap.cursor).toBeNull();
    expect(snap.data.map((a) => a.agentId)).toEqual(['analyst', 'researcher', 'critic', 'builder']);
    expect(snap.data.every((a) => a.status === 'idle' && a.currentTaskId === null && a.lastEvent === null)).toBe(true);
    expect(p.getAgent('researcher')).toEqual({ agentId: 'researcher', status: 'idle', currentTask: null, trace: [] });
  });

  it('derives working then retains the terminal outcome (idle does not overwrite)', () => {
    const p = new AgentActivityProjection(50);
    p.apply(ev('01', 'researcher.started'));
    expect(p.getAgent('researcher')!.status).toBe('working');
    p.apply(ev('02', 'researcher.completed'));
    const a = p.getAgent('researcher')!;
    expect(a.status).toBe('succeeded');                 // terminal retained
    expect(a.currentTask).toEqual({ id: 't1', type: 'researcher.completed', status: 'succeeded' });
  });

  it('surfaces the system agent only after an unknown event', () => {
    const p = new AgentActivityProjection(50);
    expect(p.snapshot().data.map((a) => a.agentId)).not.toContain('system');
    expect(p.getAgent('system')).toBeNull();
    p.apply(ev('01', 'chat.message.received'));
    expect(p.snapshot().data.map((a) => a.agentId)).toContain('system');
    expect(p.getAgent('system')!.status).toBe('working');
  });

  it('caps the trace ring buffer and keeps newest', () => {
    const p = new AgentActivityProjection(2);
    p.apply(ev('01', 'researcher.started'));
    p.apply(ev('02', 'researcher.started'));
    p.apply(ev('03', 'researcher.completed'));
    const trace = p.getAgent('researcher')!.trace;
    expect(trace.length).toBe(2);
    expect(trace.map((e) => e.id)).toEqual(['02', '03']);
  });

  it('is idempotent and monotonic on the keyset cursor', () => {
    const p = new AgentActivityProjection(50);
    p.apply(ev('02', 'researcher.started'));
    const c1 = p.cursorKey();
    p.apply(ev('01', 'researcher.completed')); // older key → ignored
    expect(p.getAgent('researcher')!.status).toBe('working');
    expect(p.cursorKey()).toEqual(c1);
  });

  it('sanitizes the trace (no raw payload leak)', () => {
    const p = new AgentActivityProjection(50);
    p.apply(ev('01', 'some.unknown', { payload: { secret: 'X' } }));
    expect(JSON.stringify(p.snapshot())).not.toContain('X');
  });

  it('returns null for an unknown agentId (→ 404 at the route)', () => {
    expect(new AgentActivityProjection(50).getAgent('ghost' as never)).toBeNull();
  });
});
