# Lab-side parallel backtests (Tier 1 of the scaling analysis) — design

Date: 2026-07-03 (rev 2 after user review: `run_pending` resume moved out)
Status: awaiting user re-approval
Context: `trading-backtester/docs/ROADMAP.md` Phase D item 15 (analysis 2026-07-02). The
backtester side already scales horizontally (Pg SKIP-LOCKED queue, N worker processes,
dedup + coalescing validated); the lab submits strictly sequentially, so backtester
workers sit idle. This spec parallelizes the lab's submission/orchestration layer.

## Goals

1. Grid points of a WFO round run concurrently instead of `for … await` (biggest win:
   "8 × ~30 s serial" → "~30 s wall").
2. More than one research task can progress at a time (BullMQ worker concurrency knob).
3. Baseline lane overlaps train and holdout members once the holdout boundary resolves.

## Non-goals

- Webhook/callback-driven completion (spec №2; `callbackUrl` plumbing stays as is).
- **`run_pending` → resume (moved to spec №2 by user decision).** A poll-budget expiry
  still fails the experiment `INCONCLUSIVE 'run_pending'`, exactly as today. Resume is
  a durable-workflow change, not a parallelism change — review of the queue/lifecycle
  mechanics showed it needs real design, which belongs with the webhook spec:
  - `QueueEnvelope` (`src/domain/types.ts`) has no payload/counter field and
    `QueueEnvelopeSchema` is strict — a resume counter needs an envelope extension, the
    existing `attempt` field, or `ResearchTask.payload`.
  - `BullMqQueueAdapter.enqueue` pins `jobId = dedupeKey ?? taskId` with
    `removeOnComplete: 1000` — re-enqueueing the same taskId may be silently dropped
    while the completed job is retained; resume needs a distinct jobId scheme or a
    dedicated enqueue mode.
  - `startWorker` (`src/worker/worker.ts`) owns the generic lifecycle: handler return →
    `completed`, throw → `failed`. A "pending, re-enqueued" outcome fits neither branch
    and requires an explicit third path in the worker contract.
  - `StrategyBacktestRunRepository` has no `findByResumeToken`, and the executor creates
    a fresh `labRunId` + `createSubmitted` per call — replay would duplicate rows
    without a new port method (port + InMemory + Drizzle + tests).
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
- Grid points returned `pending` keep today's behavior (counted as non-completed by
  `rankTopN`).
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

## Alternatives considered

- **Submit-all-then-shared-poll** (restructure runGrid into a submit phase + one poll
  loop): no benefit without a batch-status endpoint on the backtester; bigger diff;
  loses the executor's per-point persist-then-poll invariant. Rejected.
- **Webhook completion now / resume now**: strictly better long-term, but a larger
  architectural change (ingress endpoint auth, worker lifecycle third path, BullMQ
  jobId scheme, repository port extension); split into the next spec so the
  parallelism win ships first. (User decision, rev 2.)
- **Unbounded `Promise.all` over grid points**: simplest, but multiplies unthrottled
  load against an ingress with no backpressure. Rejected — bounded pool.

## Config surface (all new)

| Env | Default | Effect |
|---|---|---|
| `RESEARCH_GRID_CONCURRENCY` | 4 | max in-flight grid points per WFO round |
| `LAB_QUEUE_CONCURRENCY` | 1 | BullMQ worker concurrency (experiments in flight) |

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
- Full existing suite stays green (`pnpm check`).

## Rollout

Pure lab-side change: no contract, schema, or lifecycle changes. Defaults keep
single-experiment behavior except grid parallelism (4). Ship as one PR on
`feat/lab-parallel-backtests` (worktree `.worktrees/feat-lab-parallel-backtests`).

## Decision log

1. Scope = "parallelism first"; webhooks split into spec №2 (recommended, confirmed).
2. rev 2 (user review): `run_pending` → resume moved OUT into spec №2 — the four
   queue/lifecycle constraints above are recorded as design inputs for that spec.
3. `RESEARCH_GRID_CONCURRENCY` default 4 (mirror of backtester `WORKER_CONCURRENCY`).
