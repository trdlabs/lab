import { z } from 'zod';
import type { AgentId, AgentLifecycle } from './agent-taxonomy.ts';

const limit = z.coerce.number().int().min(1).max(100).default(20);
const BACKTEST_STATUSES = ['queued', 'submitted', 'running', 'completed', 'rejected', 'failed', 'evaluated'] as const;

export const HypothesisListQuerySchema = z.object({
  status: z.enum(['validated', 'rejected']).optional(),
  profileId: z.string().min(1).optional(),
  limit,
  cursor: z.string().min(1).optional(),
});

export const BacktestListQuerySchema = z.object({
  hypothesisId: z.string().min(1).optional(),
  status: z.enum(BACKTEST_STATUSES).optional(),
  limit,
  cursor: z.string().min(1).optional(),
});

export const AgentEventListQuerySchema = z.object({
  taskId: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  correlationId: z.string().min(1).optional(),
  limit,
  cursor: z.string().min(1).optional(),
});

// ---- DTO shapes (allowlist; mappers enforce these) ----
export interface ExpectedEffectDto { metric: string; direction: 'increase' | 'decrease'; magnitude?: string; }
export interface RulesSummaryDto { appliesTo: string; ruleCount: number; }

export interface HypothesisListItemDto {
  id: string; profileId: string; thesis: string; targetBehavior: string;
  status: 'validated' | 'rejected'; confidence: number;
  expectedEffect: ExpectedEffectDto; rulesSummary: RulesSummaryDto;
  createdAt: string; updatedAt: string;
}

export interface CuratedRuleDto { when: string; action: string; rationale?: string; }

export interface HypothesisDetailDto extends HypothesisListItemDto {
  requiredFeatures: string[];
  invalidationCriteria: string[];
  rules: { appliesTo: string; rules: CuratedRuleDto[] };
  rejectionReasons?: string[];
}

export interface BacktestMetricsDto {
  netPnlUsd: number | null; netPnlPct: number | null; totalTrades: number | null; winRate: number | null;
  profitFactor: number | null; maxDrawdownPct: number | null; expectancyUsd: number | null; sharpe: number | null; topTradeContributionPct: number | null;
}

export interface BacktestDto {
  id: string; hypothesisId: string; status: string;
  metrics: BacktestMetricsDto;
  delta: { netPnlUsd: number | null; maxDrawdownPct: number | null };
  isFragile: boolean | null;
  submittedAt: string; finishedAt: string | null; createdAt: string; updatedAt: string;
}

export interface AgentEventDto {
  id: string; ts: string; type: string; taskId: string;
  correlationId?: string;
  level: 'info' | 'warn' | 'error';
  summary: string;
  payloadSummary?: Record<string, unknown>;
}

export interface ListEnvelope<T> { data: T[]; page: { nextCursor: string | null; limit: number }; }

export interface AgentSummaryDto {
  agentId: AgentId;
  status: AgentLifecycle;
  currentTaskId: string | null;
  lastEvent: AgentEventDto | null;
}

export interface AgentActivityDto {
  agentId: AgentId;
  status: AgentLifecycle;
  currentTask: { id: string; type: string; status: AgentLifecycle } | null; // type = latest event type
  trace: AgentEventDto[]; // ring-buffer tail, oldest→newest, sanitized
}

// SSE delta payloads (carried as `data:` JSON).
export interface AgentStatusChanged { agentId: AgentId; status: AgentLifecycle; currentTaskId: string | null; ts: string; }
export interface AgentEventAppended { agentId: AgentId; event: AgentEventDto; }

// ---- Experiment DTOs ----
export const ExperimentListQuerySchema = z.object({
  strategyProfileId: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
  limit,
  cursor: z.string().optional(),
});

export interface ExperimentDto {
  id: string;
  experimentType: string;
  strategyProfileId: string;
  hypothesisId: string | null;
  buildId: string | null;
  bundleHash: string | null;
  status: string;
  verdict: string | null;
  verdictReason: string | null;
  datasetScope: unknown;
  holdoutPolicy: unknown;
  holdoutBoundary: unknown | null;
  aggregateMetrics: unknown | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ExperimentRunMemberDto {
  id: string;
  experimentId: string;
  backtestRunId: string | null;
  role: string;
  foldId: number | null;
  periodFrom: string;
  periodTo: string;
  symbols: string[];
  tradeCount: number | null;
  resultSummary: unknown | null;
  createdAt: string;
}
