# Revision-lane routing + config hygiene — Implementation Plan

> **Execution:** task-by-task TDD, optional subagents. Do each task's steps in order (write failing test → run-fail → implement → run-pass → commit). Steps use checkbox (`- [ ]`) syntax for tracking. (If a superpowers execution skill is available in the session, subagent-driven-development / executing-plans may be used; they are not required.)

**Goal:** Вынести линию ревизий (`revision.build`, `revision.consolidate`) в отдельную BullMQ-очередь со своим воркером через чистую routing-обёртку над неизменным `BullMqQueueAdapter`, плюс закрыть дешёвую конфиг-гигиену Этапа 0.

**Architecture:** Новый `RoutingQueueAdapter implements TaskQueuePort` держит карту `QueueLane → TaskQueuePort` и роутит каждый `enqueue` через чистую функцию `routeTaskType`. `process(handler)` регистрирует один и тот же handler во всех lane; `close()` закрывает все, агрегируя ошибки. `BullMqQueueAdapter` не меняется. `composeRuntime` строит две lane (`research-tasks`, `research-tasks-revision`) с независимыми concurrency.

**Tech Stack:** TypeScript (ESM, runtime через `node --experimental-strip-types`), Vitest, BullMQ ^5.21, node-postgres (`pg`), Drizzle.

Спека: `docs/superpowers/specs/2026-07-11-lab-revision-lane-routing-design.md`.

## Global Constraints

- **Node >=22, pnpm@9.12.0, ESM** (`"type": "module"`). Runtime — `node --experimental-strip-types`.
- **НЕ использовать TS parameter properties** (`constructor(private x)`) — ломается под strip-types в рантайме (проходит tsc+Vitest, но падает при `pnpm worker`); AST-guard-тест репозитория это блокирует. Всегда: явное поле + присваивание в конструкторе.
- Типчек: `pnpm typecheck` (= `tsc -p tsconfig.json`). Тесты: `pnpm test` (= `vitest run`). Один файл: `pnpm exec vitest run <path>`.
- **Concurrency guard (только докой, без runtime-валидации):** `LAB_QUEUE_CONCURRENCY` must-stay-1 до среза 1.4; `LAB_REVISION_QUEUE_CONCURRENCY` must-stay-1 до среза 1.5. Оба lane содержат backtester-submitters — поднимать без общего семафора (1.4) нельзя.
- Runtime-коммиты этого плана отдельны от уже сделанного docs-коммита `acf48de`.
- Существующие типы (verbatim): `TaskQueuePort { enqueue(envelope, opts?): Promise<void>; process(handler): void; close(): Promise<void> }`; `QueueHandler = (envelope: QueueEnvelope) => Promise<void>`; `QueueEnvelope { taskId: string; taskType: AgentTaskType; correlationId: string; source: TaskSource; attempt: number; dedupeKey?: string }`.

---

### Task 1: `routeTaskType` + `QueueLane`

**Files:**
- Create: `src/adapters/queue/route-task-type.ts`
- Test: `src/adapters/queue/route-task-type.test.ts`

**Interfaces:**
- Produces: `type QueueLane = 'default' | 'revision'`; `function routeTaskType(taskType: string): QueueLane`.

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/queue/route-task-type.test.ts
import { describe, it, expect } from 'vitest';
import { routeTaskType } from './route-task-type.ts';
import { AGENT_TASK_TYPES } from '../../domain/schemas.ts';

describe('routeTaskType', () => {
  it('routes revision.* to the revision lane', () => {
    expect(routeTaskType('revision.build')).toBe('revision');
    expect(routeTaskType('revision.consolidate')).toBe('revision');
  });

  it('routes everything else to the default lane', () => {
    expect(routeTaskType('hypothesis.build')).toBe('default');
    expect(routeTaskType('backtest.completed')).toBe('default');
    expect(routeTaskType('paper.monitor')).toBe('default');
  });

  it('routes an unknown task type to the default lane', () => {
    expect(routeTaskType('totally.unknown')).toBe('default');
    expect(routeTaskType('')).toBe('default');
  });

  it('maps every registered AgentTaskType to a lane (exhaustive)', () => {
    for (const t of AGENT_TASK_TYPES) {
      const lane = routeTaskType(t);
      expect(lane === 'default' || lane === 'revision').toBe(true);
      if (t.startsWith('revision.')) expect(lane).toBe('revision');
      else expect(lane).toBe('default');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/adapters/queue/route-task-type.test.ts`
Expected: FAIL — cannot find module `./route-task-type.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapters/queue/route-task-type.ts

/** The queue lanes the router dispatches to. See slice spec 2026-07-11-lab-revision-lane-routing. */
export type QueueLane = 'default' | 'revision';

/**
 * Pure routing policy — the single point that decides which lane a task type runs on.
 * revision.build / revision.consolidate carry the UNIQUE(profile, version) race and their
 * own backtester-submits, so they run on an isolated revision lane. Everything else — and any
 * unrecognised type — goes to the default lane.
 */
export function routeTaskType(taskType: string): QueueLane {
  return taskType === 'revision.build' || taskType === 'revision.consolidate' ? 'revision' : 'default';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/adapters/queue/route-task-type.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/queue/route-task-type.ts src/adapters/queue/route-task-type.test.ts
git commit -m "feat(queue): pure routeTaskType policy (default | revision lane)"
```

---

### Task 2: `RoutingQueueAdapter` + `buildQueueLanes`

**Files:**
- Create: `src/adapters/queue/routing-queue.adapter.ts`
- Test: `src/adapters/queue/routing-queue.adapter.test.ts`

**Interfaces:**
- Consumes: `routeTaskType`, `QueueLane` (Task 1); `TaskQueuePort`, `QueueHandler` (`src/ports/task-queue.port.ts`); `QueueEnvelope` (`src/domain/types.ts`).
- Produces:
  - `class RoutingQueueAdapter implements TaskQueuePort` — constructor `(lanes: Record<QueueLane, TaskQueuePort>)`.
  - `const DEFAULT_QUEUE_NAME = 'research-tasks'`, `const REVISION_QUEUE_NAME = 'research-tasks-revision'`.
  - `interface QueueLaneConfig { defaultConcurrency: number; revisionConcurrency: number; createLaneAdapter(queueName: string, workerConcurrency: number): TaskQueuePort }`.
  - `function buildQueueLanes(cfg: QueueLaneConfig): Record<QueueLane, TaskQueuePort>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/queue/routing-queue.adapter.test.ts
import { describe, it, expect } from 'vitest';
import type { TaskQueuePort, QueueHandler } from '../../ports/task-queue.port.ts';
import type { QueueEnvelope } from '../../domain/types.ts';
import {
  RoutingQueueAdapter, buildQueueLanes, DEFAULT_QUEUE_NAME, REVISION_QUEUE_NAME,
} from './routing-queue.adapter.ts';

function fakeQueue(): TaskQueuePort & {
  enqueued: Array<{ envelope: QueueEnvelope; opts?: { delayMs?: number } }>;
  processed: number; closed: number; closeError?: Error;
} {
  const state = {
    enqueued: [] as Array<{ envelope: QueueEnvelope; opts?: { delayMs?: number } }>,
    processed: 0,
    closed: 0,
    closeError: undefined as Error | undefined,
    async enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }) { state.enqueued.push({ envelope, opts }); },
    process(_handler: QueueHandler) { state.processed += 1; },
    async close() { state.closed += 1; if (state.closeError) throw state.closeError; },
  };
  return state;
}

function envelope(taskType: string): QueueEnvelope {
  return { taskId: 't1', taskType: taskType as QueueEnvelope['taskType'], correlationId: 'c1', source: 'web', attempt: 1 };
}

describe('RoutingQueueAdapter', () => {
  it('enqueues revision.* on the revision lane, everything else on default, passing delayMs through', async () => {
    const def = fakeQueue(); const rev = fakeQueue();
    const adapter = new RoutingQueueAdapter({ default: def, revision: rev });

    await adapter.enqueue(envelope('hypothesis.build'), { delayMs: 500 });
    await adapter.enqueue(envelope('revision.build'));

    expect(def.enqueued).toHaveLength(1);
    const firstDefault = def.enqueued[0]!;
    expect(firstDefault.envelope.taskType).toBe('hypothesis.build');
    expect(firstDefault.opts).toEqual({ delayMs: 500 });
    expect(rev.enqueued).toHaveLength(1);
    const firstRevision = rev.enqueued[0]!;
    expect(firstRevision.envelope.taskType).toBe('revision.build');
  });

  it('registers the handler on every lane', () => {
    const def = fakeQueue(); const rev = fakeQueue();
    const adapter = new RoutingQueueAdapter({ default: def, revision: rev });
    adapter.process(async () => {});
    expect(def.processed).toBe(1);
    expect(rev.processed).toBe(1);
  });

  it('closes ALL lanes even when one fails, then throws AggregateError (no short-circuit)', async () => {
    const def = fakeQueue(); const rev = fakeQueue();
    rev.closeError = new Error('revision boom');
    const adapter = new RoutingQueueAdapter({ default: def, revision: rev });
    await expect(adapter.close()).rejects.toThrow(AggregateError);
    expect(def.closed).toBe(1);
    expect(rev.closed).toBe(1);
  });

  it('closes all lanes cleanly when none fail', async () => {
    const def = fakeQueue(); const rev = fakeQueue();
    const adapter = new RoutingQueueAdapter({ default: def, revision: rev });
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

describe('buildQueueLanes', () => {
  it('builds the revision lane at the given concurrency and the default lane from env (config-assert, no BullMQ)', () => {
    const calls: Array<{ name: string; conc: number }> = [];
    buildQueueLanes({
      defaultConcurrency: 3,
      revisionConcurrency: 1,
      createLaneAdapter: (name, conc) => { calls.push({ name, conc }); return fakeQueue(); },
    });
    expect(calls).toContainEqual({ name: REVISION_QUEUE_NAME, conc: 1 });
    expect(calls).toContainEqual({ name: DEFAULT_QUEUE_NAME, conc: 3 });
    expect(REVISION_QUEUE_NAME).toBe('research-tasks-revision');
    expect(DEFAULT_QUEUE_NAME).toBe('research-tasks');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/adapters/queue/routing-queue.adapter.test.ts`
Expected: FAIL — cannot find module `./routing-queue.adapter.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapters/queue/routing-queue.adapter.ts
import type { TaskQueuePort, QueueHandler } from '../../ports/task-queue.port.ts';
import type { QueueEnvelope } from '../../domain/types.ts';
import { routeTaskType, type QueueLane } from './route-task-type.ts';

export const DEFAULT_QUEUE_NAME = 'research-tasks';
export const REVISION_QUEUE_NAME = 'research-tasks-revision';

/**
 * TaskQueuePort that fans a single logical queue out to per-lane BullMQ queues.
 * enqueue routes by taskType; process registers ONE handler on every lane; close
 * closes all lanes and aggregates failures. No parameter properties (strip-types).
 */
export class RoutingQueueAdapter implements TaskQueuePort {
  private readonly lanes: Record<QueueLane, TaskQueuePort>;

  constructor(lanes: Record<QueueLane, TaskQueuePort>) {
    this.lanes = lanes;
  }

  async enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }): Promise<void> {
    await this.lanes[routeTaskType(envelope.taskType)].enqueue(envelope, opts);
  }

  // Registers the handler on each lane synchronously. A synchronous registration
  // failure of any lane propagates and fails boot; process() does NOT promise the
  // underlying Redis connection is ready — full async readiness is a later slice.
  process(handler: QueueHandler): void {
    for (const lane of Object.values(this.lanes)) lane.process(handler);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(Object.values(this.lanes).map((lane) => lane.close()));
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, 'RoutingQueueAdapter.close: one or more lanes failed to close');
    }
  }
}

export interface QueueLaneConfig {
  defaultConcurrency: number;
  revisionConcurrency: number;
  createLaneAdapter(queueName: string, workerConcurrency: number): TaskQueuePort;
}

/** Builds the lane map. The createLaneAdapter seam keeps this pure/testable (no Redis). */
export function buildQueueLanes(cfg: QueueLaneConfig): Record<QueueLane, TaskQueuePort> {
  return {
    default: cfg.createLaneAdapter(DEFAULT_QUEUE_NAME, cfg.defaultConcurrency),
    revision: cfg.createLaneAdapter(REVISION_QUEUE_NAME, cfg.revisionConcurrency),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/adapters/queue/routing-queue.adapter.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/queue/routing-queue.adapter.ts src/adapters/queue/routing-queue.adapter.test.ts
git commit -m "feat(queue): RoutingQueueAdapter + buildQueueLanes (revision lane isolation)"
```

---

### Task 3: env vars `LAB_REVISION_QUEUE_CONCURRENCY` + `LAB_PG_POOL_MAX`

**Files:**
- Modify: `src/config/env.ts` (interface `Env` near line 28; `loadEnv` return near line 232)
- Test: `src/config/env.queue.test.ts`

**Interfaces:**
- Produces: `Env.LAB_REVISION_QUEUE_CONCURRENCY: number` (default 1), `Env.LAB_PG_POOL_MAX: number` (default 10). Both parsed with the existing `parsePositiveInt` (invalid/zero/empty → fallback).

- [ ] **Step 1: Write the failing test**

```ts
// src/config/env.queue.test.ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';

describe('queue/pool env knobs', () => {
  it('defaults LAB_REVISION_QUEUE_CONCURRENCY to 1 and LAB_PG_POOL_MAX to 10', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.LAB_REVISION_QUEUE_CONCURRENCY).toBe(1);
    expect(env.LAB_PG_POOL_MAX).toBe(10);
  });

  it('parses valid positive integers', () => {
    const env = loadEnv({ LAB_REVISION_QUEUE_CONCURRENCY: '2', LAB_PG_POOL_MAX: '20' } as NodeJS.ProcessEnv);
    expect(env.LAB_REVISION_QUEUE_CONCURRENCY).toBe(2);
    expect(env.LAB_PG_POOL_MAX).toBe(20);
  });

  it('falls back on invalid/zero values', () => {
    const env = loadEnv({ LAB_REVISION_QUEUE_CONCURRENCY: '0', LAB_PG_POOL_MAX: 'garbage' } as NodeJS.ProcessEnv);
    expect(env.LAB_REVISION_QUEUE_CONCURRENCY).toBe(1);
    expect(env.LAB_PG_POOL_MAX).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/config/env.queue.test.ts`
Expected: FAIL — `LAB_REVISION_QUEUE_CONCURRENCY` / `LAB_PG_POOL_MAX` are `undefined` (not on `Env`).

- [ ] **Step 3: Add the fields**

In `src/config/env.ts`, in the `Env` interface next to `LAB_QUEUE_CONCURRENCY: number;`, add:

```ts
  LAB_REVISION_QUEUE_CONCURRENCY: number;
  LAB_PG_POOL_MAX: number;
```

In `loadEnv`'s returned object, next to `LAB_QUEUE_CONCURRENCY: parsePositiveInt(source.LAB_QUEUE_CONCURRENCY, 1),`, add:

```ts
    LAB_REVISION_QUEUE_CONCURRENCY: parsePositiveInt(source.LAB_REVISION_QUEUE_CONCURRENCY, 1),
    LAB_PG_POOL_MAX: parsePositiveInt(source.LAB_PG_POOL_MAX, 10),
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm exec vitest run src/config/env.queue.test.ts`
Expected: PASS (3 tests).
Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.queue.test.ts
git commit -m "feat(config): LAB_REVISION_QUEUE_CONCURRENCY + LAB_PG_POOL_MAX env knobs"
```

---

### Task 4: `createDbClient` pool max

**Files:**
- Modify: `src/db/client.ts`
- Test: `src/db/client.test.ts`

**Interfaces:**
- Produces: `createDbClient(databaseUrl: string, opts?: { max?: number }): { db: Db; pool: Pool }` — passes `max` into `new Pool`; omitted → node-pg default.

- [ ] **Step 1: Write the failing test**

```ts
// src/db/client.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { createDbClient } from './client.ts';

const pools: Pool[] = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

describe('createDbClient', () => {
  it('applies the max pool size when provided', () => {
    const { pool } = createDbClient('postgres://u:p@localhost:5432/db', { max: 20 });
    pools.push(pool);
    expect(pool.options.max).toBe(20);
  });

  it('leaves node-pg default when max is omitted', () => {
    const { pool } = createDbClient('postgres://u:p@localhost:5432/db');
    pools.push(pool);
    expect(pool.options.max).toBe(10);
  });
});
```

Note: constructing a `pg.Pool` does not open a connection; `pool.end()` in `afterEach` is a clean no-op teardown. `pool.options.max` defaults to 10 in node-pg.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/db/client.test.ts`
Expected: FAIL — `createDbClient` ignores the second arg; `pool.options.max` is 10 in test 1.

- [ ] **Step 3: Update the implementation**

Replace the body of `createDbClient` in `src/db/client.ts`:

```ts
export function createDbClient(databaseUrl: string, opts?: { max?: number }): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: databaseUrl, ...(opts?.max !== undefined ? { max: opts.max } : {}) });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/db/client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/client.ts src/db/client.test.ts
git commit -m "feat(db): optional pool max in createDbClient"
```

---

### Task 5: Wire `composeRuntime` to the routing adapter + pool max

**Files:**
- Modify: `src/composition.ts` (import + lines 337–338 inside `composeRuntime`)

**Interfaces:**
- Consumes: `RoutingQueueAdapter`, `buildQueueLanes` (Task 2); `BullMqQueueAdapter` (unchanged); `createDbClient` 2-arg (Task 4); `env.LAB_REVISION_QUEUE_CONCURRENCY`, `env.LAB_PG_POOL_MAX` (Task 3).
- Note: no new test — the lane policy is covered by Task 2's `buildQueueLanes` config-assert; this task is mechanical wiring, verified by typecheck + full suite.

- [ ] **Step 1: Add the import**

At the top of `src/composition.ts`, next to the existing `import { BullMqQueueAdapter } ...` (line 2), add:

```ts
import { RoutingQueueAdapter, buildQueueLanes } from './adapters/queue/routing-queue.adapter.ts';
```

- [ ] **Step 2: Replace the db + queue construction**

In `composeRuntime`, replace line 337:

```ts
  const { db, pool } = createDbClient(env.DATABASE_URL);
```

with:

```ts
  const { db, pool } = createDbClient(env.DATABASE_URL, { max: env.LAB_PG_POOL_MAX });
```

and replace line 338:

```ts
  const queue = new BullMqQueueAdapter(env.REDIS_URL, 'research-tasks', { workerConcurrency: env.LAB_QUEUE_CONCURRENCY });
```

with:

```ts
  const queue = new RoutingQueueAdapter(buildQueueLanes({
    defaultConcurrency: env.LAB_QUEUE_CONCURRENCY,
    revisionConcurrency: env.LAB_REVISION_QUEUE_CONCURRENCY,
    createLaneAdapter: (name, workerConcurrency) =>
      new BullMqQueueAdapter(env.REDIS_URL, name, { workerConcurrency }),
  }));
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. (`RoutingQueueAdapter` satisfies `TaskQueuePort`, so the `queue` binding and every downstream consumer — ingress, worker, `advanceChatPlan` — typecheck unchanged.)

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS — no regressions. In particular the composition and worker tests still pass; the worker now starts two BullMQ workers via the single `queue.process(handler)` call (unchanged `startWorker`).

- [ ] **Step 5: Commit**

```bash
git add src/composition.ts
git commit -m "feat(composition): route tasks to isolated revision lane; wire pool max"
```

---

### Task 6: `.env.example` + docker-compose worker env (0.1, 0.2, 0.3)

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml` (worker service `environment:` block; ingress service `environment:` block for the shared pool knob)

**Interfaces:**
- Docs/config only. No unit test; verified by YAML validation + visual diff.

- [ ] **Step 1: `.env.example` — fix the token-budget comment (0.2)**

Replace:

```
# Cumulative LLM token budget per research chain (correlationId-keyed). Gates: between
# research cycles AND between WFO sweep rounds. Unset = unlimited.
RESEARCH_TASK_TOKEN_BUDGET=
```

with:

```
# Cumulative LLM token budget per research chain (correlationId-keyed). Gates: between
# research cycles AND between WFO sweep rounds. Unset = 200000 (default); 0 = unlimited.
RESEARCH_TASK_TOKEN_BUDGET=
```

- [ ] **Step 2: `.env.example` — concurrency block + new knobs (0.1, 0.6)**

Replace:

```
# Lab-side backtest parallelism. Total in-flight pressure on the backtester
# = LAB_QUEUE_CONCURRENCY × RESEARCH_GRID_CONCURRENCY (defaults 1 × 4 = 4,
# matching the backtester's default WORKER_CONCURRENCY=4). The backtester has
# no ingress backpressure yet — raise these deliberately.
RESEARCH_GRID_CONCURRENCY=4
LAB_QUEUE_CONCURRENCY=1
```

with:

```
# Lab-side backtest parallelism. Total in-flight pressure on the backtester
# = LAB_QUEUE_CONCURRENCY × RESEARCH_GRID_CONCURRENCY (defaults 1 × 4 = 4,
# matching the backtester's default WORKER_CONCURRENCY=4). The backtester has
# no ingress backpressure yet — raise these deliberately.
#
# Task lanes (slice 2026-07-11): revision.build / revision.consolidate run on a
# separate BullMQ queue (research-tasks-revision) with its own worker concurrency.
# BOTH lanes contain backtester-submitters (default: hypothesis.build/strategy.wfo;
# revision: revision.build), so raising EITHER concurrency without the shared
# backtester semaphore (slice 1.4) can exceed the in-flight contract above.
#   LAB_QUEUE_CONCURRENCY          — must stay 1 until the backtester semaphore (1.4).
#   LAB_REVISION_QUEUE_CONCURRENCY — must stay 1 until revision retry-on-conflict (1.5);
#                                    the revision lane holds the UNIQUE(profile,version) race.
RESEARCH_GRID_CONCURRENCY=4
LAB_QUEUE_CONCURRENCY=1
LAB_REVISION_QUEUE_CONCURRENCY=1
# Postgres connection pool size per process (node-pg default 10). Invalid/zero → 10.
LAB_PG_POOL_MAX=10
```

- [ ] **Step 3: docker-compose — proxy the knobs into worker + ingress (0.3)**

`composeRuntime()` runs in both the worker and ingress processes; `createDbClient` (pool)
runs in both, but only the worker calls `queue.process()` — so the concurrency knobs are
worker-only, while `LAB_PG_POOL_MAX` is a global pool knob needed in both.

In `docker-compose.yml`, in the **worker** service `environment:` block, after the
`RESEARCH_TASK_TOKEN_BUDGET: ${RESEARCH_TASK_TOKEN_BUDGET:-}` line, add:

```yaml
      # Task-lane + pool knobs (slice 2026-07-11). Both lanes hold backtester-submitters;
      # keep both concurrencies at 1 until the shared backtester semaphore (1.4).
      LAB_QUEUE_CONCURRENCY: ${LAB_QUEUE_CONCURRENCY:-1}
      LAB_REVISION_QUEUE_CONCURRENCY: ${LAB_REVISION_QUEUE_CONCURRENCY:-1}
      RESEARCH_GRID_CONCURRENCY: ${RESEARCH_GRID_CONCURRENCY:-4}
      LAB_PG_POOL_MAX: ${LAB_PG_POOL_MAX:-10}
```

Then, in the **ingress** service `environment:` block, after the `READ_API_PORT: "3100"`
line, add the shared pool knob (ingress also builds a pg pool via `createDbClient`):

```yaml
      # Postgres pool size (global; createDbClient runs in ingress too). See slice 2026-07-11.
      LAB_PG_POOL_MAX: ${LAB_PG_POOL_MAX:-10}
```

- [ ] **Step 4: Validate the compose file**

Run: `docker compose -f docker-compose.yml config -q`
Expected: no output, exit 0 (YAML + interpolation valid). If `docker` is unavailable in the environment, skip and eyeball the diff instead.

- [ ] **Step 5: Commit**

```bash
git add .env.example docker-compose.yml
git commit -m "docs(config): document lane concurrency guards; proxy knobs into worker + ingress"
```

---

## Final verification

- [ ] Run the full check: `pnpm check` (typecheck + all tests). Expected: green.
- [ ] Confirm no runtime change touched `src/orchestrator/handlers/revision-build.handler.ts` or other revision domain logic (this slice is transport-only; the preservation-gate track owns that file).

## Out of scope (later slices — do NOT implement here)

- 0.4 — `envelope.attempt` increment + `agent_event` lifecycle events (health/observability slice; worker currently writes only `updateStatus`).
- 0.5 — stuck-task reconciler + `research_task(status)` index (own migration).
- 1.2 — fast/heavy/revision queue classes.
- 1.4 — shared backtester submit semaphore.
- Worker health/readiness endpoint + `TaskQueuePort.process` → async contract.
