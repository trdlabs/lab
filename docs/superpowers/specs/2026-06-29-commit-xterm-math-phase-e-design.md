# Design: `commitXTermMath` Phase E — long-tail indicators (Squeeze · Pivots · Pressure)

- **Date:** 2026-06-29
- **Status:** Approved design (brainstorming complete) → ready for implementation plan
- **Owner:** Alexander Nikolskiy
- **Parent spec:** `docs/superpowers/specs/2026-06-28-commit-xterm-math-design.md` (§2 non-goals + §11 Phase E + §15 Q7 deferred the "long tail" to this iteration).
- **Scope:** Add three indicators — **Squeeze (TTM)**, **classic floor Pivots**, **taker Pressure** — to the pure math engine `src/research-math/**`, surfaced **only in the per-term summary** (`TermIndicatorSnapshot` + `summaryLine`), never in the compact per-row table.

---

## 1. Context & decision

The shipped engine (`#99`, on `main`) renders a market-context math block per timeframe-term: a compact per-row table (price + EMA/RSI/ATR + OI/OIΔ/CVD/liq) plus a rich per-term summary line (MACD, Bollinger, Stochastic, ADX, Fibonacci, OIΔ, CVD, liq, funding). The parent spec deferred a "long tail" of rarer indicators (`CCI/DEMA/WMA/Squeeze/Pressure/pivots`) to Phase E "by demand".

**YAGNI cut (decided 2026-06-29 with the owner):** the moving-average / extra-oscillator tail is **dropped entirely** as redundant with the existing core:
- **WMA** — a moving-average variant adding no new dimension beyond `EMA`/`SMA`; only useful as a building block (HMA) which is out of scope. Dropped.
- **DEMA** — a lag-reduced moving average; duplicates the existing `emaFast`/`emaSlow` cross. Dropped.
- **CCI** — a typical-price oscillator, but overlaps `RSI` + `Stochastic` + Bollinger `%B`. Dropped.

**Included** (each adds a genuinely distinct, LLM-citable dimension the current block lacks):
- **Pivots** — concrete support/resistance price levels (distinct from Fibonacci, which is derived from the swing hi/lo).
- **Squeeze (TTM)** — a volatility-compression regime signal ("squeeze on → impending expansion"), cheap to derive from the already-computed Bollinger + ATR primitives.
- **Pressure (taker bias)** — a normalized recent aggressive-flow imbalance, complementing CVD (which is a cumulative, unbounded running total).

These give the researcher anchorable `when`-conditions it currently cannot express: "when price reaches pivot R1", "when the squeeze fires", "when taker buy-pressure exceeds X".

---

## 2. Goals / non-goals

**Goals**
1. Three new pure, deterministic, dependency-free indicator functions, unit-tested with reference vectors, returning `null` during warmup (never `NaN`), Wilder/standard smoothing where applicable.
2. Surface them in `TermIndicatorSnapshot` (the per-term summary) and `summaryLine` only — the compact per-row table is **unchanged** (a deliberate focus choice).
3. Coverage-honest: `Pivots`/`Squeeze` gated on `hasOhlc`; `Pressure` gated on `hasTaker`; rendered `n/a` (driven by the existing `CoverageFlags`), never fabricated.
4. Both gates green: `npm run typecheck` (exit 0) **and** `npx vitest run` (currently ~2297 passed / 0 failed — hold it).

**Non-goals**
- No CCI / DEMA / WMA (dropped per §1).
- No change to the per-row table schema (`TermMathRow`), `MarketContextMath` envelope, the read port, the adapter, the handler, or the prompt builder.
- No new runtime dependency. No GARCH (Phase F). No new data source.

---

## 3. Indicator specifications

All functions live under `src/research-math/indicators/`, are pure (no I/O, no `Date.now`/`Math.random`), deterministic, and follow the existing convention: take primitive arrays, return `(T | null)[]` series **or** a single windowed aggregate object (mirroring `liquidationAggregates` / `pctChangeOverWindow`). Index access uses `!`/guards only where the loop bound proves presence (no logic change), per `noUncheckedIndexedAccess`. Relative imports carry the `.ts` extension (runs under `node --experimental-strip-types`).

### 3.1 Pivots — `indicators/levels.ts`

Classic floor pivots computed from a single completed bar's H/L/C. The builder feeds the **previous bar of the same term** (`rows[last-1]`) so the levels project onto the current (latest) bar — strictly backward, no look-ahead.

```ts
export interface PivotLevels {
  pp: number;
  r1: number; r2: number; r3: number;
  s1: number; s2: number; s3: number;
}

export function pivots(high: number, low: number, close: number): PivotLevels;
```

Formulas (standard floor pivots):
```
PP = (H + L + C) / 3
R1 = 2·PP − L          S1 = 2·PP − H
R2 = PP + (H − L)      S2 = PP − (H − L)
R3 = H + 2·(PP − L)    S3 = L − 2·(H − PP)
```

- Always returns a fully-populated object (no warmup state — it is a closed-form transform of three scalars).
- The **builder** computes it only when `hasOhlc && rows.length >= 2`, otherwise the snapshot field is `null`.
- Distinct from `fibonacci` (swing hi/lo retracements): pivots are the prior-bar HLC projection.

**Unit tests:** known-value vector (e.g. H=110, L=90, C=105 → PP=101.667, R1=113.333, S1=93.333, R2=121.667, S2=81.667, R3=133.333, S3=73.333), symmetry sanity (R1−PP vs PP−S1 relation), no `NaN` on degenerate H==L==C.

### 3.2 Squeeze (TTM) — `indicators/volatility.ts`

Detects Bollinger Bands contracting inside the Keltner Channel (volatility compression), with a TTM momentum histogram value.

```ts
export interface SqueezePoint { on: boolean; momentum: number | null; }

export function squeeze(
  highs: readonly number[], lows: readonly number[], closes: readonly number[],
  period: number, bbK: number, kcMult: number,
): (SqueezePoint | null)[];
```

- **Bollinger basis/bands:** `mid = SMA(close, period)`, `sd = stddev(close, period)`, `bbUpper = mid + bbK·sd`, `bbLower = mid − bbK·sd`. (Recompute locally with the same rolling sum/sumSq approach as `bollinger`; do **not** add a new dependency on the `bollinger` object shape.)
- **Keltner channel:** `kcMid = SMA(close, period)`, `kcUpper = kcMid + kcMult·ATR(period)`, `kcLower = kcMid − kcMult·ATR(period)`, where `ATR` is the existing Wilder `atr(highs, lows, closes, period)`.
- **Squeeze on:** `on = bbUpper < kcUpper && bbLower > kcLower` (bands inside the channel).
- **Momentum (faithful TTM):** the histogram value is the linear-regression endpoint over `period` of the series
  `d[i] = close[i] − ½·( ½·(highestHigh(period)[i] + lowestLow(period)[i]) + SMA(close, period)[i] )`.
  A small pure helper `linregEndpoint(values: readonly (number | null)[], period: number): (number | null)[]` (ordinary least-squares fit of `y` on `x=0..period−1`, returning the fitted value at the last point `x=period−1`) provides this — clean-room, no dependency. It returns `null` for any window that is not yet `period` long or contains a `null` (the `d` series is gap-free once it starts, so this is just the warmup head).
- **Warmup (decoupled):** the `on` flag is available as soon as **both** the Bollinger bands and the Keltner channel are defined (i.e. index `≥ period`, since ATR's first non-null is at index `period`). The `momentum` value warms up **independently and later** — `d` needs `period−1` bars to start and the linreg needs a full `period`-wide window, so `momentum` is first non-null at index `≈ 2·period − 2`. A `SqueezePoint` is therefore non-`null` from the first index where `on` is computable, and carries `momentum: null` until its own window fills. Never `NaN`. (Rationale: the on/off regime — the primary signal — should not be withheld just because the longer momentum window has not filled; this lets Squeeze render on short series like the coarse-demo `long` term.)
- The **builder** computes it only when `hasOhlc` (ATR requires high/low); else `null`.

Term config: `period` = existing `bbPeriod`, `bbK` = existing `bbK`, plus a new `kcMult` field (1.5 standard).

**Unit tests:** warmup → point `null` until BB+ATR defined; `on` available while `momentum` is still `null` (decoupled warmup); a hand-built compression case asserts `on=true` (tight BB inside wide KC); an expansion case asserts `on=false`; `momentum` non-null once its `≈2·period−2` window fills; `linregEndpoint` verified against a known linear ramp (perfect fit → endpoint equals the ramp value), a flat series (slope 0 → endpoint = the constant), and a window containing a `null` → `null`; no `NaN`.

### 3.3 Pressure (taker bias) — `indicators/levels.ts`

Normalized recent aggressive-flow imbalance over a trailing window. A windowed aggregate (not a `[last]`-of-series read), mirroring `liquidationAggregates`.

```ts
export interface TakerPressure {
  bias: number | null;      // (ΣBuy − ΣSell) / (ΣBuy + ΣSell) ∈ [−1, 1]; null when no taker data in window
  buyShare: number | null;  // ΣBuy / (ΣBuy + ΣSell) ∈ [0, 1]; null when no taker data in window
}

export function takerPressure(
  buys: readonly (number | null)[], sells: readonly (number | null)[], window: number,
): TakerPressure;
```

- Sums the **last `window`** bars where both `buys[i]` and `sells[i]` are non-null; `total = ΣBuy + ΣSell`.
- `bias = total === 0 ? null : (ΣBuy − ΣSell) / total`; `buyShare = total === 0 ? null : ΣBuy / total`.
- If no usable bar in the window → `{ bias: null, buyShare: null }`.
- The **builder** computes it only when `hasTaker`; else `null`.
- Complements CVD: CVD is the cumulative, unbounded running total of `buy − sell`; pressure is the bounded, normalized recent imbalance over a fixed window.

Term config: new `pressureWindow` field (micro/short shorter, swing/long standard).

**Unit tests:** all-buy window → `bias=1`, `buyShare=1`; all-sell → `bias=−1`, `buyShare=0`; balanced → `bias≈0`, `buyShare≈0.5`; window respects only the trailing `window` bars; nulls/gaps skipped; empty/no-taker → `{null,null}`; `total===0` → `{null,null}` (no division by zero).

---

## 4. Data model & wiring (assembly)

### 4.1 `term-config.ts`

Add two fields to `TermConfig`:
```ts
readonly kcMult: number;        // Keltner multiplier for Squeeze (1.5 standard)
readonly pressureWindow: number; // trailing bars for taker Pressure
```
`TERM_CONFIGS` values:
- `kcMult: 1.5` for all four terms (standard TTM).
- `pressureWindow`: micro 14, short 14, swing 20, long 20 (shorter on fast terms, standard on slow). (Tunable; chosen to match the existing `realizedVolWindow`/`bbPeriod` cadence.)

Update `term-config.test.ts` to assert the new fields are present and sane on every config.

### 4.2 `market-context-math.ts` — `TermIndicatorSnapshot` + `buildTerm`

Extend the snapshot:
```ts
readonly squeeze: { on: boolean; momentum: number | null; momentumState: 'rising' | 'falling' | 'flat' } | null;
readonly pivots: PivotLevels | null;
readonly pressure: { bias: number; buyShare: number; state: 'buy' | 'sell' | 'balanced' } | null;
```

`buildTerm` additions (after the existing array computations):
- `const sqArr = cov.hasOhlc ? squeeze(highs, lows, closes, cfg.bbPeriod, cfg.bbK, cfg.kcMult) : new Array(rows.length).fill(null);`
  - snapshot `squeeze`: from `sqArr[last]`; `momentumState` = compare `sqArr[last].momentum` vs `sqArr[last-1]?.momentum` (`'flat'` within an epsilon, or when either point's `momentum` is `null`; `'rising'`/`'falling'` only when both are present and differ beyond the epsilon).
- `pivots`: `cov.hasOhlc && rows.length >= 2 ? pivots(highs[last-1]!, lows[last-1]!, closes[last-1]!) : null`.
- `pressure`: `cov.hasTaker` → `takerPressure(buys, sells, cfg.pressureWindow)`; map to `{ bias, buyShare, state }` with `state` from `bias` thresholds (`> 0.05 → 'buy'`, `< −0.05 → 'sell'`, else `'balanced'`); `null` when `hasTaker` is false **or** the aggregate `bias`/`buyShare` is `null`.

No change to `TermMathRow`, the table-row mapping, `MarketContextMath`, `CoverageFlags`, or `buildMarketContextMath`'s term-selection/notes logic (the existing OHLC/taker notes already cover the new `n/a` cases; see §4.4).

### 4.3 `format-market-context-math.ts` — `summaryLine`

Append three parts to the existing `parts` array (per-term summary line only; the per-row table is untouched):
- Squeeze: `i.squeeze ? \`Squeeze ${i.squeeze.on ? 'ON' : 'OFF'} (mom ${i.squeeze.momentum == null ? 'n/a' : num(i.squeeze.momentum) + ' ' + i.squeeze.momentumState})\` : 'Squeeze n/a'`
- Pivots: `i.pivots ? \`Pivots PP=${num(i.pivots.pp)} R1/2/3=${num(i.pivots.r1)}/${num(i.pivots.r2)}/${num(i.pivots.r3)} S1/2/3=${num(i.pivots.s1)}/${num(i.pivots.s2)}/${num(i.pivots.s3)}\` : 'Pivots n/a'`
- Pressure: `i.pressure ? \`Pressure ${i.pressure.bias >= 0 ? '+' : ''}${num(i.pressure.bias)} (${i.pressure.state} ${(i.pressure.buyShare * 100).toFixed(0)}% buy)\` : 'Pressure n/a'`

Update `format-market-context-math.test.ts` snapshots accordingly.

### 4.4 Coverage notes

No new note strings are required: the existing
- `'OHLC high/low absent → ATR/Stochastic/ADX/Fibonacci shown as n/a.'`
- `'Taker flow absent in this source → CVD shown as n/a.'`

cover the new `n/a` cases. **Extend the text** of those two notes to also name the new indicators (`… ATR/Stochastic/ADX/Fibonacci/Squeeze/Pivots …` and `… CVD/Pressure …`) so the coverage explanation stays honest and complete. Update the affected `market-context-math.test.ts` / formatter snapshot assertions.

---

## 5. Testing strategy

- **Indicators (new unit suites / additions):** reference vectors per §3 — warmup → `null`, known values, no `NaN`, edge cases (degenerate H==L==C, all-buy/all-sell pressure, perfect-ramp linreg, division-by-zero guards).
- **Assembly:** `market-context-math.test.ts` — full-fidelity term carries non-null `squeeze`/`pivots`/`pressure`; coarse (no-OHLC) term → `squeeze`/`pivots` `null`; no-taker term → `pressure` `null`; `momentumState` transitions; the extended note text appears.
- **Formatter:** `format-market-context-math.test.ts` snapshots — the three new summary parts render with values when present and `… n/a` when absent; per-row table bytes unchanged.
- **Determinism:** same input + `nowMs` → byte-identical markdown (existing invariant preserved).
- **Both gates:** every task runs `npm run typecheck` (exit 0) **and** `npx vitest run` (hold ~2297 passed / 0 failed; net new tests increase the count).

---

## 6. Implementation plan (subagent-driven TDD, mirrors the engine build)

Each task is RED → GREEN with both gates per task (typecheck + vitest), then per-task spec/quality review, then a final whole-branch review.

- **E1 — Pivots.** `pivots()` + `linregEndpoint` helper is **not** here; pivots only. Unit suite in `levels.test.ts`.
- **E2 — Squeeze.** `linregEndpoint` helper + `squeeze()` in `volatility.ts`; unit suite in `volatility.test.ts`.
- **E3 — Pressure.** `takerPressure()` in `levels.ts`; unit suite in `levels.test.ts`.
- **E4 — Config + assembly.** `TermConfig` fields (`kcMult`, `pressureWindow`) + `TERM_CONFIGS` values + `term-config.test.ts`; `TermIndicatorSnapshot` fields + `buildTerm` population + extended notes; `market-context-math.test.ts`.
- **E5 — Format.** `summaryLine` three parts + `format-market-context-math.test.ts` snapshots.

(E1–E3 are independent and may run in parallel; E4 depends on E1–E3; E5 depends on E4.)

---

## 7. Risks & open questions

- **Token cost:** three short additions to one per-term summary line; bounded, negligible vs the per-row table. Acceptable.
- **Squeeze momentum scaling:** the TTM histogram value is in price units and unbounded; we report the raw value + a `rising/falling/flat` state. We deliberately do not normalize (keeps it a faithful TTM read; the state carries the actionable direction).
- **Pivot reference choice:** term-local prior bar (chosen) vs higher-timeframe daily pivots. Term-local keeps `buildTerm` self-contained and pure; higher-TF pivots would couple terms and add no clear LLM benefit here. Revisit only if demand appears.
- **Demo fidelity:** coarse demo fixtures (1h, taker null) will show `Pivots` and the `Squeeze` on/off flag on the `long` term, but `Squeeze` momentum reads `n/a` there (its `≈2·period` warmup, ≈38 bars at `bbPeriod` 20, exceeds the ~24–28 long-term bars) and `Pressure` is `n/a` (no taker) — all consistent with the existing coverage-honest behaviour; golden / real platform (1m + taker) exercise full fidelity.

---

## 8. Success criteria

1. `squeeze`, `pivots`, `takerPressure` are pure, deterministic, dependency-free, unit-covered (warmup `null`, known values, no `NaN`).
2. The three appear in every data-supported term's summary line, with honest `n/a` driven by `hasOhlc`/`hasTaker`.
3. The compact per-row table is byte-unchanged.
4. No regression: `npm run typecheck` exit 0 and `npx vitest run` green (≥ 2297 passed, 0 failed).
5. No new runtime dependency; no change to the read port, adapter, handler, or prompt builder.
