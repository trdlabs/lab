export interface AgentEvent {
  id: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentEventRepository {
  append(event: AgentEvent): Promise<void>;
  listByTask(taskId: string): Promise<AgentEvent[]>;
}
