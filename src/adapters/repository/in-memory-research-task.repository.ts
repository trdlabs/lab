import type { AgentTaskType, ResearchTask, TaskStatus } from '../../domain/types.ts';
import type { ResearchTaskRepository } from '../../ports/research-task.repository.ts';

export class InMemoryResearchTaskRepository implements ResearchTaskRepository {
  private readonly byId = new Map<string, ResearchTask>();

  async create(task: ResearchTask): Promise<void> {
    if (this.byId.has(task.id)) throw new Error(`research_task already exists: ${task.id}`);
    this.byId.set(task.id, { ...task });
  }

  async findById(id: string): Promise<ResearchTask | null> {
    return this.byId.get(id) ?? null;
  }

  async findByDedupeKey(dedupeKey: string): Promise<ResearchTask | null> {
    for (const t of this.byId.values()) {
      if (t.dedupeKey === dedupeKey) return t;
    }
    return null;
  }

  async listByCorrelationAndTypes(correlationId: string, taskTypes: AgentTaskType[]): Promise<ResearchTask[]> {
    const types = new Set(taskTypes);
    return [...this.byId.values()].filter((t) => t.correlationId === correlationId && types.has(t.taskType));
  }

  async updateStatus(id: string, status: TaskStatus): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) throw new Error(`research_task not found: ${id}`);
    this.byId.set(id, { ...existing, status, updatedAt: new Date().toISOString() });
  }
}
