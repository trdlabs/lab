# Trade-Preservation Gate — Slice 1a (lab-only, revision lane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic trade-level preservation veto to the strategy-revision acceptance lane so a combo backtest that games net PnL (kills winners, abstains from trades, or inflates PnL with an end-of-data position) is downgraded ACCEPT→REJECT.

**Architecture:** A pure `evaluateTradePreservation` module compares baseline-run vs candidate-run per-trade records and returns structured `PreservationMetadata`. A thin `applyRevisionPreservationGate` wrapper downgrades a `RevisionVerdict` (only ACCEPT→REJECT, never up). Wired into `revision-build.handler.ts` using trades already fetchable via `services.runTrades.getRunTrades(platformRunId)` (revision baseline + candidate are separate platform runs). Metadata persists in a new `preservation_gate` jsonb column on `strategy_revision`.

**Tech Stack:** TypeScript (node `--experimental-strip-types`), Vitest, Drizzle ORM (Postgres), pnpm.

**Spec:** `docs/superpowers/specs/2026-07-11-trade-preservation-gate-design.md` (§1.5 = slice split; this plan is **Slice 1a only** — revision lane, lab-only). Slice 1b (backtester contract + hypothesis proxy lane) is a separate later plan.

## Global Constraints

- **No TS parameter properties** (`constructor(private x)`) — breaks under `--experimental-strip-types`; an AST guard test blocks it. Declare fields explicitly.
- **Import paths carry the `.ts` extension** (e.g. `from './evaluator.ts'`) — repo convention under strip-types.
- **Tests:** `vitest run` (script `pnpm test`). Single file: `pnpm test <path>`. Convention: `import { describe, it, expect } from 'vitest'`, colocated `*.test.ts`, factory helpers for fixtures.
- **Typecheck:** `pnpm typecheck` (`tsc -p tsconfig.json`) — covers `src/` only, not `scripts/`.
- **Veto only downgrades**: ACCEPT→REJECT. Never touches an already-REJECT verdict. Never upgrades.
- **Kill-switch `LAB_TRADE_PRESERVATION_GATE=off`** must fully restore old behavior and must NOT fetch trades.
- **Determinism**: matching + verdicts must be reproducible (stable sort with full tie-breaker); no `Date.now()`/`Math.random()` in the module.
- Commit after each task with the shown message.

---

### Task 1: Keep `closeReason` through the trades read path

**Files:**
- Modify: `src/domain/research-experiment.ts` (interface `TradeRecord`, ~line 50)
- Modify: `src/adapters/platform/http-backtester.adapter.ts` (`parseTrade`, ~line 429)
- Test: `src/adapters/platform/http-backtester-run-trades.test.ts` (existing)

**Interfaces:**
- Produces: `TradeRecord` now has optional `closeReason?: string` (raw engine reason, e.g. `'end_of_data'`, `'stop_hit'`, `'time_exit'`). All later tasks rely on this field.

- [ ] **Step 1: Write the failing test** — append to `src/adapters/platform/http-backtester-run-trades.test.ts`:

```ts
it('parseTrade keeps closeReason from the artifact row', async () => {
  const client = fakeClientReturningRows([
    { entryTs: 1000, exitTs: 2000, side: 'long', realizedPnl: 5, closeReason: 'end_of_data' },
  ]);
  const trades = await new HttpBacktesterRunTradesAdapter(client).getRunTrades('run1');
  expect(trades[0]!.closeReason).toBe('end_of_data');
});
```

Reuse the file's existing fake-client helper for `getArtifactManifest`/`readArtifact` (mirror the existing `getRunTrades('run1')` test at the top of the file; if the helper is inline, copy its shape and add the `closeReason` field to the row).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/adapters/platform/http-backtester-run-trades.test.ts`
Expected: FAIL — `trades[0].closeReason` is `undefined`.

- [ ] **Step 3: Add the field to `TradeRecord`** in `src/domain/research-experiment.ts`:

```ts
export interface TradeRecord {
  entryTs: number; // epoch ms
  exitTs: number;
  side: 'long' | 'short';
  realizedPnl: number;
  /** Raw engine close reason as serialized in the trades artifact (e.g. 'end_of_data', 'stop_hit', 'time_exit'); undefined on legacy/fake rows. */
  closeReason?: string;
}
```

- [ ] **Step 4: Read `closeReason` in `parseTrade`** (`src/adapters/platform/http-backtester.adapter.ts`):

```ts
function parseTrade(row: unknown): TradeRecord {
  const r = row as Record<string, unknown>;
  if (typeof r.entryTs !== 'number' || typeof r.exitTs !== 'number') {
    throw new Error('trades artifact row missing entryTs/exitTs');
  }
  return {
    entryTs: r.entryTs,
    exitTs: r.exitTs,
    side: r.side === 'short' ? 'short' : 'long',
    realizedPnl: typeof r.realizedPnl === 'number' ? r.realizedPnl : 0,
    ...(typeof r.closeReason === 'string' ? { closeReason: r.closeReason } : {}),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/adapters/platform/http-backtester-run-trades.test.ts`
Expected: PASS (new test + existing ones).

- [ ] **Step 6: Commit**

```bash
git add src/domain/research-experiment.ts src/adapters/platform/http-backtester.adapter.ts src/adapters/platform/http-backtester-run-trades.test.ts
git commit -m "feat(preservation): keep closeReason through the trades read path"
```

---

### Task 2: Pure `evaluateTradePreservation` module

**Files:**
- Create: `src/validation/trade-preservation.ts`
- Test: `src/validation/trade-preservation.test.ts`

**Interfaces:**
- Consumes: `TradeRecord` (Task 1).
- Produces:
  - `type PreservationReason = 'end_of_data_position' | 'abstention_gaming' | 'winner_degradation'`
  - `interface PreservationThresholds { winnerRetention; maxTradeDropPct; abstentionShare; eodShare; matchToleranceMs; minWinnerSample }` (all `number`)
  - `const DEFAULT_PRESERVATION_THRESHOLDS: PreservationThresholds`
  - `interface PreservationAggregates { baseline: { netPnlUsd; totalTrades }; variant: { netPnlUsd; totalTrades } }`
  - `interface PreservationMetadata { fired; reason; metrics; thresholds }`
  - `function evaluateTradePreservation(baselineTrades, variantTrades, agg, t): PreservationMetadata`

- [ ] **Step 1: Write the failing tests** — create `src/validation/trade-preservation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateTradePreservation, DEFAULT_PRESERVATION_THRESHOLDS } from './trade-preservation.ts';
import type { PreservationAggregates } from './trade-preservation.ts';
import type { TradeRecord } from '../domain/research-experiment.ts';

const T = DEFAULT_PRESERVATION_THRESHOLDS;
function tr(over: Partial<TradeRecord> = {}): TradeRecord {
  return { entryTs: 1000, exitTs: 2000, side: 'long', realizedPnl: 10, ...over };
}
function agg(bPnl: number, bN: number, vPnl: number, vN: number): PreservationAggregates {
  return { baseline: { netPnlUsd: bPnl, totalTrades: bN }, variant: { netPnlUsd: vPnl, totalTrades: vN } };
}

describe('matching', () => {
  it('matches same-side same-entry trades; flags disappeared and new', () => {
    const base = [tr({ entryTs: 100 }), tr({ entryTs: 200 })];
    const variant = [tr({ entryTs: 100 }), tr({ entryTs: 300 })];
    const r = evaluateTradePreservation(base, variant, agg(0, 2, 0, 2), T);
    expect(r.metrics.matchedCount).toBe(1);
    expect(r.metrics.disappearedCount).toBe(1);
    expect(r.metrics.newCount).toBe(1);
  });
});

describe('end_of_data_position', () => {
  it('fires INCONCLUSIVE-worthy veto when a new EOD variant trade carries >= eodShare of a positive delta', () => {
    const base = [tr({ realizedPnl: -5 })];
    const variant = [tr({ realizedPnl: -5, entryTs: 100 }), tr({ entryTs: 999999, realizedPnl: 60, closeReason: 'end_of_data' })];
    const r = evaluateTradePreservation(base, variant, agg(-5, 1, 55, 2), T); // totalDelta = 60
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('end_of_data_position');
  });
  it('does not double-count a baseline EOD trade (incremental attribution)', () => {
    const base = [tr({ entryTs: 100, realizedPnl: 50, closeReason: 'end_of_data' })];
    const variant = [tr({ entryTs: 100, realizedPnl: 60, closeReason: 'end_of_data' })];
    const r = evaluateTradePreservation(base, variant, agg(50, 1, 60, 1), T); // totalDelta=10, eodDelta=max(0,60-50)=10 >= 0.5*10
    expect(r.reason).toBe('end_of_data_position'); // still fires: incremental 10 >= 5
    expect(r.metrics.eodDelta).toBe(10);
  });
  it('does not fire when totalDelta <= 0', () => {
    const variant = [tr({ entryTs: 999999, realizedPnl: 60, closeReason: 'end_of_data' })];
    const r = evaluateTradePreservation([], variant, agg(100, 0, 100, 1), T); // totalDelta 0
    expect(r.fired).toBe(false);
  });
});

describe('abstention_gaming', () => {
  it('fires when trade count drops past threshold and removed losers explain the delta', () => {
    const base = [tr({ realizedPnl: -30, entryTs: 1 }), tr({ realizedPnl: -30, entryTs: 2 }),
                  tr({ realizedPnl: 5, entryTs: 3 }), tr({ realizedPnl: 5, entryTs: 4 }), tr({ realizedPnl: 5, entryTs: 5 })];
    const variant = [tr({ realizedPnl: 5, entryTs: 3 }), tr({ realizedPnl: 5, entryTs: 4 }), tr({ realizedPnl: 5, entryTs: 5 })];
    // baseline 5 trades net -45; variant 3 trades net 15 → totalDelta 60; dropPct 40%; removedLosers 60 >= 0.7*60
    const r = evaluateTradePreservation(base, variant, agg(-45, 5, 15, 3), T);
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('abstention_gaming');
  });
});

describe('winner_degradation', () => {
  it('fires when matched+disappeared winners lose more than retention allows', () => {
    const base = [tr({ entryTs: 1, realizedPnl: 40 }), tr({ entryTs: 2, realizedPnl: 40 }),
                  tr({ entryTs: 3, realizedPnl: 40 }), tr({ entryTs: 4, realizedPnl: 40 })];
    // variant keeps one winner, drops three → contribution 40 vs gross 160; 40 < 0.9*160
    const variant = [tr({ entryTs: 1, realizedPnl: 40 })];
    const r = evaluateTradePreservation(base, variant, agg(160, 4, 40, 1), T);
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('winner_degradation');
  });
  it('is skipped below minWinnerSample', () => {
    const base = [tr({ realizedPnl: 40 }), tr({ realizedPnl: 40 })]; // 2 < 3
    const r = evaluateTradePreservation(base, [], agg(80, 2, 0, 0), T);
    expect(r.reason).not.toBe('winner_degradation');
  });
});

it('returns fired:false with populated metrics when nothing triggers', () => {
  const base = [tr({ realizedPnl: 10 }), tr({ realizedPnl: 10 }), tr({ realizedPnl: 10 })];
  const variant = [tr({ realizedPnl: 12 }), tr({ realizedPnl: 12 }), tr({ realizedPnl: 12 })];
  const r = evaluateTradePreservation(base, variant, agg(30, 3, 36, 3), T);
  expect(r.fired).toBe(false);
  expect(r.reason).toBeNull();
  expect(r.metrics.totalDelta).toBe(6);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/validation/trade-preservation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module** — create `src/validation/trade-preservation.ts`:

```ts
import type { TradeRecord } from '../domain/research-experiment.ts';

export type PreservationReason = 'end_of_data_position' | 'abstention_gaming' | 'winner_degradation';

export interface PreservationThresholds {
  winnerRetention: number;
  maxTradeDropPct: number;
  abstentionShare: number;
  eodShare: number;
  matchToleranceMs: number;
  minWinnerSample: number;
}

export const DEFAULT_PRESERVATION_THRESHOLDS: PreservationThresholds = {
  winnerRetention: 0.9,
  maxTradeDropPct: 20,
  abstentionShare: 0.7,
  eodShare: 0.5,
  matchToleranceMs: 0,
  minWinnerSample: 3,
};

export interface PreservationAggregates {
  baseline: { netPnlUsd: number; totalTrades: number };
  variant: { netPnlUsd: number; totalTrades: number };
}

export interface PreservationMetadata {
  fired: boolean;
  reason: PreservationReason | null;
  metrics: {
    totalDelta: number;
    matchedCount: number;
    disappearedCount: number;
    newCount: number;
    baselineWinnerCount: number;
    eodDelta?: number;
    dropPct?: number;
    removedLosersPnl?: number;
    baselineWinnerGross?: number;
    variantWinnerContribution?: number;
  };
  thresholds: PreservationThresholds;
}

const EOD = 'end_of_data';

interface Indexed { t: TradeRecord; i: number }
function orderKey(x: Indexed, y: Indexed): number {
  return (x.t.entryTs - y.t.entryTs)
    || (x.t.exitTs - y.t.exitTs)
    || (x.t.realizedPnl - y.t.realizedPnl)
    || (x.i - y.i);
}

interface MatchResult {
  matched: Array<{ baseline: TradeRecord; variant: TradeRecord }>;
  disappeared: TradeRecord[];
  newTrades: TradeRecord[];
}

function matchTrades(baseline: TradeRecord[], variant: TradeRecord[], toleranceMs: number): MatchResult {
  const matched: MatchResult['matched'] = [];
  const disappeared: TradeRecord[] = [];
  const newTrades: TradeRecord[] = [];
  for (const side of ['long', 'short'] as const) {
    const bs = baseline.map((t, i) => ({ t, i })).filter((x) => x.t.side === side).sort(orderKey);
    const vs = variant.map((t, i) => ({ t, i })).filter((x) => x.t.side === side).sort(orderKey);
    const usedV = new Set<number>();
    for (const b of bs) {
      let best = -1;
      let bestDist = Infinity;
      for (let k = 0; k < vs.length; k++) {
        if (usedV.has(k)) continue;
        const dist = Math.abs(b.t.entryTs - vs[k]!.t.entryTs);
        if (dist <= toleranceMs && dist < bestDist) { bestDist = dist; best = k; }
      }
      if (best >= 0) { usedV.add(best); matched.push({ baseline: b.t, variant: vs[best]!.t }); }
      else disappeared.push(b.t);
    }
    for (let k = 0; k < vs.length; k++) if (!usedV.has(k)) newTrades.push(vs[k]!.t);
  }
  return { matched, disappeared, newTrades };
}

/**
 * Deterministic trade-level preservation check. Compares baseline-run vs variant-run
 * per-trade records; returns a structured veto verdict. Never mutates inputs; no clock/rng.
 * First-match order: end_of_data_position, abstention_gaming, winner_degradation.
 */
export function evaluateTradePreservation(
  baselineTrades: TradeRecord[],
  variantTrades: TradeRecord[],
  agg: PreservationAggregates,
  t: PreservationThresholds,
): PreservationMetadata {
  const totalDelta = agg.variant.netPnlUsd - agg.baseline.netPnlUsd;
  const { matched, disappeared, newTrades } = matchTrades(baselineTrades, variantTrades, t.matchToleranceMs);
  const winners = baselineTrades.filter((x) => x.realizedPnl > 0);

  const base = {
    totalDelta,
    matchedCount: matched.length,
    disappearedCount: disappeared.length,
    newCount: newTrades.length,
    baselineWinnerCount: winners.length,
  };

  // (1) end_of_data_position → INCONCLUSIVE (handled by the caller's mapping)
  if (totalDelta > 0) {
    let eodDelta = 0;
    for (const m of matched) if (m.variant.closeReason === EOD) eodDelta += Math.max(0, m.variant.realizedPnl - m.baseline.realizedPnl);
    for (const v of newTrades) if (v.closeReason === EOD) eodDelta += Math.max(0, v.realizedPnl);
    if (eodDelta >= t.eodShare * totalDelta) {
      return { fired: true, reason: 'end_of_data_position', metrics: { ...base, eodDelta }, thresholds: t };
    }
  }

  // (2) abstention_gaming → MODIFY
  if (agg.baseline.totalTrades > 0 && totalDelta > 0) {
    const dropPct = ((agg.baseline.totalTrades - agg.variant.totalTrades) / agg.baseline.totalTrades) * 100;
    if (dropPct >= t.maxTradeDropPct) {
      let removedLosersPnl = 0;
      for (const d of disappeared) if (d.realizedPnl < 0) removedLosersPnl += Math.abs(d.realizedPnl);
      if (removedLosersPnl >= t.abstentionShare * totalDelta) {
        return { fired: true, reason: 'abstention_gaming', metrics: { ...base, dropPct, removedLosersPnl }, thresholds: t };
      }
    }
  }

  // (3) winner_degradation → MODIFY
  if (winners.length >= t.minWinnerSample) {
    const baselineWinnerGross = winners.reduce((s, w) => s + w.realizedPnl, 0);
    const variantByBaseline = new Map<TradeRecord, TradeRecord>(matched.map((m) => [m.baseline, m.variant]));
    let variantWinnerContribution = 0;
    for (const w of winners) {
      const v = variantByBaseline.get(w);
      variantWinnerContribution += v ? v.realizedPnl : 0;
    }
    if (variantWinnerContribution < t.winnerRetention * baselineWinnerGross) {
      return { fired: true, reason: 'winner_degradation', metrics: { ...base, baselineWinnerGross, variantWinnerContribution }, thresholds: t };
    }
  }

  return { fired: false, reason: null, metrics: { ...base }, thresholds: t };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/validation/trade-preservation.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/validation/trade-preservation.ts src/validation/trade-preservation.test.ts
git commit -m "feat(preservation): pure evaluateTradePreservation module"
```

---

### Task 3: `applyRevisionPreservationGate` wrapper (downgrade-only)

**Files:**
- Create: `src/validation/apply-preservation-gate.ts`
- Test: `src/validation/apply-preservation-gate.test.ts`

**Interfaces:**
- Consumes: `evaluateTradePreservation`, `PreservationAggregates`, `PreservationThresholds`, `PreservationMetadata` (Task 2); `RevisionVerdict` (`src/validation/revision-evaluator.ts`).
- Produces:
  - `interface RevisionGateResult { verdict: RevisionVerdict; preservation: PreservationMetadata | null }`
  - `function applyRevisionPreservationGate(verdict, baselineTrades, variantTrades, agg, thresholds): RevisionGateResult`

- [ ] **Step 1: Write the failing tests** — create `src/validation/apply-preservation-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyRevisionPreservationGate } from './apply-preservation-gate.ts';
import { DEFAULT_PRESERVATION_THRESHOLDS } from './trade-preservation.ts';
import type { RevisionVerdict } from './revision-evaluator.ts';
import type { TradeRecord } from '../domain/research-experiment.ts';

const T = DEFAULT_PRESERVATION_THRESHOLDS;
const accept: RevisionVerdict = { decision: 'ACCEPT', reasons: ['pnl_improved'] };
function tr(over: Partial<TradeRecord> = {}): TradeRecord {
  return { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 40, ...over };
}
const agg = (bPnl: number, bN: number, vPnl: number, vN: number) =>
  ({ baseline: { netPnlUsd: bPnl, totalTrades: bN }, variant: { netPnlUsd: vPnl, totalTrades: vN } });

it('downgrades ACCEPT to REJECT with the veto reason when preservation fires', () => {
  const base = [tr({ entryTs: 1 }), tr({ entryTs: 2 }), tr({ entryTs: 3 }), tr({ entryTs: 4 })]; // 4 winners gross 160
  const variant = [tr({ entryTs: 1 })]; // contribution 40 < 0.9*160
  const r = applyRevisionPreservationGate(accept, base, variant, agg(160, 4, 40, 1), T);
  expect(r.verdict.decision).toBe('REJECT');
  expect(r.verdict.reasons).toEqual(['winner_degradation']);
  expect(r.preservation?.fired).toBe(true);
});

it('leaves ACCEPT untouched when preservation does not fire', () => {
  const base = [tr({ realizedPnl: 10 }), tr({ realizedPnl: 10 }), tr({ realizedPnl: 10 })];
  const variant = [tr({ realizedPnl: 12 }), tr({ realizedPnl: 12 }), tr({ realizedPnl: 12 })];
  const r = applyRevisionPreservationGate(accept, base, variant, agg(30, 3, 36, 3), T);
  expect(r.verdict).toEqual(accept);
  expect(r.preservation?.fired).toBe(false);
});

it('never touches an already-REJECT verdict and does not evaluate preservation', () => {
  const reject: RevisionVerdict = { decision: 'REJECT', reasons: ['no_improvement_over_accepted'] };
  const r = applyRevisionPreservationGate(reject, [], [], agg(0, 0, 0, 0), T);
  expect(r.verdict).toBe(reject);
  expect(r.preservation).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/validation/apply-preservation-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the wrapper** — create `src/validation/apply-preservation-gate.ts`:

```ts
import type { RevisionVerdict } from './revision-evaluator.ts';
import type { TradeRecord } from '../domain/research-experiment.ts';
import {
  evaluateTradePreservation,
  type PreservationAggregates,
  type PreservationThresholds,
  type PreservationMetadata,
} from './trade-preservation.ts';

export interface RevisionGateResult {
  verdict: RevisionVerdict;
  preservation: PreservationMetadata | null;
}

/**
 * Downgrade-only preservation veto for the revision lane. Evaluates trades only when the
 * incoming verdict is ACCEPT; a fired veto flips ACCEPT→REJECT with the veto reason. Never
 * upgrades and never touches a REJECT verdict.
 */
export function applyRevisionPreservationGate(
  verdict: RevisionVerdict,
  baselineTrades: TradeRecord[],
  variantTrades: TradeRecord[],
  agg: PreservationAggregates,
  thresholds: PreservationThresholds,
): RevisionGateResult {
  if (verdict.decision !== 'ACCEPT') return { verdict, preservation: null };
  const preservation = evaluateTradePreservation(baselineTrades, variantTrades, agg, thresholds);
  if (!preservation.fired) return { verdict, preservation };
  return { verdict: { decision: 'REJECT', reasons: [preservation.reason!] }, preservation };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test src/validation/apply-preservation-gate.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/validation/apply-preservation-gate.ts src/validation/apply-preservation-gate.test.ts
git commit -m "feat(preservation): applyRevisionPreservationGate downgrade-only wrapper"
```

---

### Task 4: Config — thresholds + kill-switch on Env/AppServices

**Files:**
- Modify: `src/config/env.ts` (interface `Env` ~line 39; `loadEnv` ~line 239)
- Modify: `src/orchestrator/app-services.ts` (interface `AppServices` ~line 89)
- Modify: `src/composition.ts` (`composeRuntime` ~line 435 — passes `env.*` into services)
- Modify: `test/support/make-services.ts` (`makeServices` ~line 119 — default test wiring)
- Test: `src/config/env.test.ts` (existing) — add cases

**Interfaces:**
- Consumes: `PreservationThresholds`, `DEFAULT_PRESERVATION_THRESHOLDS` (Task 2).
- Produces: `AppServices.preservationThresholds: PreservationThresholds` and `AppServices.preservationGateEnabled: boolean` — read by Task 6.

- [ ] **Step 1: Write the failing test** — append to `src/config/env.test.ts`:

```ts
it('loads preservation thresholds with defaults and gate on', () => {
  const env = loadEnv({}); // pass the empty-record form this file already uses for loadEnv
  expect(env.preservationGateEnabled).toBe(true);
  expect(env.preservationThresholds.winnerRetention).toBe(0.9);
  expect(env.preservationThresholds.minWinnerSample).toBe(3);
});

it('honors LAB_TRADE_PRESERVATION_GATE=off and env overrides', () => {
  const env = loadEnv({
    LAB_TRADE_PRESERVATION_GATE: 'off',
    LAB_TRADE_PRESERVATION_EOD_SHARE: '0.4',
  });
  expect(env.preservationGateEnabled).toBe(false);
  expect(env.preservationThresholds.eodShare).toBe(0.4);
});
```

(If `loadEnv` reads `process.env` directly rather than an argument, follow the file's existing test pattern for injecting env — mirror how neighboring `loadEnv` tests set values.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/config/env.test.ts`
Expected: FAIL — `preservationThresholds`/`preservationGateEnabled` undefined.

- [ ] **Step 3: Extend `Env` and `loadEnv`** in `src/config/env.ts`:

Add the import near the top:
```ts
import { DEFAULT_PRESERVATION_THRESHOLDS, type PreservationThresholds } from '../validation/trade-preservation.ts';
```

Add to the `Env` interface (near `evaluatorThresholds`):
```ts
  preservationGateEnabled: boolean;
  preservationThresholds: PreservationThresholds;
```

In `loadEnv`, next to where `evaluatorThresholds` is built, add a numeric-env helper (if the file has one like `numEnv`, reuse it; otherwise define this local) and the block:
```ts
const numOr = (key: string, dflt: number): number => {
  const raw = src[key];               // `src` = the same env source loadEnv already reads (process.env or the injected record)
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : dflt;
};
// ...
preservationGateEnabled: src.LAB_TRADE_PRESERVATION_GATE !== 'off',
preservationThresholds: {
  winnerRetention: numOr('LAB_TRADE_PRESERVATION_WINNER_RETENTION', DEFAULT_PRESERVATION_THRESHOLDS.winnerRetention),
  maxTradeDropPct: numOr('LAB_TRADE_PRESERVATION_MAX_TRADE_DROP_PCT', DEFAULT_PRESERVATION_THRESHOLDS.maxTradeDropPct),
  abstentionShare: numOr('LAB_TRADE_PRESERVATION_ABSTENTION_SHARE', DEFAULT_PRESERVATION_THRESHOLDS.abstentionShare),
  eodShare: numOr('LAB_TRADE_PRESERVATION_EOD_SHARE', DEFAULT_PRESERVATION_THRESHOLDS.eodShare),
  matchToleranceMs: numOr('LAB_TRADE_PRESERVATION_MATCH_TOLERANCE_MS', DEFAULT_PRESERVATION_THRESHOLDS.matchToleranceMs),
  minWinnerSample: numOr('LAB_TRADE_PRESERVATION_MIN_WINNER_SAMPLE', DEFAULT_PRESERVATION_THRESHOLDS.minWinnerSample),
},
```
(Match `src` to whatever identifier `loadEnv` already uses for its env source; keep the existing style of the `evaluatorThresholds` block.)

- [ ] **Step 4: Thread through `AppServices` + composition + test support**

`src/orchestrator/app-services.ts` — add to `AppServices` (near `evaluatorThresholds`):
```ts
  preservationGateEnabled: boolean;
  preservationThresholds: PreservationThresholds;
```
(import `PreservationThresholds` from `../validation/trade-preservation.ts`.)

`src/composition.ts` `composeRuntime` (near `evaluatorThresholds: env.evaluatorThresholds,`):
```ts
    preservationGateEnabled: env.preservationGateEnabled,
    preservationThresholds: env.preservationThresholds,
```

`test/support/make-services.ts` `makeServices` (near `evaluatorThresholds: DEFAULT_EVALUATOR_THRESHOLDS,`):
```ts
    preservationGateEnabled: overrides.preservationGateEnabled ?? true,
    preservationThresholds: overrides.preservationThresholds ?? DEFAULT_PRESERVATION_THRESHOLDS,
```
(import `DEFAULT_PRESERVATION_THRESHOLDS` from `../../src/validation/trade-preservation.ts`; add both keys to the `overrides` type if it is an explicit interface.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test src/config/env.test.ts && pnpm typecheck`
Expected: PASS, no type errors (compile confirms every `AppServices` constructor now supplies the two fields).

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts src/orchestrator/app-services.ts src/composition.ts test/support/make-services.ts
git commit -m "feat(preservation): env thresholds + kill-switch wired to AppServices"
```

---

### Task 5: Persist `preservation_gate` on `strategy_revision`

**Files:**
- Modify: `src/db/schema.ts` (`strategyRevision` table, ~line 359)
- Modify: `src/domain/strategy-revision.ts` (`StrategyRevision` interface, ~line 12)
- Modify: `src/ports/strategy-revision.repository.ts` (`StrategyRevisionRepository.updateStatus` Pick union, ~line 3)
- Modify: `src/adapters/repository/drizzle-strategy-revision.repository.ts` (`strategyRevisionToDomain` ~line 10; `updateStatus` ~line 75)
- Create (generated): `migrations/0021_*.sql` via `pnpm db:generate`
- Test: `src/adapters/repository/drizzle-strategy-revision.repository.test.ts` (existing) — add a round-trip case if the file uses a real/pg-lite db; otherwise assert the domain mapping only.

**Interfaces:**
- Consumes: `PreservationMetadata` (Task 2).
- Produces: `StrategyRevision.preservationGate?: PreservationMetadata`; `updateStatus` accepts `preservationGate` in its patch.

- [ ] **Step 1: Add the column** in `src/db/schema.ts` inside `strategyRevision` (add an import `import type { PreservationMetadata } from '../validation/trade-preservation.ts';` at top, next to the other `$type` imports):

```ts
  preservationGate: jsonb('preservation_gate').$type<PreservationMetadata>(),
```
(place it near `verdictReason`; nullable — no `.notNull()`.)

- [ ] **Step 2: Add the domain field** in `src/domain/strategy-revision.ts` `StrategyRevision`:

```ts
  preservationGate?: PreservationMetadata;
```
(import `PreservationMetadata` from `../validation/trade-preservation.ts`.)

- [ ] **Step 3: Extend the repository port + adapter**

`src/ports/strategy-revision.repository.ts` — add `'preservationGate'` to the `updateStatus` patch `Pick<StrategyRevision, ...>` union.

`src/adapters/repository/drizzle-strategy-revision.repository.ts`:
- In `strategyRevisionToDomain`, map the column back: `preservationGate: row.preservationGate ?? undefined,`.
- In `updateStatus`, add to the `Pick` union `'preservationGate'` and the set line:
```ts
    if (patch.preservationGate !== undefined) set.preservationGate = patch.preservationGate;
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `migrations/0021_*.sql` adding `preservation_gate jsonb` to `strategy_revision` (and a `migrations/meta` snapshot bump). Inspect the SQL — it must be a single additive `ALTER TABLE "strategy_revision" ADD COLUMN "preservation_gate" jsonb;` with no drops.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm typecheck && pnpm test src/adapters/repository/drizzle-strategy-revision.repository.test.ts`
Expected: PASS. (If the repo test needs the mapping exercised, assert `strategyRevisionToDomain({...row, preservationGate: {fired:false,...}}).preservationGate?.fired === false`.)

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/domain/strategy-revision.ts src/ports/strategy-revision.repository.ts src/adapters/repository/drizzle-strategy-revision.repository.ts migrations/
git commit -m "feat(preservation): persist preservation_gate on strategy_revision (migration 0021)"
```

---

### Task 6: Wire the gate into `revision-build.handler.ts`

**Files:**
- Modify: `src/orchestrator/handlers/revision-build.handler.ts` (baseline resolution ~line 285-310; candidate loop ~line 313-330; accept-path `updateStatus` ~line 369; reject-path `updateStatus` ~line 397)
- Test: `src/orchestrator/handlers/revision-flow.integration.test.ts` (existing harness) — add a veto case + a kill-switch case.

**Interfaces:**
- Consumes: `applyRevisionPreservationGate` (Task 3); `services.runTrades` (already on `AppServices`), `services.preservationGateEnabled`, `services.preservationThresholds` (Task 4); `RevisionRunResult.platformRunId`; `existingBaselineRun.platformRunId`.

- [ ] **Step 1: Write the failing integration tests** — in `revision-flow.integration.test.ts`, add two cases modeled on the file's existing full-handler setup (it builds `services` via the test harness and drives `revisionBuildHandler`). Seed run trades through a `FakeRunTradesAdapter` keyed by `platformRunId`, and make the candidate combo beat the baseline on aggregates (so `evaluateRevision` returns ACCEPT) while the trades encode an abstention/winner kill:

```ts
import { FakeRunTradesAdapter } from '../../adapters/platform/fake-run-trades.adapter.ts';
// ... inside the describe that already wires revisionBuildHandler ...

it('vetoes an abstention-gamed combo: ACCEPT downgraded to rejected + preservationGate persisted', async () => {
  // Arrange: baseline platformRunId 'base-pr' has 5 trades (net negative, many losers);
  // candidate platformRunId 'cand-pr' keeps only the winners (net positive) — evaluateRevision ACCEPTs on aggregates.
  const runTrades = new FakeRunTradesAdapter({
    'base-pr': [
      { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -30 },
      { entryTs: 2, exitTs: 3, side: 'long', realizedPnl: -30 },
      { entryTs: 3, exitTs: 4, side: 'long', realizedPnl: 5 },
      { entryTs: 4, exitTs: 5, side: 'long', realizedPnl: 5 },
      { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 5 },
    ],
    'cand-pr': [
      { entryTs: 3, exitTs: 4, side: 'long', realizedPnl: 5 },
      { entryTs: 4, exitTs: 5, side: 'long', realizedPnl: 5 },
      { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 5 },
    ],
  });
  // Configure the revisionRunExecutor fake so comparison_baseline → platformRunId 'base-pr'
  // (metrics net -45, totalTrades 5) and candidate → platformRunId 'cand-pr' (metrics net +15,
  // totalTrades 3, drawdown/fragility within accept range). Wire services with { runTrades }.

  // Act: run revisionBuildHandler(task, services)

  // Assert
  const revision = await services.revisions.findById(revisionId);
  expect(revision?.status).toBe('rejected');
  expect(revision?.preservationGate?.fired).toBe(true);
  expect(revision?.preservationGate?.reason).toBe('abstention_gaming');
});

it('kill-switch off: same combo is accepted and runTrades is never called', async () => {
  const getRunTrades = vi.fn(async () => []);
  const runTrades = { getRunTrades };
  // services built with { runTrades, preservationGateEnabled: false }, same executor fakes as above
  // Act: run revisionBuildHandler
  const revision = await services.revisions.findById(revisionId);
  expect(revision?.status).toBe('accepted');
  expect(getRunTrades).not.toHaveBeenCalled();
});
```

(Copy the surrounding harness — executor fake, `makeServices`/composition, `revisionId` resolution — from the existing passing tests in this file; only the trades seeding, the `preservationGateEnabled` override, and the assertions are new. Import `vi` from `vitest`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/orchestrator/handlers/revision-flow.integration.test.ts`
Expected: FAIL — combo is accepted (no veto), `preservationGate` undefined; kill-switch test fails because the field/behavior doesn't exist yet.

- [ ] **Step 3: Capture the baseline platformRunId**

In `revision-build.handler.ts`, in the Step-8 baseline block (~line 285-310), hoist a run-id and set it in both branches:

```ts
  let baselinePlatformRunId: string | null = null;
  let baselineMetrics: BacktestMetricBlock | null =
    existingBaselineRun && existingBaselineRun.status === 'completed' && existingBaselineRun.metrics
      ? existingBaselineRun.metrics
      : null;
  if (baselineMetrics && existingBaselineRun) baselinePlatformRunId = existingBaselineRun.platformRunId;
  if (!baselineMetrics) {
    const cmp = await services.revisionRunExecutor.execute({ /* ...comparison_baseline... */ });
    baselineMetrics = cmp.status === 'completed' && cmp.metrics ? cmp.metrics : null;
    if (baselineMetrics) baselinePlatformRunId = cmp.platformRunId;
  }
```

- [ ] **Step 4: Pre-fetch baseline trades once (only when the gate is on)**

Right before the `for (let attempt = 0; ; attempt++)` loop, add:

```ts
  const gateOn = services.preservationGateEnabled && baselinePlatformRunId !== null;
  const baselineTrades = gateOn ? await services.runTrades.getRunTrades(baselinePlatformRunId!) : [];
  let firedPreservation: PreservationMetadata | null = null;
```

(import at top: `import { applyRevisionPreservationGate } from '../../validation/apply-preservation-gate.ts';` and `import type { PreservationMetadata } from '../../validation/trade-preservation.ts';`)

- [ ] **Step 5: Apply the veto inside the loop, right after `evaluateRevision`**

Replace the `if (result.status === 'completed' && result.metrics) { verdict = evaluateRevision(...) }` block with:

```ts
    if (result.status === 'completed' && result.metrics) {
      verdict = evaluateRevision({ accepted: baselineMetrics, candidate: result.metrics, minTrades: 20 });
      if (gateOn && verdict.decision === 'ACCEPT') {
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
    } else {
      verdict = { decision: 'REJECT', reasons: ['candidate_run_unavailable'] };
    }
```

A preservation-driven REJECT now flows through the existing greedy-degradation path (drops the worst hypothesis and retries) exactly like any other reject — no extra branching needed.

- [ ] **Step 6: Persist `preservationGate` on both terminal paths**

In the accept-path `updateStatus` (~line 369) add `preservationGate: firedPreservation ?? undefined,`:
```ts
    await services.revisions.updateStatus(revisionId, {
      status: 'accepted', metrics: acceptedMetrics as unknown as Record<string, unknown>,
      comboBacktestRunId: acceptedRun.runId, verdictReason: verdict.reasons.join(', '),
      preservationGate: firedPreservation ?? undefined, updatedAt: now(),
    });
```
In the reject-path `updateStatus` (~line 397) likewise add `preservationGate: firedPreservation ?? undefined,` so a veto that terminated the loop is recorded.

- [ ] **Step 7: Run the targeted tests, then the full suite**

Run: `pnpm test src/orchestrator/handlers/revision-flow.integration.test.ts`
Expected: PASS (veto case rejected with `abstention_gaming`; kill-switch case accepted, `getRunTrades` not called).

Run: `pnpm test && pnpm typecheck`
Expected: full suite green; no type errors. (Fix any existing revision-flow tests whose fixtures now trip the veto by either adjusting their trades or setting `preservationGateEnabled: false` in their `makeServices` overrides — prefer the latter for tests unrelated to preservation.)

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/handlers/revision-build.handler.ts src/orchestrator/handlers/revision-flow.integration.test.ts
git commit -m "feat(preservation): wire trade-preservation veto into the revision lane"
```

---

## Self-Review

**Spec coverage (slice 1a scope per §1.5):**
- Section A (closeReason) → Task 1. ✓
- Section B (`evaluateTradePreservation`, 3 verdicts, matching + tie-breaker, guards) → Task 2. ✓
- Section C revision wrapper (downgrade-only, ACCEPT→REJECT) → Task 3; wiring → Task 6. ✓
- Section D (6 thresholds + kill-switch, single env source, off = no fetch) → Task 4; off-path assertion → Task 6 Step 1. ✓
- Persistence (preservation_gate jsonb + migration 0021 + domain/repo) → Task 5. ✓
- Regression anchor (abstention/EOD exploit → non-accept) → Task 2 tests + Task 6 integration. ✓
- Out of scope (correctly deferred to 1b): hypothesis proxy lane (`finalizeBacktestCompletion`), backtester/SDK contract, `evaluation` table column, experiment/holdout path.

**Placeholder scan:** none — every code step shows full code; the only "match the file's existing style" notes (env `src` identifier, integration harness) point at concrete existing files the implementer edits, not vague instructions.

**Type consistency:** `PreservationThresholds`/`PreservationMetadata`/`PreservationAggregates`/`evaluateTradePreservation`/`applyRevisionPreservationGate`/`RevisionGateResult` names are identical across Tasks 2–6. `RevisionVerdict` (`{decision:'ACCEPT'|'REJECT', reasons:string[]}`) and `RevisionRunResult.platformRunId` match the real definitions. `updateStatus` patch extension matches the existing `Partial<Pick<StrategyRevision, ...>>` shape.

**Note for slice 1b (next plan):** add `applyBacktestPreservationGate` (EvaluationOutcome: EOD→INCONCLUSIVE, abstention/winner→MODIFY), the backtester `baseline-trades` artifact + SDK `baselineTradesRef`, re-pin, `toSdkComparison` widening, and the `evaluation.preservation_gate` column.
