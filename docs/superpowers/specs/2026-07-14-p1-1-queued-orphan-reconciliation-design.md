# P1-1 — Queued-orphan reconciliation (boot sweeper + research_task as a light outbox)

Source finding: `docs/research/2026-07-12-lab-code-review-bugs-and-bottlenecks.md` §P1-1.

## Problem

`createAndEnqueueTask` (src/orchestrator/task-intake.ts) persists the row, then enqueues:

```ts
await deps.repo.create(task);          // status = 'queued'
await deps.queue.enqueue(envelope, ...); // <- crash / failure here strands the row
```

A crash (or an `enqueue` failure) between the two leaves the DB row `queued` forever with
no queue job. Worse, the dedup guard hides it: a later intake with the same `dedupeKey`
finds the stranded row and returns `{ deduped: true }` **without** re-enqueuing, so the
orphan is never repaired. It wedges the loop even at `LAB_QUEUE_CONCURRENCY=1`.

## Approach — boot sweeper, with `research_task` as a light outbox

At worker startup, before consuming, scan for `queued` rows and re-enqueue them. The row
itself is the durable record of intent (no separate outbox table / relay process). Chosen
over hot-path re-enqueue-on-dedupe (which only repairs orphans that get a *second* intake
with the same dedupeKey, and widens the intake surface) and over a transactional outbox
(a new table + relay poller — overkill at this scale).

**Durability boundary (the honest residual risk):** reconciliation runs at boot only, so an
orphan is repaired at the next worker restart, not immediately. That is the accepted
trade-off for a minimal, no-relay design at current (single-user, low-volume) scale.

## Design

### 1. Persist scheduling intent — `available_at`

Store an **absolute** availability time on the row, not the original `delayMs`, so a delayed
orphan is restored with its *remaining* delay rather than a fresh full delay.

- Migration (additive): `research_task.available_at timestamptz NULL`. Next free migration
  number at implementation time (expected 0025 — verify `ls migrations/` after rebasing onto
  current main; parallel PRs such as R5a/#175 may claim a number).
- Domain: add `availableAt?: string` (ISO) to `ResearchTask`.
- `createAndEnqueueTask` computes `availableAt` from a single injected `now`:
  `availableAt = new Date(now + (delayMs ?? 0)).toISOString()` and writes it on the row.
  The hot path still passes `delayMs` straight to `queue.enqueue`; `available_at` is the
  durable copy used only for restoration.

### 2. `listQueued()` — narrow repo read

`ResearchTaskRepository.listQueued(): Promise<ResearchTask[]>` — rows with `status='queued'`
only, in a **stable order (`createdAt, id`)**. Kept narrow (the sweeper is the only consumer)
rather than a general `listByStatus`. Implemented on the port, drizzle, and in-memory adapters.

### 3. `reconcileQueuedTasks({ repo, queue, now })` — the sweeper

```ts
let attempted = 0, reEnqueued = 0;
for (const t of await repo.listQueued()) {
  attempted += 1;
  const delayMs = remainingDelayMs(t.availableAt, now());
  await queue.enqueue(toQueueEnvelope(t), delayMs > 0 ? { delayMs } : undefined);
  reEnqueued += 1;
}
return { attempted, reEnqueued };
```

- `toQueueEnvelope(task)` — a shared helper (extracted from the inline envelope build in
  task-intake, reused there) so the reconstructed envelope carries the **same `dedupeKey`**,
  hence the same BullMQ jobId.
- `remainingDelayMs(availableAt, now)`: `null/undefined → 0` (legacy rows / immediate);
  a valid future ISO → `max(0, Date.parse(availableAt) - now)`. A **non-empty but unparseable**
  `availableAt` is a **data error → throw** (never coerce NaN into an implicit immediate).
- Strictly `queued`. `running / completed / rejected / failed` are never touched — a crash
  *after* the handler starts leaves the row `running` (the worker's P1-3 fence transitions to
  running before dispatch), which BullMQ's own stalled-redelivery + the P1-3 terminal fence
  handle, not this sweeper.

### 4. Wiring & failure policy

In the worker runtime entrypoint (`worker.ts`), reconcile **before** starting the consumer,
so the worker never races reconciliation against live job pickup:

```ts
const { attempted, reEnqueued } = await reconcileQueuedTasks({ repo, queue, now });
console.log(`reconciled queued tasks: attempted=${attempted} re-enqueued=${reEnqueued}`);
startWorker({ queue, router, services });
```

- **Logging** counts `attempted` / `re-enqueued`, **not** "restored": without queue
  inspection we cannot tell a genuinely lost job from one that still exists (the enqueue is a
  no-op in that case). Claiming "restored N" would be false.
- **Fail-fast:** an `enqueue` error during the sweep **aborts startup** (propagates out of the
  entrypoint). Starting the worker after a partial sweep would run with knowingly-incomplete
  reconciliation.

### 5. Idempotency ("no duplicate active jobs")

The sweeper does **not** probe for job existence (`TaskQueuePort` can't). It relies on the
adapter being idempotent by jobId (`dedupeKey ?? taskId`):

- **BullMQ:** `add` with an existing jobId is a no-op (active job) and recreates a lost one.
  `toQueueEnvelope` preserves `dedupeKey` so the jobId matches.
- The keyless case is covered too: BullMQ's jobId falls back to `taskId`, which the row carries.

## Testing

The stock `InMemoryQueueAdapter` is insufficient here: it dedupes **only** by `dedupeKey`
(keyless envelopes are always delivered), whereas BullMQ keys on `dedupeKey ?? taskId`, and it
**ignores** `delayMs` by design. So the sweeper tests use a small **recording queue fake** that
(a) records each `enqueue(envelope, opts)` for `delayMs` assertions and (b) models BullMQ jobId
identity (`dedupeKey ?? taskId`) for the active-job case.

Required cases:
- **immediate orphan** — `availableAt` null/past, fresh queue → enqueued once with `delayMs`
  absent/0.
- **delayed orphan** — `availableAt` in the future (injected `now`) → enqueued with
  `delayMs === max(0, availableAt - now)`.
- **active job → no-op, both identity modes:**
  - task **with** `dedupeKey` — pre-seed the jobId, reconcile → not enqueued again;
  - task **without** `dedupeKey` — identity via `taskId` — pre-seed, reconcile → not enqueued.
- **non-queued untouched** — seed `completed/rejected/running/failed` → `listQueued` excludes
  them → `enqueue` never called.
- **unparseable `availableAt`** → throws (data error, not implicit immediate).
- **fail-fast** — a queue whose `enqueue` throws → `reconcileQueuedTasks` rejects (startup aborts).
- **`listQueued` order** — returns `queued` rows sorted by `createdAt, id`.
- **gated Redis** (like the other `DATABASE_URL`-style gated tests): a real BullMQ `add()`
  twice with the same jobId yields a single job — locks the production idempotency assumption.

## Scope

- `src/domain/types.ts` — `availableAt?: string` on `ResearchTask`.
- migration — additive `available_at` column.
- `src/ports/research-task.repository.ts` — `listQueued()`.
- `src/adapters/repository/{drizzle,in-memory}-research-task.repository.ts` — `listQueued` + persist `available_at`.
- `src/orchestrator/task-intake.ts` — write `availableAt`; extract `toQueueEnvelope`.
- `src/orchestrator/reconcile-queued-tasks.ts` (new) — the sweeper.
- `src/worker/worker.ts` — reconcile before `startWorker`.
- tests as above.

## Out of scope

- Hot-path re-enqueue-on-dedupe (doesn't cover no-second-intake orphans; widens surface).
- Transactional outbox table + relay.
- Continuous (non-boot) reconciliation.
- R5 / revision-build.

## Rollout note

Rebase onto current main after R5a/#175 lands and generate the migration as the next free
number (verify `ls migrations/`; expected 0025). Additive column, no backfill required — legacy
rows with `available_at IS NULL` reconcile as immediate.
