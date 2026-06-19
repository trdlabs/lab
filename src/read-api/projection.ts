// In-memory Agent Activity Projection (read-only; never persisted). Serves the REST
// snapshot/activity endpoints. apply() is idempotent + monotonic on the keyset cursor.
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';
import type { Cursor } from '../ports/keyset.ts';
import { encodeCursor } from './pagination.ts';
import { toAgentEventDto } from './mappers.ts';
import { agentIdForType, lifecycleForType, KNOWN_AGENT_IDS, AGENT_IDS, type AgentId, type AgentLifecycle } from './agent-taxonomy.ts';
import type { AgentEventDto, AgentSummaryDto, AgentActivityDto } from './dto.ts';

interface AgentState {
  status: AgentLifecycle;
  currentTask: { id: string; type: string; status: AgentLifecycle } | null;
  lastEvent: AgentEventDto | null;
  trace: AgentEventDto[];
}

function freshIdle(): AgentState {
  return { status: 'idle', currentTask: null, lastEvent: null, trace: [] };
}

function isAfter(a: Cursor, b: Cursor): boolean {
  return a.t > b.t || (a.t === b.t && a.id > b.id);
}

export class AgentActivityProjection {
  private readonly state = new Map<AgentId, AgentState>();
  private cursor: Cursor | null = null;

  private readonly traceLimit: number;

  constructor(traceLimit: number) {
    this.traceLimit = traceLimit;
    for (const id of KNOWN_AGENT_IDS) this.state.set(id, freshIdle());
  }

  apply(row: AgentEventRow): void {
    const key: Cursor = { t: row.createdAt, id: row.id };
    if (this.cursor && !isAfter(key, this.cursor)) return; // idempotent / monotonic

    const agentId = agentIdForType(row.type);
    const status = lifecycleForType(row.type);
    const dto = toAgentEventDto(row);

    const s = this.state.get(agentId) ?? freshIdle();
    s.status = status;
    s.currentTask = { id: row.taskId, type: row.type, status };
    s.lastEvent = dto;
    s.trace.push(dto);
    if (s.trace.length > this.traceLimit) s.trace.shift();
    this.state.set(agentId, s);

    this.cursor = key;
  }

  cursorKey(): Cursor | null {
    return this.cursor ? { ...this.cursor } : null; // copy: never hand out the live cursor reference
  }

  snapshot(): { data: AgentSummaryDto[]; cursor: string | null } {
    const ids: AgentId[] = [...KNOWN_AGENT_IDS];
    if (this.state.has('system')) ids.push('system');
    const data = ids.map((agentId) => {
      const s = this.state.get(agentId)!;
      return { agentId, status: s.status, currentTaskId: s.currentTask?.id ?? null, lastEvent: s.lastEvent };
    });
    return { data, cursor: this.cursor ? encodeCursor(this.cursor) : null };
  }

  getAgent(agentId: AgentId): AgentActivityDto | null {
    if (!(AGENT_IDS as readonly string[]).includes(agentId)) return null;
    if (agentId === 'system' && !this.state.has('system')) return null;
    const s = this.state.get(agentId) ?? freshIdle();
    return { agentId, status: s.status, currentTask: s.currentTask, trace: [...s.trace] };
  }
}
