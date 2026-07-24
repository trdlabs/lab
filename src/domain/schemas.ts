import { z } from 'zod';

export const AGENT_TASK_TYPES = [
  'strategy.onboard', 'strategy.analyze_source', 'research.generate_hypotheses',
  'research.run_cycle', 'hypothesis.build', 'backtest.submit', 'backtest.resume', 'backtest.completed',
  'sweep.run', 'paper.start', 'paper.monitor', 'performance.review',
  'hypothesis.holdout',
  'research.pause', 'research.wake_check',
  'strategy.baseline', 'strategy.wfo',
  'revision.build', 'revision.consolidate', 'cycle.scorecard',
] as const;

export const TASK_SOURCES = ['telegram', 'web', 'crawler', 'cron', 'platform', 'operator'] as const;

export const AgentTaskTypeSchema = z.enum(AGENT_TASK_TYPES);
export const TaskSourceSchema = z.enum(TASK_SOURCES);

export const IngressTaskRequestSchema = z.object({
  taskType: AgentTaskTypeSchema,
  source: TaskSourceSchema,
  correlationId: z.string().min(1).optional(),
  dedupeKey: z.string().min(1).optional(),
  payload: z.record(z.unknown()).default({}),
});
export type IngressTaskRequest = z.infer<typeof IngressTaskRequestSchema>;

export const QueueEnvelopeSchema = z.object({
  taskId: z.string().min(1),
  taskType: AgentTaskTypeSchema,
  correlationId: z.string().min(1),
  source: TaskSourceSchema,
  attempt: z.number().int().positive(),
  dedupeKey: z.string().min(1).optional(),
});

export type ValidationSeverity = 'error' | 'warning';
export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  path: string;
  message: string;
}
export interface ValidationResult {
  status: 'valid' | 'invalid';
  issues: ValidationIssue[];
}
