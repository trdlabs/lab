# R3b-1 — Data-Bound Cycle-2 Eval Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive the Cycle-2 evaluation window once from the dataset's available date range and thread it durably (immutable) through every `hypothesis.build`, retry, and the merged `revision.build`, so R3a's holdout gate operates on real accumulated history instead of the hardcoded `defaultPlatformRun` fixture.

**Architecture:** A pure resolver (`resolveEvalPeriod`) turns a dataset list + fallback config into a bound `PlatformRunConfig`. `research-run-cycle` resolves it once at the top and stamps it onto each `hypothesis.build` payload; FAIL/MODIFY retries inherit it through the `backtest.completed` payload (mirroring the existing `symbol` field, sourced from the persisted `BacktestRun.platformRun`). `revision-build` does NOT re-resolve — it extracts the canonical window from its correlation's `hypothesis.build` tasks and rejects (never mixes) if they disagree. Everything is fail-soft to `defaultPlatformRun`.

**Tech Stack:** TypeScript (`node --experimental-strip-types`), Zod, Vitest, Drizzle/Postgres (no migration needed — windows ride on existing jsonb task payloads + the already-persisted `BacktestRun.platformRun`).

**Spec:** `docs/superpowers/specs/2026-07-12-r3b1-data-bound-eval-window-design.md` (commit `aa48525`).

## Global Constraints

- **Runtime:** `node --experimental-strip-types`. NO TypeScript parameter properties (`constructor(private x)`) — they break at runtime; an AST-guard test blocks them.
- **Additive + back-compat only:** `evalPlatformRun` is OPTIONAL everywhere. An in-flight task enqueued before this field existed must still work (retry falls back to re-resolving, exactly as today). NO migration — task payloads are jsonb; `BacktestRun.platformRun` is already persisted.
- **No new env var.** `PlatformRunConfig` SHAPE is unchanged — only its `period` value becomes data-bound.
- **Fail-soft never aborts.** Any miss/throw → `defaultPlatformRun` + an observable `eval_window.*` event. The demo (mock `dateRange` = `2026-06-12..2026-06-18`, ~6 days) must stay green: a short bound window makes R3a's `resolveHoldoutBoundary` return `mode:'none'`, so the gate stays inert — binding never breaks the demo.
- **Resolver is pure and never throws** — no I/O, no clock. Handlers own all I/O + event emission (with their own `task.id`). A thrown `listDatasets()` is caught by the handler → `dataset_discovery_failed` fallback; the resolver is never handed a failure.
- **`distinct` compares the WHOLE `PlatformRunConfig`** (`datasetId`, `symbols`, `timeframe`, `period`, `seed`) via the project's canonical `stableStringify` (`src/orchestrator/handlers/backtest-support.ts:29`), NOT `JSON.stringify` and NOT `period` alone.
- **Cycle 1 (onboarding) is NOT bound here** — it has its own holdout via `experiment-service`. Only Cycle 2 (`research.run_cycle` → `hypothesis.build` → `revision.build`).
- **TDD, frequent commits, DRY, YAGNI.**

---

## File Structure

- **Create** `src/orchestrator/handlers/platform-run-config.schema.ts` — the single shared Zod `PlatformRunConfigSchema` matching the `PlatformRunConfig` interface. Imported by the three payload schemas that carry an eval window.
- **Create** `src/research/eval-period-resolver.ts` — the pure `resolveEvalPeriod` resolver + its reason union.
- **Modify** `src/orchestrator/handlers/research-run-cycle.handler.ts` — add `evalPlatformRun` to the payload schema; resolve once at the handler top; thread onto each `hypothesis.build` payload; emit `eval_window.*`.
- **Modify** `src/orchestrator/handlers/backtest-support.ts` — add optional `evalPlatformRun` to `enqueueBacktestCompleted` args + the `backtest.completed` payload.
- **Modify** `src/orchestrator/handlers/run-platform-backtest.ts` + `src/orchestrator/handlers/resume-platform-backtest.ts` — both producers pass `evalPlatformRun` from the persisted run.
- **Modify** `src/orchestrator/handlers/backtest-completed.handler.ts` — extract `evalPlatformRun` from the payload; thread it through `enqueueResearchRetry`.
- **Modify** `src/orchestrator/handlers/revision-build.handler.ts` — extract the canonical window from the cycle's `hypothesis.build` tasks; consistency gate (reject on disagreement, pre-executor); no-window fallback.
- **Test files** created alongside each (see tasks).

---

## Task 1: Shared `PlatformRunConfigSchema`

**Files:**
- Create: `src/orchestrator/handlers/platform-run-config.schema.ts`
- Modify: `src/orchestrator/handlers/hypothesis-build.handler.ts:24-30` (replace the inline `platformRun` shape with the shared schema — proves byte-identity)
- Test: `src/orchestrator/handlers/platform-run-config.schema.test.ts`

**Interfaces:**
- Consumes: the `PlatformRunConfig` interface (`src/ports/research-platform.port.ts`): `{ datasetId: string; symbols: readonly string[]; timeframe: string; period: { from: string; to: string }; seed: number }`. Must stay byte-identical to the existing inline `HypothesisBuildPayloadSchema.platformRun` shape (`hypothesis-build.handler.ts:24`), which enforces `symbols: z.array(z.string().min(1)).min(1)` (non-empty array).
- Produces: `export const PlatformRunConfigSchema` (a `z.ZodType`) and `export type PlatformRunConfigInput = z.infer<typeof PlatformRunConfigSchema>`. This task wires it into `HypothesisBuildPayloadSchema.platformRun` (collapsing the first inline copy). Later tasks add `evalPlatformRun: PlatformRunConfigSchema.optional()` to two more payload schemas (research.run_cycle, backtest.completed).

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/handlers/platform-run-config.schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PlatformRunConfigSchema } from './platform-run-config.schema.ts';

describe('PlatformRunConfigSchema', () => {
  const valid = {
    datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
    period: { from: '2026-01-01', to: '2026-03-01' }, seed: 7,
  };

  it('parses a well-formed config', () => {
    const r = PlatformRunConfigSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(valid);
  });

  it('rejects a missing period', () => {
    const { period, ...noPeriod } = valid;
    expect(PlatformRunConfigSchema.safeParse(noPeriod).success).toBe(false);
  });

  it('rejects an empty datasetId', () => {
    expect(PlatformRunConfigSchema.safeParse({ ...valid, datasetId: '' }).success).toBe(false);
  });

  it('rejects a non-integer seed', () => {
    expect(PlatformRunConfigSchema.safeParse({ ...valid, seed: 1.5 }).success).toBe(false);
  });

  it('rejects an empty symbols array (preserves the HypothesisBuildPayloadSchema invariant)', () => {
    expect(PlatformRunConfigSchema.safeParse({ ...valid, symbols: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/platform-run-config.schema.test.ts`
Expected: FAIL — `Cannot find module './platform-run-config.schema.ts'`.

- [ ] **Step 3: Write the schema**

Create `src/orchestrator/handlers/platform-run-config.schema.ts`:

```ts
// src/orchestrator/handlers/platform-run-config.schema.ts
import { z } from 'zod';

/** The single canonical Zod shape for a PlatformRunConfig (the Cycle-2 eval window).
 *  Mirrors the PlatformRunConfig interface in ports/research-platform.port.ts. Shared by
 *  every payload schema that carries an eval window so the three sites never drift (R3b-1 §3.0). */
export const PlatformRunConfigSchema = z.object({
  datasetId: z.string().min(1),
  symbols: z.array(z.string().min(1)).min(1),
  timeframe: z.string().min(1),
  period: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  seed: z.number().int(),
});

export type PlatformRunConfigInput = z.infer<typeof PlatformRunConfigSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/platform-run-config.schema.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Wire the shared schema into `HypothesisBuildPayloadSchema` (collapse the first inline copy)**

In `src/orchestrator/handlers/hypothesis-build.handler.ts`, add the import (near the top, after the `zod` import):

```ts
import { PlatformRunConfigSchema } from './platform-run-config.schema.ts';
```

Replace the inline `platformRun` shape (`:24-30`) with the shared schema — keeping `.optional()`:

```ts
  cycleDepth: z.number().int().min(0).default(0),
  platformRun: PlatformRunConfigSchema.optional(),
});
```

This is a pure DRY collapse: the shared schema is byte-identical to the inline shape (same `symbols: z.array(z.string().min(1)).min(1)` invariant), so all downstream `payload.platformRun!` uses at `:104`/`:131-133` and the `platformRun === undefined` guard at `:61` are unaffected.

- [ ] **Step 6: Run the hypothesis-build tests to confirm the collapse is behavior-neutral**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/hypothesis-build.handler.test.ts`
Expected: PASS (unchanged — the schema is identical).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/handlers/platform-run-config.schema.ts src/orchestrator/handlers/platform-run-config.schema.test.ts src/orchestrator/handlers/hypothesis-build.handler.ts
git commit -m "feat(r3b1): shared PlatformRunConfigSchema, wired into HypothesisBuildPayloadSchema"
```

---

## Task 2: Pure `resolveEvalPeriod` resolver

**Files:**
- Create: `src/research/eval-period-resolver.ts`
- Test: `src/research/eval-period-resolver.test.ts`

**Interfaces:**
- Consumes: `DatasetDescriptor` (`src/ports/research-run-lifecycle.ts`): `{ datasetId: string; symbols: readonly string[]; dateRange: { from: string; to: string }; timeframe: string; coveredKinds: readonly ... }`. `PlatformRunConfig` (`src/ports/research-platform.port.ts`).
- Produces: `export function resolveEvalPeriod(datasets, fallback): ResolvedEvalPeriod` and `export type ResolvedEvalPeriod = { runConfig: PlatformRunConfig; source: 'dataset' | 'fallback'; fallbackReason?: EvalPeriodFallbackReason }` with `EvalPeriodFallbackReason = 'no_datasets' | 'dataset_not_found' | 'no_date_range' | 'invalid_range'`. Task 3's handler consumes this.

- [ ] **Step 1: Write the failing test**

Create `src/research/eval-period-resolver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveEvalPeriod } from './eval-period-resolver.ts';
import type { DatasetDescriptor } from '../ports/research-run-lifecycle.ts';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';

const fallback: PlatformRunConfig = {
  datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
  period: { from: '2020-01-01', to: '2020-02-01' }, seed: 7,
};

function dataset(over: Partial<DatasetDescriptor> = {}): DatasetDescriptor {
  return {
    datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
    dateRange: { from: '2026-01-01', to: '2026-03-01' }, coveredKinds: [], ...over,
  };
}

describe('resolveEvalPeriod', () => {
  it('binds the period to the matching dataset dateRange', () => {
    const r = resolveEvalPeriod([dataset()], fallback);
    expect(r.source).toBe('dataset');
    expect(r.runConfig.period).toEqual({ from: '2026-01-01', to: '2026-03-01' });
    // everything else stays from fallback
    expect(r.runConfig.datasetId).toBe('ds');
    expect(r.runConfig.seed).toBe(7);
  });

  it('falls back on an empty dataset list', () => {
    const r = resolveEvalPeriod([], fallback);
    expect(r).toEqual({ runConfig: fallback, source: 'fallback', fallbackReason: 'no_datasets' });
  });

  it('falls back when no dataset id matches', () => {
    const r = resolveEvalPeriod([dataset({ datasetId: 'other' })], fallback);
    expect(r.source).toBe('fallback');
    expect(r.fallbackReason).toBe('dataset_not_found');
  });

  it('falls back when the timeframe does not match', () => {
    const r = resolveEvalPeriod([dataset({ timeframe: '1m' })], fallback);
    expect(r.fallbackReason).toBe('dataset_not_found');
  });

  it('falls back on an unparseable dateRange', () => {
    const r = resolveEvalPeriod([dataset({ dateRange: { from: 'not-a-date', to: '2026-03-01' } })], fallback);
    expect(r.fallbackReason).toBe('invalid_range');
  });

  it('falls back when from >= to', () => {
    const r = resolveEvalPeriod([dataset({ dateRange: { from: '2026-03-01', to: '2026-01-01' } })], fallback);
    expect(r.fallbackReason).toBe('invalid_range');
  });

  it('falls back on an empty dateRange string', () => {
    const r = resolveEvalPeriod([dataset({ dateRange: { from: '', to: '' } })], fallback);
    expect(r.fallbackReason).toBe('no_date_range');
  });

  it('never throws on the matched dataset, returns fallback on bad range', () => {
    expect(() => resolveEvalPeriod([dataset({ dateRange: { from: '', to: '' } })], fallback)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/research/eval-period-resolver.test.ts`
Expected: FAIL — `Cannot find module './eval-period-resolver.ts'`.

- [ ] **Step 3: Write the resolver**

Create `src/research/eval-period-resolver.ts`:

```ts
// src/research/eval-period-resolver.ts
import type { DatasetDescriptor } from '../ports/research-run-lifecycle.ts';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';

export type EvalPeriodFallbackReason =
  | 'no_datasets'
  | 'dataset_not_found'
  | 'no_date_range'
  | 'invalid_range';

export interface ResolvedEvalPeriod {
  readonly runConfig: PlatformRunConfig;
  readonly source: 'dataset' | 'fallback';
  readonly fallbackReason?: EvalPeriodFallbackReason;
}

/** Pure. Never throws, no I/O, no clock. Binds `fallback.period` to the dateRange of the dataset
 *  matching `fallback.datasetId` + `fallback.timeframe`; any miss/invalid returns `fallback` with a
 *  reason. The handler owns discovery I/O + event emission (R3b-1 §3.1). */
export function resolveEvalPeriod(
  datasets: readonly DatasetDescriptor[],
  fallback: PlatformRunConfig,
): ResolvedEvalPeriod {
  if (datasets.length === 0) {
    return { runConfig: fallback, source: 'fallback', fallbackReason: 'no_datasets' };
  }
  const match = datasets.find(
    (d) => d.datasetId === fallback.datasetId && d.timeframe === fallback.timeframe,
  );
  if (!match) {
    return { runConfig: fallback, source: 'fallback', fallbackReason: 'dataset_not_found' };
  }
  const range = match.dateRange;
  if (!range || !range.from || !range.to) {
    return { runConfig: fallback, source: 'fallback', fallbackReason: 'no_date_range' };
  }
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
    return { runConfig: fallback, source: 'fallback', fallbackReason: 'invalid_range' };
  }
  return {
    runConfig: { ...fallback, period: { from: range.from, to: range.to } },
    source: 'dataset',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/research/eval-period-resolver.test.ts`
Expected: PASS (8/8).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/research/eval-period-resolver.ts src/research/eval-period-resolver.test.ts
git commit -m "feat(r3b1): pure resolveEvalPeriod (dataset dateRange -> bound window)"
```

---

## Task 3: `research-run-cycle` resolves once + threads the window

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts` (schema at `:30-45`; handler top `:145-167`; hypothesis.build enqueue payload `:460`)
- Test: `src/orchestrator/handlers/research-run-cycle.eval-window.test.ts`

**Interfaces:**
- Consumes: `resolveEvalPeriod` (Task 2), `PlatformRunConfigSchema` (Task 1). `services.researchPlatform.listDatasets(): Promise<{ datasets: readonly DatasetDescriptor[] }>`, `services.defaultPlatformRun: PlatformRunConfig`, `event(taskId, type, data)` (already imported/used at `:160`).
- Produces: every `hypothesis.build` task enqueued by this handler now carries `payload.platformRun` = the resolved window (immutable). Events `eval_window.resolved { source, period }`, `eval_window.fallback { reason }`. Task 4 populates the `payload.evalPlatformRun` this handler now reads.

**Context:** The mock's `listDatasets` returns `dateRange 2026-06-12..2026-06-18` and its datasetId likely differs from the test harness `defaultPlatformRun.datasetId 'ds'`, so tests inject a stub `researchPlatform` to force each branch. The handler currently does NOT call `listDatasets` — you are adding the first call, at the top, right after the `research.run_cycle.started` event (`:167`).

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/handlers/research-run-cycle.eval-window.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { researchRunCycleHandler } from './research-run-cycle.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { MockResearchPlatformAdapter } from '../../adapters/platform/mock-research-platform.adapter.ts';
import { stubResearcher, draft } from './research-run-cycle.test-fixtures.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { DatasetDescriptor } from '../../ports/research-run-lifecycle.ts';

/** researchPlatform stub whose listDatasets is controllable; everything else delegates to the mock. */
function platformWith(listDatasets: () => Promise<{ datasets: readonly DatasetDescriptor[] }>) {
  const base = new MockResearchPlatformAdapter();
  return Object.assign(base, { listDatasets });
}

const boundDataset: DatasetDescriptor = {
  datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
  dateRange: { from: '2026-01-01', to: '2026-03-01' }, coveredKinds: [],
};

function task(over: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 't1', taskType: 'research.run_cycle', source: 'chat', correlationId: 'c1',
    status: 'queued',
    payload: { strategyProfileId: 'p1', cycleDepth: 0 },
    createdAt: '2026-07-12T00:00:00Z', updatedAt: '2026-07-12T00:00:00Z', ...over,
  };
}

async function seedProfile(services: ReturnType<typeof makeServices>) {
  await services.strategyProfiles.create({
    id: 'p1', name: 'P', coreIdea: 'idea', status: 'active',
    createdAt: '2026-07-12T00:00:00Z', updatedAt: '2026-07-12T00:00:00Z',
  } as never);
}

describe('research-run-cycle eval-window binding', () => {
  it('binds the window to the dataset dateRange and stamps every hypothesis.build', async () => {
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('thesis A')], researchSummary: 's' }),
      researchPlatform: platformWith(async () => ({ datasets: [boundDataset] })),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task(), services);

    const events = (await services.events.listByTask('t1')).map((e) => e.type);
    expect(events).toContain('eval_window.resolved');

    const builds = (await services.researchTasks.listByCorrelationAndTypes('c1', ['hypothesis.build']));
    expect(builds.length).toBeGreaterThan(0);
    for (const b of builds) {
      expect(b.payload.platformRun).toMatchObject({ period: { from: '2026-01-01', to: '2026-03-01' } });
    }
  });

  it('falls back to defaultPlatformRun + eval_window.fallback when listDatasets throws', async () => {
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('thesis A')], researchSummary: 's' }),
      researchPlatform: platformWith(async () => { throw new Error('transport down'); }),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task(), services);

    const fallbackEvent = (await services.events.listByTask('t1')).find((e) => e.type === 'eval_window.fallback');
    expect(fallbackEvent?.data).toMatchObject({ reason: 'dataset_discovery_failed' });

    const builds = await services.researchTasks.listByCorrelationAndTypes('c1', ['hypothesis.build']);
    for (const b of builds) {
      expect(b.payload.platformRun).toEqual(services.defaultPlatformRun);
    }
  });

  it('reuses payload.evalPlatformRun WITHOUT calling listDatasets again', async () => {
    let calls = 0;
    const inherited = { datasetId: 'ds', symbols: ['ETHUSDT'], timeframe: '4h', period: { from: '2025-01-01', to: '2025-06-01' }, seed: 3 };
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('thesis A')], researchSummary: 's' }),
      researchPlatform: platformWith(async () => { calls += 1; return { datasets: [boundDataset] }; }),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task({ payload: { strategyProfileId: 'p1', cycleDepth: 1, evalPlatformRun: inherited } }), services);

    expect(calls).toBe(0);
    const builds = await services.researchTasks.listByCorrelationAndTypes('c1', ['hypothesis.build']);
    for (const b of builds) expect(b.payload.platformRun).toEqual(inherited);
  });
});
```

> **Note on `stubResearcher` / `draft`:** these already exist in `research-run-cycle.handler.test.ts` (imported at its top). If they are not exported from a shared fixtures module, extract them into `src/orchestrator/handlers/research-run-cycle.test-fixtures.ts` and re-import them in BOTH test files as the first sub-step (a pure move, no behavior change), then commit that move separately. If `makeServices` does not accept a `researchPlatform` override, add it to `test/support/make-services.ts` (it already accepts `researcher`, `critic` overrides — follow that pattern).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/research-run-cycle.eval-window.test.ts`
Expected: FAIL — hypothesis.build payloads carry `defaultPlatformRun`, no `eval_window.*` event, and the `evalPlatformRun` schema field is stripped (invalid payload or ignored).

- [ ] **Step 3: Add `evalPlatformRun` to the payload schema**

In `src/orchestrator/handlers/research-run-cycle.handler.ts`, add the import near the other schema imports (top of file, after line 5):

```ts
import { PlatformRunConfigSchema } from './platform-run-config.schema.ts';
import { resolveEvalPeriod } from '../../research/eval-period-resolver.ts';
import type { PlatformRunConfig } from '../../ports/research-platform.port.ts';
import type { DatasetDescriptor } from '../../ports/research-run-lifecycle.ts';
```

Add the field to `ResearchRunCyclePayloadSchema` (after the `paperRunId` field, `:44`):

```ts
  paperRunId: z.string().optional(),
  /** The Cycle-2 eval window, resolved once at the head of the cycle and inherited by retries
   *  (R3b-1 §3.3). When present, this handler uses it verbatim instead of re-resolving. */
  evalPlatformRun: PlatformRunConfigSchema.optional(),
});
```

- [ ] **Step 4: Resolve once at the handler top**

In `researchRunCycleHandler`, immediately AFTER the `research.run_cycle.started` event append (ends `:167`) and BEFORE `const symbol = ...` (`:168`), insert:

```ts
  // R3b-1: resolve the Cycle-2 eval window ONCE. A retry inherits it via payload.evalPlatformRun
  // (no re-resolve); a fresh cycle derives it from the dataset dateRange. Fail-soft to the fixture.
  let evalRun: PlatformRunConfig;
  if (payload.evalPlatformRun) {
    evalRun = payload.evalPlatformRun;
  } else {
    let datasets: readonly DatasetDescriptor[] | undefined;
    try {
      ({ datasets } = await services.researchPlatform.listDatasets());
    } catch {
      datasets = undefined;
    }
    if (datasets === undefined) {
      evalRun = services.defaultPlatformRun;
      await services.events.append(event(task.id, 'eval_window.fallback', { reason: 'dataset_discovery_failed' }));
    } else {
      const resolved = resolveEvalPeriod(datasets, services.defaultPlatformRun);
      evalRun = resolved.runConfig;
      if (resolved.source === 'dataset') {
        await services.events.append(event(task.id, 'eval_window.resolved', { source: 'dataset', period: resolved.runConfig.period }));
      } else {
        await services.events.append(event(task.id, 'eval_window.fallback', { reason: resolved.fallbackReason }));
      }
    }
  }
```

- [ ] **Step 5: Thread the window onto each hypothesis.build**

At the `hypothesis.build` enqueue payload (`:460`), replace `services.defaultPlatformRun`:

```ts
        payload: { hypothesisId: hypothesis.id, platformRun: evalRun, cycleDepth: payload.cycleDepth },
```

- [ ] **Step 6: Run the new test + the existing handler test**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/research-run-cycle.eval-window.test.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: PASS. The existing handler test must stay green (its mock `listDatasets` returns a dataset whose id/timeframe likely miss `defaultPlatformRun`, so it takes the `dataset_not_found` fallback and hypotheses still use `defaultPlatformRun` — unchanged behavior).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.eval-window.test.ts test/support/make-services.ts src/orchestrator/handlers/research-run-cycle.test-fixtures.ts 2>/dev/null
git commit -m "feat(r3b1): research-run-cycle resolves eval window once + threads into hypothesis.build"
```

---

## Task 4: `backtest.completed` producers + retry inheritance

**Files:**
- Modify: `src/orchestrator/handlers/backtest-support.ts` (`enqueueBacktestCompleted` args `:127-140`; `BacktestCompletedPayloadSchema` — locate via `rg -n "BacktestCompletedPayloadSchema" src/orchestrator/handlers/backtest-completed.handler.ts`)
- Modify: `src/orchestrator/handlers/run-platform-backtest.ts` (`:102`)
- Modify: `src/orchestrator/handlers/resume-platform-backtest.ts` (`:57`)
- Modify: `src/orchestrator/handlers/backtest-completed.handler.ts` (schema `:22-25`; `enqueueResearchRetry` `:49-76`; extract `:86`; retry calls `:113`, `:136`)
- Test: `src/orchestrator/handlers/backtest-completed.eval-window.test.ts` (retry-inheritance) + assertions appended to `src/orchestrator/handlers/run-platform-backtest.test.ts` and `src/orchestrator/handlers/resume-platform-backtest.test.ts` (producer-path — each producer actually stamps the window)

**Interfaces:**
- Consumes: `PlatformRunConfigSchema` (Task 1). `BacktestRun.platformRun: PlatformRunConfig` (already persisted at `run-platform-backtest.ts:76`). `again.platformRun` (submit) / `run.platformRun` (resume).
- Produces: `enqueueBacktestCompleted` args gain `evalPlatformRun?: PlatformRunConfig`; the `backtest.completed` payload gains `evalPlatformRun?`; `enqueueResearchRetry` gains an `evalPlatformRun?` param and stamps it onto the retry `research.run_cycle` payload (which Task 3 reads). Back-compat: all optional.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/handlers/backtest-completed.eval-window.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { backtestCompletedHandler } from './backtest-completed.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { ResearchTask } from '../../domain/types.ts';

const evalWindow = { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2026-01-01', to: '2026-03-01' }, seed: 7 };

function completedTask(payload: Record<string, unknown>): ResearchTask {
  return {
    id: 'bt1', taskType: 'backtest.completed', source: 'chat', correlationId: 'c1', status: 'queued',
    payload, createdAt: '2026-07-12T00:00:00Z', updatedAt: '2026-07-12T00:00:00Z',
  };
}

const failPayload = (over: Record<string, unknown> = {}) => ({
  backtestRunId: 'r1', hypothesisId: 'h1', strategyProfileId: 'p1',
  decision: 'FAIL', reasons: ['loss'], cycleDepth: 0, ...over,
});

describe('backtest-completed retry inherits evalPlatformRun', () => {
  it('threads evalPlatformRun into the retry research.run_cycle payload', async () => {
    const services = makeServices();
    await backtestCompletedHandler(completedTask(failPayload({ evalPlatformRun: evalWindow, symbol: 'BTCUSDT' })), services);
    const retry = (await services.researchTasks.listByCorrelationAndTypes('c1', ['research.run_cycle']))[0];
    expect(retry?.payload.evalPlatformRun).toEqual(evalWindow);
    expect(retry?.payload.symbol).toBe('BTCUSDT');
  });

  it('omits evalPlatformRun on an old payload without the field (back-compat)', async () => {
    const services = makeServices();
    await backtestCompletedHandler(completedTask(failPayload()), services);
    const retry = (await services.researchTasks.listByCorrelationAndTypes('c1', ['research.run_cycle']))[0];
    expect(retry).toBeDefined();
    expect(retry?.payload.evalPlatformRun).toBeUndefined();
  });
});
```

- [ ] **Step 1b: Write the producer-path tests (prove submit AND resume stamp the window)**

The retry-inheritance test above only exercises `backtestCompletedHandler`. Add one test per producer proving the `backtest.completed` payload actually carries the window. Mirror the existing `symbol` producer test (`run-platform-backtest.test.ts:65-73`) which uses `InMemoryQueueAdapter` + `queue.queued.filter(...)` + `researchTasks.findById(taskId).payload`.

Append to `src/orchestrator/handlers/run-platform-backtest.test.ts` (inside its `describe`, reusing its `setup`/`PLATFORM_RUN`):

```ts
  it('enqueued backtest.completed payload carries evalPlatformRun = the run window (submit)', async () => {
    const queue = new InMemoryQueueAdapter();
    const { s, common } = await setup({ researchPlatform: new MockResearchPlatformAdapter(), backtestBackend: 'research_platform', taskQueue: queue });
    await runPlatformBacktest(common);

    const enqueued = queue.queued.filter((q) => q.taskType === 'backtest.completed');
    expect(enqueued).toHaveLength(1);
    const completedTask = await s.researchTasks.findById(enqueued[0]!.taskId);
    expect(completedTask!.payload.evalPlatformRun).toEqual(PLATFORM_RUN); // = again.platformRun (persisted)
  });
```

Append the resume analogue to `src/orchestrator/handlers/resume-platform-backtest.test.ts`. Its setup persists a `submitted` `BacktestRun` (with `platformRun`) then calls `resumePlatformRun(s, run)`. Assert the window comes from the **persisted (fresh) run**, not the input object — pass a `run` argument whose `.platformRun` is deliberately DIFFERENT from the persisted row, and assert the payload carries the PERSISTED window:

```ts
  it('enqueued backtest.completed payload carries evalPlatformRun from the fresh re-read, not the stale input (resume)', async () => {
    const queue = new InMemoryQueueAdapter();
    const s = makeServices({ researchPlatform: new MockResearchPlatformAdapter(), taskQueue: queue });
    // Persist the canonical run with the REAL window (adapt to this file's existing seeding helper).
    const persistedWindow = { datasetId: 'ds', symbols: ['ETHUSDT'], timeframe: '1h', period: { from: '2026-01-01', to: '2026-03-01' }, seed: 7 };
    const run = await seedSubmittedRun(s, { platformRun: persistedWindow }); // this file's helper
    // Caller passes a STALE copy with a different window; the producer must ignore it.
    const staleInput = { ...run, platformRun: { ...persistedWindow, period: { from: '1999-01-01', to: '1999-02-01' } } };
    await resumePlatformRun(s, staleInput);

    const enqueued = queue.queued.filter((q) => q.taskType === 'backtest.completed');
    expect(enqueued).toHaveLength(1);
    const completedTask = await s.researchTasks.findById(enqueued[0]!.taskId);
    expect(completedTask!.payload.evalPlatformRun).toEqual(persistedWindow); // fresh read wins over stale input
  });
```

> Adapt `seedSubmittedRun` to the resume test file's actual setup (it already builds a submitted run + its task + a completed poll outcome — reuse that; only ensure the persisted `platformRun` differs from the `staleInput` you pass). If the file has no reusable seeder, factor its inline setup into one. The KEY assertion is `evalPlatformRun === persistedWindow` (the guard-#2 `again` read), which is exactly what refinement #2 requires.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/backtest-completed.eval-window.test.ts src/orchestrator/handlers/run-platform-backtest.test.ts src/orchestrator/handlers/resume-platform-backtest.test.ts`
Expected: FAIL — retry test: `retry.payload.evalPlatformRun` is `undefined`; producer tests: `completedTask.payload.evalPlatformRun` is `undefined` (field not stamped yet).

- [ ] **Step 3: Add `evalPlatformRun` to `enqueueBacktestCompleted` args**

In `src/orchestrator/handlers/backtest-support.ts`, add the import at the top (near other imports):

```ts
import type { PlatformRunConfig } from '../../ports/research-platform.port.ts';
```

In the `enqueueBacktestCompleted` `args` object type (after `symbol?: string;`, `:139`), add:

```ts
    /** The Cycle-2 eval window this run executed on (BacktestRun.platformRun), threaded so a
     *  retry researches the SAME window (R3b-1 §3.3). Absent on runs before this field existed. */
    evalPlatformRun?: PlatformRunConfig;
```

The task's `payload: args` assignment already carries every arg field verbatim, so no further change is needed inside `enqueueBacktestCompleted`.

- [ ] **Step 4: Both producers pass the window from the persisted run**

In `src/orchestrator/handlers/run-platform-backtest.ts`, at the `enqueueBacktestCompleted(services, task, { ... })` call (`:102`), add the field (source: the `again` object read from `findById`):

```ts
      deltaMaxDrawdownPct: result.deltaMaxDrawdownPct,
      ...(again.platformRun ? { evalPlatformRun: again.platformRun } : {}),
```

(Insert as the last property of the args object, after the existing delta fields.)

In `src/orchestrator/handlers/resume-platform-backtest.ts`, at its `enqueueBacktestCompleted(services, task, { ... })` call (`:57`), add the same — sourced from **`again`, the fresh re-read from Guard #2** (`:50`), NOT the `run` input parameter (which is the potentially-stale object the caller passed in):

```ts
      ...(again.platformRun ? { evalPlatformRun: again.platformRun } : {}),
```

> Rationale: `again = await services.backtests.findById(runId)` is the guard-#2 re-read the resume path already uses for `platformRunId` (`applyPlatformTerminalOutcome({ ..., platformRunId: again.platformRunId }`, `:53`). Sourcing the window from the same fresh read keeps the eval window consistent with the terminal outcome and avoids a stale input. Confirm `again` is in scope with `rg -n "const again|again.platformRun" src/orchestrator/handlers/resume-platform-backtest.ts`.

- [ ] **Step 5: Add `evalPlatformRun` to the `backtest.completed` payload schema**

In `src/orchestrator/handlers/backtest-completed.handler.ts`, add the import:

```ts
import { PlatformRunConfigSchema } from './platform-run-config.schema.ts';
```

In `BacktestCompletedPayloadSchema`, next to the `symbol` field (`:25`):

```ts
  symbol: z.string().optional(),
  /** The eval window this run executed on; threaded into the retry cycle (R3b-1 §3.3). */
  evalPlatformRun: PlatformRunConfigSchema.optional(),
```

- [ ] **Step 6: Extract + thread through `enqueueResearchRetry`**

Add `evalPlatformRun` to the destructure at `:86`:

```ts
    deltaNetPnlUsd, deltaMaxDrawdownPct, symbol, evalPlatformRun,
```

Add a parameter to `enqueueResearchRetry` (`:49-56`) after `symbol?: string,`:

```ts
  symbol?: string,
  evalPlatformRun?: import('../../ports/research-platform.port.ts').PlatformRunConfig,
```

Extend its retry payload (`:64`):

```ts
    payload: { strategyProfileId, cycleDepth: nextCycleDepth, feedback, ...(symbol ? { symbol } : {}), ...(evalPlatformRun ? { evalPlatformRun } : {}) },
```

Pass it at BOTH retry call sites (`:113` FAIL, `:136` MODIFY) — append the argument:

```ts
        await enqueueResearchRetry(task, services, strategyProfileId,
          { hypothesisId, decision, reasons }, cycleDepth + 1, symbol, evalPlatformRun);
```

- [ ] **Step 7: Run the new tests + existing backtest-completed tests**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/backtest-completed.eval-window.test.ts src/orchestrator/handlers/backtest-completed.handler.test.ts src/orchestrator/handlers/run-platform-backtest.test.ts src/orchestrator/handlers/resume-platform-backtest.test.ts`
Expected: PASS — including the two producer-path tests (submit → `again.platformRun`, resume → `again.platformRun` from the fresh guard-#2 read). Existing tests stay green (field is optional; producers add it only when `platformRun` is present, which it always is on a real run).

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/orchestrator/handlers/backtest-support.ts src/orchestrator/handlers/run-platform-backtest.ts src/orchestrator/handlers/resume-platform-backtest.ts src/orchestrator/handlers/backtest-completed.handler.ts src/orchestrator/handlers/backtest-completed.eval-window.test.ts src/orchestrator/handlers/run-platform-backtest.test.ts src/orchestrator/handlers/resume-platform-backtest.test.ts
git commit -m "feat(r3b1): both backtest.completed producers thread evalPlatformRun into retries"
```

---

## Task 5: `revision-build` extracts the canonical window + consistency gate

**Files:**
- Modify: `src/orchestrator/handlers/revision-build.handler.ts` (cycleTasks `:210`; runConfig `:326`)
- Test: `src/orchestrator/handlers/revision-build.eval-window.test.ts` (or extend `revision-flow.integration.test.ts`)

**Interfaces:**
- Consumes: `cycleTasks = services.researchTasks.listByCorrelationAndTypes(correlationId, ['hypothesis.build'])` (already fetched at `:210`); each task's `payload.platformRun: PlatformRunConfig`. `stableStringify` (`./backtest-support.ts:29`). `services.defaultPlatformRun`. `services.revisions.updateStatus(revisionId, { status: 'rejected', verdictReason, updatedAt })` + `event(...)` — the exact reject shape already used at `:346-349` for `comparison_baseline_unavailable`. `revisionId` + `version` exist by Step 7 (`revision.candidate_built` at `:321`).
- Produces: `runConfig` at `:326` is the cycle's canonical window instead of `services.defaultPlatformRun`. New events `eval_window.inconsistent { revisionId, version, windows }`, `eval_window.fallback { reason: 'no_cycle_window' }`; new `verdictReason: 'eval_window_inconsistent'`. Feeds R3a's `resolveHoldoutBoundary`.

**Context — ordering (spec §3.4):** the cycle windows are readable at Step 2 (`:210`), but the `revisionId` needed for the reject only exists after the candidate revision is created (~Step 7). So compute the window set early (or re-derive from `cycleTasks` at Step 8 — the same list is in scope), and apply the gate at Step 8, right where `runConfig` is chosen (`:326`), BEFORE the comparison-baseline executor runs. This mirrors the existing `comparison_baseline_unavailable` reject at `:346-349`, which already rejects a created candidate before spending an executor run.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/handlers/revision-build.eval-window.test.ts`. Model the setup on the existing `revision-flow.integration.test.ts` (same `makeServices` harness + how it seeds `hypothesis.build` tasks and eligible proposals). The three cases:

```ts
import { describe, it, expect } from 'vitest';
import { revisionBuildHandler } from './revision-build.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
// Reuse the cycle-seeding helpers from the integration test's setup (extract them into a shared
// fixtures module `revision-flow.fixtures.ts` if they are not already exported, then import here).
import { seedMergeableCycle } from './revision-flow.fixtures.ts';

const windowA = { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2026-01-01', to: '2026-03-01' }, seed: 7 };
const windowB = { ...windowA, period: { from: '2026-02-01', to: '2026-04-01' } };
const windowSeedDiff = { ...windowA, seed: 99 };

describe('revision-build eval-window extraction', () => {
  it('runs the full-window comparison baseline on the single cycle window (not defaultPlatformRun)', async () => {
    const { services, task } = await seedMergeableCycle({ platformRun: windowA });
    await revisionBuildHandler(task, services);
    // Assert BY LABEL: the comparison_baseline executor run always uses the full cycle window
    // (runConfig). Do NOT assert every() call shares windowA.period — R3a's train/holdout runs
    // deliberately carry SPLIT periods (encodeTrain/HoldoutPeriod), and every() is vacuously true
    // on an empty calls array. Anchor on the labeled call + a non-empty guard.
    const calls = services.revisionRunExecutor.calls ?? [];
    expect(calls.length).toBeGreaterThan(0);
    const baselineCall = calls.find((c: { label: string }) => c.label === 'comparison_baseline');
    expect(baselineCall).toBeDefined();
    expect(baselineCall!.run.period).toEqual(windowA.period);
  });

  it('rejects the candidate with eval_window_inconsistent when windows disagree (period)', async () => {
    const { services, task } = await seedMergeableCycle({ platformRuns: [windowA, windowB] });
    await revisionBuildHandler(task, services);
    const events = (await services.events.listByTask(task.id)).map((e) => e.type);
    expect(events).toContain('eval_window.inconsistent');
    expect(events).toContain('revision.rejected');
    // executor NOT invoked for a comparison/holdout run on an inconsistent cycle
    expect((services.revisionRunExecutor.calls ?? []).length).toBe(0);
    const rev = (await services.revisions.listByStrategyProfile('p1')).at(-1);
    expect(rev?.verdictReason).toBe('eval_window_inconsistent');
  });

  it('treats a seed-only difference as inconsistent (whole-config distinct)', async () => {
    const { services, task } = await seedMergeableCycle({ platformRuns: [windowA, windowSeedDiff] });
    await revisionBuildHandler(task, services);
    expect((await services.events.listByTask(task.id)).map((e) => e.type)).toContain('eval_window.inconsistent');
  });

  it('falls back to defaultPlatformRun + eval_window.fallback when no cycle window is present', async () => {
    const { services, task } = await seedMergeableCycle({ platformRun: undefined });
    await revisionBuildHandler(task, services);
    const fallback = (await services.events.listByTask(task.id)).find((e) => e.type === 'eval_window.fallback');
    expect(fallback?.data).toMatchObject({ reason: 'no_cycle_window' });
  });
});
```

> **Harness note:** `seedMergeableCycle` is a to-be-extracted helper — the existing `revision-flow.integration.test.ts` already builds a mergeable cycle (eligible proposals + `hypothesis.build` tasks in a correlation). Extract that setup into `revision-flow.fixtures.ts`, parameterized so each `hypothesis.build` task's `payload.platformRun` can be set per-task (`platformRun` = same for all; `platformRuns` = one per seeded build task). Confirm the executor-spy accessor (`services.revisionRunExecutor.calls`) matches the harness; if the harness uses a different capture, assert against that instead. Do the extraction as the first sub-step (pure move, commit separately).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/revision-build.eval-window.test.ts`
Expected: FAIL — `runConfig` is still `defaultPlatformRun`; no `eval_window.*` events; inconsistent cycles are not rejected.

- [ ] **Step 3: Import `stableStringify`**

In `src/orchestrator/handlers/revision-build.handler.ts`, confirm/add to the `backtest-support.ts` import:

```ts
import { event, stableStringify /* , ...existing */ } from './backtest-support.ts';
```

(`stableStringify` is exported at `backtest-support.ts:29`; append it to the existing named import from that module.)

- [ ] **Step 4: Extract the canonical window + apply the gate at Step 8**

Replace `const runConfig = services.defaultPlatformRun;` (`:326`) with:

```ts
  // R3b-1: the eval window is the cycle's — extracted from the hypothesis.build tasks, never
  // re-resolved here. If the cycle's tasks disagree, reject rather than silently mix windows.
  const cycleWindows = cycleTasks
    .map((t) => t.payload.platformRun as PlatformRunConfig | undefined)
    .filter((w): w is PlatformRunConfig => w !== undefined);
  const distinct = new Map(cycleWindows.map((w) => [stableStringify(w), w]));
  let runConfig: PlatformRunConfig;
  if (distinct.size > 1) {
    await services.revisions.updateStatus(revisionId, {
      status: 'rejected', verdictReason: 'eval_window_inconsistent', updatedAt: now(),
    });
    await services.events.append(event(task.id, 'eval_window.inconsistent', {
      revisionId, version, windows: [...distinct.values()],
    }));
    await services.events.append(event(task.id, 'revision.rejected', {
      revisionId, version, reasons: ['eval_window_inconsistent'],
    }));
    return;
  }
  if (distinct.size === 1) {
    runConfig = [...distinct.values()][0]!;
  } else {
    runConfig = services.defaultPlatformRun;
    await services.events.append(event(task.id, 'eval_window.fallback', { reason: 'no_cycle_window' }));
  }
```

Ensure `PlatformRunConfig` is imported (add if absent):

```ts
import type { PlatformRunConfig } from '../../ports/research-platform.port.ts';
```

> `now()` is already defined in this handler (used at `:347` etc.). `revisionId` and `version` are in scope from Step 7 (used by `revision.candidate_built` at `:321`). Verify `cycleTasks` is still in scope at `:326` — it is declared at `:210` within the same handler body.

- [ ] **Step 5: Run the new test + the revision-flow integration test**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/revision-build.eval-window.test.ts src/orchestrator/handlers/revision-flow.integration.test.ts`
Expected: PASS. The integration test stays green: its seeded `hypothesis.build` tasks either all carry one window (→ that window) or none (→ `no_cycle_window` fallback to `defaultPlatformRun`, identical to today's behavior). If the integration harness seeds build tasks WITHOUT a `platformRun`, the fallback branch preserves current behavior — confirm no assertion there depends on the absence of an `eval_window.fallback` event; if one does, update it to allow the additive event.

- [ ] **Step 6: R3a interaction check**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/revision-flow.integration.test.ts` (the R3a holdout tests live here). Confirm the holdout gate still runs on the chosen `runConfig` (now the cycle window) and short-window cases stay `mode:'none'`.
Expected: PASS.

- [ ] **Step 7: Typecheck + full suite**

Run: `pnpm typecheck && node --experimental-strip-types node_modules/vitest/vitest.mjs run`
Expected: no type errors; full suite green (0 failures).

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/handlers/revision-build.handler.ts src/orchestrator/handlers/revision-build.eval-window.test.ts src/orchestrator/handlers/revision-flow.fixtures.ts 2>/dev/null
git commit -m "feat(r3b1): revision-build extracts canonical cycle window + consistency gate"
```

---

## Self-Review

**1. Spec coverage:**
- §3.0 shared `PlatformRunConfigSchema` → Task 1. ✅
- §3.1 pure resolver (never throws, 4 fallback reasons) → Task 2. ✅
- §3.1 handler owns I/O, `dataset_discovery_failed` on throw → Task 3 Step 4. ✅
- §3.2 resolve once + thread into every hypothesis.build → Task 3 Steps 4-5. ✅
- §3.3 retry inheritance via backtest.completed, both producers source `run.platformRun` → Task 4. ✅
- §3.4 revision-build extracts window, `distinct` via `stableStringify` on whole config, reject pre-executor, no-window fallback → Task 5. ✅
- §3.5 fail-soft + demo (short mock window → R3a inert) → Global Constraints + Task 5 Step 6. ✅
- §5 testing (resolver units, both producers, inconsistent-cycle, seed-diff distinct, back-compat) → Tasks 2/4/5. ✅
- §6 Cycle 1 not bound → Global Constraints; only `research.run_cycle` path touched. ✅

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step shows the code. The two harness-extraction notes (fixtures modules, executor-spy accessor) are explicit conditional instructions with concrete `rg` verification, not placeholders. ✅

**3. Type consistency:** `resolveEvalPeriod(datasets, fallback) → { runConfig, source, fallbackReason? }` consistent across Tasks 2/3. `evalPlatformRun?: PlatformRunConfig` consistent across schema (Task 1/3/4) and args (Task 4). `stableStringify` name matches `backtest-support.ts:29`. `PlatformRunConfig` period shape `{ from, to }` consistent. Events `eval_window.resolved|fallback|inconsistent` spelled identically in emit + assertions. ✅

**One flagged risk for the implementer/reviewer:** the exact test-harness accessors (`makeServices` `researchPlatform` override; `services.revisionRunExecutor.calls` spy; `seedMergeableCycle`/`stubResearcher` fixture exports) are asserted from the spec's mechanics but must be confirmed against the actual harness at implementation time — each task's note says how to verify and what to do if the accessor differs. This is deliberate: the production plumbing (line numbers, `run.platformRun`, `cycleTasks` at `:210`) is confirmed; the test-support surface is the one place to adapt.
