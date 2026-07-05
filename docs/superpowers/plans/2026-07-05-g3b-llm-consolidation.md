# G3b — LLM-consolidation of strategy revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At a nesting-depth threshold, LLM-consolidate a deeply-stacked accepted `strategy_revision` into one flat clean strategy factory, verify strict behavioral parity (fail-safe), then re-baseline the clean source through the full G1 contour.

**Architecture:** A new `revision.consolidate` task type, triggered from `revision.build` on `revision.accepted && compositionDepth >= threshold`. Its handler reconstructs the accepted revision's stacked source, rewrites it via a new `StrategyConsolidatorPort` (fake/mastra behind a seam), re-runs it on the accepted revision's EXACT combo run-context, and compares the full scalar metric block via a pure `evaluateConsolidation` parity ladder. On parity it materializes a `kind:'consolidated'` revision (compositionDepth reset to 1, inheriting R's `hypothesisIds`/`mergedRuleSet` verbatim) and enqueues `strategy.baseline` in a new ready-bundle mode (no LLM rebuild). Every failure is fail-safe: the stacked revision stays source-of-truth.

**Tech Stack:** TypeScript (`node --experimental-strip-types`), Vitest, Drizzle (Postgres, `pnpm db:generate`), zod, esbuild (`assembleStrategyBundle`), Mastra agents.

**Spec:** `docs/superpowers/specs/2026-07-05-g3b-llm-consolidation-design.md`.

## Global Constraints

- **NO TS parameter properties.** `constructor(private x)` breaks under `node --experimental-strip-types` at runtime (an AST guard test blocks it). Declare fields explicitly.
- **Additive migrations only.** New nullable/defaulted columns; edit `src/db/schema.ts` then `pnpm db:generate`; never rewrite existing migrations. Run against a scratch DB — never destructive.
- **Deterministic bundle hash.** Never LLM-rebuild a source you already have; reconstruct persisted `{source,manifest,bundleHash}` via `reconstructStrategyBundle` (hash-pinned). Non-deterministic rebuild → `bundleHash` drift.
- **Fail-safe, never fail-closed.** Any consolidation failure leaves the stacked revision `accepted`/source-of-truth, emits `revision.consolidation_rejected`/`_skipped`, and does NOT re-baseline.
- **Main invariant.** LLM consolidation preserves semantics and adds no rules. Behavior change (any metric divergence) → REJECT. Style-A (unsupported) overlays are NEVER rescued: `consolidated.hypothesisIds` inherits R's verbatim.
- **Gates per task:** `pnpm typecheck` clean and `pnpm test` (relevant files) green before commit. `pnpm typecheck` can take minutes in WSL2 — let it finish, do not treat slowness as a hang.
- **Handlers take `(task, services: AppServices)`** — there is no separate `HandlerDeps` type.
- **Metrics vocabulary:** strategy-lane runs pass `metrics: [...RESEARCH_RUN_METRICS]` (snake_case platform keys); resulting `BacktestMetricBlock` is camelCase scalar numbers.

---

### Task 1: Guard the combo-run `platformRun` persistence (prerequisite §13)

`BacktesterRevisionRunExecutor.execute()` already persists `platformRun: req.run` on the `revision_combo` row (`src/research/backtester-revision-run-executor.ts:47`). Consolidation's run-context source-of-truth (§4 step 2) depends on this. Lock it with a regression test so it can't silently regress.

**Files:**
- Test: `src/research/backtester-revision-run-executor.test.ts` (add one test to the existing file; if absent, create it).

**Interfaces:**
- Consumes: `BacktesterRevisionRunExecutor` ctor `{ platform, strategyBacktests, poll, callbackUrl?, now }`; `RevisionRunRequest` `{ revisionId, label, strategyBundle, strategyProfileId, run, metrics, correlationId }`.
- Produces: nothing new — a locking test.

- [ ] **Step 1: Write the failing test**

Add a test that captures the row passed to `strategyBacktests.createSubmitted` and asserts `row.platformRun` deep-equals the request's `run`. Use a fake `strategyBacktests` repo recording `createSubmitted` args and a fake `platform` returning a submit handle. Mirror the existing test's fixtures in that file (reuse its `makeExecutor`/`req` helpers if present; otherwise construct a minimal `RevisionRunRequest` with a concrete `PlatformRunConfig` `run = { datasetId:'ds-1', symbols:['ESPORTSUSDT'], timeframe:'1h', period:{from:'2026-06-12',to:'2026-06-19'}, seed:42 }`).

```ts
it('persists platformRun (the run-context) on the submitted revision_combo row', async () => {
  const created: StrategyBacktestRun[] = [];
  const strategyBacktests = { ...fakeStrategyBacktests(), createSubmitted: async (r: StrategyBacktestRun) => { created.push(r); } };
  const executor = new BacktesterRevisionRunExecutor({ platform: fakePlatformSubmitOnly(), strategyBacktests, poll: { maxPolls: 1, pollDelayMs: 0 }, now: () => '2026-07-05T00:00:00.000Z' });
  const run = { datasetId: 'ds-1', symbols: ['ESPORTSUSDT'], timeframe: '1h', period: { from: '2026-06-12', to: '2026-06-19' }, seed: 42 };
  await executor.execute({ revisionId: 'rev-1', label: 'candidate', strategyBundle: fakeAssembledBundle(), strategyProfileId: 'prof-1', run, metrics: [...RESEARCH_RUN_METRICS], correlationId: 'c1' });
  expect(created).toHaveLength(1);
  expect(created[0]!.platformRun).toEqual(run);
});
```

- [ ] **Step 2: Run it — expect PASS immediately (regression lock, not RED)**

Run: `pnpm vitest run src/research/backtester-revision-run-executor.test.ts -t "persists platformRun"`
Expected: PASS (the behavior already exists). If it FAILS, the prerequisite is NOT met — STOP and add `platformRun: req.run` to the row in `backtester-revision-run-executor.ts` before proceeding.

- [ ] **Step 3: Commit**

```bash
git add src/research/backtester-revision-run-executor.test.ts
git commit -m "test(research): lock platformRun persistence on revision_combo run (G3b prereq)"
```

---

### Task 2: Additive schema/domain/repo fields + `findConsolidatedOf`

Add the G3b revision fields as **optional/defaulted** (non-breaking — existing constructors keep compiling) and the idempotency query.

**Files:**
- Modify: `src/domain/strategy-revision.ts`
- Modify: `src/db/schema.ts:359` (`strategyRevision` table)
- Create: `migrations/0020_*.sql` (via `pnpm db:generate`, then hand-append backfill)
- Modify: `src/ports/strategy-revision.repository.ts`
- Modify: `src/adapters/repository/drizzle-strategy-revision.repository.ts`
- Modify: `src/adapters/repository/in-memory-strategy-revision.repository.ts`
- Test: `src/adapters/repository/in-memory-strategy-revision.repository.test.ts` (add cases; create if absent)

**Interfaces:**
- Produces (domain): `StrategyRevision` gains `kind?: 'composed' | 'consolidated'`, `consolidatedFromRevisionId?: string`, `semanticParentRevisionId?: string`, `compositionDepth?: number`, `baselineValidationStatus?: 'pending' | 'passed' | 'inconclusive' | 'failed'`, `baselineExperimentId?: string`, `baselineTaskId?: string`.
- Produces (repo): `findConsolidatedOf(revisionId: string): Promise<StrategyRevision | null>`; `updateStatus` patch `Pick` extended with `baselineValidationStatus | baselineExperimentId | baselineTaskId`.

- [ ] **Step 1: Extend the domain type**

In `src/domain/strategy-revision.ts` add to `StrategyRevision` (after `verdictReason?`):
```ts
  kind?: 'composed' | 'consolidated';        // default 'composed' when absent
  consolidatedFromRevisionId?: string;       // consolidated: the R it materializes
  semanticParentRevisionId?: string;         // composed: baseRevisionId; consolidated: R.id
  compositionDepth?: number;                 // default 1; consolidation resets to 1
  baselineValidationStatus?: 'pending' | 'passed' | 'inconclusive' | 'failed';
  baselineExperimentId?: string;
  baselineTaskId?: string;
```

- [ ] **Step 2: Extend the Drizzle schema**

In `src/db/schema.ts` `strategyRevision` columns (before the closing `}`), add:
```ts
  kind: text('kind').notNull().default('composed').$type<'composed' | 'consolidated'>(),
  consolidatedFromRevisionId: text('consolidated_from_revision_id'),
  semanticParentRevisionId: text('semantic_parent_revision_id'),
  compositionDepth: integer('composition_depth').notNull().default(1),
  baselineValidationStatus: text('baseline_validation_status').$type<'pending' | 'passed' | 'inconclusive' | 'failed'>(),
  baselineExperimentId: text('baseline_experiment_id'),
  baselineTaskId: text('baseline_task_id'),
```

- [ ] **Step 3: Generate the migration + append backfill**

Run: `pnpm db:generate`
Expected: creates `migrations/0020_*.sql` adding the 7 columns (with `DEFAULT 'composed'` / `DEFAULT 1`). Then **append** a compositionDepth backfill for existing chains to that generated file:
```sql
--> statement-breakpoint
WITH RECURSIVE chain AS (
  SELECT id, base_revision_id, 1 AS depth FROM strategy_revision WHERE base_revision_id IS NULL
  UNION ALL
  SELECT r.id, r.base_revision_id, c.depth + 1 FROM strategy_revision r JOIN chain c ON r.base_revision_id = c.id
)
UPDATE strategy_revision s SET composition_depth = chain.depth FROM chain WHERE s.id = chain.id;
```

- [ ] **Step 4: Extend the repo port**

In `src/ports/strategy-revision.repository.ts`: add `baselineValidationStatus`, `baselineExperimentId`, `baselineTaskId` to the `updateStatus` patch `Pick<StrategyRevision, ...>` union, and add:
```ts
  /** The consolidated revision that materializes `revisionId` (kind='consolidated', consolidatedFromRevisionId=revisionId), or null. */
  findConsolidatedOf(revisionId: string): Promise<StrategyRevision | null>;
```

- [ ] **Step 5: Implement in both repos**

Drizzle (`drizzle-strategy-revision.repository.ts`): in `updateStatus`'s set-builder add the three `if (patch.X !== undefined) set.snake_case = patch.X` guards; extend `strategyRevisionToDomain` to map the 7 new columns (`kind: r.kind ?? 'composed'`, `compositionDepth: r.compositionDepth ?? 1`, others straight); add:
```ts
async findConsolidatedOf(revisionId: string): Promise<StrategyRevision | null> {
  const rows = await this.db.select().from(strategyRevision)
    .where(and(eq(strategyRevision.consolidatedFromRevisionId, revisionId), eq(strategyRevision.kind, 'consolidated')))
    .limit(1);
  return rows[0] ? strategyRevisionToDomain(rows[0]) : null;
}
```
In-memory (`in-memory-strategy-revision.repository.ts`): mirror — `findConsolidatedOf` filters the array; `updateStatus` merges the three new patch keys; `create` stores the new fields as-is.

- [ ] **Step 6: Write repo tests (RED → GREEN)**

Add to the in-memory repo test: (a) `create` + `findById` round-trips `kind`/`compositionDepth`/`consolidatedFromRevisionId`/`baselineValidationStatus`; (b) `findConsolidatedOf` returns the consolidated child and `null` when none; (c) `updateStatus` patches `baselineValidationStatus`+`baselineExperimentId`.

```ts
it('findConsolidatedOf returns the consolidated materialization of R', async () => {
  const repo = new InMemoryStrategyRevisionRepository();
  await repo.create(rev({ id: 'R', kind: 'composed', version: 3 }));
  expect(await repo.findConsolidatedOf('R')).toBeNull();
  await repo.create(rev({ id: 'C', kind: 'consolidated', consolidatedFromRevisionId: 'R', version: 4 }));
  expect((await repo.findConsolidatedOf('R'))?.id).toBe('C');
});
```
Run: `pnpm vitest run src/adapters/repository/in-memory-strategy-revision.repository.test.ts` → PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck` → clean.
```bash
git add src/domain/strategy-revision.ts src/db/schema.ts migrations/ src/ports/strategy-revision.repository.ts src/adapters/repository/drizzle-strategy-revision.repository.ts src/adapters/repository/in-memory-strategy-revision.repository.ts src/adapters/repository/in-memory-strategy-revision.repository.test.ts
git commit -m "feat(research): additive strategy_revision consolidation fields + findConsolidatedOf"
```

---

### Task 3: `evaluateConsolidation` — strict full-block parity ladder (pure)

**Files:**
- Create: `src/validation/consolidation-evaluator.ts`
- Test: `src/validation/consolidation-evaluator.test.ts`

**Interfaces:**
- Consumes: `BacktestMetricBlock` (`src/ports/platform-gateway.port.ts`) — scalars `netPnlUsd, netPnlPct, totalTrades, winRate, profitFactor, maxDrawdownPct, expectancyUsd, sharpe, topTradeContributionPct`.
- Produces: `ConsolidationTolerances`, `DEFAULT_CONSOLIDATION_TOLERANCES`, `ConsolidationVerdict`, `evaluateConsolidation(accepted, clean, tol?)`.

- [ ] **Step 1: Write failing tests**

```ts
import { evaluateConsolidation, DEFAULT_CONSOLIDATION_TOLERANCES } from './consolidation-evaluator.ts';
const M = (o: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock => ({
  netPnlUsd: 100, netPnlPct: 10, totalTrades: 42, winRate: 0.6, profitFactor: 1.5,
  maxDrawdownPct: 3.2, expectancyUsd: 2.4, sharpe: 1.4, topTradeContributionPct: 12, ...o,
});
it('ACCEPTs exact parity', () => {
  expect(evaluateConsolidation(M(), M()).decision).toBe('ACCEPT');
});
it('REJECTs any trade-count change', () => {
  const v = evaluateConsolidation(M(), M({ totalTrades: 41 }));
  expect(v).toMatchObject({ decision: 'REJECT', reasons: ['trade_count_changed'] });
});
it('REJECTs winRate/profitFactor drift even when total/net/dd match (3 metrics are insufficient)', () => {
  const v = evaluateConsolidation(M(), M({ winRate: 0.7, profitFactor: 1.9 }));
  expect(v.decision).toBe('REJECT');
  expect(v.reasons).toContain('metric_divergence:winRate');
  expect(v.reasons).toContain('metric_divergence:profitFactor');
});
it('REJECTs an IMPROVEMENT (bar is "matched", not "not worse")', () => {
  expect(evaluateConsolidation(M(), M({ netPnlUsd: 500 })).decision).toBe('REJECT');
});
it('tolerates float-reassociation within epsilon', () => {
  expect(evaluateConsolidation(M({ netPnlUsd: 100 }), M({ netPnlUsd: 100.005 })).decision).toBe('ACCEPT');
});
it('skips a field absent from either block (no false REJECT)', () => {
  const a = { ...M() } as Record<string, number>; delete a.sharpe;
  expect(evaluateConsolidation(a as BacktestMetricBlock, M()).decision).toBe('ACCEPT');
});
```
Run: `pnpm vitest run src/validation/consolidation-evaluator.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement**

```ts
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

export interface ConsolidationTolerances { tolRel: number; tolAbs: number; }
export const DEFAULT_CONSOLIDATION_TOLERANCES: ConsolidationTolerances = { tolRel: 0.001, tolAbs: 0.01 };
export interface ConsolidationDelta { field: string; accepted: number; clean: number; }
export type ConsolidationVerdict =
  | { decision: 'ACCEPT'; reasons: ['parity_ok']; deltas: ConsolidationDelta[] }
  | { decision: 'REJECT'; reasons: string[]; deltas: ConsolidationDelta[] };

// Every scalar field except totalTrades (which must match EXACTLY).
const PARITY_FIELDS = [
  'netPnlUsd', 'netPnlPct', 'winRate', 'profitFactor', 'maxDrawdownPct',
  'expectancyUsd', 'sharpe', 'topTradeContributionPct',
] as const;

export function evaluateConsolidation(
  accepted: BacktestMetricBlock,
  clean: BacktestMetricBlock,
  tol: ConsolidationTolerances = DEFAULT_CONSOLIDATION_TOLERANCES,
): ConsolidationVerdict {
  if (clean.totalTrades !== accepted.totalTrades) {
    return { decision: 'REJECT', reasons: ['trade_count_changed'],
      deltas: [{ field: 'totalTrades', accepted: accepted.totalTrades, clean: clean.totalTrades }] };
  }
  const reasons: string[] = [];
  const deltas: ConsolidationDelta[] = [];
  for (const f of PARITY_FIELDS) {
    const a = (accepted as Record<string, unknown>)[f];
    const c = (clean as Record<string, unknown>)[f];
    if (typeof a !== 'number' || typeof c !== 'number') continue; // absent/undefined → skip
    const bound = Math.max(tol.tolAbs, tol.tolRel * Math.abs(a));
    if (Math.abs(c - a) > bound) { reasons.push(`metric_divergence:${f}`); deltas.push({ field: f, accepted: a, clean: c }); }
  }
  if (reasons.length) return { decision: 'REJECT', reasons, deltas };
  return { decision: 'ACCEPT', reasons: ['parity_ok'], deltas: [] };
}
```
Run tests → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/validation/consolidation-evaluator.ts src/validation/consolidation-evaluator.test.ts
git commit -m "feat(research): evaluateConsolidation strict full-block parity ladder"
```

---

### Task 4: `StrategyConsolidatorPort` + `FakeStrategyConsolidator`

**Files:**
- Create: `src/ports/strategy-consolidator.port.ts`
- Create: `src/adapters/consolidator/fake-strategy-consolidator.ts`
- Test: `src/adapters/consolidator/fake-strategy-consolidator.test.ts`

**Interfaces:**
- Consumes: `StrategyBuilderOutput`, `StrategyManifestMeta` (`src/ports/strategy-builder.port.ts`); `assembleStrategyBundle` (`src/domain/strategy-bundle.ts`).
- Produces: `StrategyConsolidateArgs`, `StrategyConsolidatorPort`, `FakeStrategyConsolidator`.

- [ ] **Step 1: Define the port**

```ts
import type { StrategyBuilderOutput, StrategyManifestMeta } from './strategy-builder.port.ts';
import type { AgentCallOpts } from './agent-call-opts.ts'; // the onUsage opts type lives here

export interface StrategyConsolidateArgs {
  readonly stackedSource: string;
  readonly manifestMeta: StrategyManifestMeta;
  readonly mergedRuleSet: Record<string, unknown>; // { order, rules, theses? } — intent, NOT license to add rules
  readonly theses?: Record<string, string>;
}
export interface StrategyConsolidatorPort {
  readonly adapter: string;
  readonly model: string;
  consolidate(args: StrategyConsolidateArgs, opts?: AgentCallOpts): Promise<StrategyBuilderOutput>;
}
```
(`AgentCallOpts` is exported from `src/ports/agent-call-opts.ts` — from a port file use `./agent-call-opts.ts`, from an adapter use `../../ports/agent-call-opts.ts`.)

- [ ] **Step 2: Write the failing test**

```ts
it('produces an assemblable single-module strategy output', async () => {
  const c = new FakeStrategyConsolidator();
  const out = await c.consolidate({ stackedSource: 'irrelevant', manifestMeta: SHORT_AFTER_PUMP_META, mergedRuleSet: { order: [], rules: [] } });
  const bundle = await assembleStrategyBundle(out); // throws if not self-contained
  expect(bundle.bundleHash).toMatch(/^sha256:/);
});
```
(Import `SHORT_AFTER_PUMP_META` from `src/adapters/builder/fake-strategy-builder.ts` if exported; else construct a minimal `StrategyManifestMeta`.)
Run → FAIL.

- [ ] **Step 3: Implement the fake**

Return a deterministic, self-contained strategy factory. Reuse the fixture source the fake builder already uses so it is guaranteed to assemble:
```ts
import type { StrategyConsolidatorPort, StrategyConsolidateArgs } from '../../ports/strategy-consolidator.port.ts';
import type { StrategyBuilderOutput } from '../../ports/strategy-builder.port.ts';
import { SHORT_AFTER_PUMP_SOURCE, SHORT_AFTER_PUMP_META } from '../builder/fake-strategy-builder.ts';

export class FakeStrategyConsolidator implements StrategyConsolidatorPort {
  readonly adapter = 'fake';
  readonly model = 'fake';
  async consolidate(args: StrategyConsolidateArgs): Promise<StrategyBuilderOutput> {
    // Deterministic passthrough: a clean, self-contained factory. Behavioral parity vs R is
    // decided by the equivalence backtest in the handler, not by this fake.
    return { source: SHORT_AFTER_PUMP_SOURCE, manifestMeta: args.manifestMeta ?? SHORT_AFTER_PUMP_META };
  }
}
```
(If `SHORT_AFTER_PUMP_SOURCE`/`_META` are not exported, export them from `fake-strategy-builder.ts` — additive.)
Run → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ports/strategy-consolidator.port.ts src/adapters/consolidator/fake-strategy-consolidator.ts src/adapters/consolidator/fake-strategy-consolidator.test.ts src/adapters/builder/fake-strategy-builder.ts
git commit -m "feat(research): StrategyConsolidatorPort + FakeStrategyConsolidator"
```

---

### Task 5: Mastra consolidator adapter + `buildConsolidator` + env knobs + wiring

**Files:**
- Create: `src/adapters/consolidator/mastra-strategy-consolidator.ts`
- Create: `src/mastra/agents/strategy-consolidator.agent.ts`
- Modify: `src/config/env.ts` (+ `src/config/env.test.ts`)
- Modify: `src/composition.ts` (`buildConsolidator` + wire)
- Modify: `src/orchestrator/app-services.ts` (add `consolidator`)
- Modify: `test/support/make-services.ts` (default `consolidator: null`)
- Test: `src/composition.consolidator.test.ts` (adapter selection)

**Interfaces:**
- Consumes: `resolveLanguageModel` (`src/adapters/llm/model-provider.ts`), `createStrategyBuilderAgent` pattern.
- Produces: `env.CONSOLIDATOR_ADAPTER: 'off'|'fake'|'mastra'`, `env.CONSOLIDATOR_MODEL: string`; `buildConsolidator(env, rt): StrategyConsolidatorPort | null`; `AppServices.consolidator: StrategyConsolidatorPort | null`.

- [ ] **Step 1: env knobs (test-first)**

In `src/config/env.test.ts` add: default `CONSOLIDATOR_ADAPTER` → `'off'`; `'mastra'`/`'fake'` pass through; `CONSOLIDATOR_MODEL` default present.
In `src/config/env.ts`: add to `Env` interface `CONSOLIDATOR_ADAPTER: 'off' | 'fake' | 'mastra';` and `CONSOLIDATOR_MODEL: string;`. In `loadEnv` (do NOT use the global `resolveAdapter` default — consolidation must be OFF unless explicitly enabled):
```ts
CONSOLIDATOR_ADAPTER: source.CONSOLIDATOR_ADAPTER === 'mastra' ? 'mastra' : source.CONSOLIDATOR_ADAPTER === 'fake' ? 'fake' : 'off',
CONSOLIDATOR_MODEL: source.CONSOLIDATOR_MODEL ?? 'openrouter/anthropic/claude-opus-4-8',
```
Run: `pnpm vitest run src/config/env.test.ts` → PASS.

- [ ] **Step 2: Mastra adapter + agent factory**

`src/mastra/agents/strategy-consolidator.agent.ts`: mirror `createStrategyBuilderAgent` — an `Agent` whose system prompt instructs: "Rewrite the given multi-module composed strategy into ONE flat, self-contained `export default function` factory with IDENTICAL behavior. Do NOT add, remove, or alter any rule/condition. No imports." Structured output = the same strategy LLM output schema the builder uses (`StrategyLlmOutputSchema`) → `llmToStrategyBuilderOutput`.
`src/adapters/consolidator/mastra-strategy-consolidator.ts`: a class `MastraStrategyConsolidator implements StrategyConsolidatorPort` with explicit fields (NO parameter properties):
```ts
export class MastraStrategyConsolidator implements StrategyConsolidatorPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;
  constructor(agent: Agent, label: string) { this.agent = agent; this.model = label; }
  async consolidate(args: StrategyConsolidateArgs, opts?: AgentCallOpts): Promise<StrategyBuilderOutput> {
    const userMsg = renderConsolidationPrompt(args); // stacked source + mergedRuleSet as reference
    const result = await this.agent.generate(userMsg, {
      structuredOutput: { schema: StrategyLlmOutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS }, // match MastraStrategyBuilder's constant
    });
    // Exact usage-reporting (token-budget kill-switch depends on this — NOT cosmetic):
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
    return llmToStrategyBuilderOutput(StrategyLlmOutputSchema.parse(result.object));
  }
}
```

- [ ] **Step 3: `buildConsolidator` + wiring**

In `src/composition.ts` (mirror `buildStrategyBuilder`):
```ts
export function buildConsolidator(env: ReturnType<typeof loadEnv>, rt: MastraRuntime): StrategyConsolidatorPort | null {
  if (env.CONSOLIDATOR_ADAPTER === 'mastra') {
    const resolved = resolveLanguageModel(env, env.CONSOLIDATOR_MODEL);
    return new MastraStrategyConsolidator(createStrategyConsolidatorAgent({ model: resolved.model }), resolved.label);
  }
  if (env.CONSOLIDATOR_ADAPTER === 'fake') return new FakeStrategyConsolidator();
  return null; // 'off' → consolidation disabled
}
```
Add `consolidator: StrategyConsolidatorPort | null;` to `AppServices` (near `strategyCritic`). In `composeRuntime`'s `services` object: `consolidator: buildConsolidator(env, mastraRuntime),`. In `make-services.ts`: `consolidator: overrides.consolidator ?? null,`.

- [ ] **Step 4: Adapter-selection test**

`src/composition.consolidator.test.ts`:
```ts
it('off by default; fake when CONSOLIDATOR_ADAPTER=fake', () => {
  expect(buildConsolidator(loadEnv({} as NodeJS.ProcessEnv), rt)).toBeNull();
  expect(buildConsolidator(loadEnv({ CONSOLIDATOR_ADAPTER: 'fake' } as unknown as NodeJS.ProcessEnv), rt)?.adapter).toBe('fake');
});
```
(Use the same `rt`/MastraRuntime stub other composition tests use.)
Run → PASS. `pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/consolidator/mastra-strategy-consolidator.ts src/mastra/agents/strategy-consolidator.agent.ts src/config/env.ts src/config/env.test.ts src/composition.ts src/composition.consolidator.test.ts src/orchestrator/app-services.ts test/support/make-services.ts
git commit -m "feat(research): mastra consolidator adapter + buildConsolidator seam (off by default)"
```

---

### Task 6: `strategy.baseline` ready-bundle mode + baseline-status writeback

**Files:**
- Modify: `src/orchestrator/handlers/strategy-baseline.handler.ts`
- Test: `src/orchestrator/handlers/strategy-baseline.handler.test.ts`

**Interfaces:**
- Consumes: `reconstructStrategyBundle(artifacts, ref)`, `services.revisions.updateStatus`, `runStrategyBaselineValidation({...}) -> { experimentId, verdict }`.
- Produces: `StrategyBaselinePayloadSchema` gains optional `bundleArtifactRef`, `consolidatedRevisionId`.

- [ ] **Step 1: Failing tests**

(a) When `bundleArtifactRef` is present, the handler does NOT call `strategyBuilder.build` and the resulting `bundleHash` equals the artifact's (stable/deterministic). (b) When `consolidatedRevisionId` is present, on completion the revision is patched: `baselineValidationStatus` mapped from `verdict`, `baselineExperimentId = experimentId`. Use `makeServices` with a spy `strategyBuilder.build` and an in-memory `revisions` seeded with a consolidated revision.
```ts
it('ready-bundle mode reconstructs the given bundle and skips the builder', async () => {
  const services = makeServices({ /* spy strategyBuilder.build to throw if called */ });
  const ref = await services.artifacts.put(JSON.stringify(persistedBundleJson), { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' });
  await strategyBaselineHandler(taskWith({ strategyProfileId: 'prof-1', bundleArtifactRef: ref }), services);
  // build never called; strategy.baseline.completed emitted with the artifact's bundleHash
});
it('patches consolidated revision baseline status on completion', async () => {
  // seed revisions with { id:'C', kind:'consolidated', baselineValidationStatus:'pending' }
  // run with payload.consolidatedRevisionId='C'; assert updated baselineValidationStatus + baselineExperimentId set
});
```
Run → FAIL.

- [ ] **Step 2: Implement**

Extend the schema:
```ts
export const StrategyBaselinePayloadSchema = z.object({
  strategyProfileId: z.string().min(1),
  sourceTaskId: z.string().optional(),
  bundleArtifactRef: z.custom<ArtifactRef>((v) => typeof v === 'object' && v !== null).optional(),
  consolidatedRevisionId: z.string().optional(),
});
```
Replace the build block with a branch:
```ts
let bundle: AssembledStrategyBundle;
let bundleArtifactRef: ArtifactRef;
if (parsed.data.bundleArtifactRef) {
  bundleArtifactRef = parsed.data.bundleArtifactRef;
  bundle = await reconstructStrategyBundle(services.artifacts, bundleArtifactRef);
} else {
  const out = await services.strategyBuilder.build({ spec: { description: `baseline validation for profile ${profile.id}` }, authoringDoc: getAuthoringDoc('strategy'), profile });
  bundle = await assembleStrategyBundle(out);
  bundleArtifactRef = await services.artifacts.put(JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }), { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'strategy-baseline-handler' });
}
```
After `const { experimentId, verdict } = await services.experimentService.runStrategyBaselineValidation({...})` and before/after the wfo enqueue, add the writeback. **First read the actual `verdict` literal union from `runStrategyBaselineValidation`'s return type** and map by rule: a PASS-equivalent → `'passed'`, an INCONCLUSIVE-equivalent → `'inconclusive'`, anything else (FAIL/error) → `'failed'`:
```ts
if (parsed.data.consolidatedRevisionId) {
  const baselineValidationStatus = verdict === 'PASS' ? 'passed' : verdict === 'INCONCLUSIVE' ? 'inconclusive' : 'failed';
  await services.revisions.updateStatus(parsed.data.consolidatedRevisionId, { baselineValidationStatus, baselineExperimentId: experimentId, baselineTaskId: task.id, updatedAt: new Date().toISOString() });
}
```
(Adjust the `'PASS'`/`'INCONCLUSIVE'` literals to the real enum found in step 2.)
Run tests → PASS. `pnpm typecheck` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/handlers/strategy-baseline.handler.ts src/orchestrator/handlers/strategy-baseline.handler.test.ts
git commit -m "feat(research): strategy.baseline ready-bundle mode + consolidated baseline-status writeback"
```

---

### Task 7: `revision.build` — write compositionDepth + enqueue `revision.consolidate` trigger

**Files:**
- Modify: `src/orchestrator/handlers/revision-build.handler.ts`
- Modify: `src/config/env.ts` (+ `env.test.ts`)
- Modify: `src/orchestrator/app-services.ts` (+ `make-services.ts`)
- Test: `src/orchestrator/handlers/revision-build.handler.test.ts` (add trigger + depth cases)

**Interfaces:**
- Consumes: `services.consolidator`, `services.consolidationDepthThreshold`, `createAndEnqueueTask`.
- Produces: `env.LAB_CONSOLIDATION_DEPTH_THRESHOLD: number`; `AppServices.consolidationDepthThreshold: number`.

- [ ] **Step 1: env + services knob**

`env.ts`: first add a `parseNonNegativeInt(value, fallback)` helper next to `parsePositiveInt` — `const n = Number(value); return Number.isInteger(n) && n >= 0 ? n : fallback;` — because `parsePositiveInt` requires `n > 0` and would coerce the `0` kill-switch to fallback `2`. Then `Env` += `LAB_CONSOLIDATION_DEPTH_THRESHOLD: number;`; `loadEnv` += `LAB_CONSOLIDATION_DEPTH_THRESHOLD: parseNonNegativeInt(source.LAB_CONSOLIDATION_DEPTH_THRESHOLD, 2),`. `env.test.ts`: default → 2; `'3'` → 3; **`'0'` → 0** (kill-switch honored); invalid/empty → 2. `AppServices` += `consolidationDepthThreshold: number;`. `make-services.ts`: `consolidationDepthThreshold: overrides.consolidationDepthThreshold ?? 0,` (0 = disabled in tests unless opted in). `composeRuntime`: `consolidationDepthThreshold: env.LAB_CONSOLIDATION_DEPTH_THRESHOLD,`.

- [ ] **Step 2: Write compositionDepth on new revisions**

In `revision-build.handler.ts`: bootstrap create (`bootstrapFromBaseline`) sets `kind: 'composed', compositionDepth: 1, semanticParentRevisionId: undefined`. The Step-7 candidate `revision` object sets `kind: 'composed'`, `compositionDepth: (accepted.compositionDepth ?? 1) + 1`, `semanticParentRevisionId: accepted.id`.

- [ ] **Step 3: Trigger enqueue on accept (failing test first)**

Test: an accepted composed revision at `compositionDepth >= threshold` enqueues one `revision.consolidate` task (dedupeKey `revision.consolidate:${revisionId}`) ONLY when `services.consolidator` is non-null and `threshold > 0`; below threshold, or `consolidator=null`, or `threshold=0` → not enqueued.
```ts
it('enqueues revision.consolidate when the accepted revision reaches the depth threshold', async () => {
  const enqueued: string[] = [];
  const services = makeServices({ consolidator: new FakeStrategyConsolidator(), consolidationDepthThreshold: 2, taskQueue: recordingQueue(enqueued) });
  // seed accepted base at compositionDepth 1, eligible hypotheses so the new revision is depth 2 and ACCEPTs
  await revisionBuildHandler(task, services);
  expect(enqueued).toContain('revision.consolidate');
});
it('does not enqueue when consolidator is null or threshold is 0', async () => { /* both variants → no revision.consolidate */ });
```
Run → FAIL.

- [ ] **Step 4: Implement the trigger**

Immediately AFTER the `revision.accepted` event append (the `verdict.decision === 'ACCEPT'` branch), add:
```ts
const newDepth = (accepted.compositionDepth ?? 1) + 1;
if (services.consolidator !== null && services.consolidationDepthThreshold > 0 && newDepth >= services.consolidationDepthThreshold) {
  await createAndEnqueueTask(
    { taskType: 'revision.consolidate', source: task.source, payload: { revisionId, strategyProfileId }, correlationId: task.correlationId, dedupeKey: `revision.consolidate:${revisionId}` },
    { repo: services.researchTasks, queue: services.taskQueue },
  );
}
```
Run trigger tests → PASS. Run the full existing `revision-build.handler.test.ts` → still green (default make-services `consolidationDepthThreshold: 0` keeps old tests inert). `pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/revision-build.handler.ts src/config/env.ts src/config/env.test.ts src/orchestrator/app-services.ts test/support/make-services.ts src/orchestrator/handlers/revision-build.handler.test.ts
git commit -m "feat(research): revision.build writes compositionDepth + enqueues revision.consolidate at threshold"
```

---

### Task 8: `revision.consolidate` handler — guards, run-context, parity gate, reject paths

**Files:**
- Create: `src/orchestrator/handlers/revision-consolidate.handler.ts`
- Modify: `src/domain/schemas.ts` (append `'revision.consolidate'` to `AGENT_TASK_TYPES`)
- Modify: `src/composition.ts` (`router.register('revision.consolidate', revisionConsolidateHandler)`)
- Modify: `src/ports/strategy-revision-run-executor.ts` (`label` union += `'consolidation'`)
- Modify: `src/config/env.ts` (+ `env.test.ts`) — tolerance knobs
- Modify: `src/orchestrator/app-services.ts` (+ `make-services.ts`) — `consolidationTolerances`
- Test: `src/orchestrator/handlers/revision-consolidate.handler.test.ts`

**Interfaces:**
- Consumes: `services.{revisions, strategyBacktests, artifacts, consolidator, revisionRunExecutor, consolidationTolerances, events, researchTasks, taskQueue}`; `reconstructStrategyBundle`, `assembleStrategyBundle`, `validateStrategyBundle`, `evaluateConsolidation`, `RESEARCH_RUN_METRICS`.
- Produces: `RevisionConsolidatePayloadSchema`, `revisionConsolidateHandler`; env `LAB_CONSOLIDATION_TOL_REL`/`LAB_CONSOLIDATION_TOL_ABS`; `AppServices.consolidationTolerances`.

- [ ] **Step 1: task-type + label + tolerance plumbing**

`schemas.ts`: append `'revision.consolidate'` to `AGENT_TASK_TYPES`. `strategy-revision-run-executor.ts`: `label: 'candidate' | 'comparison_baseline' | 'consolidation'` — the label is **diagnostic only**. NOTE (dedup identity, for the retry tests in Step 2): `BacktesterRevisionRunExecutor` dedups a COMPLETED run by `(strategyBundleId, paramsHash, bundleHash)`; `revisionId`/`label` ride the `resumeToken`, NOT the lookup. So the consolidation run's identity is the clean bundle's `bundleHash` — a genuinely-consolidated clean source (new bundleHash) always runs fresh, while an LLM that returned the SAME divergent bundle honestly reuses that completed run and rejects again (still fail-safe). Tests therefore drive parity via the injected `revisionRunExecutor` metrics, not by assuming a fresh submit per label. `env.ts`: `LAB_CONSOLIDATION_TOL_REL: parseFloatOr(source.LAB_CONSOLIDATION_TOL_REL, 0.001)`, `LAB_CONSOLIDATION_TOL_ABS: parseFloatOr(source.LAB_CONSOLIDATION_TOL_ABS, 0.01)` (+ `Env` fields + defaults test). `AppServices` += `consolidationTolerances: ConsolidationTolerances;`. `make-services.ts`: `consolidationTolerances: overrides.consolidationTolerances ?? DEFAULT_CONSOLIDATION_TOLERANCES,`. `composeRuntime`: `consolidationTolerances: { tolRel: env.LAB_CONSOLIDATION_TOL_REL, tolAbs: env.LAB_CONSOLIDATION_TOL_ABS },`.

- [ ] **Step 2: Failing tests (reject/guard paths)**

Seed a consolidatable accepted composed revision R (`comboBacktestRunId` → a `strategyBacktests` row with a non-null `platformRun` and `R.metrics`). Provide `consolidator` and a `revisionRunExecutor` whose `execute` returns controllable metrics. Assert, per case, that R stays `accepted`, no consolidated revision is created, no `strategy.baseline` enqueued, and the right event fires:
- `already_consolidated`: pre-seed a consolidated child → `revision.consolidation_skipped {reason:'already_consolidated'}`, consolidator NOT called.
- not accepted / not composed / no bundleArtifactRef → `revision.consolidation_skipped {reason:'not_consolidatable'}`.
- `comboBacktestRunId` missing OR its row `platformRun` null → `revision.consolidation_rejected {reason:'missing_run_context'}`; NO fallback to defaultPlatformRun.
- consolidator output fails `validateStrategyBundle` → `..._rejected {reason:'bundle_invalid'}`.
- equivalence run metrics diverge (executor returns different totalTrades) → `..._rejected` with `metric`/`trade_count` reasons + deltas; R still `accepted`.
- rejected is retryable: after a divergent reject, a second handler invocation with an equivalent executor proceeds (consolidator/executor called again).
Run → FAIL.

- [ ] **Step 3: Implement the handler skeleton**

```ts
export const RevisionConsolidatePayloadSchema = z.object({
  revisionId: z.string().min(1),
  strategyProfileId: z.string().min(1),
});
const now = (): string => new Date().toISOString();

export const revisionConsolidateHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(RevisionConsolidatePayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid revision.consolidate payload: ${JSON.stringify(parsed.issues)}`);
  const { revisionId, strategyProfileId } = parsed.data;
  const reject = async (reason: string, extra: Record<string, unknown> = {}) => {
    await services.events.append(event(task.id, 'revision.consolidation_rejected', { fromRevisionId: revisionId, reason, ...extra }));
  };

  // Idempotency (retryable fail-safe): no-op only if R is already consolidated.
  if (await services.revisions.findConsolidatedOf(revisionId)) {
    await services.events.append(event(task.id, 'revision.consolidation_skipped', { revisionId, reason: 'already_consolidated' }));
    return;
  }
  const R = await services.revisions.findById(revisionId);
  if (!R || R.status !== 'accepted' || (R.kind ?? 'composed') !== 'composed' || !R.bundleArtifactRef) {
    await services.events.append(event(task.id, 'revision.consolidation_skipped', { revisionId, reason: 'not_consolidatable' }));
    return;
  }
  // Run-context = the ACTUAL combo run's platformRun (source of truth; no default fallback).
  if (!R.comboBacktestRunId || !R.metrics) { await reject('missing_run_context'); return; }
  const comboRun = await services.strategyBacktests.findById(R.comboBacktestRunId);
  const ctx = comboRun?.platformRun ?? null;
  if (!comboRun || !ctx) { await reject('missing_run_context'); return; }

  const stacked = await reconstructStrategyBundle(services.artifacts, R.bundleArtifactRef);
  if (!services.consolidator) { await reject('consolidator_disabled'); return; }
  let out;
  try {
    out = await services.consolidator.consolidate({
      stackedSource: stacked.source, manifestMeta: stacked.manifest as StrategyManifestMeta,
      mergedRuleSet: R.mergedRuleSet, theses: (R.mergedRuleSet as { theses?: Record<string, string> }).theses,
    });
  } catch (err) { await reject('consolidator_error', { detail: errMsg(err) }); return; }

  const assembled = await assembleStrategyBundle(out);
  if (validateStrategyBundle(assembled).status === 'rejected') { await reject('bundle_invalid'); return; }

  const cleanRun = await services.revisionRunExecutor.execute({
    revisionId: R.id, label: 'consolidation', strategyBundle: assembled, strategyProfileId,
    run: ctx, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
  });
  if (cleanRun.status !== 'completed' || !cleanRun.metrics) { await reject('consolidation_run_unavailable'); return; }

  const verdict = evaluateConsolidation(R.metrics as unknown as BacktestMetricBlock, cleanRun.metrics, services.consolidationTolerances);
  if (verdict.decision === 'REJECT') { await reject(verdict.reasons.join(','), { reasons: verdict.reasons, deltas: verdict.deltas }); return; }

  // ACCEPT path → Task 9 fills this in.
  await acceptConsolidation(task, services, { R, assembled, cleanRun }); // stub throwing 'not_implemented' until Task 9
};
```
Register in `composition.ts`. Run reject/guard tests → PASS (the ACCEPT stub is never reached by these cases). `pnpm typecheck` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/handlers/revision-consolidate.handler.ts src/domain/schemas.ts src/composition.ts src/ports/strategy-revision-run-executor.ts src/config/env.ts src/config/env.test.ts src/orchestrator/app-services.ts test/support/make-services.ts src/orchestrator/handlers/revision-consolidate.handler.test.ts
git commit -m "feat(research): revision.consolidate handler — guards, run-context, parity gate, fail-safe rejects"
```

---

### Task 9: `revision.consolidate` accept path — materialize + re-baseline

**Files:**
- Modify: `src/orchestrator/handlers/revision-consolidate.handler.ts` (`acceptConsolidation`)
- Test: `src/orchestrator/handlers/revision-consolidate.handler.test.ts` (happy + Style-A + baseline enqueue)

**Interfaces:**
- Consumes: `services.revisions.create`, `createAndEnqueueTask`, `services.artifacts.put`.
- Produces: `revision.consolidated` event; a `kind:'consolidated'` revision; an enqueued ready-bundle `strategy.baseline`.

- [ ] **Step 1: Failing tests**

Equivalent consolidation (executor returns metrics == R.metrics) →
(a) a consolidated revision exists with `kind:'consolidated'`, `baseRevisionId=consolidatedFromRevisionId=semanticParentRevisionId=R.id`, `compositionDepth=1`, `version=R.version+1`, `status='accepted'`, `baselineValidationStatus='pending'`, and `hypothesisIds`/`mergedRuleSet` **deep-equal R's** (verbatim);
(b) exactly one `strategy.baseline` task enqueued with `payload.bundleArtifactRef` set and `payload.consolidatedRevisionId` = the new id;
(c) `revision.consolidated` event emitted;
(d) **Style-A**: seed R whose `dropped` contains an `unsupported_module_shape` hypothesis NOT in `hypothesisIds` → the consolidated revision's `hypothesisIds` still equals R's (the dropped Style-A id is absent — not rescued).
Run → FAIL (accept stub throws).

- [ ] **Step 2: Implement `acceptConsolidation`**

```ts
async function acceptConsolidation(task, services, { R, assembled, cleanRun }): Promise<void> {
  const cleanRef = await services.artifacts.put(
    JSON.stringify({ source: assembled.source, manifest: assembled.manifest, bundleHash: assembled.bundleHash }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'revision-consolidate-handler' },
  );
  const newId = randomUUID();
  const consolidated: StrategyRevision = {
    id: newId, strategyProfileId: R.strategyProfileId, version: R.version + 1,
    baseRevisionId: R.id, kind: 'consolidated', consolidatedFromRevisionId: R.id, semanticParentRevisionId: R.id,
    hypothesisIds: [...R.hypothesisIds], mergedRuleSet: R.mergedRuleSet,
    bundleArtifactRef: cleanRef, bundleHash: assembled.bundleHash,
    comboBacktestRunId: cleanRun.runId, metrics: cleanRun.metrics as unknown as Record<string, unknown>,
    compositionDepth: 1, status: 'accepted', baselineValidationStatus: 'pending',
    verdictReason: 'consolidated_parity_ok', createdAt: now(), updatedAt: now(),
  };
  try { await services.revisions.create(consolidated); }
  catch (err) { await services.events.append(event(task.id, 'revision.consolidation_skipped', { revisionId: R.id, reason: 'concurrent_revision', detail: errMsg(err) })); return; }
  await createAndEnqueueTask(
    { taskType: 'strategy.baseline', source: task.source, payload: { strategyProfileId: R.strategyProfileId, bundleArtifactRef: cleanRef, consolidatedRevisionId: newId }, correlationId: task.correlationId, dedupeKey: `strategy.baseline:consolidated:${newId}` },
    { repo: services.researchTasks, queue: services.taskQueue },
  );
  await services.events.append(event(task.id, 'revision.consolidated', { fromRevisionId: R.id, newRevisionId: newId, version: consolidated.version, bundleHash: assembled.bundleHash }));
}
```
Replace the Task-8 stub call with this implementation. Run happy + Style-A tests → PASS. Run the FULL `revision-consolidate.handler.test.ts` (reject + accept) → green. `pnpm typecheck` → clean.

- [ ] **Step 3: Full-suite gate + commit**

Run: `pnpm test` → all green (record pass count).
```bash
git add src/orchestrator/handlers/revision-consolidate.handler.ts src/orchestrator/handlers/revision-consolidate.handler.test.ts
git commit -m "feat(research): revision.consolidate accept path — materialize consolidated revision + re-baseline"
```

---

## Self-Review

**Spec coverage:**
- §1 main invariant → Task 3 (parity REJECTs any change) + Task 8/9 fail-safe. ✅
- §2 depth trigger → Task 2 (field) + Task 7 (write + enqueue). ✅
- §3 additive fields → Task 2. ✅
- §4 handler flow (run-context source-of-truth, consolidate, assemble, parity, reject, accept) → Tasks 8+9. ✅
- §5 StrategyConsolidatorPort → Tasks 4+5. ✅
- §6 evaluateConsolidation full-block parity → Task 3. ✅
- §7 ready-bundle re-baseline + writeback (enum, baseline_experiment_id) → Task 6. ✅
- §8 lineage/inheritance (kind, links, verbatim inherit, semanticParent=R.id) → Task 9 + Task 2. ✅
- §9 fail-safe matrix → Task 8 reject helper covers every reason. ✅
- §10 orchestration (task type, register, kill-switch) → Tasks 7 (trigger/kill-switch) + 8 (register/schemas). ✅
- §11 tests → each task's test steps map 1:1. ✅
- §13 prerequisite (platformRun persistence) → Task 1. ✅

**Placeholder scan:** One deliberate lookup remains — the baseline `verdict` literal union in Task 6 Step 2 (map rule fully specified: PASS→passed, INCONCLUSIVE→inconclusive, else→failed; implementer reads the exact enum). All imports (incl. `AgentCallOpts` → `src/ports/agent-call-opts.ts`), the `parseNonNegativeInt` helper, exact `onUsage` reporting, and the run-executor dedup identity are now spelled out. No other TBDs.

**Type consistency:** `evaluateConsolidation(accepted, clean, tol)` arg order consistent across Task 3 and Task 8. `StrategyConsolidatorPort.consolidate(args, opts?)` consistent Tasks 4/5/8. `consolidationDepthThreshold`/`consolidationTolerances`/`consolidator` names consistent across AppServices, make-services, composeRuntime, Tasks 5/7/8. `label:'consolidation'` added in Task 8 before first use. `findConsolidatedOf` consistent Tasks 2/8. Revision field names (`compositionDepth`, `consolidatedFromRevisionId`, `semanticParentRevisionId`, `baselineValidationStatus`, `baselineExperimentId`, `baselineTaskId`) consistent across domain, schema, repo, Tasks 6/7/9.
