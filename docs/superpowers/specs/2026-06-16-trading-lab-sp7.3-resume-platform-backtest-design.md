# SP-7.3 — Resume Lifecycle for Pending `research_platform` Backtests

**Date:** 2026-06-16
**Status:** Design (review gate before `plan.md`)
**Builds on:** SP-7.2a (`ResearchPlatformPort` lifecycle, `pollOverlayRun`, `mapPlatformComparison`), SP-7.2b (`research_platform` backend wiring in `hypothesisBuildHandler` → `runPlatformBacktest`, merged to `main` as PR #20 / `9aaf73e`).

---

## 1. Problem & Goal

SP-7.2b submits an overlay run to the research platform, **persists the `BacktestRun` immediately**, and runs a *bounded* poll. If the platform has not finished within the poll budget, the run is left at `status='submitted'` (`backend='research_platform'`, `platformRunId` + `resumeToken` + `platformRun` persisted) and a `backtest.pending` event is emitted. SP-7.2b deliberately left callback/resume out of scope.

**SP-7.3 goal:** safely *continue* a pending platform-backed run to its terminal state **without re-submitting**, recovering the completed result into a persisted `Evaluation` (or recording a clean failure), with idempotency guards strong enough for sequential re-runs and stale single-delivery callbacks.

### KEY CHECK

A pending run (`status='submitted'`, `backend='research_platform'`, `platformRunId` set, `taskId` set) that the platform reports **completed** is driven by `resumePlatformRun` → `mapPlatformComparison` → `finalizeBacktestCompletion` → **exactly one persisted `Evaluation`** (decision / reasons / `metricsSnapshot`), with the run transitioned to `evaluated`. A second `resumePlatformRun` on the same run produces **no** duplicate `Evaluation`. Verified by Vitest with in-memory repositories and a fake `ResearchPlatformPort`.

---

## 2. Scope

### In scope
- Recover the originating `task.id` for event continuity (persist it on the run).
- A repository query that finds resumable platform runs.
- A reusable **core** resume function (single run) + a reusable **batch** function (enumerate + iterate).
- A **thin CLI trigger** that only wires `AppServices` and calls the batch core.
- A shared platform terminal-outcome handler used by both the submit path and the resume path.
- Resume lifecycle events.

### Out of scope → explicit follow-ups (SP-7.3b / SP-7.4)
- **Queue-backed resume trigger**: a resume job type, **claim/CAS (or equivalent) concurrency guard**, retry policy, the exactly-once-Evaluation invariant *under concurrency*, and callback/scheduler integration. The queue is the long-term-correct trigger; SP-7.3 proves the lifecycle with the CLI first, at lower infrastructure risk.
- **Callback delivery endpoint** (ingress route that resolves a single run on platform push).
- **Partial-finalize recovery**: runs stuck at `completed` without an `Evaluation` (the crash window between `markCompleted` and `markEvaluated`). Real, but not needed for the first KEY CHECK; safe to add later because the completion tail is guarded (see §9).
- **`--experimental-strip-types` boot regression** (pre-existing, repo-wide; tracked separately). Affects only the *live CLI boot*, not the Vitest-exercised core or the KEY CHECK.

### Hard constraints (honored)
- No new submit for an already-persisted pending run (poll only — `getRunStatus` / `getRunResult`).
- Artifact **ids only**, never raw artifact reads.
- No change to the evaluator or `ComparisonSummary`.
- **SP-4 (`sp4_mock`) path zero-diff.**
- No live / promotion / paper.

---

## 3. Architecture — three layers

Business logic lives **only** in the core. The CLI is wiring.

| Layer | Symbol | Responsibility | Future reuse |
|-------|--------|----------------|--------------|
| Core — single run | `resumePlatformRun(services, run): Promise<ResumeOutcome>` | Idempotency guards → bounded re-poll (no submit) → terminal outcome → finalize/fail. | A future **callback** handler calls this for one delivered run. |
| Core — batch | `resumePendingPlatformRuns(services): Promise<ResumeProbeResult>` | Enumerate resumable runs, call the single-run core for each, isolate per-run errors, return a summary. | A future **scheduler** calls this on a tick. |
| CLI trigger (thin) | `scripts/platform-resume.ts` | `composeRuntime()` → call the batch core → print summary → `pool.end()`. **No business logic.** | — |

Both core functions take `AppServices` (already exposes everything needed: `researchTasks`, `backtests`, `evaluations`, `events`, `researchPlatform`, `platformPoll`, `evaluatorThresholds`).

---

## 4. Data model — recover the originating task

No persisted entity carries `task.id` today (`backtest_run` stores `correlationId`; `hypothesis_build` and `hypothesis_proposal` carry no task reference). Event continuity (the office timeline threads `backtest.completed` under the originating research task) requires it, so we persist it on the run.

- **Domain:** add `taskId?: string` to `BacktestRun` (`src/domain/backtest-run.ts`). **Optional** ⇒ the SP-4 path, which never sets it, compiles unchanged (zero-diff).
- **Migration 0008 (additive):** `ALTER TABLE backtest_run ADD COLUMN task_id text;` (nullable), generated via `pnpm db:generate`. Add the column to the drizzle `backtest_run` schema and to the drizzle row↔domain mapping (`createSubmitted` writes it; row→domain reads it; null → `undefined`).
- **Producer:** `runPlatformBacktest` sets `taskId: task.id` when it builds the persisted run — a one-line addition to the SP-7.2b (`research_platform`) branch. SP-4 untouched.
- **Legacy note:** runs persisted by SP-7.2b *before* 0008 have `task_id = NULL` → resume skips them (`missing_task_id`). Acceptable: SP-7.2b just merged; no real data exists.

---

## 5. Repository — find resumable runs

Add to `BacktestRunRepository` (`src/ports/backtest-run.repository.ts`):

```ts
/** Pending platform-backed runs eligible for resume (status='submitted' AND backend='research_platform'). */
listResumablePlatformRuns(): Promise<BacktestRun[]>;
```

- **Drizzle** (`drizzle-backtest-run.repository.ts`): `WHERE status='submitted' AND backend='research_platform'` — served by the existing `backtest_run_status_idx`. `platform_run_id` is `NOT NULL`, so it is always present for these rows.
- **In-memory** (`in-memory-backtest-run.repository.ts`): mirror the filter.
- SP-7.3 scans **`submitted` only**. (`completed`-without-`Evaluation` recovery is a deferred follow-up; see §2 / §9.)

---

## 6. Shared platform terminal-outcome handler

The terminal (non-`pending`) block in `runPlatformBacktest` and the one resume needs are **identical**. Extract it once and have both callers use it. `finalizeBacktestCompletion` remains the shared completion/evaluation tail (unchanged).

**New** in `src/orchestrator/handlers/backtest-support.ts` (next to `finalizeBacktestCompletion` + `event`):

```ts
export type PlatformTerminalResult =
  | { kind: 'completed' }
  | { kind: 'failed'; reason: 'platform_rejected' | 'result_invalid' };

/**
 * Maps a TERMINAL platform outcome (rejected | completed) to persistence + events.
 * Pending is handled by the caller (each path emits its own pending event). Platform-specific;
 * the completion tail delegates to finalizeBacktestCompletion.
 */
export async function applyPlatformTerminalOutcome(
  services: AppServices,
  task: ResearchTask,
  args: { runId: string; hypothesisId: string },
  outcome: PlatformRunOutcome, // narrowed to rejected | completed by the caller
): Promise<PlatformTerminalResult>;
```

Behavior (lifted verbatim from `runPlatformBacktest`, so the submit path is behavior-preserving):
- **rejected** → `backtests.markRejected(runId)`; emit `backtest.failed { runId, reason: 'platform_rejected', terminalCode? }`; return `{ kind: 'failed', reason: 'platform_rejected' }`.
- **completed** → `mapPlatformComparison(outcome.summary)`:
  - `MetricMappingError` → `backtests.markFailed(runId)`; emit `backtest.failed { runId, reason: 'result_invalid', detail: 'metric_mapping_error', code }`; return `{ kind: 'failed', reason: 'result_invalid' }`.
  - otherwise → `finalizeBacktestCompletion(services, task, { runId, hypothesisId, comparison, artifactRefs: [...outcome.artifactIds] })`; return `{ kind: 'completed' }`.

It emits only **canonical** events (`backtest.failed`; and `backtest.completed` + `evaluation.completed` via finalize). The resume-specific bracket events (§8) are emitted by `resumePlatformRun` around the call, keyed off the returned `kind`.

**`runPlatformBacktest` refactor** (`run-platform-backtest.ts`): replace the inline post-submit terminal block with:

```ts
if (outcome.status === 'pending') { /* emit backtest.pending; return; */ }
await applyPlatformTerminalOutcome(services, task, { runId, hypothesisId }, outcome);
```

Its existing test suite is the regression gate — events and transitions are identical.

---

## 7. Core — `resumePlatformRun(services, run)`

```ts
export type ResumeOutcome =
  | { kind: 'completed'; runId: string }
  | { kind: 'pending';   runId: string }
  | { kind: 'failed';    runId: string; reason: 'platform_rejected' | 'result_invalid' }
  | { kind: 'skipped';   runId: string; reason: 'not_resumable' | 'already_evaluated' | 'missing_task_id' | 'task_not_found' };
```

Flow:

```
// Guard #1 (start): re-read run; Evaluation-exists check FIRST, then require status==='submitted'.
fresh = backtests.findById(run.id)
if (!fresh)                                           -> skip 'not_resumable'
if (evaluations.listByBacktestRun(run.id).length)    -> skip 'already_evaluated'
if (fresh.status !== 'submitted')                    -> skip 'not_resumable'

// Recover task for event continuity.
if (!fresh.taskId)                                    -> skip 'missing_task_id'
task = researchTasks.findById(fresh.taskId)
if (!task)                                            -> skip 'task_not_found'

emit backtest.resume.started { runId, platformRunId }

// Bounded re-poll — NO submit. Reuses SP-7.2a capability.
outcome = pollOverlayRun(researchPlatform, fresh.platformRunId, platformPoll)
if (outcome.status === 'pending'):
    emit backtest.resume.pending { runId, platformRunId }
    return pending                      // run stays 'submitted'; next probe retries

// Guard #2 (immediately before applying the terminal outcome / finalize):
// re-read run; Evaluation-exists check FIRST, then require still status==='submitted'.
again = backtests.findById(run.id)
if (!again)                                           -> skip 'not_resumable'
if (evaluations.listByBacktestRun(run.id).length)    -> skip 'already_evaluated'
if (again.status !== 'submitted')                    -> skip 'not_resumable'

result = applyPlatformTerminalOutcome(services, task, { runId, hypothesisId: fresh.hypothesisId }, outcome)
if (result.kind === 'completed'):
    emit backtest.resume.completed { runId }
    return completed
return failed(result.reason)
```

**Double idempotency check (per review):** Each guard re-reads the run, checks `evaluations.listByBacktestRun` **first** (→ `already_evaluated`), then requires `status==='submitted'` (→ `not_resumable`). Ordering matters: a second resume of a successfully finalized run (status `evaluated` **and** an `Evaluation` present) must return `already_evaluated`, not `not_resumable`. **Guard #1** runs at entry, before any events — its failure emits **nothing**. **Guard #2** runs immediately before the terminal transition (after the completed/rejected poll, before `finalizeBacktestCompletion` / `markRejected` / `markFailed`); because it fires *after* `backtest.resume.started` was already emitted, its failure emits **no additional (terminal) events** — only the pre-existing `started` event remains, and there is no state change. The guards live in the core so a future callback handed a **stale** `BacktestRun` is safe. (Guard #2 wraps the rejected transition too, strictly safer than the minimum asked.)

---

## 8. Core — `resumePendingPlatformRuns(services)` (batch)

```ts
export interface ResumeProbeResult {
  total: number;
  outcomes: ResumeOutcome[];          // one per run
  errors: { runId: string; error: string }[]; // per-run failures that threw (e.g. transport)
  counts: Record<ResumeOutcome['kind'] | 'error', number>;
}
```

```
runs = backtests.listResumablePlatformRuns()
for each run:
  try: outcomes.push(resumePlatformRun(services, run))
  catch e: errors.push({ runId: run.id, error: errMsg(e) })   // one transport failure does not abort the batch
return summary
```

Per-run error isolation matters: `getRunStatus` raising a `GatewayRunError` for one run must not stop the others. Transport/gateway errors are **not** recorded as a business failure here (no `markFailed`) — the run stays `submitted` and is retried on the next probe, matching the submit path's "throw → retry" semantics.

---

## 9. Idempotency & concurrency — honest scope

**Guaranteed by SP-7.3:**
- **Sequential re-runs** of the probe are safe: finalized/failed runs leave `status != 'submitted'` (only pending runs stay `submitted`; `evaluated` / `rejected` / `failed` do not), so `listResumablePlatformRuns` never re-selects them.
- **Stale single-delivery callback safety:** the double guard (re-read status + empty-`Evaluation` check at entry and pre-finalize) means a core invocation handed an out-of-date run cannot double-finalize.
- **Exactly one `Evaluation`** per completed run in the sequential model: the completion tail (`finalizeBacktestCompletion`) transitions `submitted → completed → evaluated`; `evaluations.listByBacktestRun` is the explicit duplicate guard.

**Explicitly deferred (queue/callback slice):**
- **Full multi-worker exactly-once under concurrency** (two resumers racing the *same* `submitted` run between the guard read and the first finalize write). SP-7.3 does not add a transactional **claim/CAS** (the `status` column is plain `text`, so a transient `resuming` status needs no migration when we add it). This is the first item of the queue follow-up.

---

## 10. Event taxonomy

All on the recovered `task.id`:

| Phase | Events |
|-------|--------|
| resume begins (after Guard #1) | `backtest.resume.started` |
| platform still running | `backtest.resume.pending` (run stays `submitted`) |
| completed | `backtest.completed` + `evaluation.completed` (from `finalizeBacktestCompletion`, unchanged) → `backtest.resume.completed` |
| failed | `backtest.failed { reason: 'platform_rejected' \| 'result_invalid' }` (canonical, same as the submit path) |

Resume `*` events **bracket** the canonical finalize events, so a resumed completion reads: `resume.started → backtest.completed → evaluation.completed → resume.completed`. No separate `resume.failed` — `backtest.failed` is the canonical terminal and `resume.started` already marks the attempt as a resume.

---

## 11. CLI trigger — `scripts/platform-resume.ts`

Mirrors the worker entrypoint (`src/worker/worker.ts`), **not** the stateless probe scripts (resume must hit the DB to find pending runs and persist the `Evaluation`):

```ts
// guarded by import.meta.url === pathToFileURL(process.argv[1]).href
const { services, pool } = composeRuntime();   // from ../src/composition.ts
try {
  const result = await resumePendingPlatformRuns(services);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await pool.end();
}
```

`package.json` script: `"platform:resume": "node --experimental-strip-types scripts/platform-resume.ts"` (consistent with `platform:run`).

**Runtime note:** like `pnpm worker`, the live boot of this CLI inherits the repo-wide `--experimental-strip-types` parameter-property regression (separate slice). This does **not** affect the SP-7.3 core/batch logic or the KEY CHECK, which are exercised entirely through Vitest with in-memory adapters.

---

## 12. Files

**New**
- `src/orchestrator/handlers/resume-platform-backtest.ts` — `resumePlatformRun`, `resumePendingPlatformRuns`, `ResumeOutcome`, `ResumeProbeResult`.
- `src/orchestrator/handlers/resume-platform-backtest.test.ts` — unit + KEY CHECK + idempotency tests.
- `scripts/platform-resume.ts` — thin CLI.
- `migrations/0008_*.sql` — additive `task_id` column (generated).

**Modified**
- `src/domain/backtest-run.ts` — `taskId?: string` on `BacktestRun`.
- `src/orchestrator/handlers/backtest-support.ts` — `applyPlatformTerminalOutcome` + `PlatformTerminalResult`.
- `src/orchestrator/handlers/run-platform-backtest.ts` — set `taskId: task.id`; call `applyPlatformTerminalOutcome` for the terminal block.
- `src/ports/backtest-run.repository.ts` — `listResumablePlatformRuns()`.
- `src/adapters/repository/in-memory-backtest-run.repository.ts` — implement the query.
- `src/adapters/repository/drizzle-backtest-run.repository.ts` — implement the query + `task_id` write/read mapping.
- drizzle `backtest_run` schema module — `task_id` column.
- `package.json` — `platform:resume` script.
- `src/orchestrator/handlers/run-platform-backtest.test.ts` — assert `taskId` persisted; stays green through the refactor.

---

## 13. Testing strategy

Core (Vitest, in-memory repos + fake `ResearchPlatformPort`):
- **KEY CHECK** — `submitted` + completed poll → exactly one `Evaluation`, run `evaluated`, event sequence `resume.started → backtest.completed → evaluation.completed → resume.completed`.
- **pending** — re-poll pending → run stays `submitted`, `resume.pending` emitted, no `Evaluation`.
- **rejected** — `markRejected`, `backtest.failed { platform_rejected }`, no `Evaluation`.
- **metric mapping error** — `markFailed`, `backtest.failed { result_invalid }`, no `Evaluation`.
- **idempotency** — second `resumePlatformRun` after a successful finalize (status `evaluated` **and** an `Evaluation` present) → `skipped 'already_evaluated'` (the Evaluation-exists check precedes the status check), no duplicate `Evaluation`.
- **task recovery** — `missing_task_id` (null `taskId`) and `task_not_found` → clean `skipped`, no events.
- **batch** — `resumePendingPlatformRuns` selects only `submitted` + `research_platform`; one run throwing (transport) is isolated into `errors[]` while others proceed; `counts` correct.

Repository:
- `listResumablePlatformRuns` filters correctly (in-memory + drizzle); `task_id` round-trips through `createSubmitted` → row → domain.

Regression / invariants:
- `runPlatformBacktest` existing tests green after the `applyPlatformTerminalOutcome` extraction (behavior-preserving).
- SP-4 path tests green (optional `taskId`, additive migration ⇒ zero-diff).
- `pnpm typecheck`, full `pnpm test`, and the no-sibling SDK boundary check green.

---

## 14. Relationship to the future callback path

`resumePlatformRun(services, run)` is the single seam the callback path will reuse: on a platform push, the callback handler loads the one run and calls `resumePlatformRun` — the entry/pre-finalize guards already make a stale or duplicate delivery safe. The queue/scheduler reuses `resumePendingPlatformRuns`. The only thing the concurrency path adds on top is the **claim/CAS** guard (§9) to upgrade "sequential + stale-safe" to "multi-worker exactly-once."
