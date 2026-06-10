import type { AGENT_TASK_TYPES, TASK_SOURCES } from './schemas.ts';

export type AgentTaskType = (typeof AGENT_TASK_TYPES)[number];
export type TaskSource = (typeof TASK_SOURCES)[number];

export type TaskStatus = 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'rejected';

export interface QueueEnvelope {
  taskId: string;
  taskType: AgentTaskType;
  correlationId: string;
  source: TaskSource;
  attempt: number;
  dedupeKey?: string;
}

export interface ResearchTask {
  id: string;
  taskType: AgentTaskType;
  source: TaskSource;
  correlationId: string;
  dedupeKey?: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRef {
  artifact_id: string;
  uri: string;
  content_hash: string; // sha256:<hex>
  kind: string;
  size_bytes: number;
  mime_type: string;
  created_at: string;
  producer: string;
  metadata: Record<string, unknown>;
}

export interface BacktestRunRef {
  platformRunId: string;
  correlationId: string;
  submittedAt: string;
}
