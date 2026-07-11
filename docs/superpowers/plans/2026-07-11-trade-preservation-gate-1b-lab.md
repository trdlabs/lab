# Trade-Preservation Gate — Slice 1b-lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the trade-preservation veto into the trading-lab **hypothesis proxy lane** by consuming the backtester's new `baseline-trades` artifact, so a gamed hypothesis is downgraded at proxy time (PASS/PAPER_CANDIDATE → MODIFY/INCONCLUSIVE).

**Architecture:** Add `RunTradesPort.getBaselineRunTrades(comparisonRunId)` to fetch the baseline leg's trades from the comparison run's manifest (via the existing generic SDK client, keyed on the `baseline-trades` artifactType — no SDK re-pin). A new `applyBacktestPreservationGate` wrapper reuses the pure `evaluateTradePreservation` (slice 1a). Wire it into `finalizeBacktestCompletion` with lazy fetch + fail-open + lane-namespaced skip events, persist to a new `evaluation.preservation_gate` column, and retrofit the slice-1a revision lane to fail-open too.

**Tech Stack:** TypeScript (node `--experimental-strip-types`), Vitest, Drizzle ORM (Postgres), pnpm. This is the `lab` repo only.

**Spec:** `docs/superpowers/specs/2026-07-11-trade-preservation-gate-1b-design.md` §4–6 (lab side). The backtester half (slice 1b-backtester) is **MERGED** — the running backtester (once redeployed) emits a `baseline-trades` artifact on comparison runs and `ARTIFACT_CONTRACT_VERSION` is `022.2`. Slice 1a (revision lane) is MERGED.

## Global Constraints

- **No TS parameter properties** (`constructor(private x)`) — breaks under `--experimental-strip-types`; declare fields explicitly.
- **Import paths carry the `.ts` extension** (e.g. `from './evaluator.ts'`).
- **Tests:** `pnpm test <path>` (vitest run). Typecheck: `pnpm typecheck`. Convention: `import { describe, it, expect } from 'vitest'`, colocated `*.test.ts`.
- **artifactType value:** `'baseline-trades'` — declare a lab-side named const `BASELINE_TRADES` (same literal the backtester uses); never inline the bare string.
- **`getBaselineRunTrades` returns `TradeRecord[] | null`:** descriptor **absent → `null`** (comparison/feature unavailable → gate skips); present → parsed array (possibly `[]` = baseline genuinely zero trades).
- **Veto is downgrade-only:** PASS/PAPER_CANDIDATE → (EOD)`INCONCLUSIVE` / (abstention|winner)`MODIFY`. Never upgrades; never touches a would-fail verdict.
- **fail-open + lane-namespaced events:** on any trade-fetch failure the gate is SKIPPED, the aggregate verdict stands, and `preservation_gate` stays **NULL** (never `fired:false`). Event `evaluation.preservation_skipped` (hypothesis lane) / `revision.preservation_skipped` (revision lane), each with `reason: 'artifact_unavailable' | 'fetch_failed'`. Absent-artifact = `artifact_unavailable`; exception = `fetch_failed`.
- **Kill-switch:** `services.preservationGateEnabled=false` → no preservation trade fetches on the proxy lane.
- **Reuse slice-1a config:** `services.preservationGateEnabled`, `services.preservationThresholds` (already on `AppServices`), and `applyRevisionPreservationGate`/`evaluateTradePreservation`/`PreservationMetadata`/`PreservationAggregates`/`PreservationThresholds` from `src/validation/`.
- **No SDK re-pin.** lab keeps `@trading-backtester/sdk` v0.7.0; reads the new artifact via the generic client. Task 6 locks version tolerance.

---

### Task 1: `getBaselineRunTrades` port method + adapters

**Files:**
- Modify: `src/ports/run-trades.port.ts`
- Modify: `src/adapters/platform/http-backtester.adapter.ts` (add `BASELINE_TRADES` const + method on `HttpBacktesterRunTradesAdapter`, ~line 449)
- Modify: `src/adapters/platform/fake-run-trades.adapter.ts`
- Modify: `src/adapters/platform/mock-run-trades.adapter.ts`
- Test: `src/adapters/platform/http-backtester-run-trades.test.ts` (existing); `src/adapters/platform/fake-run-trades.adapter.test.ts` (new, small)

**Interfaces:**
- Consumes: `TradeRecord` (`src/domain/research-experiment.ts`, has `closeReason?`), the client's `getArtifactManifest(runId)` + `readArtifact(runId, contentHash, {offset,limit})`.
- Produces: `RunTradesPort.getBaselineRunTrades(comparisonRunId: string): Promise<TradeRecord[] | null>`; exported `const BASELINE_TRADES = 'baseline-trades'`.

- [ ] **Step 1: Write the failing test** — append to `src/adapters/platform/http-backtester-run-trades.test.ts`:

```ts
it('getBaselineRunTrades reads the baseline-trades descriptor (with closeReason)', async () => {
  const client = fakeClientReturningRows(
    [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -5, closeReason: 'end_of_data' }],
    'baseline-trades', // artifactType the fake manifest should expose
  );
  const trades = await new HttpBacktesterRunTradesAdapter(client).getBaselineRunTrades('cmp-run');
  expect(trades).not.toBeNull();
  expect(trades![0]!.closeReason).toBe('end_of_data');
});

it('getBaselineRunTrades returns null when no baseline-trades descriptor exists (old backtester)', async () => {
  const client = fakeClientReturningRows([], 'trades'); // only a 'trades' descriptor, no baseline-trades
  const trades = await new HttpBacktesterRunTradesAdapter(client).getBaselineRunTrades('cmp-run');
  expect(trades).toBeNull();
});
```

The file already has a fake-client helper for `getRunTrades` tests. Extend it (or add `fakeClientReturningRows(rows, artifactType)`) so the returned manifest's descriptor carries the given `artifactType` (default `'trades'`) and `availability: 'available'`, and `readArtifact` returns `{ page: rows, total: rows.length }`. Mirror the existing helper's shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/adapters/platform/http-backtester-run-trades.test.ts`
Expected: FAIL — `getBaselineRunTrades` is not a function.

- [ ] **Step 3: Add the port method**

`src/ports/run-trades.port.ts`:
```ts
import type { TradeRecord } from '../domain/research-experiment.ts';

export interface RunTradesPort {
  /** Fetch the per-trade records for a completed backtest run (paged + parsed). */
  getRunTrades(runId: string): Promise<TradeRecord[]>;
  /**
   * Fetch the BASELINE leg's per-trade records from a comparison run's manifest.
   * `comparisonRunId` is the variant/headline run id (the manifest is keyed by it).
   * Returns null when the run carries no baseline-trades artifact (non-comparison run or
   * a backtester too old to emit it) — the caller treats null as "feature unavailable".
   */
  getBaselineRunTrades(comparisonRunId: string): Promise<TradeRecord[] | null>;
}
```

- [ ] **Step 4: Implement on the http adapter**

In `src/adapters/platform/http-backtester.adapter.ts`, add the const near `parseTrade` and the method inside `HttpBacktesterRunTradesAdapter` (right after `getRunTrades`):
```ts
/** Backtester artifact type for the baseline leg's per-trade records on a comparison run (slice 1b). */
export const BASELINE_TRADES = 'baseline-trades';
```
```ts
  async getBaselineRunTrades(comparisonRunId: string): Promise<TradeRecord[] | null> {
    const manifest = await this.client.getArtifactManifest(comparisonRunId);
    const desc = manifest.descriptors.find(
      (d) => d.artifactType === BASELINE_TRADES && d.availability === 'available',
    );
    if (!desc) return null; // absent descriptor = comparison/feature unavailable

    const out: TradeRecord[] = [];
    let offset = 0;
    const limit = 500;
    for (;;) {
      const pageRes = await this.client.readArtifact(comparisonRunId, desc.contentHash, { offset, limit });
      for (const row of pageRes.page) out.push(parseTrade(row));
      const consumed = offset + pageRes.page.length;
      if (pageRes.page.length === 0 || consumed >= pageRes.total) break;
      offset = consumed;
    }
    return out;
  }
```

- [ ] **Step 5: Implement on the fake + mock adapters**

`src/adapters/platform/fake-run-trades.adapter.ts` — add a separate `baselineByRun` map (do NOT reuse `byRun`):
```ts
export class FakeRunTradesAdapter implements RunTradesPort {
  private readonly byRun: Map<string, TradeRecord[]>;
  private readonly baselineByRun: Map<string, TradeRecord[]>;
  constructor(byRun: Record<string, TradeRecord[]> = {}, baselineByRun: Record<string, TradeRecord[]> = {}) {
    this.byRun = new Map(Object.entries(byRun));
    this.baselineByRun = new Map(Object.entries(baselineByRun));
  }
  async getRunTrades(runId: string): Promise<TradeRecord[]> {
    return this.byRun.get(runId) ?? [];
  }
  async getBaselineRunTrades(comparisonRunId: string): Promise<TradeRecord[] | null> {
    return this.baselineByRun.has(comparisonRunId) ? this.baselineByRun.get(comparisonRunId)! : null;
  }
}
```

`src/adapters/platform/mock-run-trades.adapter.ts` — mock has no artifacts:
```ts
  async getBaselineRunTrades(): Promise<TradeRecord[] | null> {
    return null;
  }
```

- [ ] **Step 6: Add the fake-adapter test** — create `src/adapters/platform/fake-run-trades.adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeRunTradesAdapter } from './fake-run-trades.adapter.ts';

describe('FakeRunTradesAdapter.getBaselineRunTrades', () => {
  it('returns seeded baseline trades from the separate baselineByRun map', async () => {
    const a = new FakeRunTradesAdapter(
      { 'cmp-run': [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 3 }] },
      { 'cmp-run': [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -9 }] },
    );
    expect(await a.getBaselineRunTrades('cmp-run')).toEqual([{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -9 }]);
  });
  it('returns null (not []) for an unknown run', async () => {
    expect(await new FakeRunTradesAdapter().getBaselineRunTrades('nope')).toBeNull();
  });
});
```

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm test src/adapters/platform/http-backtester-run-trades.test.ts src/adapters/platform/fake-run-trades.adapter.test.ts && pnpm typecheck`
Expected: PASS; no type errors. (Existing `new FakeRunTradesAdapter({...})` call sites still compile — the second ctor arg is optional.)

- [ ] **Step 8: Commit**

```bash
git add src/ports/run-trades.port.ts src/adapters/platform/http-backtester.adapter.ts src/adapters/platform/fake-run-trades.adapter.ts src/adapters/platform/mock-run-trades.adapter.ts src/adapters/platform/http-backtester-run-trades.test.ts src/adapters/platform/fake-run-trades.adapter.test.ts
git commit -m "feat(preservation): getBaselineRunTrades(comparisonRunId) on RunTradesPort + adapters"
```

---

### Task 2: `applyBacktestPreservationGate` wrapper

**Files:**
- Modify: `src/validation/apply-preservation-gate.ts`
- Test: `src/validation/apply-preservation-gate.test.ts` (existing — add cases)

**Interfaces:**
- Consumes: `EvaluationOutcome` (`src/validation/evaluator.ts` — `{ decision: EvaluationDecision, reasons: string[] }`); `evaluateTradePreservation`, `PreservationAggregates`, `PreservationThresholds`, `PreservationMetadata` (`src/validation/trade-preservation.ts`).
- Produces: `interface BacktestGateResult { outcome: EvaluationOutcome; preservation: PreservationMetadata | null }`; `function applyBacktestPreservationGate(outcome, baselineTrades, variantTrades, agg, thresholds): BacktestGateResult`.

- [ ] **Step 1: Write the failing tests** — append to `src/validation/apply-preservation-gate.test.ts`:

```ts
import { applyBacktestPreservationGate } from './apply-preservation-gate.ts';
import type { EvaluationOutcome } from './evaluator.ts';

const pass: EvaluationOutcome = { decision: 'PASS', reasons: ['positive_edge'] };
function trB(over: Partial<TradeRecord> = {}): TradeRecord {
  return { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 40, ...over };
}

it('downgrades PASS to MODIFY on winner_degradation', () => {
  const base = [trB({ entryTs: 1 }), trB({ entryTs: 2 }), trB({ entryTs: 3 }), trB({ entryTs: 4 })]; // 4 winners gross 160
  const variant = [trB({ entryTs: 1 })]; // contribution 40 < 0.9*160
  const r = applyBacktestPreservationGate(pass, base, variant, agg(160, 4, 40, 1), T);
  expect(r.outcome.decision).toBe('MODIFY');
  expect(r.outcome.reasons).toContain('winner_degradation');
});

it('downgrades PAPER_CANDIDATE to INCONCLUSIVE on end_of_data_position', () => {
  const paperCand: EvaluationOutcome = { decision: 'PAPER_CANDIDATE', reasons: ['strong_robust_edge'] };
  const base = [trB({ realizedPnl: -5 })];
  const variant = [trB({ realizedPnl: -5, entryTs: 100 }), trB({ entryTs: 999, realizedPnl: 60, closeReason: 'end_of_data' })];
  const r = applyBacktestPreservationGate(paperCand, base, variant, agg(-5, 1, 55, 2), T); // totalDelta 60, eodDelta 60
  expect(r.outcome.decision).toBe('INCONCLUSIVE');
  expect(r.outcome.reasons).toContain('end_of_data_position');
});

it('leaves a would-accept verdict untouched when nothing fires', () => {
  const base = [trB({ realizedPnl: 10 }), trB({ realizedPnl: 10 }), trB({ realizedPnl: 10 })];
  const variant = [trB({ realizedPnl: 12 }), trB({ realizedPnl: 12 }), trB({ realizedPnl: 12 })];
  const r = applyBacktestPreservationGate(pass, base, variant, agg(30, 3, 36, 3), T);
  expect(r.outcome).toEqual(pass);
  expect(r.preservation?.fired).toBe(false);
});

it('never touches a non-would-accept verdict and does no trade work', () => {
  const modify: EvaluationOutcome = { decision: 'MODIFY', reasons: ['drawdown_regression'] };
  const r = applyBacktestPreservationGate(modify, [], [], agg(0, 0, 0, 0), T);
  expect(r.outcome).toBe(modify);
  expect(r.preservation).toBeNull();
});
```

(`T`, `agg`, `TradeRecord` import already exist in this test file from slice 1a — reuse them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/validation/apply-preservation-gate.test.ts`
Expected: FAIL — `applyBacktestPreservationGate` not exported.

- [ ] **Step 3: Implement the wrapper** — add to `src/validation/apply-preservation-gate.ts`:

```ts
import type { EvaluationOutcome } from './evaluator.ts';

export interface BacktestGateResult {
  outcome: EvaluationOutcome;
  preservation: PreservationMetadata | null;
}

const BACKTEST_VETO_DECISION = {
  end_of_data_position: 'INCONCLUSIVE',
  abstention_gaming: 'MODIFY',
  winner_degradation: 'MODIFY',
} as const;

/**
 * Downgrade-only preservation veto for the hypothesis proxy lane. Evaluates trades only when the
 * incoming verdict is would-accept (PASS or PAPER_CANDIDATE). A fired veto downgrades:
 * end_of_data_position → INCONCLUSIVE, abstention_gaming/winner_degradation → MODIFY. Never upgrades.
 */
export function applyBacktestPreservationGate(
  outcome: EvaluationOutcome,
  baselineTrades: TradeRecord[],
  variantTrades: TradeRecord[],
  agg: PreservationAggregates,
  thresholds: PreservationThresholds,
): BacktestGateResult {
  if (outcome.decision !== 'PASS' && outcome.decision !== 'PAPER_CANDIDATE') {
    return { outcome, preservation: null };
  }
  const preservation = evaluateTradePreservation(baselineTrades, variantTrades, agg, thresholds);
  if (!preservation.fired) return { outcome, preservation };
  return {
    outcome: { decision: BACKTEST_VETO_DECISION[preservation.reason!], reasons: [preservation.reason!] },
    preservation,
  };
}
```
(`EvaluationOutcome` import: add it to the existing imports. `TradeRecord`, `evaluateTradePreservation`, `PreservationAggregates`, `PreservationThresholds`, `PreservationMetadata` are already imported in this file from slice 1a.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test src/validation/apply-preservation-gate.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/validation/apply-preservation-gate.ts src/validation/apply-preservation-gate.test.ts
git commit -m "feat(preservation): applyBacktestPreservationGate downgrade-only wrapper"
```

---

### Task 3: Persist `preservation_gate` on `evaluation`

**Files:**
- Modify: `src/db/schema.ts` (`evaluation` table, ~line 222)
- Modify: `src/domain/evaluation.ts` (`Evaluation` interface)
- Modify: `src/adapters/repository/drizzle-evaluation.repository.ts` (`create`, ~line 25)
- Create (generated): `migrations/0022_*.sql` via `pnpm db:generate`
- Test: `src/adapters/repository/in-memory-evaluation.repository.test.ts` (existing) — add a round-trip case

**Interfaces:**
- Consumes: `PreservationMetadata` (`src/validation/trade-preservation.ts`).
- Produces: `Evaluation.preservationGate?: PreservationMetadata`; the `evaluation.preservation_gate` jsonb column.

- [ ] **Step 1: Add the domain field** in `src/domain/evaluation.ts`:

```ts
import type { PreservationMetadata } from '../validation/trade-preservation.ts';
// ... inside interface Evaluation, after createdAt (or grouped with the outcome fields):
  preservationGate?: PreservationMetadata;
```

- [ ] **Step 2: Add the schema column** in `src/db/schema.ts` inside `evaluation` (add `import type { PreservationMetadata } from '../validation/trade-preservation.ts';` at top if not present — slice 1a already added it for `strategyRevision`, so it likely exists):

```ts
  preservationGate: jsonb('preservation_gate').$type<PreservationMetadata>(),
```
(place after `thresholds`; nullable — no `.notNull()`.)

- [ ] **Step 3: Map it in the drizzle repo** — `src/adapters/repository/drizzle-evaluation.repository.ts` `create`, add to the `.values({...})`:
```ts
      preservationGate: e.preservationGate,
```
(The in-memory repo needs NO change — its `create` does `{ ...evaluation }`, carrying the new field automatically.)

- [ ] **Step 4: Write the round-trip test** — append to `src/adapters/repository/in-memory-evaluation.repository.test.ts`:

```ts
import { DEFAULT_PRESERVATION_THRESHOLDS } from '../../validation/trade-preservation.ts';

it('round-trips preservationGate through create/findById', async () => {
  const repo = new InMemoryEvaluationRepository();
  const ev = makeEvaluation({ // reuse the file's existing Evaluation factory; if none, construct a minimal Evaluation inline
    preservationGate: {
      fired: true, reason: 'abstention_gaming',
      metrics: { totalDelta: 60, matchedCount: 3, disappearedCount: 2, newCount: 0, baselineWinnerCount: 3 },
      thresholds: DEFAULT_PRESERVATION_THRESHOLDS,
    },
  });
  await repo.create(ev);
  const got = await repo.findById(ev.id);
  expect(got?.preservationGate?.reason).toBe('abstention_gaming');
});
```
(If the test file has no `Evaluation` factory, construct a minimal valid `Evaluation` inline — read the existing test for the shape it already builds and add `preservationGate` to it.)

- [ ] **Step 5: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `migrations/0022_*.sql` with a single additive `ALTER TABLE "evaluation" ADD COLUMN "preservation_gate" jsonb;` (+ a meta snapshot). Inspect the SQL — it must be that single additive column and nothing else. If drizzle-kit emits any other change, STOP and report BLOCKED with the SQL.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm typecheck && pnpm test src/adapters/repository/in-memory-evaluation.repository.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/domain/evaluation.ts src/adapters/repository/drizzle-evaluation.repository.ts src/adapters/repository/in-memory-evaluation.repository.test.ts migrations/
git commit -m "feat(preservation): persist preservation_gate on evaluation (migration 0022)"
```

---

### Task 4: Wire the gate into `finalizeBacktestCompletion`

**Files:**
- Modify: `src/orchestrator/handlers/backtest-support.ts` (`finalizeBacktestCompletion`, ~line 62-92)
- Test: `src/orchestrator/handlers/backtest-support.test.ts` (existing if present; otherwise add a focused test file `src/orchestrator/handlers/backtest-support.preservation.test.ts`)

**Interfaces:**
- Consumes: `applyBacktestPreservationGate` (Task 2), `getBaselineRunTrades`/`getRunTrades` (Task 1), `services.preservationGateEnabled`/`services.preservationThresholds` (slice 1a), `event`/`errMsg` (both already in this file), `PreservationMetadata`.

- [ ] **Step 1: Write the failing tests** — create `src/orchestrator/handlers/backtest-support.preservation.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { finalizeBacktestCompletion } from './backtest-support.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { FakeRunTradesAdapter } from '../../adapters/platform/fake-run-trades.adapter.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';
import type { ResearchTask } from '../../domain/types.ts';

function metric(over: Partial<import('../../ports/platform-gateway.port.ts').BacktestMetricBlock> = {}) {
  return { netPnlUsd: 100, netPnlPct: 1, totalTrades: 30, winRate: 0.5, profitFactor: 1.6, maxDrawdownPct: 7, expectancyUsd: 3, sharpe: 0.8, topTradeContributionPct: 20, ...over };
}
// baseline net -45 (25 trades, many losers), variant net +15 (20 trades, only winners kept)
// → evaluateBacktest PASS-shaped delta, trades encode abstention_gaming (see slice 1a math).
function comparison(): ComparisonSummary {
  return {
    baseline: metric({ netPnlUsd: -45, totalTrades: 25, profitFactor: 0.8 }),
    variant: metric({ netPnlUsd: 15, totalTrades: 20, profitFactor: 1.2 }),
    sampleSize: { baselineTrades: 25, variantTrades: 20 }, platformContractVersion: 'test-0',
  };
}
function task(): ResearchTask {
  return { id: 't1', taskType: 'backtest.completed', source: 'operator', correlationId: 'c1', status: 'running', payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}

it('downgrades a would-accept verdict to MODIFY on abstention and persists preservation_gate', async () => {
  const runTrades = new FakeRunTradesAdapter(
    { 'run-1': [ /* variant */ { entryTs: 3, exitTs: 4, side: 'long', realizedPnl: 5 }, { entryTs: 4, exitTs: 5, side: 'long', realizedPnl: 5 }, { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 5 } ] },
    { 'run-1': [ /* baseline */ { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -30 }, { entryTs: 2, exitTs: 3, side: 'long', realizedPnl: -30 }, { entryTs: 3, exitTs: 4, side: 'long', realizedPnl: 5 }, { entryTs: 4, exitTs: 5, side: 'long', realizedPnl: 5 }, { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 5 } ] },
  );
  const services = makeServices({ runTrades });
  const res = await finalizeBacktestCompletion(services, task(), { runId: 'run-1', hypothesisId: 'h1', comparison: comparison(), artifactRefs: [] });
  expect(res.decision).toBe('MODIFY');
  const evals = await services.evaluations.listByBacktestRun('run-1');
  expect(evals[0]?.preservationGate?.reason).toBe('abstention_gaming');
});

it('fail-open: baseline artifact unavailable → verdict unchanged + evaluation.preservation_skipped(artifact_unavailable), preservation_gate NULL', async () => {
  // variant trades present, baseline map empty → getBaselineRunTrades returns null
  const runTrades = new FakeRunTradesAdapter({ 'run-1': [] }, {});
  const events: string[] = [];
  const services = makeServices({ runTrades });
  const origAppend = services.events.append.bind(services.events);
  services.events.append = async (e: any) => { events.push(e.type + ':' + (e.payload?.reason ?? '')); return origAppend(e); };
  const res = await finalizeBacktestCompletion(services, task(), { runId: 'run-1', hypothesisId: 'h1', comparison: comparison(), artifactRefs: [] });
  // aggregate verdict stands (whatever evaluateBacktest returns for this comparison) — NOT downgraded by the gate
  const evals = await services.evaluations.listByBacktestRun('run-1');
  expect(evals[0]?.preservationGate).toBeUndefined();
  expect(events).toContain('evaluation.preservation_skipped:artifact_unavailable');
});

it('kill-switch off: no baseline/variant preservation fetch', async () => {
  const getBaselineRunTrades = vi.fn(async () => null);
  const getRunTrades = vi.fn(async () => []);
  const runTrades = { getRunTrades, getBaselineRunTrades };
  const services = makeServices({ runTrades, preservationGateEnabled: false });
  await finalizeBacktestCompletion(services, task(), { runId: 'run-1', hypothesisId: 'h1', comparison: comparison(), artifactRefs: [] });
  expect(getBaselineRunTrades).not.toHaveBeenCalled();
});
```

(If `evaluateBacktest(comparison())` does not return a would-accept decision for these fixtures, adjust the metric fixture so the aggregate ladder yields PASS/PAPER_CANDIDATE — e.g. raise variant netPnl delta and keep drawdown/fragility in range — while the trades still encode abstention. Verify against `src/validation/evaluator.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/orchestrator/handlers/backtest-support.preservation.test.ts`
Expected: FAIL — no downgrade / no event / fetch called.

- [ ] **Step 3: Wire the gate into `finalizeBacktestCompletion`**

Add imports at the top of `src/orchestrator/handlers/backtest-support.ts`:
```ts
import { applyBacktestPreservationGate } from '../../validation/apply-preservation-gate.ts';
import type { PreservationMetadata } from '../../validation/trade-preservation.ts';
```
Replace the `const outcome = evaluateBacktest(...)` … `Evaluation` … return block with:
```ts
  const outcome = evaluateBacktest(c, services.evaluatorThresholds);

  let finalDecision = outcome.decision;
  let finalReasons = outcome.reasons;
  let preservationGate: PreservationMetadata | undefined;
  if (services.preservationGateEnabled && (outcome.decision === 'PASS' || outcome.decision === 'PAPER_CANDIDATE')) {
    try {
      const baselineTrades = await services.runTrades.getBaselineRunTrades(args.runId);
      if (baselineTrades === null) {
        await services.events.append(event(task.id, 'evaluation.preservation_skipped', { runId: args.runId, reason: 'artifact_unavailable' }));
      } else {
        const variantTrades = await services.runTrades.getRunTrades(args.runId);
        const gated = applyBacktestPreservationGate(
          outcome, baselineTrades, variantTrades,
          { baseline: { netPnlUsd: c.baseline.netPnlUsd, totalTrades: c.baseline.totalTrades },
            variant: { netPnlUsd: c.variant.netPnlUsd, totalTrades: c.variant.totalTrades } },
          services.preservationThresholds,
        );
        finalDecision = gated.outcome.decision;
        finalReasons = gated.outcome.reasons;
        if (gated.preservation) preservationGate = gated.preservation;
      }
    } catch (err) {
      await services.events.append(event(task.id, 'evaluation.preservation_skipped', { runId: args.runId, reason: 'fetch_failed', detail: errMsg(err) }));
    }
  }

  const evaluation: Evaluation = {
    id: randomUUID(), backtestRunId: args.runId, hypothesisId: args.hypothesisId,
    decision: finalDecision, reasons: finalReasons, metricsSnapshot: c,
    thresholds: services.evaluatorThresholds, createdAt: now(),
    ...(preservationGate !== undefined ? { preservationGate } : {}),
  };
  await services.evaluations.create(evaluation);
  await services.backtests.markEvaluated(args.runId);
  await services.events.append(event(task.id, 'evaluation.completed', { runId: args.runId, decision: finalDecision, reasons: finalReasons }));
  return {
    decision: finalDecision, reasons: finalReasons,
    deltaNetPnlUsd: completion.deltaNetPnlUsd, deltaMaxDrawdownPct: completion.deltaMaxDrawdownPct,
  };
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test src/orchestrator/handlers/backtest-support.preservation.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/backtest-support.ts src/orchestrator/handlers/backtest-support.preservation.test.ts
git commit -m "feat(preservation): wire trade-preservation veto into the hypothesis proxy lane"
```

---

### Task 5: Slice-1a revision lane fail-open retrofit

**Files:**
- Modify: `src/orchestrator/handlers/revision-build.handler.ts` (the gate block inside the candidate loop, ~line 331-343)
- Test: `src/orchestrator/handlers/revision-flow.integration.test.ts` (existing)

**Interfaces:**
- Consumes: `event`/`errMsg` (already imported in this handler), `applyRevisionPreservationGate` (slice 1a).

- [ ] **Step 1: Write the failing test** — append a case to `revision-flow.integration.test.ts`'s Task-6 describe block:

```ts
it('revision lane fail-open: a getRunTrades throw skips the veto and emits revision.preservation_skipped', async () => {
  // baseline runs (comparison_baseline) fine; the candidate variant fetch throws.
  const runTrades = {
    getRunTrades: vi.fn(async (id: string) => { if (id === 'cand-pr') throw new Error('boom'); return []; }),
    getBaselineRunTrades: vi.fn(async () => null),
  };
  const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
  const services = makeServices({ revisionRunExecutor: makeVetoExecutor(), researcher: cap.port, runTrades });
  const events: string[] = [];
  const orig = services.events.append.bind(services.events);
  services.events.append = async (e: any) => { events.push(e.type); return orig(e); };

  const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
  await seedAcceptedV1(services, baseBundle);
  await seedTwoHypotheses(services);
  await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

  // veto skipped → the combo's evaluateRevision ACCEPT stands → revision accepted
  const v2 = (await services.revisions.listByProfile('p1')).find((r) => r.version === 2);
  expect(v2?.status).toBe('accepted');
  expect(events).toContain('revision.preservation_skipped');
});
```
(`makeVetoExecutor` sets baseline `base-pr` / candidate `cand-pr` platformRunIds — the fetch of `cand-pr` throws here.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orchestrator/handlers/revision-flow.integration.test.ts`
Expected: FAIL — the throw propagates out of `revisionBuildHandler` (unhandled), no event.

- [ ] **Step 3: Wrap the gate block in try/catch** — in `revision-build.handler.ts`, the current gate block is:
```ts
      if (gateOn && verdict.decision === 'ACCEPT') {
        if (baselineTrades === null) baselineTrades = await services.runTrades.getRunTrades(baselinePlatformRunId!);
        const variantTrades = await services.runTrades.getRunTrades(result.platformRunId);
        const gated = applyRevisionPreservationGate(
          verdict, baselineTrades, variantTrades,
          { baseline: { netPnlUsd: baselineMetrics.netPnlUsd, totalTrades: baselineMetrics.totalTrades },
            variant: { netPnlUsd: result.metrics.netPnlUsd, totalTrades: result.metrics.totalTrades } },
          services.preservationThresholds,
        );
        verdict = gated.verdict;
        if (gated.preservation) firedPreservation = gated.preservation;
      }
```
Wrap its body in try/catch (fail-open — a fetch error skips the veto, leaving the `evaluateRevision` verdict intact):
```ts
      if (gateOn && verdict.decision === 'ACCEPT') {
        try {
          if (baselineTrades === null) baselineTrades = await services.runTrades.getRunTrades(baselinePlatformRunId!);
          const variantTrades = await services.runTrades.getRunTrades(result.platformRunId);
          const gated = applyRevisionPreservationGate(
            verdict, baselineTrades, variantTrades,
            { baseline: { netPnlUsd: baselineMetrics.netPnlUsd, totalTrades: baselineMetrics.totalTrades },
              variant: { netPnlUsd: result.metrics.netPnlUsd, totalTrades: result.metrics.totalTrades } },
            services.preservationThresholds,
          );
          verdict = gated.verdict;
          if (gated.preservation) firedPreservation = gated.preservation;
        } catch (err) {
          await services.events.append(event(task.id, 'revision.preservation_skipped', { revisionId, reason: 'fetch_failed', detail: errMsg(err) }));
        }
      }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test src/orchestrator/handlers/revision-flow.integration.test.ts && pnpm typecheck`
Expected: PASS (new fail-open case + the existing slice-1a veto/kill-switch cases still green).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/revision-build.handler.ts src/orchestrator/handlers/revision-flow.integration.test.ts
git commit -m "feat(preservation): fail-open the revision-lane trade fetch (revision.preservation_skipped)"
```

---

### Task 6: Version-tolerance lock-test (rollout invariant)

**Files:**
- Test: `src/adapters/platform/http-backtester-run-trades.test.ts` (existing) — add a manifest-version-tolerance case

**Interfaces:**
- Consumes: `HttpBacktesterRunTradesAdapter` (Task 1), the fake-client helper.

**Why:** The backtester bumped `ARTIFACT_CONTRACT_VERSION` `022.1 → 022.2`. lab pins `@trading-backtester/sdk` v0.7.0. The rollout invariant is that lab's read path does not reject a manifest carrying the newer `artifactContractVersion`. lab consumes via `getArtifactManifest` → descriptor lookup by `artifactType`, which is version-agnostic. This test locks that: a `022.2` manifest carrying a `baseline-trades` descriptor is read normally.

- [ ] **Step 1: Write the test** — append to `src/adapters/platform/http-backtester-run-trades.test.ts`:

```ts
it('reads a baseline-trades artifact from a manifest tagged artifactContractVersion 022.2 (rollout tolerance)', async () => {
  // Fake client whose manifest advertises the bumped contract version + a baseline-trades descriptor.
  const client = fakeClientReturningRows(
    [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -5, closeReason: 'end_of_data' }],
    'baseline-trades',
    '022.2', // artifactContractVersion on the manifest
  );
  const trades = await new HttpBacktesterRunTradesAdapter(client).getBaselineRunTrades('cmp-run');
  expect(trades).not.toBeNull();
  expect(trades!).toHaveLength(1);
});
```
Extend `fakeClientReturningRows` (from Task 1) to accept an optional third arg `artifactContractVersion` (default `'022.1'`) and set it on the returned manifest object. The assertion proves lab's read path (descriptor lookup by artifactType) is indifferent to the manifest's contract version — the rollout tolerance the spec §7 requires, locked as a regression.

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test src/adapters/platform/http-backtester-run-trades.test.ts`
Expected: PASS (the read path ignores `artifactContractVersion`; a future strict-version gate in the adapter would break this test).

- [ ] **Step 3: Commit**

```bash
git add src/adapters/platform/http-backtester-run-trades.test.ts
git commit -m "test(preservation): lock lab's read tolerance for artifactContractVersion 022.2"
```

---

## Self-Review

**Spec coverage (§4–6):**
- §4 `getBaselineRunTrades(comparisonRunId): Promise<TradeRecord[]|null>` on port + http/fake/mock (fake separate `baselineByRun`), absent→null → Task 1. ✓
- §5.1 `applyBacktestPreservationGate` (EOD→INCONCLUSIVE, abstention/winner→MODIFY, downgrade-only) → Task 2. ✓
- §5.2 wiring in `finalizeBacktestCompletion` (lazy fetch, would-accept only, fail-open `artifact_unavailable`/`fetch_failed`, kill-switch no-fetch, `preservationGate` only when gate ran) → Task 4. ✓
- §5.3 `evaluation.preservation_gate` column + migration 0022 + domain + drizzle create (in-memory automatic) → Task 3. ✓
- §6 revision-lane fail-open retrofit (`revision.preservation_skipped`) → Task 5. ✓
- §7 version-tolerance lock → Task 6. ✓
- Config reuse (`preservationGateEnabled`/`preservationThresholds`) — no new env (constraints + Task 4). ✓
- Out of scope (correctly absent): experiment/holdout path; SDK re-pin (B1); backtester changes (shipped slice 1b-backtester).

**Placeholder scan:** none — full code in every step. The two "adjust the fixture if evaluateBacktest doesn't return would-accept" notes (Task 4) and "reuse the file's Evaluation factory or construct inline" (Task 3) are fixture-shaping instructions grounded in named real files, not vague requirements.

**Type consistency:** `getBaselineRunTrades(comparisonRunId): Promise<TradeRecord[]|null>`, `BASELINE_TRADES='baseline-trades'`, `applyBacktestPreservationGate(outcome, baselineTrades, variantTrades, agg, thresholds) → {outcome, preservation}`, `BacktestGateResult`, `Evaluation.preservationGate?`, event names `evaluation.preservation_skipped`/`revision.preservation_skipped` with `reason` — consistent across Tasks 1–6 and matching the real `EvaluationOutcome`/`Evaluation`/`event` shapes. `event(taskId, type: string, payload)` takes a free-string type, so no event-type registry needs extending.

**Note:** This slice needs the running backtester redeployed from `backtester` main to actually emit `baseline-trades` in production, but does NOT block on it — an old backtester → `getBaselineRunTrades` returns null → `artifact_unavailable` skip (Task 4 test 2 locks this). No SDK re-pin.
