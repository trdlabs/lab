import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';
import type { HypothesisListItemDto, HypothesisDetailDto, BacktestDto, AgentEventDto, CuratedRuleDto, ExperimentDto, ExperimentRunMemberDto } from './dto.ts';
import type { ResearchExperiment, ExperimentRunMember } from '../domain/research-experiment.ts';

export function toHypothesisListItem(h: HypothesisProposal): HypothesisListItemDto {
  return {
    id: h.id, profileId: h.strategyProfileId, thesis: h.thesis, targetBehavior: h.targetBehavior,
    status: h.status, confidence: h.confidence,
    expectedEffect: { metric: h.expectedEffect.metric, direction: h.expectedEffect.direction, ...(h.expectedEffect.magnitude ? { magnitude: h.expectedEffect.magnitude } : {}) },
    rulesSummary: { appliesTo: h.ruleAction.appliesTo, ruleCount: h.ruleAction.rules.length },
    createdAt: h.createdAt, updatedAt: h.updatedAt,
  };
}

export function toHypothesisDetail(h: HypothesisProposal): HypothesisDetailDto {
  const rules: CuratedRuleDto[] = h.ruleAction.rules.map((r) => ({
    when: r.when, action: r.action, ...(r.rationale ? { rationale: r.rationale } : {}),
  }));
  return {
    ...toHypothesisListItem(h),
    requiredFeatures: h.requiredFeatures,
    invalidationCriteria: h.invalidationCriteria,
    rules: { appliesTo: h.ruleAction.appliesTo, rules },
    ...(h.status === 'rejected' ? { rejectionReasons: h.issues.map((i) => i.message) } : {}),
  };
}

export function toBacktestDto(b: BacktestRun): BacktestDto {
  const m = b.metrics;
  return {
    id: b.id, hypothesisId: b.hypothesisId, status: b.status,
    metrics: {
      netPnlUsd: m?.netPnlUsd ?? null, netPnlPct: m?.netPnlPct ?? null, totalTrades: m?.totalTrades ?? null,
      winRate: m?.winRate ?? null, profitFactor: m?.profitFactor ?? null, maxDrawdownPct: m?.maxDrawdownPct ?? null,
      expectancyUsd: m?.expectancyUsd ?? null, sharpe: m?.sharpe ?? null, topTradeContributionPct: m?.topTradeContributionPct ?? null,
    },
    delta: { netPnlUsd: b.deltaNetPnlUsd, maxDrawdownPct: b.deltaMaxDrawdownPct },
    isFragile: b.isFragile,
    submittedAt: b.submittedAt, finishedAt: b.finishedAt, createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
}

// ---- agent event sanitization (deny-by-default) ----
const PAYLOAD_ALLOWLIST: Record<string, string[]> = {
  'strategy_analyst.started': [],
  'strategy_analyst.completed': ['profileId', 'direction'],
  'strategy_analyst.failed': ['reason'],
  'strategy.onboard.deduped': ['profileId'],
};
const SUMMARY_BY_TYPE: Record<string, string> = {
  'strategy_analyst.started': 'Strategy analysis started',
  'strategy_analyst.completed': 'Strategy analysis completed',
  'strategy_analyst.failed': 'Strategy analysis failed',
  'strategy.onboard.deduped': 'Duplicate strategy onboarding skipped',
};

function deriveLevel(type: string): 'info' | 'warn' | 'error' {
  const t = type.toLowerCase();
  if (t.includes('fail') || t.includes('error') || t.includes('reject')) return 'error';
  if (t.includes('warn') || t.includes('skip') || t.includes('dedup')) return 'warn';
  return 'info';
}
function humanize(type: string): string {
  return type.replace(/[._]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}
function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}
function pickAllowed(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in payload && isScalar(payload[k])) out[k] = payload[k];
  return Object.keys(out).length > 0 ? out : undefined;
}

export function toAgentEventDto(row: AgentEventRow): AgentEventDto {
  const known = Object.prototype.hasOwnProperty.call(PAYLOAD_ALLOWLIST, row.type);
  const payloadSummary = known ? pickAllowed(row.payload, PAYLOAD_ALLOWLIST[row.type]!) : undefined;
  const dto: AgentEventDto = {
    id: row.id, ts: row.createdAt, type: row.type, taskId: row.taskId,
    level: deriveLevel(row.type),
    summary: SUMMARY_BY_TYPE[row.type] ?? humanize(row.type),
  };
  if (row.correlationId) dto.correlationId = row.correlationId;
  if (payloadSummary) dto.payloadSummary = payloadSummary;
  return dto;
}

// ---- Experiment mappers (null-preserving) ----
export function toExperimentDto(e: ResearchExperiment): ExperimentDto {
  return {
    id: e.id, experimentType: e.experimentType, strategyProfileId: e.strategyProfileId,
    hypothesisId: e.hypothesisId ?? null, buildId: e.buildId ?? null, bundleHash: e.bundleHash ?? null,
    status: e.status, verdict: e.verdict ?? null, verdictReason: e.verdictReason ?? null,
    datasetScope: e.datasetScope, holdoutPolicy: e.holdoutPolicy, holdoutBoundary: e.holdoutBoundary ?? null,
    aggregateMetrics: e.aggregateMetrics ?? null,
    createdAt: e.createdAt, updatedAt: e.updatedAt, completedAt: e.completedAt ?? null,
  };
}

export function toExperimentRunMemberDto(m: ExperimentRunMember): ExperimentRunMemberDto {
  return {
    id: m.id, experimentId: m.experimentId, backtestRunId: m.backtestRunId ?? null,
    strategyBacktestRunId: m.strategyBacktestRunId ?? null,
    role: m.role, foldId: m.foldId ?? null, periodFrom: m.periodFrom, periodTo: m.periodTo,
    symbols: m.symbols, tradeCount: m.tradeCount ?? null, resultSummary: m.resultSummary ?? null,
    createdAt: m.createdAt,
  };
}
