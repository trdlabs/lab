# Meaningful Completion Replies — PR1 (trading-lab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trading-lab read-API endpoint `GET /v1/tasks/:taskId/completion-summary` that returns a structured, domain `CompletionSummary` for a completed research task, so trading-office can replace the generic `Done.` reply (PR2, separate).

**Architecture:** A pure read-side builder (`src/read-api/completion-summary.ts`) assembles a discriminated `CompletionSummary` by completed task type (`strategy.onboard` / `research.run_cycle` / `backtest.completed`) from existing read ports. A thin Hono route exposes it on the gated `/v1` surface. Read-only + additive — no migration, no new domain events, no event-log changes. Every external fetch is wrapped so a missing entity degrades to a partial summary, never an error.

**Tech Stack:** TypeScript ESM under `node --experimental-strip-types` (NO TS parameter properties — guarded by `src/strip-types-no-param-properties.test.ts`), Hono read-API, Vitest, hexagonal ports/adapters.

**Spec:** `docs/superpowers/specs/2026-06-19-meaningful-completion-replies-design.md`.

---

## Verified facts (from current source)

- Read-API is **Hono**; app built in `src/read-api/read-app.ts` via `createReadApp(deps: ReadApiDeps)`. The `/v1` sub-app applies `readAuthMiddleware(deps.token)` then `register*Routes(v1, deps)`. There is a `V1_PATHS` list used to register a 405 for non-GET methods.
- Route pattern (`src/read-api/routes/hypotheses.ts`): `app.get('/hypotheses/:id', async (c) => { const h = await deps.hypotheses.getById(c.req.param('id')); if (!h) return c.json({ error: { code: 'not_found', message: '...' } }, 404); return c.json(...); })`.
- `ReadApiDeps` (`src/read-api/deps.ts`) currently: `hypotheses: HypothesisReadPort`, `backtests: BacktestReadPort`, `agentEvents: AgentEventReadPort`, `projection`, `agentStream`, `streamHeartbeatMs`, `checkReadiness`, `token`. It does **not** yet expose research-task or strategy-profile repos.
- Port signatures: `ResearchTaskRepository.findById(id): Promise<ResearchTask | null>` (`src/ports/research-task.repository.ts`); `StrategyProfileRepository.findById(id): Promise<StrategyProfile | null>` (`src/ports/strategy-profile.repository.ts`); `HypothesisReadPort { list(q: HypothesisListQuery): Promise<HypothesisProposal[]>; getById(id): Promise<HypothesisProposal | null> }`, `HypothesisListQuery { status?, profileId?, limit, after? }`; `BacktestReadPort { list(q); getById(id): Promise<BacktestRun | null> }`; `AgentEventReadPort.list(q: AgentEventListQuery): Promise<AgentEventRow[]>`, `AgentEventListQuery { taskId?, type?, since?, correlationId?, limit, after? }`, `AgentEventRow { id, taskId, type, payload: Record<string, unknown>, createdAt, correlationId? }`.
  - **Confirm the exact exported interface names** for the research-task and strategy-profile repos when importing (they may differ slightly); the `findById` methods are as above.
- Domain shapes: `ResearchTask { id, taskType, status, payload: Record<string, unknown>, correlationId, createdAt, ... }`; `StrategyProfile { id, coreIdea, direction, ... }` (no `name` field → map `coreIdea`); `HypothesisProposal { id, strategyProfileId, thesis, confidence, status: 'validated'|'rejected', ... }`; `BacktestRun { id, metrics: BacktestMetricBlock | null, ... }`; `BacktestMetricBlock { netPnlUsd, netPnlPct, totalTrades, winRate, profitFactor, maxDrawdownPct, expectancyUsd, sharpe, topTradeContributionPct }`.
- `MAX_CYCLE_DEPTH = 2` exported from `src/orchestrator/handlers/backtest-completed.handler.ts:22`.
- `backtest.completed` task payload: `{ backtestRunId, hypothesisId, strategyProfileId, decision, reasons, cycleDepth }`.
- `research.run_cycle.completed` event payload: `{ proposed, validated, rejected, deduped, criticReviews }` (one `hypothesis.build` is enqueued per validated hypothesis → `backtestsEnqueued = validated`).
- onboard → profileId: not guaranteed in one fixed field; resolve by scanning the task's events for a payload `profileId` or `strategyId` (e.g. `strategy_analyst.completed`, `strategy.onboard.deduped`); fallback `profile: null`.

## File Structure

- **Create** `src/read-api/completion-summary.ts` — `CompletionSummary` types, `CompletionSummaryDeps`, the `buildCompletionSummary` builder + per-kind helpers. One focused responsibility: assemble a summary from read ports.
- **Create** `src/read-api/completion-summary.test.ts` — builder unit tests with in-memory fake deps.
- **Create** `src/read-api/routes/completion-summary.ts` — `registerCompletionSummaryRoutes(app, deps)`.
- **Create** `src/read-api/routes/completion-summary.test.ts` — endpoint integration test (200 per kind + 404 paths) through `createReadApp`.
- **Modify** `src/read-api/deps.ts` — add `researchTasks` + `strategyProfiles` to `ReadApiDeps`.
- **Modify** `src/read-api/read-app.ts` — register the new route + add its path to `V1_PATHS`.
- **Modify** `src/composition.ts` — wire the two repos into the `read` deps object.

---

### Task 1: Builder skeleton + `backtest.completed` kind

**Files:**
- Create: `src/read-api/completion-summary.ts`
- Test: `src/read-api/completion-summary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildCompletionSummary, type CompletionSummaryDeps } from './completion-summary.ts';

// Minimal in-memory deps. Each method returns canned data; override per test.
function fakeDeps(over: Partial<Record<string, unknown>> = {}): CompletionSummaryDeps {
  const base = {
    researchTasks: { findById: async () => null },
    strategyProfiles: { findById: async () => null },
    hypotheses: { list: async () => [], getById: async () => null },
    backtests: { list: async () => [], getById: async () => null },
    agentEvents: { list: async () => [] },
  };
  return { ...base, ...over } as unknown as CompletionSummaryDeps;
}

const completedTask = (over: Record<string, unknown>) => ({
  id: 't1', taskType: 'backtest.completed', source: 'operator', correlationId: 'c1',
  status: 'completed', payload: {}, createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z',
  ...over,
});

describe('buildCompletionSummary — backtest.completed', () => {
  it('maps decision, metrics, hypothesis, profile and willRetry', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({
        payload: { backtestRunId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1', decision: 'FAIL', reasons: ['low sharpe'], cycleDepth: 0 },
      }) },
      backtests: { getById: async (id: string) => id === 'b1' ? {
        id: 'b1', metrics: { netPnlUsd: -10, netPnlPct: -1, totalTrades: 20, winRate: 0.4, profitFactor: 0.8, maxDrawdownPct: 15, expectancyUsd: -0.5, sharpe: -0.2, topTradeContributionPct: 30 },
      } : null },
      hypotheses: { list: async () => [], getById: async (id: string) => id === 'h1' ? { id: 'h1', thesis: 'short the pump', confidence: 0.6, status: 'validated' } : null },
      strategyProfiles: { findById: async (id: string) => id === 'p1' ? { id: 'p1', coreIdea: 'fade pumps', direction: 'short' } : null },
    });

    const s = await buildCompletionSummary(deps, 't1');

    expect(s?.kind).toBe('backtest.completed');
    if (s?.kind !== 'backtest.completed') throw new Error('wrong kind');
    expect(s.decision).toBe('FAIL');
    expect(s.metrics.netPnlUsd).toBe(-10);
    expect(s.metrics.winRate).toBe(0.4);
    expect(s.metrics.sharpe).toBe(-0.2);
    expect(s.hypothesis).toEqual({ id: 'h1', thesis: 'short the pump', confidence: 0.6, status: 'validated' });
    expect(s.profile).toEqual({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' });
    expect(s.reasons).toEqual(['low sharpe']);
    expect(s.willRetry).toBe(true); // FAIL && cycleDepth 0 < 2
    expect(s.links).toEqual({ taskId: 't1', profileId: 'p1', hypothesisId: 'h1', backtestRunId: 'b1' });
  });

  it('all-null metrics when the backtest run has no metric block', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({ payload: { backtestRunId: 'b1', decision: 'INCONCLUSIVE' } }) },
      backtests: { getById: async () => ({ id: 'b1', metrics: null }) },
    });
    const s = await buildCompletionSummary(deps, 't1');
    if (s?.kind !== 'backtest.completed') throw new Error('wrong kind');
    expect(s.metrics).toEqual({ netPnlUsd: null, netPnlPct: null, winRate: null, profitFactor: null, maxDrawdownPct: null, sharpe: null, totalTrades: null });
    expect(s.willRetry).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/read-api/completion-summary.test.ts`
Expected: FAIL — `buildCompletionSummary` is not defined / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
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
export interface SummaryLinks { taskId: string; profileId?: string; hypothesisId?: string; backtestRunId?: string }

export interface BacktestCompletedCompletionSummary {
  kind: 'backtest.completed'; taskId: string; status: string; profile: ProfileRef | null;
  hypothesis: HypothesisRef | null; decision: EvaluationDecisionLabel;
  metrics: KeyMetrics; reasons: string[]; willRetry: boolean; links: SummaryLinks;
}

export type CompletionSummary = BacktestCompletedCompletionSummary; // extended in later tasks

export interface CompletionSummaryDeps {
  researchTasks: Pick<ResearchTaskRepository, 'findById'>;
  strategyProfiles: Pick<StrategyProfileRepository, 'findById'>;
  hypotheses: Pick<HypothesisReadPort, 'list' | 'getById'>;
  backtests: Pick<BacktestReadPort, 'getById'>;
  agentEvents: Pick<AgentEventReadPort, 'list'>;
}

const THESIS_MAX = 240;
const clip = (s: string, n = THESIS_MAX): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

async function safe<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
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
  const p = task.payload as {
    backtestRunId?: string; hypothesisId?: string; strategyProfileId?: string;
    decision?: string; reasons?: unknown; cycleDepth?: number;
  };
  const decision = (p.decision ?? 'INCONCLUSIVE') as EvaluationDecisionLabel;
  const reasons = Array.isArray(p.reasons) ? p.reasons.map(String) : [];
  const cycleDepth = typeof p.cycleDepth === 'number' ? p.cycleDepth : 0;
  const run: BacktestRun | null = p.backtestRunId ? await safe(() => deps.backtests.getById(p.backtestRunId!)) : null;
  const hyp = p.hypothesisId ? await safe(() => deps.hypotheses.getById(p.hypothesisId!)) : null;
  const profile = p.strategyProfileId ? await safe(() => deps.strategyProfiles.findById(p.strategyProfileId!)) : null;
  return {
    kind: 'backtest.completed', taskId: task.id, status: task.status,
    profile: profile ? toProfileRef(profile) : null,
    hypothesis: hyp ? toHypothesisRef(hyp) : null,
    decision, metrics: toKeyMetrics(run?.metrics ?? null), reasons,
    willRetry: (decision === 'FAIL' || decision === 'MODIFY') && cycleDepth < MAX_CYCLE_DEPTH,
    links: { taskId: task.id, profileId: p.strategyProfileId, hypothesisId: p.hypothesisId, backtestRunId: p.backtestRunId },
  };
}

export async function buildCompletionSummary(deps: CompletionSummaryDeps, taskId: string): Promise<CompletionSummary | null> {
  const task = await safe(() => deps.researchTasks.findById(taskId));
  if (!task || task.status !== 'completed') return null;
  switch (task.taskType) {
    case 'backtest.completed': return buildBacktestCompleted(deps, task);
    default: return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/read-api/completion-summary.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/read-api/completion-summary.ts src/read-api/completion-summary.test.ts
git commit -m "feat(read-api): completion-summary builder — backtest.completed kind"
```

---

### Task 2: `research.run_cycle` kind

**Files:**
- Modify: `src/read-api/completion-summary.ts`
- Test: `src/read-api/completion-summary.test.ts`

- [ ] **Step 1: Write the failing test** (append to the test file)

```ts
describe('buildCompletionSummary — research.run_cycle', () => {
  const runCycleTask = (over: Record<string, unknown> = {}) => ({
    id: 'rc1', taskType: 'research.run_cycle', source: 'operator', correlationId: 'c1',
    status: 'completed', payload: { strategyProfileId: 'p1' },
    createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z', ...over,
  });

  it('pulls counts from the run_cycle.completed event and top-3 validated hypotheses by confidence', async () => {
    const hyps = [
      { id: 'hA', thesis: 'A', confidence: 0.5, status: 'validated' },
      { id: 'hB', thesis: 'B', confidence: 0.9, status: 'validated' },
      { id: 'hC', thesis: 'C', confidence: 0.7, status: 'validated' },
      { id: 'hD', thesis: 'D', confidence: 0.1, status: 'validated' },
    ];
    const deps = fakeDeps({
      researchTasks: { findById: async () => runCycleTask() },
      strategyProfiles: { findById: async () => ({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' }) },
      agentEvents: { list: async (q: { type?: string }) => q.type === 'research.run_cycle.completed'
        ? [{ id: 'e1', taskId: 'rc1', type: 'research.run_cycle.completed', payload: { proposed: 5, validated: 4, rejected: 1, deduped: 0, criticReviews: 4 }, createdAt: '2026-06-19T00:00:00.000Z' }]
        : [] },
      hypotheses: { list: async (q: { profileId?: string; status?: string }) => q.profileId === 'p1' && q.status === 'validated' ? hyps : [], getById: async () => null },
    });

    const s = await buildCompletionSummary(deps, 'rc1');
    if (s?.kind !== 'research.run_cycle') throw new Error('wrong kind');
    expect(s.counts).toEqual({ proposed: 5, validated: 4, rejected: 1, deduped: 0, criticReviews: 4, backtestsEnqueued: 4 });
    expect(s.topHypotheses.map((h) => h.id)).toEqual(['hB', 'hC', 'hA']); // by confidence desc, top 3
    expect(s.profile?.coreIdea).toBe('fade pumps');
    expect(s.links).toEqual({ taskId: 'rc1', profileId: 'p1' });
  });

  it('zero counts + empty top when no completion event and no hypotheses', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => runCycleTask({ payload: {} }) } });
    const s = await buildCompletionSummary(deps, 'rc1');
    if (s?.kind !== 'research.run_cycle') throw new Error('wrong kind');
    expect(s.counts).toEqual({ proposed: 0, validated: 0, rejected: 0, deduped: 0, criticReviews: 0, backtestsEnqueued: 0 });
    expect(s.topHypotheses).toEqual([]);
    expect(s.profile).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/read-api/completion-summary.test.ts`
Expected: FAIL — run_cycle returns `null` (default branch) → `s?.kind !== 'research.run_cycle'` throws.

- [ ] **Step 3: Write minimal implementation** (add to `completion-summary.ts`)

Add the type, extend the union, add the helper, and add the switch case:

```ts
export interface RunCycleCompletionSummary {
  kind: 'research.run_cycle'; taskId: string; status: string; profile: ProfileRef | null;
  counts: { proposed: number; validated: number; rejected: number; deduped: number; criticReviews: number; backtestsEnqueued: number };
  topHypotheses: HypothesisRef[]; nextStep?: { taskType: string }; links: SummaryLinks;
}
// update: export type CompletionSummary = BacktestCompletedCompletionSummary | RunCycleCompletionSummary;

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

async function buildRunCycle(deps: CompletionSummaryDeps, task: ResearchTask): Promise<RunCycleCompletionSummary> {
  const profileId = (task.payload as { strategyProfileId?: string }).strategyProfileId;
  const profile = profileId ? await safe(() => deps.strategyProfiles.findById(profileId)) : null;

  const events = (await safe(() => deps.agentEvents.list({ taskId: task.id, type: 'research.run_cycle.completed', limit: 1 }))) ?? [];
  const ev = events[0]?.payload as { proposed?: unknown; validated?: unknown; rejected?: unknown; deduped?: unknown; criticReviews?: unknown } | undefined;
  const validated = num(ev?.validated);
  const counts = {
    proposed: num(ev?.proposed), validated, rejected: num(ev?.rejected),
    deduped: num(ev?.deduped), criticReviews: num(ev?.criticReviews), backtestsEnqueued: validated,
  };

  let topHypotheses: HypothesisRef[] = [];
  if (profileId) {
    const hs = (await safe(() => deps.hypotheses.list({ profileId, status: 'validated', limit: 50 }))) ?? [];
    topHypotheses = [...hs]
      .sort((a, b) => (b.confidence - a.confidence) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 3)
      .map(toHypothesisRef);
  }

  return {
    kind: 'research.run_cycle', taskId: task.id, status: task.status,
    profile: profile ? toProfileRef(profile) : null, counts, topHypotheses,
    links: { taskId: task.id, profileId },
  };
}
```

Add to the switch in `buildCompletionSummary`: `case 'research.run_cycle': return buildRunCycle(deps, task);`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/read-api/completion-summary.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/read-api/completion-summary.ts src/read-api/completion-summary.test.ts
git commit -m "feat(read-api): completion-summary — research.run_cycle kind"
```

---

### Task 3: `strategy.onboard` kind (profileId via events, fallback null)

**Files:**
- Modify: `src/read-api/completion-summary.ts`
- Test: `src/read-api/completion-summary.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
describe('buildCompletionSummary — strategy.onboard', () => {
  const onboardTask = (over: Record<string, unknown> = {}) => ({
    id: 'ob1', taskType: 'strategy.onboard', source: 'operator', correlationId: 'c1',
    status: 'completed', payload: {}, createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z', ...over,
  });

  it('resolves the created profile from a task event payload (profileId or strategyId) and sets nextStep', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => onboardTask() },
      agentEvents: { list: async () => [
        { id: 'e1', taskId: 'ob1', type: 'strategy_analyst.started', payload: {}, createdAt: '2026-06-19T00:00:00.000Z' },
        { id: 'e2', taskId: 'ob1', type: 'strategy_analyst.completed', payload: { profileId: 'p9', direction: 'long' }, createdAt: '2026-06-19T00:00:01.000Z' },
      ] },
      strategyProfiles: { findById: async (id: string) => id === 'p9' ? { id: 'p9', coreIdea: 'breakout', direction: 'long' } : null },
    });
    const s = await buildCompletionSummary(deps, 'ob1');
    if (s?.kind !== 'strategy.onboard') throw new Error('wrong kind');
    expect(s.profile).toEqual({ id: 'p9', coreIdea: 'breakout', direction: 'long' });
    expect(s.nextStep).toEqual({ taskType: 'research.run_cycle' });
    expect(s.links).toEqual({ taskId: 'ob1', profileId: 'p9' });
  });

  it('degrades to profile:null when no event carries a profile id', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => onboardTask() } });
    const s = await buildCompletionSummary(deps, 'ob1');
    if (s?.kind !== 'strategy.onboard') throw new Error('wrong kind');
    expect(s.profile).toBeNull();
    expect(s.links.profileId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/read-api/completion-summary.test.ts`
Expected: FAIL — onboard returns `null` (default branch).

- [ ] **Step 3: Write minimal implementation** (add to `completion-summary.ts`)

> **Observability pattern (added in the 2026-06-19 refinement, already live in `completion-summary.ts`):**
> every kind builds via `const warnings: string[] = []; const safe = makeSafe(task.id, warnings);`,
> each guarded read uses `safe('<code>_failed', () => ...)`, and the returned summary includes
> `warnings`. Follow the same pattern here (onboard summary also carries `warnings`).

```ts
export interface OnboardCompletionSummary {
  kind: 'strategy.onboard'; taskId: string; status: string;
  profile: ProfileRef | null; nextStep?: { taskType: string }; links: SummaryLinks;
  warnings: readonly string[];
}
// update: export type CompletionSummary = BacktestCompletedCompletionSummary | RunCycleCompletionSummary | OnboardCompletionSummary;

async function buildOnboard(deps: CompletionSummaryDeps, task: ResearchTask): Promise<OnboardCompletionSummary> {
  const warnings: string[] = [];
  const safe = makeSafe(task.id, warnings);
  const events = (await safe('events_read_failed', () => deps.agentEvents.list({ taskId: task.id, limit: 50 }))) ?? [];
  let profileId: string | undefined;
  for (const e of events) {
    const pl = e.payload as { profileId?: unknown; strategyId?: unknown };
    if (typeof pl.profileId === 'string' && pl.profileId) { profileId = pl.profileId; break; }
    if (typeof pl.strategyId === 'string' && pl.strategyId) { profileId = pl.strategyId; break; }
  }
  const profile = profileId ? await safe('profile_read_failed', () => deps.strategyProfiles.findById(profileId!)) : null;
  return {
    kind: 'strategy.onboard', taskId: task.id, status: task.status,
    profile: profile ? toProfileRef(profile) : null,
    nextStep: { taskType: 'research.run_cycle' },
    links: { taskId: task.id, profileId },
    warnings,
  };
}
```

Add to the switch: `case 'strategy.onboard': return buildOnboard(deps, task);`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/read-api/completion-summary.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/read-api/completion-summary.ts src/read-api/completion-summary.test.ts
git commit -m "feat(read-api): completion-summary — strategy.onboard kind"
```

---

### Task 4: Null guards (unknown / non-completed / unsupported type)

**Files:**
- Test: `src/read-api/completion-summary.test.ts` (impl already handles these — this task locks the contract)

- [ ] **Step 1: Write the failing test** (append)

```ts
describe('buildCompletionSummary — null contract', () => {
  it('returns null for an unknown task', async () => {
    expect(await buildCompletionSummary(fakeDeps(), 'missing')).toBeNull();
  });
  it('returns null for a non-completed task', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => ({ id: 't', taskType: 'research.run_cycle', status: 'running', payload: {}, source: 'operator', correlationId: 'c', createdAt: '', updatedAt: '' }) } });
    expect(await buildCompletionSummary(deps, 't')).toBeNull();
  });
  it('returns null for a completed but unsupported task type', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => ({ id: 't', taskType: 'hypothesis.build', status: 'completed', payload: {}, source: 'operator', correlationId: 'c', createdAt: '', updatedAt: '' }) } });
    expect(await buildCompletionSummary(deps, 't')).toBeNull();
  });
  it('does not throw when researchTasks.findById rejects (graceful)', async () => {
    const deps = fakeDeps({ researchTasks: { findById: async () => { throw new Error('db down'); } } });
    expect(await buildCompletionSummary(deps, 't')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it (should already pass from Task 1's guards)**

Run: `npx vitest run src/read-api/completion-summary.test.ts`
Expected: PASS (10 tests). If the graceful test fails, ensure `buildCompletionSummary` wraps `findById` in `safe(...)` (it does per Task 1).

- [ ] **Step 3: Commit**

```bash
git add src/read-api/completion-summary.test.ts
git commit -m "test(read-api): completion-summary null/graceful contract"
```

---

### Task 5: Extend `ReadApiDeps` + wire composition

**Files:**
- Modify: `src/read-api/deps.ts`
- Modify: `src/composition.ts:245-256` (the `read` deps object)

- [ ] **Step 1: Add the two repos to `ReadApiDeps`**

In `src/read-api/deps.ts`, add imports and fields (confirm exact exported interface names from the port files):

```ts
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
// ... inside interface ReadApiDeps:
  researchTasks: ResearchTaskRepository;
  strategyProfiles: StrategyProfileRepository;
```

- [ ] **Step 2: Wire them in composition**

In `src/composition.ts`, the `read: ReadApiDeps = { ... }` object: add `researchTasks` and `strategyProfiles` using the repository instances already constructed in composition (search for the existing `new Drizzle*` / factory for research-task and strategy-profile repos and reuse those instances). Example shape:

```ts
const read: ReadApiDeps = {
  hypotheses: new DrizzleHypothesisReadAdapter(db),
  backtests: new DrizzleBacktestReadAdapter(db),
  agentEvents: agentEventsRead,
  researchTasks,        // existing instance in composition
  strategyProfiles,     // existing instance in composition
  projection,
  agentStream,
  streamHeartbeatMs: env.AGENT_EVENT_STREAM_HEARTBEAT_MS,
  checkReadiness: async () => { try { await db.execute(sql`select 1`); return true; } catch { return false; } },
  token: env.TRADING_LAB_READ_TOKEN ?? '',
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean (no missing-property errors on `ReadApiDeps`).

- [ ] **Step 4: Commit**

```bash
git add src/read-api/deps.ts src/composition.ts
git commit -m "feat(read-api): expose research-task + strategy-profile repos in ReadApiDeps"
```

---

### Task 6: Endpoint route + registration

**Files:**
- Create: `src/read-api/routes/completion-summary.ts`
- Modify: `src/read-api/read-app.ts` (register route + add path to `V1_PATHS`)

- [ ] **Step 1: Write the route**

```ts
// src/read-api/routes/completion-summary.ts
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { buildCompletionSummary } from '../completion-summary.ts';

export function registerCompletionSummaryRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/tasks/:taskId/completion-summary', async (c) => {
    const summary = await buildCompletionSummary(deps, c.req.param('taskId'));
    if (!summary) {
      return c.json({ error: { code: 'not_found', message: 'completion summary not available' } }, 404);
    }
    return c.json(summary);
  });
}
```

- [ ] **Step 2: Register it in `read-app.ts`**

Add the import and call alongside the other `register*Routes(v1, deps)` calls:

```ts
import { registerCompletionSummaryRoutes } from './routes/completion-summary.ts';
// ... after registerAgentEventRoutes(v1, deps):
registerCompletionSummaryRoutes(v1, deps);
```

Also add the path to the `V1_PATHS` array (used for the 405 method-not-allowed registration): add `'/tasks/:taskId/completion-summary'`.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean. (`ReadApiDeps` satisfies `CompletionSummaryDeps` structurally after Task 5.)

- [ ] **Step 4: Commit**

```bash
git add src/read-api/routes/completion-summary.ts src/read-api/read-app.ts
git commit -m "feat(read-api): GET /v1/tasks/:taskId/completion-summary route"
```

---

### Task 7: Endpoint integration test (auth, per-kind, 404)

**Files:**
- Test: `src/read-api/routes/completion-summary.test.ts`

- [ ] **Step 1: Write the failing test**

Reuse the existing read-api route test harness for assembling `ReadApiDeps` fakes (look at a sibling route test, e.g. `src/read-api/routes/hypotheses.test.ts`, for how `createReadApp` is built with fakes + token, and how requests pass the bearer header). Then:

```ts
import { describe, it, expect } from 'vitest';
import { createReadApp } from '../read-app.ts';

const TOKEN = 'test-token';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

// Build a full ReadApiDeps with fakes. Mirror the sibling route test for projection/agentStream stubs.
function appWith(over: Record<string, unknown>) {
  const deps = {
    hypotheses: { list: async () => [], getById: async () => null },
    backtests: { list: async () => [], getById: async () => null },
    agentEvents: { list: async () => [] },
    researchTasks: { findById: async () => null },
    strategyProfiles: { findById: async () => null },
    projection: { cursorKey: () => null, getAgent: () => undefined, snapshot: () => [] },
    agentStream: { subscribe: () => () => {}, start: async () => {}, stop: async () => {} },
    streamHeartbeatMs: 15000,
    checkReadiness: async () => true,
    token: TOKEN,
    ...over,
  };
  return createReadApp(deps as never);
}

describe('GET /v1/tasks/:taskId/completion-summary', () => {
  it('401 without a bearer token', async () => {
    const res = await appWith({}).request('/v1/tasks/t1/completion-summary');
    expect(res.status).toBe(401);
  });

  it('404 for an unknown task', async () => {
    const res = await appWith({}).request('/v1/tasks/missing/completion-summary', auth);
    expect(res.status).toBe(404);
  });

  it('200 + backtest.completed summary', async () => {
    const app = appWith({
      researchTasks: { findById: async () => ({ id: 't1', taskType: 'backtest.completed', status: 'completed', source: 'operator', correlationId: 'c', createdAt: '', updatedAt: '', payload: { backtestRunId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1', decision: 'PASS', reasons: ['ok'], cycleDepth: 0 } }) },
      backtests: { list: async () => [], getById: async () => ({ id: 'b1', metrics: { netPnlUsd: 100, netPnlPct: 10, totalTrades: 30, winRate: 0.6, profitFactor: 1.8, maxDrawdownPct: 8, expectancyUsd: 3, sharpe: 1.1, topTradeContributionPct: 20 } }) },
      hypotheses: { list: async () => [], getById: async () => ({ id: 'h1', thesis: 'short the pump', confidence: 0.7, status: 'validated' }) },
      strategyProfiles: { findById: async () => ({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' }) },
    });
    const res = await app.request('/v1/tasks/t1/completion-summary', auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('backtest.completed');
    expect(body.decision).toBe('PASS');
    expect(body.metrics.profitFactor).toBe(1.8);
    expect(body.hypothesis.id).toBe('h1');
    expect(body.links.backtestRunId).toBe('b1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails / then passes**

Run: `npx vitest run src/read-api/routes/completion-summary.test.ts`
Expected: PASS once the route is wired. If `createReadApp` needs additional stub methods on `projection`/`agentStream`, copy the exact stub shape from the sibling route test that already calls `createReadApp`.

- [ ] **Step 3: Commit**

```bash
git add src/read-api/routes/completion-summary.test.ts
git commit -m "test(read-api): completion-summary endpoint — auth, 404, backtest.completed"
```

---

### Task 8: Full-suite gate

- [ ] **Step 1: Run typecheck + full suite + strip-types guard**

Run: `pnpm check`
Expected: typecheck clean; all tests pass (including `src/strip-types-no-param-properties.test.ts` — the builder/route are plain functions, no parameter properties).

- [ ] **Step 2: Confirm the endpoint boots under strip-types (no parse error)**

Run: `timeout 12 node --experimental-strip-types src/ingress/server.ts 2>&1 | head -5`
Expected: reaches the runtime `DATABASE_URL is required` check (no `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).

- [ ] **Step 3: Commit (if any fixups were needed)**

```bash
git add -A
git commit -m "chore(read-api): completion-summary PR1 green (typecheck + suite + strip-types)"
```

---

## Out of scope (PR2, trading-office — separate plan in that repo)

- Lab read-API client `getCompletionSummary(taskId)`.
- `renderCompletionSummary(summary)` markdown renderer (per kind).
- `ConversationFollower` integration replacing the `|| 'Done.'` fallback.
- `backtest.completed` surfacing as follow-up operator messages.
- `OPERATOR_COMPLETION_SUMMARY` flag (default on) + graceful fallback.

## Notes for the implementer

- **No TS parameter properties** anywhere (strip-types). All new code is plain functions/interfaces.
- **Graceful degradation is a hard requirement**: every external read goes through `safe(...)`; a missing entity yields `null`/partial fields, never a thrown 500. (`buildCompletionSummary` returns `null` only for unknown/non-completed/unsupported tasks → 404.)
- **Confirm exact exported interface names** for `ResearchTaskRepository` / `StrategyProfileRepository` when importing into `deps.ts` and `completion-summary.ts`.
- Endpoint is read-only + additive: **no migration**, **no new domain events**, **event log unchanged** (privacy invariant §12 preserved).
