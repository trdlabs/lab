# P1-3 — Worker idempotency fence (reliability track B)

Source finding: `docs/research/2026-07-12-lab-code-review-bugs-and-bottlenecks.md` §P1-3.

## Problem

`src/worker/worker.ts` flips a task to `running` unconditionally, with no check that
it is already terminal:

```ts
const task = await services.researchTasks.findById(envelope.taskId);
await services.researchTasks.updateStatus(task.id, 'running'); // <-- unconditional
await router.dispatch(...);
await services.researchTasks.updateStatus(task.id, 'completed');
```

If the process crashes (or the job stalls) **between `dispatch` and the BullMQ ack**,
the job is redelivered. The task row is already `completed`, but the worker re-runs the
handler anyway — for `research.run_cycle` that means fresh LLM calls, new fingerprints,
and a second batch of hypotheses written under the same `correlationId`. This is a
correctness hazard independent of concurrency (it fires at `LAB_QUEUE_CONCURRENCY=1`).

## Fix

Replace the unconditional `updateStatus(id, 'running')` with a single **atomic claim**:

```
tryStartRun(id): Promise<boolean>
  UPDATE research_task SET status='running', updated_at=now()
  WHERE id = :id AND status NOT IN ('completed','rejected')
  -> true iff a row was updated
```

The worker skips a task it could not claim:

```ts
const claimed = await services.researchTasks.tryStartRun(task.id);
if (!claimed) {
  await services.events.append(event(task.id, 'task.redelivery_skipped', { status: task.status }));
  return; // ack the redelivery; do NOT re-run the handler
}
```

This is fence + claim in **one** step — there is no TOCTOU window between reading the
status and flipping it (the earlier `findById` is only for the audit payload; the claim
is authoritative).

## Terminal stop-set

Skip re-run only when the task is already terminal: **`completed` or `rejected`**.

| status      | on redelivery | why |
|-------------|---------------|-----|
| `completed` | skip          | idempotent — the work is done and its effects are persisted |
| `rejected`  | skip          | terminal domain decision; re-running would be wrong |
| `failed`    | re-run        | BullMQ retry intent — a failed attempt should be retried |
| `running`   | re-run        | previous attempt crashed before finishing; re-run it |
| `queued`    | re-run        | normal first delivery |
| `accepted`  | re-run        | pre-enqueue state; claim moves it to running |

## Invariants

1. A `completed`/`rejected` task is never re-dispatched.
2. The claim is atomic — two concurrent deliveries cannot both dispatch.
3. Handlers are unchanged. **Cycle-2 handlers (research-run-cycle, revision-*,
   backtest-*, paper-*) are not touched** — this is purely the generic worker lifecycle.
4. No schema change (a conditional `UPDATE`), so no migration.

## Scope

- `src/ports/research-task.repository.ts` — add `tryStartRun`.
- `src/adapters/repository/drizzle-research-task.repository.ts` — conditional UPDATE + rowCount.
- `src/adapters/repository/in-memory-research-task.repository.ts` — mirror the guard.
- `src/worker/worker.ts` — claim + skip-with-audit.
- Tests: repo (claim succeeds on non-terminal, fails on completed/rejected) + worker
  (redelivery of a completed task does NOT dispatch; a queued task dispatches once).

## Out of scope (do not pull in)

P1-2 (route all enqueues through task-intake), P1-25 (23505 handling), per-profile
advisory lock (P1-7) — these are the rest of the concurrency-unblock package and are
owned elsewhere / land later.
