import { describe, it, expect } from 'vitest';
import { framesForEvent, SSE_STATUS_CHANGED, SSE_EVENT_APPENDED } from './stream-frames.ts';
import { encodeCursor } from './pagination.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';

const row: AgentEventRow = { id: 'e1', taskId: 't1', type: 'researcher.started', payload: { secret: 'X' }, createdAt: '2026-01-01T00:00:01.000Z' };

describe('framesForEvent', () => {
  it('emits status_changed (no id) + event_appended (id) on a status transition', () => {
    const { frames, status } = framesForEvent(undefined, row);
    expect(status).toBe('working');
    expect(frames).toHaveLength(2);

    const changed = frames[0]!;
    expect(changed.event).toBe(SSE_STATUS_CHANGED);
    expect(changed.id).toBeUndefined();                       // derived → non-resumable
    expect(changed.data).toEqual({ agentId: 'researcher', status: 'working', currentTaskId: 't1', ts: '2026-01-01T00:00:01.000Z' });

    const appended = frames[1]!;
    expect(appended.event).toBe(SSE_EVENT_APPENDED);
    expect(appended.id).toBe(encodeCursor({ t: row.createdAt, id: row.id })); // resumable keyset cursor
    expect((appended.data as { agentId: string }).agentId).toBe('researcher');
    expect(JSON.stringify(appended.data)).not.toContain('X'); // sanitized
  });

  it('omits status_changed when status is unchanged', () => {
    const { frames } = framesForEvent('working', row);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe(SSE_EVENT_APPENDED);
  });
});
