# market-context-math precision + M1/M3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render price-scale indicator values with magnitude-adaptive precision (so sub-dollar instruments stay legible), and close two logged follow-ups (M1 `takerPressure` window guard, M3 `momentumState` test coverage).

**Architecture:** A new `priceNum(v)` helper in the markdown formatter applies adaptive decimals to price-scale fields only (OHLC/EMA/ATR/MACD/Fib/Pivots/Squeeze-momentum) in both the per-row table cells and the per-term summary; bounded/percentage/integer fields keep `num`. Plus a one-line `takerPressure` window guard and extraction of `momentumStateOf` for direct testing.

**Tech Stack:** TypeScript under `node --experimental-strip-types`; Vitest; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-29-market-context-precision-design.md`

## Global Constraints

- Pure, deterministic functions only — no I/O, no `Date.now()`, no `Math.random()`.
- Indicators/formatters return `null`/`'n/a'` for absent data, never `NaN`; `priceNum` must never emit scientific notation.
- Zero new runtime dependencies. `git diff main -- package.json` stays empty.
- Relative imports carry the `.ts` extension (runs under `node --experimental-strip-types`).
- `noUncheckedIndexedAccess` is on: index access uses `!`/guards only where a loop bound proves presence — no logic change to satisfy the type checker.
- The per-row table's **column header and separator strings are byte-unchanged** — only cell *precision* changes. No field is added or removed anywhere.
- Bounded fields (RSI, Stochastic, ADX, BB %B, liq imbalance, Pressure bias), percentage fields (realizedVol, BB bandwidth, OIΔ, buyShare), and large-integer/raw fields (volume, oi, cvd, liq totals, funding) keep their existing `num`/`.toFixed`/raw formatting — do NOT route them through `priceNum`.
- Both gates green on every task: `npm run typecheck` (exit 0) AND `npx vitest run` (no regression; net new tests increase the count).

---

### Task 1: `priceNum` helper + apply to price-scale fields

**Files:**
- Modify: `src/research-math/format-market-context-math.ts` (add `priceNum`; swap `num`→`priceNum` at price-scale call sites in `rowLine` and `summaryLine`)
- Test: `src/research-math/format-market-context-math.test.ts` (append `priceNum` unit tests + a sub-dollar rendering assertion)

**Interfaces:**
- Consumes: nothing new.
- Produces: a module-private `priceNum(v: number | null): string` (not exported; used only within this file).

- [ ] **Step 1: Write the failing tests**

Append to `src/research-math/format-market-context-math.test.ts`. NOTE: `priceNum` is module-private, so the unit test exercises it **through** `formatMarketContextMath` using a sub-dollar series; add this `describe` block:

```ts
describe('formatMarketContextMath price precision (sub-dollar instruments)', () => {
  // A ~$0.05 instrument: with fixed-2-decimal rounding every price field collapses to 0.05/0.00.
  function pennyRows(n: number, cadence: number): CanonicalRowV2[] {
    return Array.from({ length: n }, (_, i) => {
      const px = 0.05 + (i % 7) * 0.0001; // small, sub-dollar, varying in the 4th–5th decimal
      return {
        schema_version: 2, minute_ts: i * cadence, symbol: 'PENNYUSDT',
        open: px, high: px + 0.0002, low: px - 0.0002, close: px, volume: 1000, turnover: px * 1000,
        oi_total_usd: 1_000_000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
        taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
        has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
      } as CanonicalRowV2;
    });
  }

  it('renders sub-dollar price fields with more than 2 decimals (not collapsed to 0.05/0.00)', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: pennyRows(120, 60_000) }, 0));
    // Pivots PP must carry >2 decimals for a ~0.05 instrument (e.g. 0.0500x), not a bare "0.05".
    const pivotMatch = md.match(/Pivots PP=([0-9.]+)/);
    expect(pivotMatch).not.toBeNull();
    const decimals = pivotMatch![1]!.split('.')[1]?.length ?? 0;
    expect(decimals).toBeGreaterThan(2);
    // No scientific notation anywhere in the block.
    expect(md).not.toMatch(/\d[eE][+-]?\d/);
  });

  it('keeps the per-row table columns byte-unchanged (only cell precision changes)', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: pennyRows(120, 60_000) }, 0));
    expect(md).toContain('| ts | open | high | low | close | vol | ema9 | ema21 | rsi14 | atr14 | oi | oiΔ | cvd | liqL | liqS |');
  });
});
```

Also append a focused behavioural table for the helper, exercised via a tiny exported-free probe — since `priceNum` is private, assert its behaviour through a high-priced series too (2-decimal path):

```ts
describe('formatMarketContextMath price precision (high-priced instruments)', () => {
  function richRows(n: number, cadence: number): CanonicalRowV2[] {
    return Array.from({ length: n }, (_, i) => {
      const px = 42000 + i; // five-figure price
      return {
        schema_version: 2, minute_ts: i * cadence, symbol: 'BTCUSDT',
        open: px, high: px + 5, low: px - 5, close: px, volume: 10, turnover: px * 10,
        oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
        taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
        has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
      } as CanonicalRowV2;
    });
  }

  it('keeps high prices at 2 decimals (no trailing-zero noise beyond 2 dp)', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: richRows(120, 60_000) }, 0));
    const pivotMatch = md.match(/Pivots PP=([0-9.]+)/);
    expect(pivotMatch).not.toBeNull();
    expect(pivotMatch![1]!.split('.')[1]?.length ?? 0).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/research-math/format-market-context-math.test.ts`
Expected: FAIL — the sub-dollar test fails (current `num(_,2)` makes `Pivots PP=0.05`, 2 decimals, not >2).

- [ ] **Step 3: Add the `priceNum` helper**

In `src/research-math/format-market-context-math.ts`, immediately after the existing `num` function, add:

```ts
function priceNum(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  if (a === 0) return '0';
  const decimals = a >= 1 ? 2 : Math.min(8, Math.max(2, 3 - Math.floor(Math.log10(a))));
  return v.toFixed(decimals);
}
```

- [ ] **Step 4: Apply `priceNum` to price-scale fields**

Replace the `rowLine` function body with (only the price-scale cells switch to `priceNum`; `volume`/`rsi`/`oi`/`oiDelta`/`cvd`/`liqLong`/`liqShort` keep `num`):

```ts
function rowLine(r: TermMathRow): string {
  return `| ${isoMinute(r.tsMs)} | ${priceNum(r.open)} | ${priceNum(r.high)} | ${priceNum(r.low)} | ${priceNum(r.close)} | ${num(r.volume, 0)} | ${priceNum(r.emaFast)} | ${priceNum(r.emaSlow)} | ${num(r.rsi)} | ${priceNum(r.atr)} | ${num(r.oi, 0)} | ${num(r.oiDelta, 0)} | ${r.cvd == null ? 'n/a' : num(r.cvd, 0)} | ${num(r.liqLong, 0)} | ${num(r.liqShort, 0)} |`;
}
```

In `summaryLine`, switch exactly these price-scale call sites from `num` to `priceNum` (leave every other `num`/`.toFixed`/raw expression untouched):
- `EMA ${num(i.emaFast)}/${num(i.emaSlow)}` → `EMA ${priceNum(i.emaFast)}/${priceNum(i.emaSlow)}`
- `ATR ${num(i.atr)}` → `ATR ${priceNum(i.atr)}`
- `MACD ${num(i.macd.line)}/${num(i.macd.signal)}/${num(i.macd.hist)}` → `MACD ${priceNum(i.macd.line)}/${priceNum(i.macd.signal)}/${priceNum(i.macd.hist)}`
- `Fib 0.618=${num(i.fibonacci.levels['0.618']!)}` → `Fib 0.618=${priceNum(i.fibonacci.levels['0.618']!)}`
- `Pivots PP=${num(i.pivots.pp)} R1/2/3=${num(i.pivots.r1)}/${num(i.pivots.r2)}/${num(i.pivots.r3)} S1/2/3=${num(i.pivots.s1)}/${num(i.pivots.s2)}/${num(i.pivots.s3)}` → same with every `num` replaced by `priceNum`
- inside the Squeeze part, `num(i.squeeze.momentum)` → `priceNum(i.squeeze.momentum)`

Do NOT change: `RSI ${num(i.rsi)}`, `BB %B ${num(i.bollinger.pctB)}`, `Stoch ${num(...)}`, `ADX ${num(...)}`, `CVD … num(i.cvdNet)`, `liq L/S ${num(i.liqLongTotal)}/${num(i.liqShortTotal)} (imb ${num(i.liqImbalance)})`, `Pressure … ${num(i.pressure.bias)}`, and the `.toFixed`/raw percentage/funding expressions.

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `npx vitest run src/research-math/format-market-context-math.test.ts && npm run typecheck`
Expected: PASS (new precision tests green; existing structural tests still green) and typecheck exit 0.

- [ ] **Step 6: Run the full suite (no regression)**

Run: `npx vitest run`
Expected: 0 failed; passed count ≥ prior baseline + the 3 new tests.

- [ ] **Step 7: Commit**

```bash
git add src/research-math/format-market-context-math.ts src/research-math/format-market-context-math.test.ts
git commit -m "fix(research-math): magnitude-adaptive price precision for market-context block

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: M1 — `takerPressure` non-positive window guard

**Files:**
- Modify: `src/research-math/indicators/levels.ts` (`takerPressure` window start)
- Test: `src/research-math/indicators/levels.test.ts` (append one case)

**Interfaces:**
- Consumes: existing `takerPressure(buys, sells, window): TakerPressure` (`{ bias: number | null; buyShare: number | null }`).
- Produces: same signature; behaviour change only for `window <= 0`.

- [ ] **Step 1: Write the failing test**

Append to the existing `describe('takerPressure', …)` block in `src/research-math/indicators/levels.test.ts`:

```ts
  it('returns nulls for a non-positive window (no bars summed)', () => {
    expect(takerPressure([6, 4], [4, 6], 0)).toEqual({ bias: null, buyShare: null });
    expect(takerPressure([6, 4], [4, 6], -3)).toEqual({ bias: null, buyShare: null });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/research-math/indicators/levels.test.ts -t takerPressure`
Expected: FAIL — current `start = window > 0 ? Math.max(0, n - window) : 0` sums all bars when `window === 0`, so `bias`/`buyShare` are non-null (e.g. `bias: 0`).

- [ ] **Step 3: Fix the window start**

In `src/research-math/indicators/levels.ts`, in `takerPressure`, change the `start` line so a non-positive window yields an empty loop:

```ts
  const start = window > 0 ? Math.max(0, n - window) : n;
```

(When `window <= 0`, `start = n` → the loop body never runs → `any` stays false → the existing `if (!any || total === 0) return { bias: null, buyShare: null };` fires.)

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run src/research-math/indicators/levels.test.ts && npm run typecheck`
Expected: PASS (the new case + all existing `takerPressure`/`pivots` tests) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/indicators/levels.ts src/research-math/indicators/levels.test.ts
git commit -m "fix(research-math): takerPressure returns nulls for non-positive window (M1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: M3 — extract & test `momentumStateOf`

**Files:**
- Modify: `src/research-math/market-context-math.ts` (add exported `momentumStateOf`; call it from `buildTerm`'s `squeeze` IIFE)
- Test: `src/research-math/market-context-math.test.ts` (append `momentumStateOf` unit tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function momentumStateOf(cur: number | null, prev: number | null): 'rising' | 'falling' | 'flat'`.

- [ ] **Step 1: Write the failing test**

Append to `src/research-math/market-context-math.test.ts`. Add `momentumStateOf` to the existing import from `./market-context-math.ts`, then:

```ts
describe('momentumStateOf', () => {
  it('is rising when momentum increased', () => {
    expect(momentumStateOf(5, 3)).toBe('rising');
  });
  it('is falling when momentum decreased', () => {
    expect(momentumStateOf(3, 5)).toBe('falling');
  });
  it('is flat when equal', () => {
    expect(momentumStateOf(5, 5)).toBe('flat');
  });
  it('is flat within the epsilon', () => {
    expect(momentumStateOf(5 + 5e-10, 5)).toBe('flat');
  });
  it('is flat when either side is null (warmup)', () => {
    expect(momentumStateOf(5, null)).toBe('flat');
    expect(momentumStateOf(null, 5)).toBe('flat');
    expect(momentumStateOf(null, null)).toBe('flat');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/research-math/market-context-math.test.ts -t momentumStateOf`
Expected: FAIL — `momentumStateOf` is not exported / not a function.

- [ ] **Step 3: Add the helper and call it from `buildTerm`**

In `src/research-math/market-context-math.ts`, add the exported helper (near the other module-level helpers like `rsiState`/`emaTrend`/`cvdTrendOf`):

```ts
export function momentumStateOf(cur: number | null, prev: number | null): 'rising' | 'falling' | 'flat' {
  if (cur == null || prev == null) return 'flat';
  const diff = cur - prev;
  return Math.abs(diff) < 1e-9 ? 'flat' : diff > 0 ? 'rising' : 'falling';
}
```

Then in `buildTerm`, replace the inline momentum-direction computation in the `squeeze` IIFE. The current block is:

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
```

Replace it with (behaviour-identical — `momentumStateOf` returns `'flat'` exactly when either momentum is null, matching the old `if` guard):

```ts
    squeeze: ((): TermIndicatorSnapshot['squeeze'] => {
      const cur = sqArr[last] ?? null;
      if (cur == null) return null;
      const prev = last >= 1 ? (sqArr[last - 1] ?? null) : null;
      return { on: cur.on, momentum: cur.momentum, momentumState: momentumStateOf(cur.momentum, prev?.momentum ?? null) };
    })(),
```

(If the on-disk block differs from the above, preserve its exact semantics — extract the `state` computation into the `momentumStateOf` call and keep `on`/`momentum` as-is. Do not change any other field.)

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run src/research-math/market-context-math.test.ts && npm run typecheck`
Expected: PASS (new `momentumStateOf` tests + all existing buildMarketContextMath tests, which assert the same `squeeze` snapshot behaviour) and typecheck exit 0.

- [ ] **Step 5: Run the full suite (no regression)**

Run: `npx vitest run`
Expected: 0 failed; passed count ≥ prior + the new tests.

- [ ] **Step 6: Commit**

```bash
git add src/research-math/market-context-math.ts src/research-math/market-context-math.test.ts
git commit -m "refactor(research-math): extract momentumStateOf + cover rising/falling (M3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after Task 3)

- [ ] `npm run typecheck` → exit 0.
- [ ] `npx vitest run` → 0 failed.
- [ ] `git diff main -- src/research-math/format-market-context-math.ts` shows the table column-header/separator strings unchanged (only cell expressions swapped `num`→`priceNum`).
- [ ] `git diff main -- package.json` is empty (no new deps).

## Task dependency graph

- **Task 1 (format)**, **Task 2 (levels)**, **Task 3 (market-context-math)** touch disjoint files and are independent — run sequentially (one implementer at a time), order does not matter.
