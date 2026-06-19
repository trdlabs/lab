# Slice 3 — Meaningful completion replies (the "Done" problem)

**Status:** Approved design (brainstormed 2026-06-19). Ready for implementation plan.
**Date:** 2026-06-19
**Roadmap:** `docs/conversational-operator-roadmap.md` §3 (HIGH).
**Builds on:** `docs/superpowers/specs/2026-06-18-conversational-operator-evidence-confirmation-design.md` §11 (response contracts), §14 slice 3.

> Spec language note: written in English to match the sibling superpowers design specs and the
> downstream implementation plan / subagent prompts. Conversation language is Russian.

## 1. Goal & problem

When a research task finishes, the operator currently sees a generic **`Done.`**. That literal
lives in **trading-office** (`apps/server/src/operator/ConversationFollower.ts:143`), as a fallback
when no event summaries accumulate: office follows trading-lab's SSE stream (`/v1/stream`) and joins
per-event `summary` strings. trading-lab emits *domain events* but its event mapper
(`src/read-api/mappers.ts`) is deny-by-default — only ~4 event types get real summaries; the rest are
generic humanized text. The operator never sees domain context (which profile, which hypotheses, what
metrics, what verdict).

**Goal:** replace `Done.` with a domain summary — profile / hypotheses / run links + key metrics —
for every operator-relevant completion, while keeping the research-only invariant and the event-log
privacy invariant intact.

## 2. Approved decisions (locked in brainstorming)

1. **Scope:** full round-trip across both repos (trading-lab + trading-office), two coordinated PRs.
2. **Delivery:** a trading-lab read-API **fetch endpoint**; office fetches a structured summary on
   task terminal and renders it. (Not via the event log — keeps the cross-entity aggregate in one
   authenticated read and avoids putting raw text into events.)
3. **Coverage:** all three operator-relevant completion types — `strategy.onboard`,
   `research.run_cycle`, `backtest.completed` — via one polymorphic `CompletionSummary` discriminated
   by completed task type.
4. **Depth:** curated "headline + decided result" (not a full data dump).
5. **Flag:** office-side `OPERATOR_COMPLETION_SUMMARY` **enabled by default**, with graceful fallback
   to the current behaviour on any failure.
6. **Privacy:** summary travels over the authenticated operator-facing read; the event log is
   unchanged (§12 still holds). Research-only; no execution.

## 3. Current-state facts (verified)

- Task types with handlers: `strategy.onboard`, `research.run_cycle`, `hypothesis.build`,
  `backtest.resume`, `backtest.completed` (`src/composition.ts:216-220`). Chat auto-chain MVP is
  `strategy.onboard → research.run_cycle` (`src/orchestrator/chain-runner.ts`).
- `research.run_cycle` completes with **hypothesis-level** data only: it proposes/validates/dedupes
  hypotheses, fans out one `hypothesis.build` per validated hypothesis, optionally critic-reviews, and
  emits `research.run_cycle.completed {proposed, validated, rejected, deduped, criticReviews}`
  (`research-run-cycle.handler.ts:222-224`). **No run metrics or PASS/FAIL decision exist yet.**
- Metrics + decision arrive later, per hypothesis, at `backtest.completed`
  (`backtest-completed.handler.ts:53-121`): payload `{backtestRunId, hypothesisId, strategyProfileId,
  decision, reasons, cycleDepth}`; emits `hypothesis.passed|failed|modify_required|inconclusive|
  paper_candidate`. Metrics live in `BacktestRun.metrics` (`src/domain/backtest-run.ts`),
  decision in `Evaluation` (`src/domain/evaluation.ts`).
- Linkage: `sessionId → ChatSessionContext.lastResearchTaskId`; `ResearchTask {id, correlationId,
  taskType, payload, status}`; `AgentEvent.taskId`; `profileId → hypotheses → backtestRunId →
  evaluation`.
- Read ports already exist: strategy-profile repo, hypothesis-read, backtest-read, evaluation repo,
  agent-event-read (`src/ports/*`, `src/adapters/read/*`).
- Office boundary: trading-lab emits events + serves `/v1` read-API; **trading-office** builds the
  operator reply text (`ConversationFollower`).

## 4. Contract — `CompletionSummary`

Lab-owned, discriminated by the completed task type:

```ts
interface ProfileRef { id: string; name: string; direction: string | null }
interface HypothesisRef { id: string; thesis: string; confidence: number | null; status: string | null }
interface KeyMetrics {
  netPnlUsd: number | null; netPnlPct: number | null; winRate: number | null;
  profitFactor: number | null; maxDrawdownPct: number | null; sharpe: number | null;
  totalTrades: number | null;
}
interface SummaryLinks { taskId: string; profileId?: string; hypothesisId?: string; backtestRunId?: string }

type EvaluationDecision = 'PASS' | 'FAIL' | 'MODIFY' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';

type CompletionSummary =
  | { kind: 'strategy.onboard'; taskId: string; status: string;
      profile: ProfileRef | null; nextStep?: { taskType: string }; links: SummaryLinks }
  | { kind: 'research.run_cycle'; taskId: string; status: string; profile: ProfileRef | null;
      counts: { proposed: number; validated: number; rejected: number; deduped: number;
                criticReviews: number; backtestsEnqueued: number };
      topHypotheses: readonly HypothesisRef[]; nextStep?: { taskType: string }; links: SummaryLinks }
  | { kind: 'backtest.completed'; taskId: string; status: string; profile: ProfileRef | null;
      hypothesis: HypothesisRef | null; decision: EvaluationDecision;
      metrics: KeyMetrics; reasons: readonly string[]; willRetry: boolean; links: SummaryLinks };
```

Notes:
- `thesis` is bounded to a short length (e.g. ≤ 240 chars) for operator display; never raw secrets.
- All metric fields nullable — mapped 1:1 from `BacktestMetricBlock`; absent metrics stay `null`.
- `topHypotheses` capped at **K = 3**, validated hypotheses ordered by `confidence` desc, tiebreak by
  `id` asc (deterministic).

## 5. trading-lab — read-side assembler + endpoint (PR1)

### 5.1 `CompletionSummaryBuilder` (`src/read-api/`)
Pure read-side composition from `taskId`, using existing read ports only. Switch on `task.taskType`:

- **`strategy.onboard`** → resolve the created profile (`ProfileRef`) and `nextStep`
  (`research.run_cycle` if a chat plan exists). *Linkage to confirm in impl:* onboard `taskId →
  profileId` (via the onboard completion event payload, or the chat-session `lastStrategyProfileId`).
  If the profile cannot be resolved, return `profile: null` (still a valid onboard summary).
- **`research.run_cycle`** → `profile` from `task.payload.strategyProfileId`; `counts` from the latest
  `research.run_cycle.completed` event for the task (`agent-event-read` by `taskId`);
  `backtestsEnqueued` = number of `hypothesis.build` tasks enqueued (one per validated hypothesis);
  `topHypotheses` = validated hypotheses for the profile (scoped to this cycle by `createdAt ≥
  task.createdAt` / correlation when available, else most-recent-K), ordered + capped per §4.
- **`backtest.completed`** → `profile`, `hypothesis`, `decision`, `reasons` from `task.payload`;
  `metrics` mapped from `BacktestRun(backtestRunId).metrics`; `willRetry` = `decision ∈ {FAIL, MODIFY}
  && cycleDepth < MAX_CYCLE_DEPTH`.

**Graceful degradation is mandatory:** a missing/unfetchable entity yields a partial summary (null
field / empty list), never a thrown error.

### 5.2 Endpoint
- `GET /v1/tasks/{taskId}/completion-summary` on the existing `/v1` read-API.
- **Auth:** reuse the read-API bearer gate office already uses for `/v1/stream` (no new boundary).
- **Responses:**
  - `200` + `CompletionSummary` for a **completed** task of a supported type.
  - `404` for unknown task, non-completed task (running/failed/rejected), or unsupported task type →
    office falls back. Failed-task replies are unchanged (office keeps its existing failure path).
- Read-only and additive: no new migration, no new domain events.

## 6. trading-office — fetch + render (PR2, depends on PR1)

- Lab read-API client gains `getCompletionSummary(taskId): Promise<CompletionSummary | null>`
  (`null` on 404/network error).
- `renderCompletionSummary(summary): string` — markdown renderer, one branch per `kind`. Examples:
  - onboard → `Профиль создан: <name> (<direction>). Дальше: research cycle.`
  - run_cycle → `Гипотезы: 3 предложено, 2 валидно, 1 отклонено · 2 бэктеста в очереди. Топ: …`
  - backtest.completed → `<PASS/FAIL/…>: <hypothesis> · PnL +$420 (12%), win 58%, PF 1.8, maxDD 9% …`
    + reasons + retry note + links.
- `ConversationFollower`: on a followed task's terminal success, fetch + render into `reply.text`,
  **replacing the `|| 'Done.'` fallback**. On `null`/disabled → existing behaviour (joined summaries
  / `Done.`).
- **`backtest.completed` surfacing:** office already observes `hypothesis.passed|failed|modify_required
  |inconclusive|paper_candidate` stream events carrying the `taskId`; on those, fetch that task's
  completion-summary and emit it as a follow-up `operator_message_completed` for the conversation.
- **Flag:** `OPERATOR_COMPLETION_SUMMARY` default **on**; off → skip fetch, current behaviour.

## 7. Privacy & invariants

- Summary is returned over the authenticated operator-facing read; it may include short theses,
  profile name, metrics, IDs — never secrets, embeddings, or raw private document bodies.
- **Event log unchanged** — no raw strategy text added to events (§12 invariant holds).
- Research-only: read endpoint, no task creation, no execution authority.

## 8. Testing contract

- **Lab unit** (`CompletionSummaryBuilder`): per-kind assembly; linkage resolution; top-K hypothesis
  selection + deterministic order; `KeyMetrics` mapping incl. all-null; `willRetry` rule; graceful
  degradation when an entity is missing (partial summary, no throw).
- **Lab integration:** `GET /v1/tasks/{id}/completion-summary` returns the correct discriminated
  summary for seeded completed tasks of each kind; `404` for unknown / non-terminal / unsupported.
- **Office unit:** `renderCompletionSummary` per kind; fallback to current behaviour when the fetch
  returns `null` or the flag is off.
- **E2E / transcript:** completion summary renders in the operator transcript for a chat→research
  flow (§13 "transcript rendering of completion summaries").

## 9. Rollout

- PR1 (lab) is read-only + additive → safe to merge independently; endpoint simply goes unused until
  PR2 lands.
- PR2 (office) ships behind `OPERATOR_COMPLETION_SUMMARY` (default on) with graceful fallback, so a
  lab outage or an unsupported task type degrades to today's reply rather than an error.

## 10. PR breakdown

- **PR1 — trading-lab:** `CompletionSummary` types + `CompletionSummaryBuilder` + `GET
  /v1/tasks/{taskId}/completion-summary` + unit/integration tests.
- **PR2 — trading-office:** lab-client `getCompletionSummary` + `renderCompletionSummary` +
  `ConversationFollower` integration + backtest.completed surfacing + flag + unit/E2E tests.

## 11. Non-goals

- No changes to the event log schema, the deny-by-default event mapper, or domain events.
- No new metrics beyond `BacktestMetricBlock`; no recomputation.
- No bot-catalog / artifact-RAG work (deferred — SDK initiative dependency).
- No live execution; research-only.

## 12. Open items to confirm during implementation

1. **onboard `taskId → profileId` linkage** — exact source (onboard completion event payload vs
   `ChatSessionContext.lastStrategyProfileId`). Fallback already specified (`profile: null`).
2. Whether `research.run_cycle` hypotheses can be reliably scoped to the cycle (createdAt/correlation)
   or only to the profile; affects `topHypotheses` precision (not correctness).
