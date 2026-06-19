import type { AgentEventReadPort, AgentEventListQuery, AgentEventRow } from '../../ports/agent-event-read.port.ts';

function cmpAsc(a: AgentEventRow, b: AgentEventRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export class InMemoryAgentEventReadAdapter implements AgentEventReadPort {
  private readonly seed: AgentEventRow[];

  constructor(seed: AgentEventRow[] = []) {
    this.seed = seed;
  }

  async list(q: AgentEventListQuery): Promise<AgentEventRow[]> {
    let rows = [...this.seed];
    if (q.taskId) rows = rows.filter((r) => r.taskId === q.taskId);
    if (q.type) rows = rows.filter((r) => r.type === q.type);
    if (q.since) rows = rows.filter((r) => r.createdAt >= q.since!);
    if (q.correlationId) rows = rows.filter((r) => r.correlationId === q.correlationId);
    rows.sort(cmpAsc);
    if (q.after) {
      const { t, id } = q.after;
      rows = rows.filter((r) => r.createdAt > t || (r.createdAt === t && r.id > id));
    }
    return rows.slice(0, q.limit);
  }
}
