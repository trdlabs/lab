# commitXTermMath Phase E — Squeeze · Pivots · Pressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three pure indicators — classic floor **Pivots**, **TTM Squeeze**, and **taker Pressure** — to the `src/research-math/**` engine, surfaced only in the per-term summary line.

**Architecture:** Three new clean-room pure functions (`pivots`, `squeeze` + a `linregEndpoint` helper, `takerPressure`) in `indicators/{levels,volatility}.ts`, wired into `TermIndicatorSnapshot`/`buildTerm` and rendered in `summaryLine`. The compact per-row table is unchanged. Coverage-honest: Pivots/Squeeze gated on `hasOhlc`, Pressure on `hasTaker`, else `n/a`.

**Tech Stack:** TypeScript run under `node --experimental-strip-types`; Vitest; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-29-commit-xterm-math-phase-e-design.md`

## Global Constraints

- Pure, deterministic functions only — no I/O, no `Date.now()`, no `Math.random()`.
- Indicators return `null` during warmup, **never** `NaN`.
- Zero new runtime dependencies (clean-room math).
- Relative imports carry the `.ts` extension (runs under `node --experimental-strip-types`).
- `noUncheckedIndexedAccess` is on: index access uses `!`/guards only where a loop bound proves presence — no logic change to satisfy the type checker.
- New indicators go in the per-term summary (`TermIndicatorSnapshot` + `summaryLine`) only. The per-row table (`TermMathRow` + `rowLine` + table columns) is **byte-unchanged**.
- **Both gates green on every task:** `npm run typecheck` (exit 0) **and** `npx vitest run` (currently ~2297 passed / 0 failed — must not regress; net new tests increase the count).

---

### Task 1: Pivots (`pivots`)

**Files:**
- Modify: `src/research-math/indicators/levels.ts` (append)
- Test: `src/research-math/indicators/levels.test.ts` (append)

**Interfaces:**
- Consumes: nothing (closed-form transform of three scalars).
- Produces:
  ```ts
  export interface PivotLevels { pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number; }
  export function pivots(high: number, low: number, close: number): PivotLevels;
  ```

- [ ] **Step 1: Write the failing test**

Append to `src/research-math/indicators/levels.test.ts` (add `pivots` to the existing import from `./levels.ts`):

```ts
import { pivots } from './levels.ts';

describe('pivots', () => {
  it('computes classic floor pivots from a known H/L/C', () => {
    const p = pivots(110, 90, 105);
    expect(p.pp).toBeCloseTo(101.6667, 4);
    expect(p.r1).toBeCloseTo(113.3333, 4);
    expect(p.s1).toBeCloseTo(93.3333, 4);
    expect(p.r2).toBeCloseTo(121.6667, 4);
    expect(p.s2).toBeCloseTo(81.6667, 4);
    expect(p.r3).toBeCloseTo(133.3333, 4);
    expect(p.s3).toBeCloseTo(73.3333, 4);
  });

  it('orders levels S3<S2<S1<PP<R1<R2<R3 for a normal bar', () => {
    const p = pivots(110, 90, 105);
    expect(p.s3).toBeLessThan(p.s2);
    expect(p.s2).toBeLessThan(p.s1);
    expect(p.s1).toBeLessThan(p.pp);
    expect(p.pp).toBeLessThan(p.r1);
    expect(p.r1).toBeLessThan(p.r2);
    expect(p.r2).toBeLessThan(p.r3);
  });

  it('produces finite values on a degenerate H==L==C bar', () => {
    const p = pivots(100, 100, 100);
    for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
    expect(p.pp).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/research-math/indicators/levels.test.ts`
Expected: FAIL — `pivots is not a function` / no export `pivots`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/research-math/indicators/levels.ts`:

```ts
export interface PivotLevels { pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number; }

export function pivots(high: number, low: number, close: number): PivotLevels {
  const pp = (high + low + close) / 3;
  const range = high - low;
  return {
    pp,
    r1: 2 * pp - low,
    s1: 2 * pp - high,
    r2: pp + range,
    s2: pp - range,
    r3: high + 2 * (pp - low),
    s3: low - 2 * (high - pp),
  };
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run src/research-math/indicators/levels.test.ts && npm run typecheck`
Expected: PASS (all `pivots` tests green) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/indicators/levels.ts src/research-math/indicators/levels.test.ts
git commit -m "feat(research-math): classic floor pivots indicator (Phase E)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Squeeze (`linregEndpoint` + `squeeze`)

**Files:**
- Modify: `src/research-math/indicators/volatility.ts` (append; already imports `sma` from `./trend.ts` and defines `atr`)
- Test: `src/research-math/indicators/volatility.test.ts` (append)

**Interfaces:**
- Consumes: `sma` (from `./trend.ts`, already imported), `atr` (same file).
- Produces:
  ```ts
  export function linregEndpoint(values: readonly (number | null)[], period: number): (number | null)[];
  export interface SqueezePoint { on: boolean; momentum: number | null; }
  export function squeeze(
    highs: readonly number[], lows: readonly number[], closes: readonly number[],
    period: number, bbK: number, kcMult: number,
  ): (SqueezePoint | null)[];
  ```

- [ ] **Step 1: Write the failing test**

Append to `src/research-math/indicators/volatility.test.ts` (add `squeeze`, `linregEndpoint` to the import from `./volatility.ts`):

```ts
import { squeeze, linregEndpoint } from './volatility.ts';

describe('linregEndpoint', () => {
  it('returns the ramp value for a perfect linear series', () => {
    const out = linregEndpoint([0, 1, 2, 3, 4], 5);
    expect(out[4]).toBeCloseTo(4, 9);
  });

  it('returns the constant for a flat series (slope 0)', () => {
    const out = linregEndpoint([5, 5, 5, 5, 5], 5);
    expect(out[4]).toBeCloseTo(5, 9);
  });

  it('is null before the window fills', () => {
    const out = linregEndpoint([1, 2, 3], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(3, 9); // clean ramp [1,2,3] → endpoint 3
  });

  it('returns null for any window containing a null, then recovers on a clean window', () => {
    const out = linregEndpoint([1, null, 3, 4, 5], 3);
    expect(out[2]).toBeNull(); // window [1,null,3]
    expect(out[3]).toBeNull(); // window [null,3,4]
    expect(out[4]).toBeCloseTo(5, 9); // window [3,4,5] is clean → endpoint 5
  });
});

describe('squeeze', () => {
  // Build a series that is calm (low BB width) for the first half, then a wide spike.
  const period = 5, bbK = 2, kcMult = 1.5;

  it('returns null during warmup (before BB + ATR are defined)', () => {
    const flat = Array.from({ length: 10 }, () => 100);
    const out = squeeze(flat, flat, flat, period, bbK, kcMult);
    for (let i = 0; i < period; i++) expect(out[i]).toBeNull();
  });

  it('reports the on flag while momentum may still be warming up (decoupled)', () => {
    // 7 bars: on is computable from index `period` (=5); momentum needs ~2*period-2 (=8) → still null at index 6
    const highs = [101, 101, 101, 101, 101, 101, 101];
    const lows  = [99, 99, 99, 99, 99, 99, 99];
    const closes = [100, 100, 100, 100, 100, 100, 100];
    const out = squeeze(highs, lows, closes, period, bbK, kcMult);
    const p = out[6];
    expect(p).not.toBeNull();
    expect(typeof p!.on).toBe('boolean');
    expect(p!.momentum).toBeNull();
  });

  it('detects squeeze ON when Bollinger bands sit inside the Keltner channel', () => {
    // Near-flat closes → tiny BB stddev; high/low spread of 4 → wider Keltner via ATR.
    const n = 12;
    const closes = Array.from({ length: n }, (_, i) => 100 + (i % 2) * 0.01);
    const highs = closes.map((c) => c + 2);
    const lows = closes.map((c) => c - 2);
    const out = squeeze(highs, lows, closes, period, bbK, kcMult);
    expect(out[n - 1]).not.toBeNull();
    expect(out[n - 1]!.on).toBe(true);
  });

  it('detects squeeze OFF when Bollinger bands blow outside the Keltner channel', () => {
    // Steep trend → large close stddev (wide BB); tight intrabar range → small ATR (narrow Keltner).
    // (Alternating spikes would NOT work: the close-to-close gap inflates TR → ATR → Keltner, masking the squeeze.)
    const n = 12;
    const closes = Array.from({ length: n }, (_, i) => 100 + 10 * i);
    const highs = closes.map((c) => c + 0.1);
    const lows = closes.map((c) => c - 0.1);
    const out = squeeze(highs, lows, closes, period, bbK, kcMult);
    expect(out[n - 1]).not.toBeNull();
    expect(out[n - 1]!.on).toBe(false);
  });

  it('never returns NaN momentum once warmed', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i));
    const highs = closes.map((c) => c + 1);
    const lows = closes.map((c) => c - 1);
    const out = squeeze(highs, lows, closes, period, bbK, kcMult);
    const last = out[out.length - 1]!;
    expect(last.momentum == null || Number.isFinite(last.momentum)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/research-math/indicators/volatility.test.ts`
Expected: FAIL — no export `squeeze` / `linregEndpoint`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/research-math/indicators/volatility.ts`:

```ts
export function linregEndpoint(values: readonly (number | null)[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period <= 0) return out;
  let sumX = 0, sumXX = 0;
  for (let x = 0; x < period; x++) { sumX += x; sumXX += x * x; }
  const denom = period * sumXX - sumX * sumX;
  for (let i = period - 1; i < n; i++) {
    let sumY = 0, sumXY = 0, ok = true;
    for (let j = 0; j < period; j++) {
      const v = values[i - period + 1 + j];
      if (v == null) { ok = false; break; }
      sumY += v; sumXY += j * v;
    }
    if (!ok) continue;
    if (denom === 0) { out[i] = sumY / period; continue; }
    const slope = (period * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / period;
    out[i] = intercept + slope * (period - 1);
  }
  return out;
}

export interface SqueezePoint { on: boolean; momentum: number | null; }

export function squeeze(
  highs: readonly number[], lows: readonly number[], closes: readonly number[],
  period: number, bbK: number, kcMult: number,
): (SqueezePoint | null)[] {
  const n = closes.length;
  const out: (SqueezePoint | null)[] = new Array(n).fill(null);
  if (period <= 0) return out;
  const mid = sma(closes, period);
  const atrArr = atr(highs, lows, closes, period);
  // rolling population stddev of closes (matches bollinger: sumSq/period − m²)
  let sum = 0, sumSq = 0;
  const sd: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    sum += closes[i]!; sumSq += closes[i]! * closes[i]!;
    if (i >= period) { sum -= closes[i - period]!; sumSq -= closes[i - period]! * closes[i - period]!; }
    if (i >= period - 1) {
      const m = sum / period;
      sd[i] = Math.sqrt(Math.max(sumSq / period - m * m, 0));
    }
  }
  // TTM momentum input series d[i] = close − ½·(½·(HH+LL) + SMA)
  const d: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) { if (highs[j]! > hh) hh = highs[j]!; if (lows[j]! < ll) ll = lows[j]!; }
    const m = mid[i];
    if (m == null) continue;
    d[i] = closes[i]! - 0.5 * (0.5 * (hh + ll) + m);
  }
  const mom = linregEndpoint(d, period);
  for (let i = 0; i < n; i++) {
    const m = mid[i], s = sd[i], a = atrArr[i];
    if (m == null || s == null || a == null) continue; // on needs BB + ATR
    const bbUpper = m + bbK * s, bbLower = m - bbK * s;
    const kcUpper = m + kcMult * a, kcLower = m - kcMult * a;
    out[i] = { on: bbUpper < kcUpper && bbLower > kcLower, momentum: mom[i] ?? null };
  }
  return out;
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run src/research-math/indicators/volatility.test.ts && npm run typecheck`
Expected: PASS (all `linregEndpoint` + `squeeze` tests green) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/indicators/volatility.ts src/research-math/indicators/volatility.test.ts
git commit -m "feat(research-math): TTM squeeze indicator + linreg-endpoint helper (Phase E)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pressure (`takerPressure`)

**Files:**
- Modify: `src/research-math/indicators/levels.ts` (append)
- Test: `src/research-math/indicators/levels.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface TakerPressure { bias: number | null; buyShare: number | null; }
  export function takerPressure(
    buys: readonly (number | null)[], sells: readonly (number | null)[], window: number,
  ): TakerPressure;
  ```

- [ ] **Step 1: Write the failing test**

Append to `src/research-math/indicators/levels.test.ts` (add `takerPressure` to the import from `./levels.ts`):

```ts
import { takerPressure } from './levels.ts';

describe('takerPressure', () => {
  it('is +1 / buyShare 1 for an all-buy window', () => {
    const tp = takerPressure([10, 10, 10], [0, 0, 0], 3);
    expect(tp.bias).toBeCloseTo(1, 9);
    expect(tp.buyShare).toBeCloseTo(1, 9);
  });

  it('is −1 / buyShare 0 for an all-sell window', () => {
    const tp = takerPressure([0, 0, 0], [10, 10, 10], 3);
    expect(tp.bias).toBeCloseTo(-1, 9);
    expect(tp.buyShare).toBeCloseTo(0, 9);
  });

  it('is ~0 / buyShare 0.5 for a balanced window', () => {
    const tp = takerPressure([5, 5], [5, 5], 2);
    expect(tp.bias).toBeCloseTo(0, 9);
    expect(tp.buyShare).toBeCloseTo(0.5, 9);
  });

  it('only sums the trailing `window` bars', () => {
    // last 2 bars: buys 1+1, sells 9+9 → strongly negative; earlier bars ignored
    const tp = takerPressure([100, 100, 1, 1], [0, 0, 9, 9], 2);
    expect(tp.bias).toBeCloseTo((2 - 18) / 20, 9);
  });

  it('skips null/gap bars and returns nulls when no usable data', () => {
    expect(takerPressure([null, null], [null, null], 2)).toEqual({ bias: null, buyShare: null });
    const tp = takerPressure([null, 6], [null, 4], 2);
    expect(tp.bias).toBeCloseTo(0.2, 9);
  });

  it('returns nulls (no divide-by-zero) when totals are zero', () => {
    expect(takerPressure([0, 0], [0, 0], 2)).toEqual({ bias: null, buyShare: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/research-math/indicators/levels.test.ts`
Expected: FAIL — no export `takerPressure`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/research-math/indicators/levels.ts`:

```ts
export interface TakerPressure { bias: number | null; buyShare: number | null; }

export function takerPressure(
  buys: readonly (number | null)[], sells: readonly (number | null)[], window: number,
): TakerPressure {
  const n = buys.length;
  const start = window > 0 ? Math.max(0, n - window) : 0;
  let sumBuy = 0, sumSell = 0, any = false;
  for (let i = start; i < n; i++) {
    const b = buys[i], s = sells[i];
    if (b != null && s != null) { sumBuy += b; sumSell += s; any = true; }
  }
  const total = sumBuy + sumSell;
  if (!any || total === 0) return { bias: null, buyShare: null };
  return { bias: (sumBuy - sumSell) / total, buyShare: sumBuy / total };
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run src/research-math/indicators/levels.test.ts && npm run typecheck`
Expected: PASS (all `takerPressure` tests green) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/indicators/levels.ts src/research-math/indicators/levels.test.ts
git commit -m "feat(research-math): taker buy/sell pressure indicator (Phase E)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Config fields + snapshot assembly + notes

**Files:**
- Modify: `src/research-math/term-config.ts` (add 2 fields to `TermConfig` + values in `TERM_CONFIGS`)
- Modify: `src/research-math/market-context-math.ts` (imports, `TermIndicatorSnapshot`, `buildTerm`, notes)
- Test: `src/research-math/term-config.test.ts` (append) and `src/research-math/market-context-math.test.ts` (append)

**Interfaces:**
- Consumes: `pivots`/`PivotLevels`/`takerPressure` (Task 1, 3), `squeeze`/`SqueezePoint` (Task 2).
- Produces (snapshot additions, relied on by Task 5):
  ```ts
  readonly squeeze: { on: boolean; momentum: number | null; momentumState: 'rising' | 'falling' | 'flat' } | null;
  readonly pivots: PivotLevels | null;
  readonly pressure: { bias: number; buyShare: number; state: 'buy' | 'sell' | 'balanced' } | null;
  ```
  and `TermConfig` gains `readonly kcMult: number;` and `readonly pressureWindow: number;`.

- [ ] **Step 1: Write the failing tests**

Append to `src/research-math/term-config.test.ts`:

```ts
describe('TERM_CONFIGS Phase E fields', () => {
  it('every config has a Keltner multiplier and a pressure window', () => {
    for (const c of TERM_CONFIGS) {
      expect(c.kcMult).toBe(1.5);
      expect(c.pressureWindow).toBeGreaterThan(0);
    }
  });
});
```

Append to `src/research-math/market-context-math.test.ts`:

```ts
describe('buildMarketContextMath Phase E indicators', () => {
  it('populates squeeze, pivots and pressure on a dense taker-bearing term', () => {
    const math = buildMarketContextMath({ ...base, rows: series(120, 60_000, true) }, 1_700_000_000_000);
    const micro = math.terms.find((t) => t.config.key === 'micro')!;
    expect(micro.indicators.squeeze).not.toBeNull();
    expect(typeof micro.indicators.squeeze!.on).toBe('boolean');
    expect(micro.indicators.pivots).not.toBeNull();
    expect(micro.indicators.pressure).not.toBeNull();
    expect(micro.indicators.pressure!.buyShare).toBeCloseTo(0.6, 9); // taker_buy 6 / (6+4)
    expect(micro.indicators.pressure!.state).toBe('buy');
  });

  it('marks pressure n/a (no taker) but keeps squeeze/pivots on a coarse OHLC term', () => {
    const math = buildMarketContextMath({ ...base, rows: series(60, 3_600_000, false) }, 1_700_000_000_000);
    const long = math.terms[0]!;
    expect(long.indicators.pressure).toBeNull();
    expect(long.indicators.pivots).not.toBeNull();
    expect(long.indicators.squeeze).not.toBeNull();
    expect(math.notes.some((n) => /Pressure/i.test(n))).toBe(true);
    expect(math.notes.some((n) => /Squeeze|Pivots/i.test(n))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/research-math/term-config.test.ts src/research-math/market-context-math.test.ts`
Expected: FAIL — `kcMult`/`pressureWindow` undefined; `indicators.squeeze`/`pivots`/`pressure` do not exist.

- [ ] **Step 3a: Add the config fields**

In `src/research-math/term-config.ts`, add to the `TermConfig` interface (after `oiPctWindow`):

```ts
  readonly kcMult: number;
  readonly pressureWindow: number;
```

Then add the two fields to each of the four `TERM_CONFIGS` entries (append to each object literal):
- `micro`:  `kcMult: 1.5, pressureWindow: 14,`
- `short`:  `kcMult: 1.5, pressureWindow: 14,`
- `swing`:  `kcMult: 1.5, pressureWindow: 20,`
- `long`:   `kcMult: 1.5, pressureWindow: 20,`

- [ ] **Step 3b: Wire the indicators into the snapshot**

In `src/research-math/market-context-math.ts`:

Extend the indicator imports:
```ts
import { atr, realizedVol, bollinger, squeeze, type BollingerPoint, type SqueezePoint } from './indicators/volatility.ts';
import {
  swingHighLow, fibonacci, cvd, oiDelta, pctChangeOverWindow, liquidationAggregates, pivots, takerPressure,
  type FibLevels, type PivotLevels,
} from './indicators/levels.ts';
```

Add to the `TermIndicatorSnapshot` interface (after `fibonacci`):
```ts
  readonly squeeze: { on: boolean; momentum: number | null; momentumState: 'rising' | 'falling' | 'flat' } | null;
  readonly pivots: PivotLevels | null;
  readonly pressure: { bias: number; buyShare: number; state: 'buy' | 'sell' | 'balanced' } | null;
```

In `buildTerm`, after the existing `const cvdArr = …; const oiDeltaArr = …;` array section, add:
```ts
  const sqArr = cov.hasOhlc
    ? squeeze(highs, lows, closes, cfg.bbPeriod, cfg.bbK, cfg.kcMult)
    : new Array<SqueezePoint | null>(rows.length).fill(null);
```

In the `indicators` object literal (after `fibonacci: …,`), add — computed from `last` (already defined above as `rows.length - 1`):
```ts
    squeeze: ((): TermIndicatorSnapshot['squeeze'] => {
      const cur = sqArr[last] ?? null;
      if (cur == null) return null;
      const prev = last >= 1 ? (sqArr[last - 1] ?? null) : null;
      let state: 'rising' | 'falling' | 'flat' = 'flat';
      if (cur.momentum != null && prev?.momentum != null) {
        const diff = cur.momentum - prev.momentum;
        state = Math.abs(diff) < 1e-9 ? 'flat' : diff > 0 ? 'rising' : 'falling';
      }
      return { on: cur.on, momentum: cur.momentum, momentumState: state };
    })(),
    pivots: cov.hasOhlc && rows.length >= 2 ? pivots(highs[last - 1]!, lows[last - 1]!, closes[last - 1]!) : null,
    pressure: ((): TermIndicatorSnapshot['pressure'] => {
      if (!cov.hasTaker) return null;
      const tp = takerPressure(buys, sells, cfg.pressureWindow);
      if (tp.bias == null || tp.buyShare == null) return null;
      const state = tp.bias > 0.05 ? 'buy' : tp.bias < -0.05 ? 'sell' : 'balanced';
      return { bias: tp.bias, buyShare: tp.buyShare, state };
    })(),
```

In `buildMarketContextMath`, extend the two coverage-note strings to name the new indicators:
```ts
  if (!overall.hasTaker) notes.push('Taker flow absent in this source → CVD/Pressure shown as n/a.');
  if (!overall.hasOhlc) notes.push('OHLC high/low absent → ATR/Stochastic/ADX/Fibonacci/Squeeze/Pivots shown as n/a.');
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `npx vitest run src/research-math/term-config.test.ts src/research-math/market-context-math.test.ts && npm run typecheck`
Expected: PASS (new Phase E assertions green; existing tests still green) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/term-config.ts src/research-math/term-config.test.ts src/research-math/market-context-math.ts src/research-math/market-context-math.test.ts
git commit -m "feat(research-math): wire squeeze/pivots/pressure into term snapshot + config (Phase E)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Format — render the three parts in `summaryLine`

**Files:**
- Modify: `src/research-math/format-market-context-math.ts` (`summaryLine` only)
- Test: `src/research-math/format-market-context-math.test.ts` (append)

**Interfaces:**
- Consumes: `TermIndicatorSnapshot.squeeze` / `.pivots` / `.pressure` (Task 4).
- Produces: three new ` · `-joined parts in the per-term summary line. No table change.

- [ ] **Step 1: Write the failing test**

Append to `src/research-math/format-market-context-math.test.ts`:

```ts
describe('formatMarketContextMath Phase E summary parts', () => {
  it('renders Squeeze, Pivots and Pressure in the summary when data supports them', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: series(120, 60_000, true) }, 0));
    expect(md).toMatch(/Squeeze (ON|OFF)/);
    expect(md).toContain('Pivots PP=');
    expect(md).toMatch(/Pressure [+-]?\d/);
    expect(md).toContain('% buy)');
  });

  it('renders Pressure n/a (no taker) while still showing Squeeze/Pivots', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: series(60, 3_600_000, false) }, 0));
    expect(md).toContain('Pressure n/a');
    expect(md).toMatch(/Squeeze (ON|OFF)/);
    expect(md).toContain('Pivots PP=');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/research-math/format-market-context-math.test.ts`
Expected: FAIL — `Squeeze`/`Pivots`/`Pressure` strings absent from the output.

- [ ] **Step 3: Write minimal implementation**

In `src/research-math/format-market-context-math.ts`, inside `summaryLine`, append to the `parts` array (after the existing `funding …` entry — keep it last-but-three or append at the end; appending at the end is fine):

```ts
    i.squeeze
      ? `Squeeze ${i.squeeze.on ? 'ON' : 'OFF'} (mom ${i.squeeze.momentum == null ? 'n/a' : num(i.squeeze.momentum) + ' ' + i.squeeze.momentumState})`
      : 'Squeeze n/a',
    i.pivots
      ? `Pivots PP=${num(i.pivots.pp)} R1/2/3=${num(i.pivots.r1)}/${num(i.pivots.r2)}/${num(i.pivots.r3)} S1/2/3=${num(i.pivots.s1)}/${num(i.pivots.s2)}/${num(i.pivots.s3)}`
      : 'Pivots n/a',
    i.pressure
      ? `Pressure ${i.pressure.bias >= 0 ? '+' : ''}${num(i.pressure.bias)} (${i.pressure.state} ${(i.pressure.buyShare * 100).toFixed(0)}% buy)`
      : 'Pressure n/a',
```

- [ ] **Step 4: Run full suite + typecheck to verify pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS — full suite green (≥ 2297 + the new Phase E tests, 0 failed) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/format-market-context-math.ts src/research-math/format-market-context-math.test.ts
git commit -m "feat(research-math): render squeeze/pivots/pressure in term summary (Phase E)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after Task 5)

- [ ] `npm run typecheck` → exit 0.
- [ ] `npx vitest run` → 0 failed; passed count ≥ 2297 + new tests.
- [ ] `git grep -n "TermMathRow" src/research-math/format-market-context-math.ts` and confirm `rowLine` / the table columns string are byte-unchanged vs `main` (`git diff main -- src/research-math/format-market-context-math.ts` shows only `summaryLine` additions).
- [ ] No new entry in `package.json` dependencies (`git diff main -- package.json` empty).

## Task dependency graph

- **Task 1 (Pivots), Task 2 (Squeeze), Task 3 (Pressure)** are independent — may run in parallel.
- **Task 4 (assembly)** depends on Tasks 1–3.
- **Task 5 (format)** depends on Task 4.
