import type { AgentTaskType } from '../domain/types.ts';

export type ChatPlanStatus = 'pending' | 'advanced' | 'failed' | 'cancelled';

/**
 * A pending auto-chain continuation. MVP supports exactly one hop:
 * strategy.onboard (afterTaskId) -> research.run_cycle, resolving the produced
 * profile by the canonical sourceFingerprint.
 */
export interface ChatPlan {
  id: string;
  sessionId: string;
  afterTaskId: string;
  nextTaskType: AgentTaskType;
  resolveProfileByFingerprint: string;
  correlationId: string;
  status: ChatPlanStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChatPlanRepository {
  create(plan: ChatPlan): Promise<void>;
  findById(id: string): Promise<ChatPlan | null>;
  findPendingByAfterTaskId(afterTaskId: string): Promise<ChatPlan | null>;
  markAdvanced(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
}
