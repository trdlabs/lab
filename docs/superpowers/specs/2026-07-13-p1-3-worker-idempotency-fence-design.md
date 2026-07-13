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

Replace the unconditional `updateStatus(id, 'running')` with a single conditional UPDATE —
an **atomic terminal fence**:

```
startRunUnlessTerminal(id): Promise<boolean>
  UPDATE research_task SET status='running', updated_at=now()
  WHERE id = :id AND status NOT IN ('completed','rejected')
  -> true iff a row was updated
```

The worker skips a task that did not transition:

```ts
const started = await services.researchTasks.startRunUnlessTerminal(task.id);
if (!started) {
  const current = await services.researchTasks.findById(task.id); // authoritative status for the audit
  await services.events.append(event(task.id, 'task.redelivery_skipped', { status: current?.status }));
  return; // ack the redelivery; do NOT re-run the handler
}
```

### What this does and does NOT guarantee

- **Guaranteed:** a `completed`/`rejected` task never re-runs its handler. The check-and-set is a
  single UPDATE, so there is no TOCTOU between reading the status and flipping it.
- **NOT guaranteed:** mutual exclusion between two concurrent *non-terminal* deliveries. Both pass
  the fence (`running -> running`) and dispatch. Serializing concurrent delivery needs an owner /
  lease token (claim the row for THIS worker, e.g. `WHERE owner IS NULL OR lease_expired`), which is
  a **separate follow-up** and a prerequisite for raising `LAB_QUEUE_CONCURRENCY`. This slice does
  not attempt it — BullMQ already delivers a job to one consumer at a time; the residual is the
  stalled-redelivery window, which the terminal fence closes for the dangerous (completed) case.

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

1. A `completed`/`rejected` task is never re-dispatched (the terminal fence).
2. The status check-and-set is atomic — no TOCTOU between reading and flipping. (This does NOT
   imply concurrent-delivery mutual exclusion — see "What this does and does NOT guarantee".)
3. Handlers are unchanged. **Cycle-2 handlers (research-run-cycle, revision-*,
   backtest-*, paper-*) are not touched** — this is purely the generic worker lifecycle.
4. No schema change (a conditional `UPDATE`), so no migration.

## Scope

- `src/ports/research-task.repository.ts` — add `startRunUnlessTerminal`.
- `src/adapters/repository/drizzle-research-task.repository.ts` — conditional UPDATE + rowCount.
- `src/adapters/repository/in-memory-research-task.repository.ts` — mirror the guard.
- `src/worker/worker.ts` — claim + skip-with-audit.
- Tests: repo (claim succeeds on non-terminal, fails on completed/rejected) + worker
  (redelivery of a completed task does NOT dispatch; a queued task dispatches once).

## Out of scope (do not pull in)

- **Concurrent-delivery mutual exclusion** (owner/lease token). The follow-up that upgrades this
  terminal fence into a real single-flight claim; a prerequisite for raising `LAB_QUEUE_CONCURRENCY`.
- P1-2 (route all enqueues through task-intake), P1-25 (23505 handling), per-profile advisory lock
  (P1-7) — the rest of the concurrency-unblock package, owned elsewhere / land later.
