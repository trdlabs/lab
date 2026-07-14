# P1-1 Queued-Orphan Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair `queued` research-task rows that were stranded when the process crashed between DB-create and queue-enqueue, by re-enqueuing them at worker startup.

**Architecture:** The `research_task` row is a light outbox. `createAndEnqueueTask` stamps an absolute `availableAt` on the row; at boot, a sweeper scans `queued` rows and re-enqueues them (with the remaining delay) before the consumer starts. Idempotency is provided by the queue adapter's jobId (`dedupeKey ?? taskId`), so an already-active job is a no-op.

**Tech Stack:** Node `--experimental-strip-types`, Vitest 2.1.9, Drizzle ORM / Postgres, BullMQ/Redis, Hono.

## Global Constraints

- No TypeScript parameter properties (`constructor(private x)`) — an AST guard test blocks them.
- TDD: write the failing test, watch it fail, minimal code, watch it pass, commit.
- `tsc -p tsconfig.json` must stay clean; run `npx vitest run <file>` per task.
- Drizzle/Redis integration tests are gated: `const d = process.env.DATABASE_URL ? describe : describe.skip` (and a Redis URL for the BullMQ test). They skip locally without the env and run in CI.
- Spec: `docs/superpowers/specs/2026-07-14-p1-1-queued-orphan-reconciliation-design.md`.
- Migration number is **0025** (`origin/main` already has R5a + `0024`). Re-verify `ls migrations/` before generating.

## File Structure

- `src/domain/types.ts` — add `availableAt?: string` to `ResearchTask`.
- `src/orchestrator/task-intake.ts` — clock contract, stamp `availableAt`, extract `toQueueEnvelope`.
- `src/ports/research-task.repository.ts` — `listQueued()`.
- `src/adapters/repository/in-memory-research-task.repository.ts` — `listQueued()`.
- `src/adapters/repository/drizzle-research-task.repository.ts` — `listQueued()`, persist/read `available_at`.
- `src/db/schema.ts` — `availableAt` column.
- `migrations/0025_*.sql` — additive `available_at`.
- `src/orchestrator/reconcile-queued-tasks.ts` (new) — the sweeper.
- `src/worker/worker.ts` — `bootWorker` wrapper: reconcile before `startWorker`.
- Tests colocated as `*.test.ts` beside each unit.

---

### Task 1: Clock contract, `availableAt` stamping, and `toQueueEnvelope` extraction

**Files:**
- Modify: `src/domain/types.ts` (add `availableAt?: string` to `ResearchTask`)
- Modify: `src/orchestrator/task-intake.ts`
- Test: `src/orchestrator/task-intake.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `toQueueEnvelope(task: ResearchTask): QueueEnvelope`; `TaskIntakeDeps.now?: () => number`; `ResearchTask.availableAt?: string`.

- [ ] **Step 1: Write the failing test**

Append to `src/orchestrator/task-intake.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createAndEnqueueTask, toQueueEnvelope } from './task-intake.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';

describe('createAndEnqueueTask — availableAt (P1-1)', () => {
  it('stamps availableAt = now + delayMs from a single injected clock', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const queue = new InMemoryQueueAdapter();
    const now = () => Date.parse('2026-07-14T00:00:00.000Z');
    const { taskId } = await createAndEnqueueTask(
      { taskType: 'strategy.onboard', source: 'web', payload: {}, delayMs: 5000 },
      { repo, queue, now },
    );
    const row = await repo.findById(taskId);
    expect(row?.availableAt).toBe('2026-07-14T00:00:05.000Z');
    expect(row?.createdAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('stamps availableAt = now when no delay', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const queue = new InMemoryQueueAdapter();
    const now = () => Date.parse('2026-07-14T00:00:00.000Z');
    const { taskId } = await createAndEnqueueTask(
      { taskType: 'strategy.onboard', source: 'web', payload: {} },
      { repo, queue, now },
    );
    expect((await repo.findById(taskId))?.availableAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('toQueueEnvelope preserves dedupeKey (jobId identity)', () => {
    const env = toQueueEnvelope({
      id: 't1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
      dedupeKey: 'chat-proposal:p1', status: 'queued', payload: {},
      createdAt: 'x', updatedAt: 'x',
    });
    expect(env).toEqual({ taskId: 't1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, dedupeKey: 'chat-proposal:p1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/task-intake.test.ts`
Expected: FAIL — `toQueueEnvelope` is not exported; `availableAt` is undefined.

- [ ] **Step 3: Add the domain field**

In `src/domain/types.ts`, in the `ResearchTask` interface (right after `status: TaskStatus;`), add:

```typescript
  /** Absolute time the task becomes runnable (ISO). Durable copy of the enqueue delay used to
   *  restore a stranded queued row with its remaining delay (P1-1). */
  availableAt?: string;
```

- [ ] **Step 4: Rewrite `createAndEnqueueTask` with the clock contract + helper**

Replace the body of `src/orchestrator/task-intake.ts` from the `TaskIntakeDeps` interface through the end of `createAndEnqueueTask` with:

```typescript
export interface TaskIntakeDeps {
  repo: ResearchTaskRepository;
  queue: TaskQueuePort;
  /** Injectable clock (ms). One value stamps createdAt/updatedAt AND availableAt. Default Date.now. */
  now?: () => number;
}

export interface TaskIntakeResult {
  taskId: string;
  status: TaskStatus;
  deduped: boolean;
}

/** Build the queue transport envelope for a task row. Carries dedupeKey so the BullMQ jobId
 *  (dedupeKey ?? taskId) is stable — the basis of enqueue idempotency (P1-1). */
export function toQueueEnvelope(task: ResearchTask): QueueEnvelope {
  return {
    taskId: task.id,
    taskType: task.taskType,
    correlationId: task.correlationId,
    source: task.source,
    attempt: 1,
    dedupeKey: task.dedupeKey,
  };
}

export async function createAndEnqueueTask(
  input: TaskIntakeInput,
  deps: TaskIntakeDeps,
): Promise<TaskIntakeResult> {
  if (input.dedupeKey) {
    const existing = await deps.repo.findByDedupeKey(input.dedupeKey);
    if (existing) return { taskId: existing.id, status: existing.status, deduped: true };
  }

  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const task: ResearchTask = {
    id: randomUUID(),
    taskType: input.taskType,
    source: input.source,
    correlationId: input.correlationId ?? randomUUID(),
    dedupeKey: input.dedupeKey,
    status: 'queued',
    payload: input.payload,
    availableAt: new Date(nowMs + (input.delayMs ?? 0)).toISOString(),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await deps.repo.create(task);

  await deps.queue.enqueue(toQueueEnvelope(task), input.delayMs !== undefined ? { delayMs: input.delayMs } : undefined);

  return { taskId: task.id, status: task.status, deduped: false };
}
```

Ensure `ResearchTask` is imported in the file's type imports (it already imports from `../domain/types.ts`; add `ResearchTask` to that import list).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/orchestrator/task-intake.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Verify no regression in task-intake consumers + typecheck**

Run: `npx vitest run src/orchestrator src/chat && npx tsc -p tsconfig.json`
Expected: PASS, tsc exit 0. (Existing callers omit `now` → default `Date.now`; `availableAt` is optional so no call-site breaks.)

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/orchestrator/task-intake.ts src/orchestrator/task-intake.test.ts
git commit -m "feat(intake): stamp absolute availableAt + extract toQueueEnvelope + clock contract (P1-1)"
```

---

### Task 2: `listQueued()` on the repository port + in-memory adapter

**Files:**
- Modify: `src/ports/research-task.repository.ts`
- Modify: `src/adapters/repository/in-memory-research-task.repository.ts`
- Test: `src/adapters/repository/in-memory-research-task.repository.test.ts`

**Interfaces:**
- Produces: `ResearchTaskRepository.listQueued(): Promise<ResearchTask[]>` — `status='queued'` only, ordered by `createdAt` then `id`.

- [ ] **Step 1: Write the failing test**

Append to `src/adapters/repository/in-memory-research-task.repository.test.ts` inside the top-level `describe`:

```typescript
  describe('listQueued (P1-1)', () => {
    it('returns only queued rows, ordered by createdAt then id', async () => {
      const repo = new InMemoryResearchTaskRepository();
      await repo.create(task({ id: 'b', status: 'queued', createdAt: '2026-01-01T00:00:02Z' }));
      await repo.create(task({ id: 'a', status: 'queued', createdAt: '2026-01-01T00:00:02Z' }));
      await repo.create(task({ id: 'early', status: 'queued', createdAt: '2026-01-01T00:00:01Z' }));
      await repo.create(task({ id: 'done', status: 'completed', createdAt: '2026-01-01T00:00:00Z' }));
      await repo.create(task({ id: 'run', status: 'running', createdAt: '2026-01-01T00:00:00Z' }));
      const ids = (await repo.listQueued()).map((t) => t.id);
      expect(ids).toEqual(['early', 'a', 'b']); // createdAt asc, then id asc; non-queued excluded
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/repository/in-memory-research-task.repository.test.ts`
Expected: FAIL — `repo.listQueued is not a function`.

- [ ] **Step 3: Add to the port**

In `src/ports/research-task.repository.ts`, add to the `ResearchTaskRepository` interface (after `listByCorrelationAndTypes`):

```typescript
  /** All rows with status 'queued', ordered by (createdAt, id). The boot sweeper's read (P1-1). */
  listQueued(): Promise<ResearchTask[]>;
```

- [ ] **Step 4: Implement in the in-memory adapter**

In `src/adapters/repository/in-memory-research-task.repository.ts`, add a method to the class:

```typescript
  async listQueued(): Promise<ResearchTask[]> {
    return [...this.byId.values()]
      .filter((t) => t.status === 'queued')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((t) => ({ ...t }));
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/adapters/repository/in-memory-research-task.repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck (surfaces every other `ResearchTaskRepository` implementer/stub that now needs `listQueued`)**

Run: `npx tsc -p tsconfig.json`
Expected: exit 0. If any inline test stub of `ResearchTaskRepository` errors, add `listQueued: async () => []` to it (mirror the existing `tryStartRun`-style stubs, e.g. in `src/worker/worker.test.ts`). The drizzle adapter is filled in Task 5 — until then add a temporary `async listQueued(): Promise<ResearchTask[]> { return []; }` to `DrizzleResearchTaskRepository` so the file compiles, with a `// P1-1 Task 5: real query` comment.

- [ ] **Step 7: Commit**

```bash
git add src/ports/research-task.repository.ts src/adapters/repository/in-memory-research-task.repository.ts src/adapters/repository/in-memory-research-task.repository.test.ts src/adapters/repository/drizzle-research-task.repository.ts
git commit -m "feat(repo): listQueued() port + in-memory adapter (P1-1)"
```

---

### Task 3: `reconcileQueuedTasks` sweeper

**Files:**
- Create: `src/orchestrator/reconcile-queued-tasks.ts`
- Test: `src/orchestrator/reconcile-queued-tasks.test.ts`

**Interfaces:**
- Consumes: `ResearchTaskRepository.listQueued`, `toQueueEnvelope`, `TaskQueuePort.enqueue`.
- Produces: `reconcileQueuedTasks(deps: { repo: Pick<ResearchTaskRepository,'listQueued'>; queue: TaskQueuePort; now?: () => number }): Promise<{ attempted: number; reEnqueued: number }>`.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/reconcile-queued-tasks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { reconcileQueuedTasks } from './reconcile-queued-tasks.ts';
import type { ResearchTask, QueueEnvelope } from '../domain/types.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';

const task = (over: Partial<ResearchTask>): ResearchTask => ({
  id: 'id', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'queued', payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
});

// Records enqueue calls AND models BullMQ jobId identity (dedupeKey ?? taskId) so "already active"
// collapses to a single job — the stock InMemoryQueueAdapter can't (it dedupes on dedupeKey only
// and ignores delayMs).
class RecordingQueue implements TaskQueuePort {
  readonly calls: { envelope: QueueEnvelope; opts?: { delayMs?: number } }[] = [];
  private readonly jobs = new Set<string>();
  async enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }): Promise<void> {
    this.calls.push({ envelope, opts });
    this.jobs.add(envelope.dedupeKey ?? envelope.taskId);
  }
  get jobCount(): number { return this.jobs.size; }
  process(): void {}
  async close(): Promise<void> {}
}

const repoOf = (rows: ResearchTask[]) => ({ listQueued: async () => rows });
const NOW = () => Date.parse('2026-07-14T00:00:00.000Z');

describe('reconcileQueuedTasks (P1-1)', () => {
  it('re-enqueues an immediate orphan with no delay', async () => {
    const queue = new RecordingQueue();
    const res = await reconcileQueuedTasks({ repo: repoOf([task({ id: 'o1' })]), queue, now: NOW });
    expect(res).toEqual({ attempted: 1, reEnqueued: 1 });
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]?.envelope.taskId).toBe('o1');
    expect(queue.calls[0]?.opts).toBeUndefined(); // no delayMs
  });

  it('re-enqueues a delayed orphan with the REMAINING delay', async () => {
    const queue = new RecordingQueue();
    await reconcileQueuedTasks({ repo: repoOf([task({ id: 'd1', availableAt: '2026-07-14T00:00:05.000Z' })]), queue, now: NOW });
    expect(queue.calls[0]?.opts).toEqual({ delayMs: 5000 });
  });

  it('past availableAt clamps to no delay', async () => {
    const queue = new RecordingQueue();
    await reconcileQueuedTasks({ repo: repoOf([task({ id: 'p1', availableAt: '2026-07-13T00:00:00.000Z' })]), queue, now: NOW });
    expect(queue.calls[0]?.opts).toBeUndefined();
  });

  it('an already-active job (with dedupeKey) collapses to a single job', async () => {
    const queue = new RecordingQueue();
    const row = task({ id: 'a1', dedupeKey: 'chat-proposal:p1' });
    await queue.enqueue({ taskId: 'a1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, dedupeKey: 'chat-proposal:p1' }); // job already active
    await reconcileQueuedTasks({ repo: repoOf([row]), queue, now: NOW });
    expect(queue.jobCount).toBe(1); // sweeper still enqueued; jobId identity keeps it one
  });

  it('an already-active keyless job collapses via taskId identity', async () => {
    const queue = new RecordingQueue();
    const row = task({ id: 'k1', dedupeKey: undefined });
    await queue.enqueue({ taskId: 'k1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, dedupeKey: undefined });
    await reconcileQueuedTasks({ repo: repoOf([row]), queue, now: NOW });
    expect(queue.jobCount).toBe(1);
  });

  it('throws on a non-empty but unparseable availableAt (data error, not implicit immediate)', async () => {
    const queue = new RecordingQueue();
    await expect(reconcileQueuedTasks({ repo: repoOf([task({ id: 'bad', availableAt: 'not-a-date' })]), queue, now: NOW }))
      .rejects.toThrow(/availableAt/i);
  });

  it('fails fast when enqueue throws (startup must abort)', async () => {
    const queue = { async enqueue() { throw new Error('redis down'); }, process() {}, async close() {} } as unknown as TaskQueuePort;
    await expect(reconcileQueuedTasks({ repo: repoOf([task({ id: 'x' })]), queue, now: NOW })).rejects.toThrow('redis down');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/reconcile-queued-tasks.test.ts`
Expected: FAIL — module `./reconcile-queued-tasks.ts` not found.

- [ ] **Step 3: Implement the sweeper**

Create `src/orchestrator/reconcile-queued-tasks.ts`:

```typescript
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import { toQueueEnvelope } from './task-intake.ts';

export interface ReconcileDeps {
  repo: Pick<ResearchTaskRepository, 'listQueued'>;
  queue: TaskQueuePort;
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
}

/** Remaining delay for a stranded row. null/undefined availableAt => immediate (0). A non-empty
 *  but unparseable value is a data error and throws — never coerce NaN into an implicit immediate. */
function remainingDelayMs(availableAt: string | undefined, nowMs: number): number {
  if (availableAt === undefined || availableAt === null) return 0;
  const t = Date.parse(availableAt);
  if (Number.isNaN(t)) throw new Error(`research_task.availableAt is not a valid ISO timestamp: ${JSON.stringify(availableAt)}`);
  return Math.max(0, t - nowMs);
}

/**
 * Boot-time reconciliation (P1-1): re-enqueue every `queued` row so a job stranded by a crash
 * between DB-create and enqueue is restored. The queue adapter dedupes by jobId (dedupeKey ??
 * taskId), so an already-active job is a no-op and a lost one is recreated. Returns attempted /
 * reEnqueued counts (NOT "restored": without queue inspection a live job is indistinguishable from
 * a lost one). Any enqueue error propagates — the caller MUST abort startup rather than run with
 * partial reconciliation.
 */
export async function reconcileQueuedTasks(deps: ReconcileDeps): Promise<{ attempted: number; reEnqueued: number }> {
  const nowMs = (deps.now ?? Date.now)();
  let attempted = 0;
  let reEnqueued = 0;
  for (const task of await deps.repo.listQueued()) {
    attempted += 1;
    const delayMs = remainingDelayMs(task.availableAt, nowMs);
    await deps.queue.enqueue(toQueueEnvelope(task), delayMs > 0 ? { delayMs } : undefined);
    reEnqueued += 1;
  }
  return { attempted, reEnqueued };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/orchestrator/reconcile-queued-tasks.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/reconcile-queued-tasks.ts src/orchestrator/reconcile-queued-tasks.test.ts
git commit -m "feat(orchestrator): reconcileQueuedTasks boot sweeper (P1-1)"
```

---

### Task 4: Wire reconciliation before the consumer (`bootWorker`)

**Files:**
- Modify: `src/worker/worker.ts`
- Test: `src/worker/worker.test.ts`

**Interfaces:**
- Consumes: `reconcileQueuedTasks`, `startWorker`.
- Produces: `bootWorker(deps: WorkerDeps, now?: () => number): Promise<void>` — awaits reconciliation, then starts the consumer.

- [ ] **Step 1: Write the failing test**

Append to `src/worker/worker.test.ts` inside the `describe('startWorker', ...)` (or a new `describe`):

```typescript
  it('[P1-1] bootWorker reconciles queued orphans BEFORE the consumer starts', async () => {
    const { bootWorker } = await import('./worker.ts');
    const order: string[] = [];
    const services = makeServices();
    // one stranded queued row (no job was ever enqueued for it)
    await services.researchTasks.create(task({ id: 'orphan-1', status: 'queued' }));
    const recordingQueue = {
      async enqueue() { order.push('enqueue'); },
      process() { order.push('process'); },
      async close() {},
    };
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async () => {});
    await bootWorker({ queue: recordingQueue as unknown as Parameters<typeof bootWorker>[0]['queue'], router, services });
    expect(order).toEqual(['enqueue', 'process']); // reconciliation fully done before consumer picks up
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/worker/worker.test.ts`
Expected: FAIL — `bootWorker` is not exported.

- [ ] **Step 3: Add `bootWorker` and use it in the entrypoint**

In `src/worker/worker.ts`, add the import at the top:

```typescript
import { reconcileQueuedTasks } from '../orchestrator/reconcile-queued-tasks.ts';
```

Add the exported wrapper after `startWorker`:

```typescript
/** Boot sequence (P1-1): reconcile stranded queued rows, THEN start consuming — never race the
 *  consumer against reconciliation. An enqueue error during the sweep aborts startup. */
export async function bootWorker(deps: WorkerDeps, now?: () => number): Promise<void> {
  const { attempted, reEnqueued } = await reconcileQueuedTasks({ repo: deps.services.researchTasks, queue: deps.queue, now });
  console.log(`reconciled queued tasks: attempted=${attempted} re-enqueued=${reEnqueued}`);
  startWorker(deps);
}
```

In the runtime entrypoint block (`if (process.argv[1] && ...)`), replace `startWorker({ queue, router, services });` with:

```typescript
  await bootWorker({ queue, router, services });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worker/worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/worker/worker.ts src/worker/worker.test.ts
git commit -m "feat(worker): bootWorker reconciles queued orphans before consuming (P1-1)"
```

---

### Task 5: Migration + drizzle persistence of `available_at` + drizzle `listQueued`

**Files:**
- Modify: `src/db/schema.ts`
- Create: `migrations/0025_*.sql` (+ meta snapshot via drizzle-kit)
- Modify: `src/adapters/repository/drizzle-research-task.repository.ts`
- Test: `src/adapters/repository/drizzle-research-task.repository.test.ts`

**Interfaces:**
- Consumes: `ResearchTask.availableAt`, `listQueued()` contract.
- Produces: drizzle `create` persists `available_at`; `toDomain` maps `NULL → undefined`; `listQueued()` real query.

- [ ] **Step 1: Write the failing (gated) test**

Append inside the gated `d(...)` block of `src/adapters/repository/drizzle-research-task.repository.test.ts`:

```typescript
  describe('availableAt + listQueued (P1-1)', () => {
    it('round-trips availableAt and maps SQL NULL to undefined', async () => {
      const withAt = task({ status: 'queued', availableAt: '2026-07-14T00:00:05.000Z' });
      const without = task({ status: 'queued' }); // availableAt undefined
      await repo.create(withAt);
      await repo.create(without);
      expect((await repo.findById(withAt.id))?.availableAt).toBe('2026-07-14T00:00:05.000Z');
      expect((await repo.findById(without.id))?.availableAt).toBeUndefined();
    });

    it('listQueued returns only queued rows ordered by (createdAt, id)', async () => {
      await db.delete(researchTask);
      const mk = (id: string, status: ResearchTask['status'], createdAt: string) =>
        repo.create(task({ id, status, createdAt }));
      await mk('b', 'queued', '2026-01-01T00:00:02.000Z');
      await mk('a', 'queued', '2026-01-01T00:00:02.000Z');
      await mk('early', 'queued', '2026-01-01T00:00:01.000Z');
      await mk('done', 'completed', '2026-01-01T00:00:00.000Z');
      expect((await repo.listQueued()).map((t) => t.id)).toEqual(['early', 'a', 'b']);
    });
  });
```

Note: the file's `task()` factory sets `createdAt` from `new Date().toISOString()` by default; the `listQueued` order test passes explicit `createdAt`. Confirm `create` writes `createdAt` from the domain value (it does: `createdAt: new Date(task.createdAt)`).

- [ ] **Step 2: Run to verify it fails (only meaningful with `DATABASE_URL`)**

Run: `DATABASE_URL=<your-pg-url> npx vitest run src/adapters/repository/drizzle-research-task.repository.test.ts`
Expected: FAIL — column `available_at` does not exist / `availableAt` undefined on round-trip. (Without `DATABASE_URL` the suite is skipped; you MUST run it against a DB for this task — see spec's gated-test note. A local ephemeral Postgres with pgvector works: apply `migrations/*.sql` in order.)

- [ ] **Step 3: Add the schema column**

In `src/db/schema.ts`, in the `researchTask` table definition, add alongside the other columns (match the existing column-builder style in that file, e.g. `timestamp('available_at', { withTimezone: true })`):

```typescript
  availableAt: timestamp('available_at', { withTimezone: true }),
```

(Use the same `timestamp`/`withTimezone` import and pattern already used by `createdAt`/`updatedAt` in that file. Nullable — do NOT add `.notNull()`.)

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate` (drizzle.config.js points at `./src/db/schema.ts`, out `./migrations`). Confirm it emits `migrations/0025_*.sql` containing `ALTER TABLE "research_task" ADD COLUMN "available_at" timestamp with time zone;` plus the meta snapshot. Re-verify the number is 0025 (`ls migrations/`); if a parallel PR bumped it, accept the generated number.

- [ ] **Step 5: Implement drizzle persist + read + `listQueued`**

In `src/adapters/repository/drizzle-research-task.repository.ts`:

In `toDomain`, add to the returned object (after `status`):

```typescript
    availableAt: row.availableAt ? row.availableAt.toISOString() : undefined,
```

In `create`, add to the `.values({...})` object:

```typescript
      availableAt: task.availableAt ? new Date(task.availableAt) : null,
```

Replace the temporary `listQueued` stub (from Task 2 Step 6) with the real query (uses `asc`, `eq` from `drizzle-orm` — add `asc` to the existing import):

```typescript
  async listQueued(): Promise<ResearchTask[]> {
    const rows = await this.db
      .select()
      .from(researchTask)
      .where(eq(researchTask.status, 'queued'))
      .orderBy(asc(researchTask.createdAt), asc(researchTask.id));
    return rows.map(toDomain);
  }
```

- [ ] **Step 6: Run the gated test to verify it passes**

Run: `DATABASE_URL=<your-pg-url> npx vitest run src/adapters/repository/drizzle-research-task.repository.test.ts`
Expected: PASS. Then `npx tsc -p tsconfig.json` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts migrations/ src/adapters/repository/drizzle-research-task.repository.ts src/adapters/repository/drizzle-research-task.repository.test.ts
git commit -m "feat(db): available_at column + drizzle persist/read + listQueued (P1-1)"
```

---

### Task 6: Gated Redis idempotency lock-test

**Files:**
- Test: `src/adapters/queue/bullmq-queue.adapter.idempotency.test.ts` (create)

**Interfaces:**
- Consumes: `BullMqQueueAdapter`, `toBullmqJobId`.

- [ ] **Step 1: Write the failing (gated) test**

Create `src/adapters/queue/bullmq-queue.adapter.idempotency.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { Queue } from 'bullmq';
import { BullMqQueueAdapter, toBullmqJobId } from './bullmq-queue.adapter.ts';
import type { QueueEnvelope } from '../../domain/types.ts';

const redis = process.env.REDIS_URL;
const d = redis ? describe : describe.skip;

// Unique per-run queue name so parallel/CI runs never collide; mandatory cleanup.
const QUEUE = `p1-1-idem-${process.pid}-${Date.now()}`;

d('BullMqQueueAdapter jobId idempotency (P1-1)', () => {
  let adapter: BullMqQueueAdapter | undefined;
  let inspect: Queue | undefined;

  afterEach(async () => {
    await adapter?.close();
    await inspect?.obliterate({ force: true }).catch(() => {});
    await inspect?.close();
    adapter = undefined;
    inspect = undefined;
  });

  it('enqueuing the same envelope twice yields a single job (same jobId)', async () => {
    adapter = new BullMqQueueAdapter(redis!, QUEUE);
    const env: QueueEnvelope = { taskId: 't-idem', taskType: 'strategy.onboard', correlationId: 'c', source: 'web', attempt: 1, dedupeKey: 'chat-proposal:p1' };
    await adapter.enqueue(env);
    await adapter.enqueue(env); // reconciliation re-enqueue of an already-active job
    inspect = new Queue(QUEUE, { connection: (adapter as unknown as { redisOpts: object }).redisOpts });
    expect(await inspect.getJobCountByTypes('waiting', 'delayed', 'active')).toBe(1);
    expect(await inspect.getJob(toBullmqJobId('chat-proposal:p1'))).toBeTruthy();
  });
});
```

Note: if reaching `redisOpts` via a cast is undesirable, construct `inspect` with the same `REDIS_URL` parsed inline instead — either is acceptable; keep the cast only if it type-checks.

- [ ] **Step 2: Run to verify it fails/skips appropriately**

Run: `REDIS_URL=<your-redis-url> npx vitest run src/adapters/queue/bullmq-queue.adapter.idempotency.test.ts`
Expected: PASS if the assumption holds (it should — BullMQ dedupes on jobId). Without `REDIS_URL` it skips. This test *locks* existing behavior; it may pass on first write — that is acceptable for a characterization/lock test (note it in the commit).

- [ ] **Step 3: Commit**

```bash
git add src/adapters/queue/bullmq-queue.adapter.idempotency.test.ts
git commit -m "test(queue): lock BullMQ same-jobId enqueue idempotency (P1-1)"
```

---

## Final verification

- [ ] `npx tsc -p tsconfig.json` → exit 0.
- [ ] `npx vitest run` → full suite green (drizzle/Redis tests skip without env). Re-run once if a >900s contention flake appears (known; a clean ~400s run is authoritative).
- [ ] With a DB: `DATABASE_URL=... npx vitest run src/adapters/repository/drizzle-research-task.repository.test.ts` green.

## Self-review notes (author)

- Spec coverage: availableAt stamping (T1), listQueued (T2/T5), sweeper w/ remaining delay + fail-fast + unparseable-throws + attempted/reEnqueued (T3), reconcile-before-consume wiring (T4), migration + persistence round-trip + NULL→undefined (T5), gated Redis idempotency + unique queue + cleanup (T6). Clock contract (T1). Active-job "single job" semantics (T3). ✓
- Types: `toQueueEnvelope`, `reconcileQueuedTasks`, `bootWorker`, `listQueued`, `availableAt` consistent across tasks. ✓
