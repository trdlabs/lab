import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';

export class InMemoryAgentEventRepository implements AgentEventRepository {
  private readonly events: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    this.events.push({ ...event });
  }

  async listByTask(taskId: string): Promise<AgentEvent[]> {
    return this.events.filter((e) => e.taskId === taskId);
  }
}
