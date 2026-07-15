// src/read-api/completion-summary.ts
import type { ResearchTask } from '../domain/types.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { HypothesisReadPort } from '../ports/hypothesis-read.port.ts';
import type { BacktestReadPort } from '../ports/backtest-read.port.ts';
import type { AgentEventReadPort } from '../ports/agent-event-read.port.ts';
import type { TokenUsageRepository } from '../ports/token-usage.repository.ts';
import { cycleScorecardMarkdownUrl } from './paths.ts';

// Display-hint only — mirrors backtest-completed.handler.ts:22 (MAX_CYCLE_DEPTH = 2). Kept local so the
// read layer does not import an orchestrator handler (avoids upward layer coupling + load-time deps).
const MAX_CYCLE_DEPTH = 2;

export type EvaluationDecisionLabel = 'PASS' | 'FAIL' | 'MODIFY' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';

export interface ProfileRef { id: string; coreIdea: string; direction: string }
export interface HypothesisRef { id: string; thesis: string; confidence: number | null; status: string | null }
export interface KeyMetrics {
  netPnlUsd: number | null; netPnlPct: number | null; winRate: number | null;
  profitFactor: number | null; maxDrawdownPct: number | null; sharpe: number | null; totalTrades: number | null;
}
export interface SummaryLinks { taskId: string; profileId?: string; hypothesisId?: string; backtestRunId?: string; scorecardUrl?: string }

export interface BacktestCompletedCompletionSummary {
  kind: 'backtest.completed'; taskId: string; status: string; profile: ProfileRef | null;
  hypothesis: HypothesisRef | null; decision: EvaluationDecisionLabel;
  metrics: KeyMetrics; reasons: readonly string[]; willRetry: boolean; links: SummaryLinks;
  warnings: readonly string[]; costUsd: number;
}

export interface RunCycleCompletionSummary {
  kind: 'research.run_cycle'; taskId: string; status: string; profile: ProfileRef | null;
  counts: { proposed: number; validated: number; rejected: number; deduped: number; criticReviews: number; backtestsEnqueued: number };
  topHypotheses: readonly HypothesisRef[]; nextStep?: { taskType: string }; links: SummaryLinks;
  warnings: readonly string[];
}

export interface OnboardCompletionSummary {
  kind: 'strategy.onboard'; taskId: string; status: string;
  profile: ProfileRef | null; nextStep?: { taskType: string }; links: SummaryLinks;
  warnings: readonly string[];
  critique?: { severity: 'low' | 'medium' | 'high'; badIdeaOrBadTiming: 'bad_idea' | 'bad_timing' | 'neither'; mainVulnerability: string };
}

export type CompletionSummary = BacktestCompletedCompletionSummary | RunCycleCompletionSummary | OnboardCompletionSummary;

export interface CompletionSummaryDeps {
  researchTasks: Pick<ResearchTaskRepository, 'findById'>;
  strategyProfiles: Pick<StrategyProfileRepository, 'findById'>;
  hypotheses: Pick<HypothesisReadPort, 'list' | 'getById'>;
  backtests: Pick<BacktestReadPort, 'getById'>;
  agentEvents: Pick<AgentEventReadPort, 'list'>;
  tokenUsage: Pick<TokenUsageRepository, 'getCost'>;
}

const THESIS_MAX = 240;
const clip = (s: string, n = THESIS_MAX): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

// Graceful-degradation reader, bound to one build. On a read failure it (1) records a privacy-safe
// `code` in `warnings` — so the operator/office can surface "часть данных недоступна" instead of a
// false "nothing found" — and (2) emits a structured warn log (the only wired sink today; the same
// records flow to OTel/Phoenix once that backlog item lands). It then returns null so the summary
// degrades to a partial result instead of throwing a 500. The GET endpoint stays side-effect-free:
// nothing is written to the event log. The completion *trigger* is the worker's existing terminal
// events on /v1/stream (push); this read only assembles the rich payload (pull).
function makeSafe(taskId: string, warnings: string[]) {
  return async function safe<T>(code: string, fn: () => Promise<T | null>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      warnings.push(code);
      console.warn(`[completion-summary] degraded read code=${code} taskId=${taskId} error=${(err as Error).message}`);
      return null;
    }
  };
}

function toKeyMetrics(m: BacktestMetricBlock | null): KeyMetrics {
  return {
    netPnlUsd: m?.netPnlUsd ?? null, netPnlPct: m?.netPnlPct ?? null, winRate: m?.winRate ?? null,
    profitFactor: m?.profitFactor ?? null, maxDrawdownPct: m?.maxDrawdownPct ?? null,
    sharpe: m?.sharpe ?? null, totalTrades: m?.totalTrades ?? null,
  };
}
function toProfileRef(p: StrategyProfile): ProfileRef { return { id: p.id, coreIdea: clip(p.coreIdea), direction: p.direction }; }
function toHypothesisRef(h: HypothesisProposal): HypothesisRef {
  return { id: h.id, thesis: clip(h.thesis), confidence: h.confidence ?? null, status: h.status ?? null };
}

async function buildBacktestCompleted(deps: CompletionSummaryDeps, task: ResearchTask): Promise<BacktestCompletedCompletionSummary> {
  const warnings: string[] = [];
  const safe = makeSafe(task.id, warnings);
  const p = task.payload as {
    backtestRunId?: string; hypothesisId?: string; strategyProfileId?: string;
    decision?: string; reasons?: unknown; cycleDepth?: number;
  };
  const decision = (p.decision ?? 'INCONCLUSIVE') as EvaluationDecisionLabel;
  const reasons = Array.isArray(p.reasons) ? p.reasons.map(String) : [];
  const cycleDepth = typeof p.cycleDepth === 'number' ? p.cycleDepth : 0;
  const run: BacktestRun | null = p.backtestRunId ? await safe('backtest_read_failed', () => deps.backtests.getById(p.backtestRunId!)) : null;
  const hyp = p.hypothesisId ? await safe('hypothesis_read_failed', () => deps.hypotheses.getById(p.hypothesisId!)) : null;
  const profile = p.strategyProfileId ? await safe('profile_read_failed', () => deps.strategyProfiles.findById(p.strategyProfileId!)) : null;
  const tokenStop = (await safe('events_read_failed', () =>
    deps.agentEvents.list({ taskId: task.id, type: 'research.token_budget_exhausted', limit: 1 }))) ?? [];
  const tokenBudgetExhausted = tokenStop.length > 0;
  const finalReasons = tokenBudgetExhausted ? [...reasons, 'token_budget_exhausted'] : reasons;
  const costUsd = (await safe('cost_read_failed', () => deps.tokenUsage.getCost(task.correlationId))) ?? 0;
  return {
    kind: 'backtest.completed', taskId: task.id, status: task.status,
    profile: profile ? toProfileRef(profile) : null,
    hypothesis: hyp ? toHypothesisRef(hyp) : null,
    decision, metrics: toKeyMetrics(run?.metrics ?? null), reasons: finalReasons,
    willRetry: (decision === 'FAIL' || decision === 'MODIFY') && cycleDepth < MAX_CYCLE_DEPTH && !tokenBudgetExhausted,
    links: { taskId: task.id, profileId: p.strategyProfileId, hypothesisId: p.hypothesisId, backtestRunId: p.backtestRunId },
    warnings, costUsd,
  };
}

async function buildRunCycle(deps: CompletionSummaryDeps, task: ResearchTask): Promise<RunCycleCompletionSummary> {
  const warnings: string[] = [];
  const safe = makeSafe(task.id, warnings);
  const profileId = (task.payload as { strategyProfileId?: string }).strategyProfileId;
  const profile = profileId ? await safe('profile_read_failed', () => deps.strategyProfiles.findById(profileId)) : null;

  const events = (await safe('events_read_failed', () => deps.agentEvents.list({ taskId: task.id, type: 'research.run_cycle.completed', limit: 1 }))) ?? [];
  const ev = events[0]?.payload as { proposed?: unknown; validated?: unknown; rejected?: unknown; deduped?: unknown; criticReviews?: unknown } | undefined;
  const validated = num(ev?.validated);
  const counts = {
    proposed: num(ev?.proposed), validated, rejected: num(ev?.rejected),
    deduped: num(ev?.deduped), criticReviews: num(ev?.criticReviews), backtestsEnqueued: validated,
  };

  let topHypotheses: HypothesisRef[] = [];
  if (profileId) {
    const hs = (await safe('hypotheses_list_failed', () => deps.hypotheses.list({ profileId, status: 'validated', limit: 50 }))) ?? [];
    topHypotheses = [...hs]
      .sort((a, b) => (b.confidence - a.confidence) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 3)
      .map(toHypothesisRef);
  }

  return {
    kind: 'research.run_cycle', taskId: task.id, status: task.status,
    profile: profile ? toProfileRef(profile) : null, counts, topHypotheses,
    links: { taskId: task.id, profileId, scorecardUrl: cycleScorecardMarkdownUrl(task.correlationId) },
    warnings,
  };
}

async function buildOnboard(deps: CompletionSummaryDeps, task: ResearchTask): Promise<OnboardCompletionSummary> {
  const warnings: string[] = [];
  const safe = makeSafe(task.id, warnings);
  const events = (await safe('events_read_failed', () => deps.agentEvents.list({ taskId: task.id, limit: 50 }))) ?? [];
  let profileId: string | undefined;
  for (const e of events) {
    const pl = e.payload as { profileId?: unknown; strategyId?: unknown };
    const pid = typeof pl.profileId === 'string' && pl.profileId
      ? pl.profileId
      : typeof pl.strategyId === 'string' && pl.strategyId
        ? pl.strategyId
        : '';
    if (pid) { profileId = pid; break; }
  }
  const profile = profileId ? await safe('profile_read_failed', () => deps.strategyProfiles.findById(profileId!)) : null;
  const critiqueEvent = events.find((e) => e.type === 'strategy_critic.completed');
  const cp = critiqueEvent?.payload as { severity?: unknown; badIdeaOrBadTiming?: unknown; mainVulnerability?: unknown } | undefined;
  const critique = cp && typeof cp.severity === 'string' && typeof cp.badIdeaOrBadTiming === 'string' && typeof cp.mainVulnerability === 'string'
    ? { severity: cp.severity as 'low' | 'medium' | 'high', badIdeaOrBadTiming: cp.badIdeaOrBadTiming as 'bad_idea' | 'bad_timing' | 'neither', mainVulnerability: cp.mainVulnerability }
    : undefined;
  return {
    kind: 'strategy.onboard', taskId: task.id, status: task.status,
    profile: profile ? toProfileRef(profile) : null,
    nextStep: { taskType: 'research.run_cycle' },
    links: { taskId: task.id, profileId },
    warnings,
    ...(critique ? { critique } : {}),
  };
}

export async function buildCompletionSummary(deps: CompletionSummaryDeps, taskId: string): Promise<CompletionSummary | null> {
  let task: ResearchTask | null;
  try {
    task = await deps.researchTasks.findById(taskId);
  } catch (err) {
    console.warn(`[completion-summary] task lookup failed taskId=${taskId} error=${(err as Error).message}`);
    return null;
  }
  if (!task || task.status !== 'completed') return null;
  switch (task.taskType) {
    case 'backtest.completed': return buildBacktestCompleted(deps, task);
    case 'research.run_cycle': return buildRunCycle(deps, task);
    case 'strategy.onboard': return buildOnboard(deps, task);
    default: return null;
  }
}
