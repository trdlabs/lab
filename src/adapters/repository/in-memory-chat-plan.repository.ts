import type { ChatPlan, ChatPlanRepository, ChatPlanStatus } from '../../ports/chat-plan.repository.ts';

export class InMemoryChatPlanRepository implements ChatPlanRepository {
  private readonly byId = new Map<string, ChatPlan>();

  async create(plan: ChatPlan): Promise<void> {
    if (this.byId.has(plan.id)) throw new Error(`chat_plan already exists: ${plan.id}`);
    this.byId.set(plan.id, { ...plan });
  }

  async findById(id: string): Promise<ChatPlan | null> {
    const found = this.byId.get(id);
    return found ? { ...found } : null;
  }

  async findPendingByAfterTaskId(afterTaskId: string): Promise<ChatPlan | null> {
    for (const p of this.byId.values()) {
      if (p.afterTaskId === afterTaskId && p.status === 'pending') return { ...p };
    }
    return null;
  }

  async markAdvanced(id: string): Promise<void> {
    this.setStatus(id, 'advanced');
  }

  async markFailed(id: string): Promise<void> {
    this.setStatus(id, 'failed');
  }

  private setStatus(id: string, status: ChatPlanStatus): void {
    const existing = this.byId.get(id);
    if (!existing) throw new Error(`chat_plan not found: ${id}`);
    this.byId.set(id, { ...existing, status, updatedAt: new Date().toISOString() });
  }
}
