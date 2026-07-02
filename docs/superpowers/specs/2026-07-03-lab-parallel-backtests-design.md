# Lab-side parallel backtests (Tier 1 of the scaling analysis) — design

Date: 2026-07-03
Status: draft, awaiting user review
Context: `trading-backtester/docs/ROADMAP.md` Phase D item 15 (analysis 2026-07-02). The
backtester side already scales horizontally (Pg SKIP-LOCKED queue, N worker processes,
dedup + coalescing validated); the lab submits strictly sequentially, so backtester
workers sit idle. This spec parallelizes the lab's submission/orchestration layer.
Webhook-driven completion is deliberately OUT of scope — it is the follow-up spec.

## Goals

1. Grid points of a WFO round run concurrently instead of `for … await` (biggest win:
   "8 × ~30 s serial" → "~30 s wall").
2. More than one research task can progress at a time (BullMQ worker concurrency knob).
3. Baseline lane overlaps train and holdout members once the holdout boundary resolves.
4. A poll-budget expiry (`run_pending`) no longer fails the experiment `INCONCLUSIVE`;
   the experiment resumes instead (bounded), leveraging existing idempotency.

## Non-goals

- Webhook/callback-driven completion (spec №2; `callbackUrl` plumbing stays as is).
- Any backtester-side change (backpressure, bundle-by-ref — ROADMAP Phase D Tier 2).
- Changing verdict semantics, metric mapping, ranking, or `resumeToken`/`experimentKey`
  derivation. Runs and verdicts must be byte-identical to today's for the serial case.

## Design

### 1. Parallel grid — `ParamGridRunner.runGrid` (`src/research/param-grid-runner.ts`)

Replace the serial `for (const point of points) await execute(…)` loop with a bounded
parallel map (small local `mapWithConcurrency` helper; no new dependency):

- Each unit of work stays exactly today's per-point sequence: `execute()` (submit →
  persist row → poll) → `computeStrategyParamsHash` → `GridResult`.
- Results are placed by point index, so `allResults` ordering — and therefore
  `rankTopN` input and tie-breaking — is identical to the serial run.
- Error semantics preserved: today a thrown `GatewayRunError` aborts the whole grid
  ("caller retries; resumeToken makes replay idempotent"). The parallel map is
  fail-fast: first rejection propagates after in-flight units settle; replay is
  idempotent for both settled and abandoned points via `resumeToken`.
- Concurrency knob: `RESEARCH_GRID_CONCURRENCY` (env, default **4**, min 1). Rationale:
  matches the backtester's default `WORKER_CONCURRENCY=4`; the backtester has no
  ingress backpressure yet (Phase D Tier 2), so the lab must self-limit.

### 2. BullMQ worker concurrency (`src/adapters/queue/bullmq-queue.adapter.ts`)

`BullMqQueueAdapter.process` currently constructs `Worker` without a `concurrency`
option (default 1). Add `LAB_QUEUE_CONCURRENCY` (env, default **1** — current behavior
preserved), passed through the adapter constructor → `Worker` options. Total lab
in-flight pressure = `LAB_QUEUE_CONCURRENCY × RESEARCH_GRID_CONCURRENCY`; defaults keep
it at 4. Document the multiplication in `.env.example`.

### 3. Train ∥ holdout — `ExperimentService.runStrategyBaselineValidation`

After the sanity gate and boundary resolution, run the train and holdout members with
`Promise.all` instead of sequentially. Verdict checks stay in today's order (train
first, then holdout) so failure reasons are deterministic.

Accepted trade-off: when train fails, a holdout run has already been submitted (today
it never is). One extra backtester run in a failure path; mitigated server-side by
dedup/coalescing and bounded by the lane's own gating. The sanity member stays first —
it produces the boundary both others depend on.

### 4. `run_pending` → resume instead of fail

Today every `pending` member outcome maps to `fail('INCONCLUSIVE', 'run_pending')` —
a slow backtester *fails* experiments. Change: surface `pending` as a retriable
condition at the task-handler level:

- `runStrategyBaselineValidation` returns a new explicit outcome
  `{ experimentId, verdict: 'PENDING_RESUME' }`-shaped signal (exact shape decided in
  the plan; alternative: throw a typed `ExperimentPendingError`) instead of writing the
  terminal INCONCLUSIVE evaluation, leaving the experiment row `running`.
- The queue handler re-enqueues the same task envelope with a delay
  (`RESEARCH_RESUME_DELAY_MS`, default 30 000) and a resume-attempt counter carried in
  the envelope; after `RESEARCH_RESUME_MAX_ATTEMPTS` (default **3**) it falls back to
  today's terminal `INCONCLUSIVE 'run_pending'`.
- Replay is cheap and idempotent by construction: `experimentKey` re-attaches to the
  existing experiment row; each member re-submit carries the same `resumeToken`, and the
  backtester's `insertOrGet` returns the already-running/completed platform run, so the
  replayed lane re-polls rather than re-computes. (The existing
  `resumePendingPlatformRuns` batch driver stays untouched — it covers orphaned *runs*;
  this covers the *experiment* lane.)
- **Required guard (plan must verify):** `BacktesterStrategyExperimentRunExecutor.execute`
  calls `strategyBacktests.createSubmitted` with a fresh `labRunId` on every call — a
  replay must not create a duplicate row for the same `resumeToken`. Add a
  find-by-resumeToken fast path (reuse the existing row and go straight to polling) or
  an upsert keyed on `resumeToken`.

Grid points returned `pending` keep today's behavior in this spec (counted as
non-completed by `rankTopN`); extending resume to grids can ride the webhook spec.

## Alternatives considered

- **Submit-all-then-shared-poll** (restructure runGrid into a submit phase + one poll
  loop): no benefit without a batch-status endpoint on the backtester; bigger diff;
  loses the executor's per-point persist-then-poll invariant. Rejected.
- **Webhook completion now**: strictly better long-term (no polling at all), but a
  larger architectural change (ingress endpoint auth, executor state machine); split
  into the next spec so the parallelism win ships first.
- **Unbounded `Promise.all` over grid points**: simplest, but multiplies unthrottled
  load against an ingress with no backpressure. Rejected — bounded pool.

## Config surface (all new, all defaults preserve current behavior except grid)

| Env | Default | Effect |
|---|---|---|
| `RESEARCH_GRID_CONCURRENCY` | 4 | max in-flight grid points per WFO round |
| `LAB_QUEUE_CONCURRENCY` | 1 | BullMQ worker concurrency (experiments in flight) |
| `RESEARCH_RESUME_DELAY_MS` | 30000 | delay before re-enqueueing a pending experiment |
| `RESEARCH_RESUME_MAX_ATTEMPTS` | 3 | resume attempts before terminal INCONCLUSIVE |

## Testing

- `mapWithConcurrency`: ordering by index, bound respected (max in-flight counter),
  fail-fast propagation, concurrency=1 degenerates to today's serial behavior.
- `ParamGridRunner`: serial-equivalence golden — same `GridRunOutput` (order, ranking,
  rejected count) with concurrency 1 vs N against a fake executor with shuffled
  completion order.
- BullMQ adapter: `Worker` receives the `concurrency` option (constructor-injection
  test, no live Redis).
- Baseline lane: train∥holdout — both submitted after boundary; verdict/reason parity
  with the serial implementation for every gate outcome (train fails, holdout fails,
  both fail).
- Resume: pending → task re-enqueued with delay + attempt counter; attempts exhausted →
  terminal `INCONCLUSIVE 'run_pending'`; replay does not duplicate
  `StrategyBacktestRun` rows (resumeToken guard); replayed member re-attaches to the
  same platform run (fake platform asserts single submit per resumeToken).
- Full existing suite stays green (`pnpm check`).

## Rollout

Pure lab-side change, no contract or schema changes expected (resume counter rides in
the queue envelope; if a schema change turns out to be needed for the executor
resumeToken guard, the plan flags it). Defaults keep single-experiment behavior except
grid parallelism (4). Ship as one PR on `feat/lab-parallel-backtests` (worktree
`.worktrees/feat-lab-parallel-backtests`).

## Open decisions taken on the user's behalf (flagged for review)

1. Scope = "parallelism first"; webhooks split into spec №2 (recommended option,
   user was AFK at the scope question).
2. `RESEARCH_GRID_CONCURRENCY` default 4 (mirror of backtester `WORKER_CONCURRENCY`).
3. Grid-point `pending` outcomes NOT resumed in this spec (baseline lane only).
4. Resume signal shape (typed error vs verdict value) deferred to the plan.
