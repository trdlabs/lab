# Lab-side Parallel Backtests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run WFO grid points, and the baseline train/holdout members, concurrently against the backtester; add a BullMQ worker-concurrency knob.

**Architecture:** A small `mapWithConcurrency` helper gives bounded, index-ordered, fail-fast parallelism. `ParamGridRunner` uses it around the existing per-point unit (submit → persist → poll, unchanged). `ExperimentService` overlaps train/holdout with `Promise.all` after the sanity/boundary gate. Two new env knobs wire through `composition.ts`.

**Tech Stack:** TypeScript (Node 24, ESM, `.ts` imports), vitest, BullMQ.

**Spec:** `docs/superpowers/specs/2026-07-03-lab-parallel-backtests-design.md` (rev 2 — `run_pending` resume is OUT of scope).

## Global Constraints

- Serial case must be byte-identical to today: `GridRunOutput` ordering, `rankTopN` input order, verdict/reason strings — unchanged.
- No new npm dependencies.
- New env knobs: `RESEARCH_GRID_CONCURRENCY` (default **4**, min 1), `LAB_QUEUE_CONCURRENCY` (default **1**, min 1) — both `parsePositiveInt`, following the existing `PLATFORM_RUN_MAX_POLLS` pattern in `src/config/env.ts`.
- `ParamGridRunnerDeps.concurrency` defaults to **1** (test/back-compat); production always passes the env value in `composition.ts`.
- Working directory: worktree `.worktrees/feat-lab-parallel-backtests`, branch `feat/lab-parallel-backtests`.
- Run tests with `pnpm vitest run <file>` (single file) and `pnpm check` (full gate) from the worktree root.

---

### Task 1: `mapWithConcurrency` helper

**Files:**
- Create: `src/research/map-with-concurrency.ts`
- Test: `src/research/map-with-concurrency.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>` — results ordered by input index; at most `limit` `fn` calls in flight; on the first rejection no NEW items start, in-flight items settle, then the first error rethrows; `limit < 1` or non-integer throws synchronously.

- [ ] **Step 1: Write the failing test**

```typescript
// src/research/map-with-concurrency.test.ts
import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './map-with-concurrency.ts';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('mapWithConcurrency', () => {
  it('returns results ordered by input index even when completion order is shuffled', async () => {
    const delays = [30, 0, 10];
    const out = await mapWithConcurrency(delays, 3, async (d, i) => {
      await new Promise((r) => setTimeout(r, d));
      return `item-${i}`;
    });
    expect(out).toEqual(['item-0', 'item-1', 'item-2']);
  });

  it('never exceeds the concurrency bound', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(maxInFlight).toBe(2);
  });

  it('limit=1 degenerates to strict serial order', async () => {
    const started: number[] = [];
    await mapWithConcurrency([0, 1, 2], 1, async (_x, i) => {
      started.push(i);
      await tick();
    });
    expect(started).toEqual([0, 1, 2]);
  });

  it('fail-fast: first rejection propagates, no new items start after it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3], 1, async (_x, i) => {
        started.push(i);
        await tick();
        if (i === 1) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]); // items 2 and 3 never started
  });

  it('rejects a non-positive or non-integer limit synchronously', () => {
    expect(() => mapWithConcurrency([1], 0, async () => {})).toThrow(/positive integer/);
    expect(() => mapWithConcurrency([1], 1.5, async () => {})).toThrow(/positive integer/);
  });

  it('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 'x')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/research/map-with-concurrency.test.ts`
Expected: FAIL — cannot find module `./map-with-concurrency.ts`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/research/map-with-concurrency.ts
/** Bounded parallel map: results keep input order; fail-fast — after the first
 *  rejection no new items start, in-flight items settle, the first error rethrows.
 *  limit=1 is exactly a serial for-await loop. */
export function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;

  const lane = async (): Promise<void> => {
    while (!failed) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  };

  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => lane());
  return Promise.all(lanes).then(() => {
    if (failed) throw firstError;
    return results;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/research/map-with-concurrency.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/research/map-with-concurrency.ts src/research/map-with-concurrency.test.ts
git commit -m "feat(research): mapWithConcurrency — bounded, index-ordered, fail-fast parallel map"
```

---

### Task 2: Parallel `ParamGridRunner.runGrid`

**Files:**
- Modify: `src/research/param-grid-runner.ts`
- Test: `src/research/param-grid-runner.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `mapWithConcurrency` from Task 1.
- Produces: `ParamGridRunnerDeps` gains optional `concurrency?: number` (default 1). `runGrid` signature and `GridRunOutput` shape unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/research/param-grid-runner.test.ts` (reuse the file's existing fake-executor pattern — check how `fakeExec` is built there and mirror it; the key requirements are below):

```typescript
// Serial-equivalence golden: concurrency N with shuffled completion order
// produces the same GridRunOutput as concurrency 1.
it('parallel run (concurrency 4, shuffled completion) equals serial run output', async () => {
  // fake executor: point index i completes after (points.length - i) * 5 ms,
  // so completion order is REVERSED vs submission order
  const makeExec = () => ({
    execute: async (req: StrategyExperimentRunRequest) => {
      const i = pointIndexOf(req.params); // derive from params, e.g. params.x
      await new Promise((r) => setTimeout(r, (POINTS - i) * 5));
      return { status: 'completed' as const, runId: `run-${i}`, platformRunId: `p-${i}`,
               metrics: fakeMetrics(i), totalTrades: 10 + i };
    },
  });
  const serial = await new ParamGridRunner({ strategyRunExecutor: makeExec(), concurrency: 1 }).runGrid(INPUT);
  const parallel = await new ParamGridRunner({ strategyRunExecutor: makeExec(), concurrency: 4 }).runGrid(INPUT);
  expect(parallel).toEqual(serial); // order, ranking, submitted, rejected — identical
});

it('respects the concurrency bound', async () => {
  let inFlight = 0; let maxInFlight = 0;
  const exec = { execute: async () => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return { status: 'completed' as const, runId: 'r', platformRunId: 'p', metrics: fakeMetrics(0), totalTrades: 3 };
  } };
  await new ParamGridRunner({ strategyRunExecutor: exec, concurrency: 2 }).runGrid(INPUT_6_POINTS);
  expect(maxInFlight).toBe(2);
});

it('default concurrency is 1 (constructor without the field stays serial)', async () => {
  const started: number[] = []; // push on execute entry, assert strictly ascending
  // … fake executor pushes its point index, awaits a macrotask, returns completed …
  await new ParamGridRunner({ strategyRunExecutor: exec }).runGrid(INPUT);
  expect(started).toEqual([0, 1, 2, /* … every point in submission order */]);
});
```

(Adapt `INPUT`/`fakeMetrics`/`pointIndexOf` to the file's existing fixtures — the existing test at `param-grid-runner.test.ts:30` already builds a valid `RunGridInput`; reuse its shape. Do not weaken the `toEqual(serial)` assertion.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run src/research/param-grid-runner.test.ts`
Expected: new tests FAIL (`concurrency` not a known property / serial behavior only); pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `src/research/param-grid-runner.ts`:

```typescript
import { mapWithConcurrency } from './map-with-concurrency.ts';

export interface ParamGridRunnerDeps {
  strategyRunExecutor: StrategyExperimentRunExecutor;
  /** Max grid points in flight. Default 1 (serial); production wires
   *  RESEARCH_GRID_CONCURRENCY from env via composition.ts. */
  concurrency?: number;
}
```

Replace the `for (const point of points)` loop body of `runGrid` with:

```typescript
  async runGrid(input: RunGridInput): Promise<GridRunOutput> {
    const points = expandGrid(input.grid, input.maxPoints);

    const allResults = await mapWithConcurrency(points, this.d.concurrency ?? 1, async (point) => {
      const outcome = await this.d.strategyRunExecutor.execute({
        experimentId: input.experimentId,
        role: 'train',
        strategyBundle: input.strategyBundle,
        strategyProfileId: input.strategyProfileId,
        run: input.trainRun,
        params: point,
        metrics: [...input.metrics],
      });

      const paramsHash = computeStrategyParamsHash({
        bundleHash: input.strategyBundle.bundleHash,
        platformRun: input.trainRun,
        params: point,
      });

      const result: GridResult = {
        point,
        paramsHash,
        status: outcome.status,
        strategyBacktestRunId: outcome.runId,
        ...(outcome.status === 'completed' ? { metrics: outcome.metrics, tradeCount: outcome.totalTrades } : {}),
      };
      return result;
    });

    const ranked = rankTopN(allResults, { n: input.topN, minTradesTrain: input.minTradesTrain });
    const rejected = allResults.filter((r) => r.status !== 'completed').length;

    return { allResults, ranked, submitted: points.length, rejected };
  }
```

(Per-point work is byte-identical to the old loop body; only the iteration strategy changed. `mapWithConcurrency` keeps index order, so `allResults` — and therefore `rankTopN` tie-breaking and `rejected` — match the serial run. Fail-fast on a thrown `GatewayRunError` is preserved.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/research/param-grid-runner.test.ts`
Expected: PASS (all, old and new).

- [ ] **Step 5: Run the neighboring suites that consume ParamGridRunner**

Run: `pnpm vitest run src/research/experiment-service.wfo.test.ts src/research/experiment-service.strategy.test.ts src/research/experiment-service.test.ts src/orchestrator/handlers/new-strategy-holdout.integration.test.ts`
Expected: PASS — they construct `ParamGridRunner` without `concurrency`, which now means explicit serial (unchanged behavior).

- [ ] **Step 6: Commit**

```bash
git add src/research/param-grid-runner.ts src/research/param-grid-runner.test.ts
git commit -m "feat(research): bounded-parallel grid execution in ParamGridRunner (default serial)"
```

---

### Task 3: BullMQ worker concurrency option

**Files:**
- Modify: `src/adapters/queue/bullmq-queue.adapter.ts`
- Test: `src/adapters/queue/bullmq-queue.adapter.test.ts` (extend if it exists; create otherwise — check first: `ls src/adapters/queue/*.test.ts`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `new BullMqQueueAdapter(redisUrl, queueName?, opts?: { workerConcurrency?: number })`; `process()` passes `concurrency` to the BullMQ `Worker`. Default `1` — today's behavior.

- [ ] **Step 1: Write the failing test**

BullMQ's `Worker` connects to Redis on construction, so unit-test via module mock (follow the file's existing pattern if a test file exists; otherwise):

```typescript
// src/adapters/queue/bullmq-queue.adapter.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerCtor = vi.fn();
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn(), close: vi.fn() })),
  Worker: vi.fn().mockImplementation((...args: unknown[]) => {
    workerCtor(...args);
    return { close: vi.fn() };
  }),
}));

const { BullMqQueueAdapter } = await import('./bullmq-queue.adapter.ts');

describe('BullMqQueueAdapter worker concurrency', () => {
  beforeEach(() => { workerCtor.mockClear(); });

  it('defaults Worker concurrency to 1', () => {
    const a = new BullMqQueueAdapter('redis://localhost:6379');
    a.process(async () => {});
    const opts = workerCtor.mock.calls[0]?.[2] as { concurrency?: number };
    expect(opts.concurrency).toBe(1);
  });

  it('passes workerConcurrency through to the Worker options', () => {
    const a = new BullMqQueueAdapter('redis://localhost:6379', 'research-tasks', { workerConcurrency: 4 });
    a.process(async () => {});
    const opts = workerCtor.mock.calls[0]?.[2] as { concurrency?: number };
    expect(opts.concurrency).toBe(4);
  });

  it('rejects a non-positive or non-integer workerConcurrency', () => {
    expect(() => new BullMqQueueAdapter('redis://localhost:6379', 'research-tasks', { workerConcurrency: 0 }))
      .toThrow(/positive integer/);
    expect(() => new BullMqQueueAdapter('redis://localhost:6379', 'research-tasks', { workerConcurrency: 1.5 }))
      .toThrow(/positive integer/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/queue/bullmq-queue.adapter.test.ts`
Expected: FAIL — `opts.concurrency` is `undefined`.

- [ ] **Step 3: Implement**

In `src/adapters/queue/bullmq-queue.adapter.ts`:

```typescript
export class BullMqQueueAdapter implements TaskQueuePort {
  private readonly queue: Queue<QueueEnvelope>;
  private readonly queueName: string;
  private readonly redisOpts: ReturnType<typeof parseRedisUrl>;
  private readonly workerConcurrency: number;
  private worker?: Worker<QueueEnvelope>;

  constructor(redisUrl: string, queueName = 'research-tasks', opts?: { workerConcurrency?: number }) {
    this.queueName = queueName;
    this.redisOpts = parseRedisUrl(redisUrl);
    const workerConcurrency = opts?.workerConcurrency ?? 1;
    if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1) {
      throw new Error(`BullMqQueueAdapter: workerConcurrency must be a positive integer, got ${workerConcurrency}`);
    }
    this.workerConcurrency = workerConcurrency;
    this.queue = new Queue<QueueEnvelope>(this.queueName, {
      connection: { ...this.redisOpts, maxRetriesPerRequest: null },
    });
  }
```

and in `process()`:

```typescript
  process(handler: QueueHandler): void {
    this.worker = new Worker<QueueEnvelope>(
      this.queueName,
      async (job) => { await handler(job.data); },
      { connection: { ...this.redisOpts, maxRetriesPerRequest: null }, concurrency: this.workerConcurrency },
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/queue/bullmq-queue.adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/queue/bullmq-queue.adapter.ts src/adapters/queue/bullmq-queue.adapter.test.ts
git commit -m "feat(queue): BullMQ worker concurrency option (default 1, unchanged)"
```

---

### Task 4: Env knobs + composition wiring

**Files:**
- Modify: `src/config/env.ts` (follow the exact `PLATFORM_RUN_MAX_POLLS` pattern: interface field + `parsePositiveInt(source.X, default)`)
- Modify: `src/composition.ts` — `const queue = new BullMqQueueAdapter(env.REDIS_URL)` (~line 280) and `const paramGridRunner = new ParamGridRunner({ strategyRunExecutor })` (line 316)
- Modify: `.env.example` (check it exists: `ls .env.example`; if absent, document in `README.md` env section instead)
- Test: `src/config/env.test.ts` (extend the existing defaults + overrides blocks at ~line 130)

**Interfaces:**
- Consumes: `ParamGridRunnerDeps.concurrency` (Task 2), `BullMqQueueAdapter` opts (Task 3).
- Produces: `env.RESEARCH_GRID_CONCURRENCY: number` (default 4), `env.LAB_QUEUE_CONCURRENCY: number` (default 1).

- [ ] **Step 1: Write the failing tests**

In `src/config/env.test.ts`, extend the existing defaults assertion block and the overrides block (mirror `PLATFORM_RUN_MAX_POLLS` lines at 132/139):

```typescript
    // in the defaults test:
    expect(e.RESEARCH_GRID_CONCURRENCY).toBe(4);
    expect(e.LAB_QUEUE_CONCURRENCY).toBe(1);

    // in the overrides test, add to the source object:
    RESEARCH_GRID_CONCURRENCY: '2', LAB_QUEUE_CONCURRENCY: '3',
    // and assert:
    expect(e.RESEARCH_GRID_CONCURRENCY).toBe(2);
    expect(e.LAB_QUEUE_CONCURRENCY).toBe(3);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/config/env.test.ts`
Expected: FAIL — properties missing.

- [ ] **Step 3: Implement env fields**

In `src/config/env.ts`, next to `PLATFORM_RUN_MAX_POLLS`:

```typescript
  /** Max in-flight grid points per WFO round (lab self-limit; backtester has no ingress backpressure yet). */
  RESEARCH_GRID_CONCURRENCY: number;
  /** BullMQ worker concurrency — research tasks processed in parallel per lab process. */
  LAB_QUEUE_CONCURRENCY: number;
```

and in the loader:

```typescript
    RESEARCH_GRID_CONCURRENCY: parsePositiveInt(source.RESEARCH_GRID_CONCURRENCY, 4),
    LAB_QUEUE_CONCURRENCY: parsePositiveInt(source.LAB_QUEUE_CONCURRENCY, 1),
```

- [ ] **Step 4: Wire composition**

In `src/composition.ts`:

```typescript
  const queue = new BullMqQueueAdapter(env.REDIS_URL, 'research-tasks', { workerConcurrency: env.LAB_QUEUE_CONCURRENCY });
  // …
  const paramGridRunner = new ParamGridRunner({ strategyRunExecutor, concurrency: env.RESEARCH_GRID_CONCURRENCY });
```

- [ ] **Step 5: Document the knobs**

Append to `.env.example` (or the README env section if `.env.example` is absent):

```bash
# Lab-side backtest parallelism. Total in-flight pressure on the backtester
# = LAB_QUEUE_CONCURRENCY × RESEARCH_GRID_CONCURRENCY (defaults 1 × 4 = 4,
# matching the backtester's default WORKER_CONCURRENCY=4). The backtester has
# no ingress backpressure yet — raise these deliberately.
RESEARCH_GRID_CONCURRENCY=4
LAB_QUEUE_CONCURRENCY=1
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run src/config/env.test.ts && pnpm typecheck`
Expected: PASS / clean. (`composition.wfo-agents.test.ts` exercises `composeRuntime` — if it constructs env without the new vars it uses defaults; must stay green: `pnpm vitest run src/composition.wfo-agents.test.ts`.)

- [ ] **Step 7: Commit**

```bash
# .env.example if it exists; otherwise the README section edited in Step 5
git add src/config/env.ts src/config/env.test.ts src/composition.ts
if [ -f .env.example ]; then git add .env.example; else git add README.md; fi
git commit -m "feat(config): RESEARCH_GRID_CONCURRENCY + LAB_QUEUE_CONCURRENCY knobs wired through composition"
```

---

### Task 5: Train ∥ holdout in the baseline lane

**Files:**
- Modify: `src/research/experiment-service.ts` (`runStrategyBaselineValidation`, the TRAIN/HOLDOUT blocks after boundary resolution, ~lines 276–288)
- Test: `src/research/experiment-service.strategy.test.ts` (extend)

**Interfaces:**
- Consumes: existing private `runStrategyMember(experimentId, role, input, runConfig)`.
- Produces: no signature changes; verdict/reason strings unchanged for every gate outcome.

**Scope guard:** this task touches ONLY `runStrategyBaselineValidation`. The overlay/
baseline-vs-variant path (`runWalkForwardOptimization` members, overlay experiment
executors, any other lane in `experiment-service.ts`) stays byte-identical — out of
scope for this PR.

- [ ] **Step 1: Write the failing test**

Add to `src/research/experiment-service.strategy.test.ts`, reusing the file's `buildSvc` fixture pattern:

```typescript
it('submits train and holdout concurrently after the boundary resolves', async () => {
  // executor fake: records role order + in-flight overlap
  const entered: string[] = [];
  let inFlight = 0; let maxInFlight = 0;
  // wrap the fixture executor's execute: on role 'train'/'holdout' — enter, await a
  // 10 ms timer, exit; record maxInFlight.
  // …
  await svc.runStrategyBaselineValidation(INPUT);
  expect(entered).toEqual(expect.arrayContaining(['sanity', 'train', 'holdout']));
  expect(maxInFlight).toBe(2); // train and holdout overlapped
});

it('verdict parity: train fails ⇒ INCONCLUSIVE train_not_run even though holdout completed', async () => {
  // executor fake: sanity completed, train rejected, holdout completed
  const out = await svc.runStrategyBaselineValidation(INPUT);
  const exp = await experiments.findById(out.experimentId);
  expect(exp?.verdictReason).toBe('train_not_run');
});

it('verdict parity: train pending ⇒ INCONCLUSIVE run_pending (checked before holdout outcome)', async () => {
  // executor fake: sanity completed, train pending, holdout rejected
  const out = await svc.runStrategyBaselineValidation(INPUT);
  const exp = await experiments.findById(out.experimentId);
  expect(exp?.verdictReason).toBe('run_pending');
});
```

(Exact fixture wiring: mirror how the existing tests in this file stub per-role outcomes; keep assertions on `verdictReason` strings — they are the contract.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/research/experiment-service.strategy.test.ts`
Expected: the overlap test FAILS (`maxInFlight` is 1 — serial today); parity tests may already pass — that is fine, they pin behavior.

- [ ] **Step 3: Implement**

In `runStrategyBaselineValidation`, replace the sequential TRAIN then HOLDOUT blocks with:

```typescript
    // --- TRAIN [from, T) ∥ HOLDOUT [T, to] (both depend only on the boundary; run concurrently.
    //     Checks stay in train-first order so failure reasons are deterministic.
    //     Trade-off: when train fails, a holdout run was already submitted — one extra
    //     backtester run on a failure path, absorbed by server-side dedup/coalescing.) ---
    const trainPeriod = encodeTrainPeriod(fullPeriod.from, boundary.t, input.runConfig.timeframe);
    const holdoutPeriod = encodeHoldoutPeriod(boundary.t, fullPeriod.to);
    const [train, holdout] = await Promise.all([
      this.runStrategyMember(experimentId, 'train', input, { ...input.runConfig, period: trainPeriod }),
      this.runStrategyMember(experimentId, 'holdout', input, { ...input.runConfig, period: holdoutPeriod }),
    ]);
    if (train.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    if (train.status !== 'completed') return fail('INCONCLUSIVE', 'train_not_run');
    if (holdout.status === 'pending') return fail('INCONCLUSIVE', 'run_pending');
    if (holdout.status !== 'completed' || !holdout.metrics) return fail('INCONCLUSIVE', 'holdout_not_run');
```

(Everything before — sanity gate, `getRunTrades`, boundary resolution, the `boundary.mode === 'none'` cap — and everything after — EVALUATE block — is untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/research/experiment-service.strategy.test.ts src/research/experiment-service.test.ts src/research/experiment-service.wfo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research/experiment-service.ts src/research/experiment-service.strategy.test.ts
git commit -m "feat(research): overlap train and holdout members after boundary resolution"
```

---

### Task 6: Full gate + branch wrap-up

**Files:** none new.

- [ ] **Step 1: Full check**

Run: `pnpm check`
Expected: typecheck + lint + full suite green (baseline was 2798 passed / 75 skipped; new total higher, 0 failures).

- [ ] **Step 2: Verify serial-default invariant once more**

Run: `git diff main --stat`
Confirm: no files outside `src/research/{map-with-concurrency,param-grid-runner,experiment-service}*`, `src/adapters/queue/bullmq-queue.adapter*`, `src/config/env*`, `src/composition.ts`, `.env.example`, `docs/superpowers/**`.

- [ ] **Step 3: Finish**

Use superpowers:finishing-a-development-branch — present merge/PR options for `feat/lab-parallel-backtests`.
