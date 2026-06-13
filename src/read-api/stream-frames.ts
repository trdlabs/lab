// Pure: compute the SSE frames for one event given the agent's previous status.
// Only agent_event_appended carries the keyset `id` (resumable); agent_status_changed
// is a derived signal with no id, so replay-from-cursor re-derives it without gaps.
import { encodeCursor } from './pagination.ts';
import { toAgentEventDto } from './mappers.ts';
import { agentIdForType, lifecycleForType, type AgentLifecycle } from './agent-taxonomy.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';
import type { AgentStatusChanged, AgentEventAppended } from './dto.ts';

export const SSE_STATUS_CHANGED = 'agent_status_changed';
export const SSE_EVENT_APPENDED = 'agent_event_appended';

export interface StreamFrame {
  id?: string;
  event: typeof SSE_STATUS_CHANGED | typeof SSE_EVENT_APPENDED;
  data: AgentStatusChanged | AgentEventAppended;
}

export function framesForEvent(
  prev: AgentLifecycle | undefined,
  row: AgentEventRow,
): { frames: StreamFrame[]; status: AgentLifecycle } {
  const agentId = agentIdForType(row.type);
  const status = lifecycleForType(row.type);
  const dto = toAgentEventDto(row);
  const frames: StreamFrame[] = [];
  if (prev !== status) {
    frames.push({ event: SSE_STATUS_CHANGED, data: { agentId, status, currentTaskId: row.taskId, ts: row.createdAt } });
  }
  frames.push({ id: encodeCursor({ t: row.createdAt, id: row.id }), event: SSE_EVENT_APPENDED, data: { agentId, event: dto } });
  return { frames, status };
}
