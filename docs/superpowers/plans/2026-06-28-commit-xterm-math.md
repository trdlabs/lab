# commitXTermMath Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute a full clean-room indicator+derivatives set over real market history and inject one structured, coverage-honest markdown block per timeframe-term into the researcher prompt, committed as an artifact.

**Architecture:** A new `MarketHistoryReadPort` surfaces `CanonicalRowV2[]` into lab via the already-vendored `HistoricalClient`. A pure, dependency-free math engine (`src/research-math/**`) computes indicators per data-driven term, assembles a typed `MarketContextMath`, and renders markdown. The research handler builds it and passes it on `ResearcherInput`; `buildPrompt` formats it in place of the raw features JSON; the rendered markdown is committed via `ArtifactStore.put`.

**Tech Stack:** TypeScript (run under `node --experimental-strip-types`), Vitest, `@trading-platform/sdk@0.7.2` (already vendored), Mastra (existing researcher agent).

**Spec:** `docs/superpowers/specs/2026-06-28-commit-xterm-math-design.md`

## Global Constraints

- **Runtime is `node --experimental-strip-types`. NO TypeScript parameter properties** (`constructor(private x: T)` compiles but breaks at runtime). Declare fields explicitly and assign in the constructor body.
- **Every relative import MUST include the `.ts` extension** (e.g. `import { ema } from './indicators/trend.ts'`). This matches the existing codebase.
- **Clean-room: zero new runtime dependencies.** All indicator math is our own code. Do NOT add `@backtest-kit/signals`, `trading-signals`, or any math/stats library.
- **Pure math layer:** functions in `src/research-math/**` have no I/O and never call `Date.now()` / `Math.random()`. The wall-clock value is passed in as `nowMs`.
- **Indicators return `null` during warmup, never `NaN`.**
- **SDK imports live only in adapters; DTOs are re-exported through the port** (enforced by `src/adapters/.../sdk-import-boundary.guard.test.ts`; follow the `bot-results-read.port.ts` convention).
- **Coverage honesty:** every `null`/missing value is driven by the `has_*` flags on `CanonicalRowV2`; never zero-fill or fabricate a proxy presented as real.
- **Tests:** Vitest. Run a single file with `npx vitest run <path>`; a single test with `npx vitest run <path> -t "<name>"`.
- **`CanonicalRowV2` field nullability (verified against `node_modules/@trading-platform/sdk/dist/historical/canonical-row.d.ts`):** `open/high/low/close/volume/turnover` are **non-null `number`**; only `oi_total_usd / funding_rate / liq_long_usd / liq_short_usd / taker_buy_volume_usd / taker_sell_volume_usd` are `number | null` (gated by `has_oi / has_funding / has_liquidations / has_taker_flow`). Consequences for the code below: type the OHLCV fields of `TermMathRow` as `number` (NOT `| null`) and map them directly (`open: r.open`, no `?? null`); in `resampleRows` the `?? 0` on `volume`/`turnover` is dead — drop it. The `coverageOf.hasOhlc` flag and the `cov.hasOhlc ? … : null` guards in `buildTerm` are therefore always-true for valid rows: keep them only as a defensive guard against an SDK contract violation (degrade ATR/Stochastic/ADX/Fibonacci to `n/a` instead of throwing on a malformed row), or drop them — both compile and run correctly. Never substitute `r.high ?? r.close`: a missing high would be a contract violation to surface, not silently mask. Values are numbers, never strings — the engine works on them directly.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/ports/market-history-read.port.ts` | Port + re-exported `CanonicalRowV2` DTO | B1 |
| `src/adapters/platform/http-market-history.adapter.ts` | Drains `HistoricalClient.queryRows` → sorted/deduped rows | B1 |
| `src/adapters/platform/select-market-history.ts` | Env-driven selector | B2 |
| `src/orchestrator/app-services.ts` (modify) | Register `marketHistory` service | B2 |
| `src/composition.ts` (modify) | Construct the adapter | B2 |
| `src/research-math/indicators/trend.ts` | `ema`, `sma`, `rsi`, `macd` | C1 |
| `src/research-math/indicators/volatility.ts` | `atr`, `realizedVol`, `bollinger` | C2 |
| `src/research-math/indicators/oscillators.ts` | `stochastic`, `adx` | C3 |
| `src/research-math/indicators/levels.ts` | `swingHighLow`, `fibonacci`, `cvd`, `oiDelta`, `pctChangeOverWindow`, `liquidationAggregates` | C4 |
| `src/research-math/resample.ts` | `resampleRows(rows, tfMs)` | C5 |
| `src/research-math/term-config.ts` | `TermKey`, `TermConfig`, `TERM_CONFIGS`, `inferCadenceMs`, `isTermIncluded` | C6 |
| `src/research-math/market-context-math.ts` | Model types + `buildMarketContextMath` | D1 |
| `src/research-math/format-market-context-math.ts` | `formatMarketContextMath` | D2 |
| `src/ports/researcher.port.ts` (modify) | Add `marketContextMath?` field | E1 |
| `src/adapters/researcher/mastra-researcher.ts` (modify) | Inject formatted block in `buildPrompt` | E1 |
| `src/orchestrator/handlers/research-run-cycle.handler.ts` (modify) | Fetch history, build math, attach, commit artifact | E2, E3 |

**Out of scope (follow-up, see spec §10-11):** Phase F GARCH(1,1); the indicator long tail (CCI/DEMA/WMA/Squeeze/Pressure/pivots); Sub-project 2 (richer 1m+taker mock fixture); Sub-project 3 (DCA signal-graph). Docker env passthrough for `LAB_MARKET_HISTORY_URL` is included in B2.

---

### Task B1: `MarketHistoryReadPort` + HTTP adapter

**Files:**
- Create: `src/ports/market-history-read.port.ts`
- Create: `src/adapters/platform/http-market-history.adapter.ts`
- Test: `src/adapters/platform/http-market-history.adapter.test.ts`

**Interfaces:**
- Consumes: `@trading-platform/sdk/historical` — `CanonicalRowV2` and `HistoricalClient.queryRows({ symbols, fromMs, toMs }): AsyncIterable<CanonicalRowV2[]>`.
- Produces: `MarketHistoryReadPort.getRows(window: MarketHistoryWindow): Promise<readonly CanonicalRowV2[]>`; `MarketHistoryWindow { symbol; fromMs; toMs }`; re-exported type `CanonicalRowV2`; class `HttpMarketHistoryAdapter` taking a `HistoricalRowsSource` (the `queryRows`-shaped seam) for testability.

- [ ] **Step 1: Write the port** (`market-history-read.port.ts`)

```ts
import type { CanonicalRowV2 } from '@trading-platform/sdk/historical';
export type { CanonicalRowV2 };

export interface MarketHistoryWindow {
  readonly symbol: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface MarketHistoryReadPort {
  /** Canonical rows for [fromMs, toMs], ascending by minute_ts, deduped (last-wins). May be []. */
  getRows(window: MarketHistoryWindow): Promise<readonly CanonicalRowV2[]>;
}
```

- [ ] **Step 2: Write the failing adapter test**

```ts
import { describe, it, expect } from 'vitest';
import { HttpMarketHistoryAdapter, type HistoricalRowsSource } from './http-market-history.adapter.ts';
import type { CanonicalRowV2 } from '../../ports/market-history-read.port.ts';

function row(ts: number, close: number): CanonicalRowV2 {
  return {
    schema_version: 2, minute_ts: ts, symbol: 'BTCUSDT',
    open: close, high: close, low: close, close, volume: 1, turnover: close,
    oi_total_usd: null, funding_rate: null, liq_long_usd: null, liq_short_usd: null,
    taker_buy_volume_usd: null, taker_sell_volume_usd: null,
    has_oi: false, has_funding: false, has_liquidations: false, has_taker_flow: false,
  } as CanonicalRowV2;
}

function fakeSource(pages: CanonicalRowV2[][]): HistoricalRowsSource {
  return {
    async *queryRows() { for (const p of pages) yield p; },
  };
}

describe('HttpMarketHistoryAdapter', () => {
  it('drains pages, sorts ascending and dedupes by minute_ts (last-wins)', async () => {
    const a = row(120_000, 1);
    const b = row(60_000, 2);
    const bDup = row(60_000, 99); // later page wins
    const adapter = new HttpMarketHistoryAdapter(fakeSource([[a, b], [bDup]]));
    const out = await adapter.getRows({ symbol: 'BTCUSDT', fromMs: 0, toMs: 200_000 });
    expect(out.map((r) => r.minute_ts)).toEqual([60_000, 120_000]);
    expect(out[0].close).toBe(99);
  });

  it('returns [] when the source yields nothing', async () => {
    const adapter = new HttpMarketHistoryAdapter(fakeSource([]));
    expect(await adapter.getRows({ symbol: 'X', fromMs: 0, toMs: 1 })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/adapters/platform/http-market-history.adapter.test.ts`
Expected: FAIL (`HttpMarketHistoryAdapter` not defined).

- [ ] **Step 4: Implement the adapter**

```ts
import type {
  CanonicalRowV2, MarketHistoryReadPort, MarketHistoryWindow,
} from '../../ports/market-history-read.port.ts';

/** The slice of the SDK HistoricalClient this adapter needs (testable seam). */
export interface HistoricalRowsSource {
  queryRows(args: { symbols: string[]; fromMs: number; toMs: number }): AsyncIterable<CanonicalRowV2[]>;
}

export class HttpMarketHistoryAdapter implements MarketHistoryReadPort {
  readonly #source: HistoricalRowsSource;

  constructor(source: HistoricalRowsSource) {
    this.#source = source;
  }

  async getRows(window: MarketHistoryWindow): Promise<readonly CanonicalRowV2[]> {
    const byTs = new Map<number, CanonicalRowV2>();
    for await (const page of this.#source.queryRows({
      symbols: [window.symbol], fromMs: window.fromMs, toMs: window.toMs,
    })) {
      for (const r of page) byTs.set(r.minute_ts, r); // last-wins
    }
    return [...byTs.values()].sort((x, y) => x.minute_ts - y.minute_ts);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/adapters/platform/http-market-history.adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ports/market-history-read.port.ts src/adapters/platform/http-market-history.adapter.ts src/adapters/platform/http-market-history.adapter.test.ts
git commit -m "feat(research-math): MarketHistoryReadPort + HTTP adapter over HistoricalClient"
```

---

### Task B2: Selector + composition wiring

**Files:**
- Create: `src/adapters/platform/select-market-history.ts`
- Modify: `src/orchestrator/app-services.ts` (add `marketHistory` to the services type + assembly)
- Modify: `src/composition.ts` (construct the real `HistoricalClient`-backed source)
- Modify: `docker-compose.demo.yml`, `.env.example` (env passthrough)
- Test: `src/adapters/platform/select-market-history.test.ts`

**Interfaces:**
- Consumes: `HttpMarketHistoryAdapter`, `HistoricalRowsSource` (B1); `HistoricalClient` from `@trading-platform/sdk/historical`.
- Produces: `selectMarketHistory(env): MarketHistoryReadPort`; `AppServices.marketHistory: MarketHistoryReadPort`.

- [ ] **Step 1: Write the failing selector test**

```ts
import { describe, it, expect } from 'vitest';
import { selectMarketHistory } from './select-market-history.ts';

describe('selectMarketHistory', () => {
  it('builds an adapter bound to the configured base URL + token', () => {
    const port = selectMarketHistory({ baseUrl: 'http://mock-platform:8839', token: 't' });
    expect(typeof port.getRows).toBe('function');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/adapters/platform/select-market-history.test.ts`
Expected: FAIL (`selectMarketHistory` not defined).

- [ ] **Step 3: Implement the selector**

> Confirm the exact `HistoricalClient` constructor shape in `node_modules/@trading-platform/sdk/dist/historical/client.d.ts` before writing; it exposes `queryRows({symbols, fromMs, toMs})`. The selector adapts it to `HistoricalRowsSource`.

```ts
import { HistoricalClient } from '@trading-platform/sdk/historical';
import { HttpMarketHistoryAdapter, type HistoricalRowsSource } from './http-market-history.adapter.ts';
import type { MarketHistoryReadPort } from '../../ports/market-history-read.port.ts';

export interface MarketHistoryConfig {
  readonly baseUrl: string;
  readonly token: string;
}

export function selectMarketHistory(cfg: MarketHistoryConfig): MarketHistoryReadPort {
  const client = new HistoricalClient({ baseUrl: cfg.baseUrl, token: cfg.token });
  const source: HistoricalRowsSource = {
    queryRows: (args) => client.queryRows(args),
  };
  return new HttpMarketHistoryAdapter(source);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/adapters/platform/select-market-history.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the service in `app-services.ts`**

Add to the `AppServices` interface (next to `botResults`):

```ts
  readonly marketHistory: MarketHistoryReadPort;
```

Add the import at the top:

```ts
import type { MarketHistoryReadPort } from '../ports/market-history-read.port.ts';
```

- [ ] **Step 6: Construct it in `composition.ts`**

In the adapter-construction block (near where `select-bot-results` is wired), add:

```ts
import { selectMarketHistory } from './adapters/platform/select-market-history.ts';
// ...
const marketHistory = selectMarketHistory({
  baseUrl: process.env.LAB_MARKET_HISTORY_URL ?? process.env.LAB_OPS_READ_URL ?? 'http://mock-platform:8839',
  token: process.env.MOCK_OPS_TOKEN ?? '',
});
```

Then include `marketHistory` in the `AppServices` object passed to the orchestrator.

- [ ] **Step 7: Add docker env passthrough**

In `docker-compose.demo.yml` under the `lab` (worker/ingress) service environment, add:

```yaml
      LAB_MARKET_HISTORY_URL: http://mock-platform:8839
```

In `.env.example`, document:

```
# Market history read (CanonicalRowV2) for commitXTermMath; defaults to the ops-read URL
LAB_MARKET_HISTORY_URL=
MARKET_HISTORY_LOOKBACK_DAYS=7
```

- [ ] **Step 8: Verify the SDK-import-boundary guard still passes + typecheck**

Run: `npx vitest run src/adapters/platform/sdk-import-boundary.guard.test.ts` (exact filename may differ — find it with `npx vitest run -t "sdk import"`).
Run: `npm run typecheck` (or the repo's typecheck script).
Expected: PASS. The only SDK import is in the adapter/selector; the DTO is re-exported through the port.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/platform/select-market-history.ts src/adapters/platform/select-market-history.test.ts src/orchestrator/app-services.ts src/composition.ts docker-compose.demo.yml .env.example
git commit -m "feat(research-math): wire MarketHistoryReadPort into composition + docker"
```

---

### Task C1: Trend/momentum indicators (`ema`, `sma`, `rsi`, `macd`)

**Files:**
- Create: `src/research-math/indicators/trend.ts`
- Test: `src/research-math/indicators/trend.test.ts`

**Interfaces:**
- Produces: `ema(values, period): (number|null)[]`; `sma(values, period): (number|null)[]`; `rsi(values, period): (number|null)[]`; `macd(values, fast, slow, signalPeriod): (MacdPoint|null)[]`; `MacdPoint { line; signal; hist }`. All input arrays are `readonly number[]`; outputs are full-length with `null` during warmup.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { ema, sma, rsi, macd } from './trend.ts';

describe('sma', () => {
  it('is null before warmup and the window mean after', () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });
});

describe('ema', () => {
  it('on a constant series equals the constant after warmup', () => {
    const out = ema([5, 5, 5, 5, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    for (const v of out.slice(2)) expect(v).toBeCloseTo(5, 10);
  });
  it('seeds with the SMA of the first `period` values', () => {
    expect(ema([2, 4, 6], 3)![2]).toBeCloseTo(4, 10); // seed = mean(2,4,6)
  });
});

describe('rsi', () => {
  it('is 100 for a strictly rising series and 0 for a strictly falling one', () => {
    expect(rsi([1, 2, 3, 4, 5], 2).at(-1)).toBe(100);
    expect(rsi([5, 4, 3, 2, 1], 2).at(-1)).toBe(0);
  });
  it('is null during warmup', () => {
    expect(rsi([1, 2, 3], 2)[1]).toBeNull(); // first value at index = period
  });
});

describe('macd', () => {
  it('line is null until both EMAs warm up and hist = line - signal', () => {
    const out = macd([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2, 4, 2);
    const last = out.at(-1)!;
    expect(last).not.toBeNull();
    expect(last.hist).toBeCloseTo(last.line - last.signal, 10);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/research-math/indicators/trend.test.ts`
Expected: FAIL (functions not defined).

- [ ] **Step 3: Implement**

```ts
export function sma(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (values[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

export function rsi(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdPoint { line: number; signal: number; hist: number; }

export function macd(
  values: readonly number[], fast: number, slow: number, signalPeriod: number,
): (MacdPoint | null)[] {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const out: (MacdPoint | null)[] = new Array(values.length).fill(null);
  const lineDefined: number[] = [];
  const lineIdx: number[] = [];
  const line: (number | null)[] = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? (emaFast[i] as number) - (emaSlow[i] as number) : null);
  for (let i = 0; i < line.length; i++) {
    if (line[i] != null) { lineDefined.push(line[i] as number); lineIdx.push(i); }
  }
  const sig = ema(lineDefined, signalPeriod);
  for (let j = 0; j < sig.length; j++) {
    if (sig[j] != null) {
      const i = lineIdx[j];
      const l = line[i] as number;
      out[i] = { line: l, signal: sig[j] as number, hist: l - (sig[j] as number) };
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/research-math/indicators/trend.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/indicators/trend.ts src/research-math/indicators/trend.test.ts
git commit -m "feat(research-math): trend indicators (ema, sma, rsi, macd)"
```

---

### Task C2: Volatility indicators (`atr`, `realizedVol`, `bollinger`)

**Files:**
- Create: `src/research-math/indicators/volatility.ts`
- Test: `src/research-math/indicators/volatility.test.ts`

**Interfaces:**
- Consumes: `sma` from `./trend.ts`.
- Produces: `atr(highs, lows, closes, period): (number|null)[]`; `realizedVol(closes, window): (number|null)[]`; `bollinger(values, period, k): (BollingerPoint|null)[]`; `BollingerPoint { upper; mid; lower; pctB; bandwidth }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { atr, realizedVol, bollinger } from './volatility.ts';

describe('atr', () => {
  it('equals the constant bar range when range is constant', () => {
    const highs = [10, 11, 12, 13, 14];
    const lows = [9, 10, 11, 12, 13];   // range 1, and |high-prevClose| etc never exceed 1 here? verify with closes
    const closes = [9.5, 10.5, 11.5, 12.5, 13.5];
    const out = atr(highs, lows, closes, 2);
    // first ATR at index 2; subsequent values stay ~1 (TR ≈ 1)
    expect(out[2]).toBeCloseTo(1, 6);
    expect(out.at(-1)).toBeCloseTo(1, 6);
  });
  it('is null during warmup', () => {
    expect(atr([1, 2], [0, 1], [0.5, 1.5], 5)).toEqual([null, null]);
  });
});

describe('realizedVol', () => {
  it('is 0 for a flat series and > 0 for an oscillating one', () => {
    expect(realizedVol([5, 5, 5, 5], 2).at(-1)).toBeCloseTo(0, 10);
    expect(realizedVol([1, 2, 1, 2, 1], 2).at(-1)!).toBeGreaterThan(0);
  });
});

describe('bollinger', () => {
  it('mid equals the SMA and price-at-mid gives %B 0.5', () => {
    const out = bollinger([2, 2, 2, 2], 3, 2)!;
    expect(out[2]!.mid).toBeCloseTo(2, 10);
    expect(out[2]!.upper).toBeCloseTo(2, 10); // zero variance
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/research-math/indicators/volatility.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { sma } from './trend.ts';

export function atr(
  highs: readonly number[], lows: readonly number[], closes: readonly number[], period: number,
): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period <= 0 || n <= period) return out;
  const tr = new Array<number>(n);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function realizedVol(closes: readonly number[], window: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (window <= 0 || n <= window) return out;
  const rets = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) rets[i] = closes[i - 1] !== 0 ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0;
  for (let i = window; i < n; i++) {
    let mean = 0;
    for (let j = i - window + 1; j <= i; j++) mean += rets[j];
    mean /= window;
    let v = 0;
    for (let j = i - window + 1; j <= i; j++) { const d = rets[j] - mean; v += d * d; }
    out[i] = Math.sqrt(v / window);
  }
  return out;
}

export interface BollingerPoint { upper: number; mid: number; lower: number; pctB: number; bandwidth: number; }

export function bollinger(values: readonly number[], period: number, k: number): (BollingerPoint | null)[] {
  const n = values.length;
  const out: (BollingerPoint | null)[] = new Array(n).fill(null);
  if (period <= 0) return out;
  const mid = sma(values, period);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i]; sumSq += values[i] * values[i];
    if (i >= period) { sum -= values[i - period]; sumSq -= values[i - period] * values[i - period]; }
    if (i >= period - 1) {
      const m = mid[i] as number;
      const variance = Math.max(sumSq / period - m * m, 0);
      const sd = Math.sqrt(variance);
      const upper = m + k * sd, lower = m - k * sd;
      const pctB = upper === lower ? 0.5 : (values[i] - lower) / (upper - lower);
      const bandwidth = m === 0 ? 0 : (upper - lower) / m;
      out[i] = { upper, mid: m, lower, pctB, bandwidth };
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/research-math/indicators/volatility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/indicators/volatility.ts src/research-math/indicators/volatility.test.ts
git commit -m "feat(research-math): volatility indicators (atr, realizedVol, bollinger)"
```

---

### Task C3: Oscillators (`stochastic`, `adx`)

**Files:**
- Create: `src/research-math/indicators/oscillators.ts`
- Test: `src/research-math/indicators/oscillators.test.ts`

**Interfaces:**
- Produces: `stochastic(highs, lows, closes, kPeriod, dPeriod, smooth): (StochPoint|null)[]`, `StochPoint { k; d }`; `adx(highs, lows, closes, period): (AdxPoint|null)[]`, `AdxPoint { adx; plusDi; minusDi }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { stochastic, adx } from './oscillators.ts';

describe('stochastic', () => {
  it('%K is 100 when close sits at the window high', () => {
    const highs = [2, 3, 4, 5], lows = [1, 1, 1, 1], closes = [2, 3, 4, 5];
    const out = stochastic(highs, lows, closes, 2, 1, 1);
    expect(out.at(-1)!.k).toBeCloseTo(100, 6);
  });
  it('%K and %D stay within [0,100]', () => {
    const h = [5, 6, 7, 6, 5, 6, 7], l = [4, 5, 6, 5, 4, 5, 6], c = [4.5, 5.5, 6.5, 5.5, 4.5, 5.5, 6.5];
    for (const p of stochastic(h, l, c, 3, 2, 1)) {
      if (p) { expect(p.k).toBeGreaterThanOrEqual(0); expect(p.k).toBeLessThanOrEqual(100); }
    }
  });
});

describe('adx', () => {
  it('produces values in [0,100] and +DI dominates a strict uptrend', () => {
    const h = Array.from({ length: 30 }, (_, i) => 10 + i);
    const l = h.map((x) => x - 1);
    const c = h.map((x) => x - 0.5);
    const out = adx(h, l, c, 5);
    const last = out.at(-1)!;
    expect(last.adx).toBeGreaterThanOrEqual(0);
    expect(last.adx).toBeLessThanOrEqual(100);
    expect(last.plusDi).toBeGreaterThan(last.minusDi);
  });
  it('is null until 2*period-1', () => {
    const h = [1, 2, 3, 4], l = [0, 1, 2, 3], c = [0.5, 1.5, 2.5, 3.5];
    expect(adx(h, l, c, 5)).toEqual([null, null, null, null]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/research-math/indicators/oscillators.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
function smaTail(values: readonly (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0, count = 0;
  const buf: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { buf.length = 0; sum = 0; count = 0; continue; } // restart on gap
    buf.push(v); sum += v; count++;
    if (buf.length > period) { sum -= buf.shift() as number; count--; }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

export interface StochPoint { k: number; d: number; }

export function stochastic(
  highs: readonly number[], lows: readonly number[], closes: readonly number[],
  kPeriod: number, dPeriod: number, smooth: number,
): (StochPoint | null)[] {
  const n = closes.length;
  const out: (StochPoint | null)[] = new Array(n).fill(null);
  const rawK: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
    rawK[i] = hh === ll ? 50 : (100 * (closes[i] - ll)) / (hh - ll);
  }
  const kSmoothed = smaTail(rawK, smooth);
  const dLine = smaTail(kSmoothed, dPeriod);
  for (let i = 0; i < n; i++) {
    if (kSmoothed[i] != null && dLine[i] != null) out[i] = { k: kSmoothed[i] as number, d: dLine[i] as number };
  }
  return out;
}

export interface AdxPoint { adx: number; plusDi: number; minusDi: number; }

export function adx(
  highs: readonly number[], lows: readonly number[], closes: readonly number[], period: number,
): (AdxPoint | null)[] {
  const n = closes.length;
  const out: (AdxPoint | null)[] = new Array(n).fill(null);
  if (period <= 0 || n < 2 * period) return out;
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  let trSum = 0, pdmSum = 0, mdmSum = 0;
  for (let i = 1; i <= period; i++) { trSum += tr[i]; pdmSum += plusDM[i]; mdmSum += minusDM[i]; }
  const dx = new Array<number | null>(n).fill(null);
  const pDi = new Array<number | null>(n).fill(null);
  const mDi = new Array<number | null>(n).fill(null);
  const at = (ts: number, pd: number, md: number) => {
    const p = ts === 0 ? 0 : (100 * pd) / ts;
    const m = ts === 0 ? 0 : (100 * md) / ts;
    const denom = p + m;
    return { p, m, dxv: denom === 0 ? 0 : (100 * Math.abs(p - m)) / denom };
  };
  let r = at(trSum, pdmSum, mdmSum);
  dx[period] = r.dxv; pDi[period] = r.p; mDi[period] = r.m;
  for (let i = period + 1; i < n; i++) {
    trSum = trSum - trSum / period + tr[i];
    pdmSum = pdmSum - pdmSum / period + plusDM[i];
    mdmSum = mdmSum - mdmSum / period + minusDM[i];
    r = at(trSum, pdmSum, mdmSum);
    dx[i] = r.dxv; pDi[i] = r.p; mDi[i] = r.m;
  }
  const firstAdx = 2 * period - 1;
  let sum = 0;
  for (let i = period; i <= firstAdx; i++) sum += dx[i] as number;
  let adxPrev = sum / period;
  out[firstAdx] = { adx: adxPrev, plusDi: pDi[firstAdx] as number, minusDi: mDi[firstAdx] as number };
  for (let i = firstAdx + 1; i < n; i++) {
    adxPrev = (adxPrev * (period - 1) + (dx[i] as number)) / period;
    out[i] = { adx: adxPrev, plusDi: pDi[i] as number, minusDi: mDi[i] as number };
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/research-math/indicators/oscillators.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/indicators/oscillators.ts src/research-math/indicators/oscillators.test.ts
git commit -m "feat(research-math): oscillators (stochastic, adx)"
```

---

### Task C4: Levels & derivatives (`swingHighLow`, `fibonacci`, `cvd`, `oiDelta`, `pctChangeOverWindow`, `liquidationAggregates`)

**Files:**
- Create: `src/research-math/indicators/levels.ts`
- Test: `src/research-math/indicators/levels.test.ts`

**Interfaces:**
- Produces: `swingHighLow(highs, lows, window): { swingHigh; swingLow }`; `fibonacci(swingHigh, swingLow): FibLevels` (`{ swingHigh; swingLow; levels: Record<string, number> }`); `cvd(buys, sells): (number|null)[]`; `oiDelta(oi): (number|null)[]`; `pctChangeOverWindow(series, window): number|null`; `liquidationAggregates(longs, shorts): { longTotal; shortTotal; imbalance }`. Inputs that can be missing are `(number|null)[]`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { swingHighLow, fibonacci, cvd, oiDelta, pctChangeOverWindow, liquidationAggregates } from './levels.ts';

describe('fibonacci', () => {
  it('places 0 at the high, 1 at the low, 0.5 at the midpoint', () => {
    const f = fibonacci(100, 0);
    expect(f.levels['0']).toBeCloseTo(100, 10);
    expect(f.levels['1']).toBeCloseTo(0, 10);
    expect(f.levels['0.5']).toBeCloseTo(50, 10);
  });
});

describe('swingHighLow', () => {
  it('returns the max high and min low over the trailing window', () => {
    expect(swingHighLow([1, 5, 3], [0, 2, 1], 3)).toEqual({ swingHigh: 5, swingLow: 0 });
  });
});

describe('cvd', () => {
  it('accumulates buy minus sell, null where taker missing from the start', () => {
    expect(cvd([10, 5, null], [4, 5, null])).toEqual([6, 6, 6]);
    expect(cvd([null, null], [null, null])).toEqual([null, null]);
  });
});

describe('oiDelta + pctChangeOverWindow', () => {
  it('computes per-bar delta and windowed pct change', () => {
    expect(oiDelta([100, 110, 121])).toEqual([null, 10, 11]);
    expect(pctChangeOverWindow([100, 110, 121], 2)).toBeCloseTo(21, 6);
  });
});

describe('liquidationAggregates', () => {
  it('sums sides and computes imbalance', () => {
    expect(liquidationAggregates([50, null], [30, 20])).toEqual({ longTotal: 50, shortTotal: 50, imbalance: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/research-math/indicators/levels.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export function swingHighLow(
  highs: readonly number[], lows: readonly number[], window: number,
): { swingHigh: number; swingLow: number } {
  const n = highs.length;
  const start = Math.max(0, n - window);
  let hi = -Infinity, lo = Infinity;
  for (let i = start; i < n; i++) { if (highs[i] > hi) hi = highs[i]; if (lows[i] < lo) lo = lows[i]; }
  return { swingHigh: hi, swingLow: lo };
}

export interface FibLevels { swingHigh: number; swingLow: number; levels: Record<string, number>; }

const FIB_RATIOS: ReadonlyArray<[string, number]> = [
  ['0', 0], ['0.236', 0.236], ['0.382', 0.382], ['0.5', 0.5], ['0.618', 0.618],
  ['0.786', 0.786], ['1', 1], ['1.272', 1.272], ['1.618', 1.618],
];

export function fibonacci(swingHigh: number, swingLow: number): FibLevels {
  const diff = swingHigh - swingLow;
  const levels: Record<string, number> = {};
  for (const [k, r] of FIB_RATIOS) levels[k] = swingHigh - diff * r;
  return { swingHigh, swingLow, levels };
}

export function cvd(buys: readonly (number | null)[], sells: readonly (number | null)[]): (number | null)[] {
  const n = buys.length;
  const out: (number | null)[] = new Array(n).fill(null);
  let cum = 0, started = false;
  for (let i = 0; i < n; i++) {
    if (buys[i] != null && sells[i] != null) {
      cum += (buys[i] as number) - (sells[i] as number);
      out[i] = cum; started = true;
    } else {
      out[i] = started ? cum : null;
    }
  }
  return out;
}

export function oiDelta(oi: readonly (number | null)[]): (number | null)[] {
  const n = oi.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) if (oi[i] != null && oi[i - 1] != null) out[i] = (oi[i] as number) - (oi[i - 1] as number);
  return out;
}

export function pctChangeOverWindow(series: readonly (number | null)[], window: number): number | null {
  const n = series.length;
  if (n === 0) return null;
  const last = series[n - 1];
  const refIdx = n - 1 - window;
  let ref: number | null = refIdx >= 0 ? series[refIdx] : null;
  if (ref == null) { for (const v of series) { if (v != null) { ref = v; break; } } }
  if (last == null || ref == null || ref === 0) return null;
  return ((last - ref) / ref) * 100;
}

export function liquidationAggregates(
  longs: readonly (number | null)[], shorts: readonly (number | null)[],
): { longTotal: number | null; shortTotal: number | null; imbalance: number | null } {
  let lt = 0, st = 0, anyL = false, anyS = false;
  for (const v of longs) if (v != null) { lt += v; anyL = true; }
  for (const v of shorts) if (v != null) { st += v; anyS = true; }
  const longTotal = anyL ? lt : null;
  const shortTotal = anyS ? st : null;
  const imbalance = longTotal != null && shortTotal != null && lt + st !== 0 ? (lt - st) / (lt + st) : null;
  return { longTotal, shortTotal, imbalance };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/research-math/indicators/levels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/indicators/levels.ts src/research-math/indicators/levels.test.ts
git commit -m "feat(research-math): levels & derivatives (fibonacci, cvd, oiDelta, liquidations)"
```

---

### Task C5: Resampling (`resampleRows`)

**Files:**
- Create: `src/research-math/resample.ts`
- Test: `src/research-math/resample.test.ts`

**Interfaces:**
- Consumes: `CanonicalRowV2` (from the port).
- Produces: `resampleRows(rows: readonly CanonicalRowV2[], tfMs: number): CanonicalRowV2[]` — aggregates finer rows into `tfMs` buckets (open=first, high=max, low=min, close=last; volume/turnover/liq/taker summed null-aware; oi/funding=last non-null; `has_*`=OR). Bucket key = `floor(minute_ts / tfMs) * tfMs`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resampleRows } from './resample.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

function r(ts: number, o: number, h: number, l: number, c: number, v: number, taker?: [number, number]): CanonicalRowV2 {
  return {
    schema_version: 2, minute_ts: ts, symbol: 'BTCUSDT',
    open: o, high: h, low: l, close: c, volume: v, turnover: c * v,
    oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: taker ? taker[0] : null, taker_sell_volume_usd: taker ? taker[1] : null,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: taker != null,
  } as CanonicalRowV2;
}

describe('resampleRows', () => {
  it('aggregates three 1m rows into one 5m bar (OHLC/sum/last/OR)', () => {
    const rows = [
      r(0, 10, 12, 9, 11, 100, [60, 40]),
      r(60_000, 11, 15, 10, 14, 50, undefined),
      r(120_000, 14, 14, 8, 9, 25, [10, 5]),
    ];
    const out = resampleRows(rows, 300_000);
    expect(out).toHaveLength(1);
    const b = out[0];
    expect([b.open, b.high, b.low, b.close]).toEqual([10, 15, 8, 9]);
    expect(b.volume).toBe(175);
    expect(b.taker_buy_volume_usd).toBe(70); // 60 + 10 (null row contributes nothing)
    expect(b.has_taker_flow).toBe(true);     // OR across the bucket
    expect(b.minute_ts).toBe(0);
  });

  it('splits across bucket boundaries', () => {
    const rows = [r(240_000, 1, 1, 1, 1, 1), r(300_000, 2, 2, 2, 2, 1)];
    expect(resampleRows(rows, 300_000).map((x) => x.minute_ts)).toEqual([0, 300_000]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/research-math/resample.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

type Agg = {
  minute_ts: number; symbol: string;
  open: number; high: number; low: number; close: number; closeTs: number;
  volume: number; turnover: number;
  oi: number | null; funding: number | null; oiTs: number; fundingTs: number;
  liqLong: number; liqShort: number; anyLiq: boolean;
  takerBuy: number; takerSell: number; anyTaker: boolean;
  anyOi: boolean; anyFunding: boolean;
};

const addNull = (acc: number, v: number | null): number => (v != null ? acc + v : acc);

export function resampleRows(rows: readonly CanonicalRowV2[], tfMs: number): CanonicalRowV2[] {
  if (rows.length === 0 || tfMs <= 0) return [];
  const sorted = [...rows].sort((a, b) => a.minute_ts - b.minute_ts);
  const buckets = new Map<number, Agg>();
  for (const row of sorted) {
    const key = Math.floor(row.minute_ts / tfMs) * tfMs;
    let a = buckets.get(key);
    if (!a) {
      a = {
        minute_ts: key, symbol: row.symbol,
        open: row.open, high: row.high, low: row.low, close: row.close, closeTs: row.minute_ts,
        volume: row.volume ?? 0, turnover: row.turnover ?? 0,
        oi: row.oi_total_usd, funding: row.funding_rate, oiTs: row.minute_ts, fundingTs: row.minute_ts,
        liqLong: row.liq_long_usd ?? 0, liqShort: row.liq_short_usd ?? 0, anyLiq: row.has_liquidations,
        takerBuy: row.taker_buy_volume_usd ?? 0, takerSell: row.taker_sell_volume_usd ?? 0, anyTaker: row.has_taker_flow,
        anyOi: row.has_oi, anyFunding: row.has_funding,
      };
      buckets.set(key, a);
      continue;
    }
    if (row.high > a.high) a.high = row.high;
    if (row.low < a.low) a.low = row.low;
    if (row.minute_ts >= a.closeTs) { a.close = row.close; a.closeTs = row.minute_ts; }
    a.volume += row.volume ?? 0;
    a.turnover += row.turnover ?? 0;
    a.liqLong = addNull(a.liqLong, row.liq_long_usd); a.liqShort = addNull(a.liqShort, row.liq_short_usd);
    a.anyLiq = a.anyLiq || row.has_liquidations;
    a.takerBuy = addNull(a.takerBuy, row.taker_buy_volume_usd);
    a.takerSell = addNull(a.takerSell, row.taker_sell_volume_usd);
    a.anyTaker = a.anyTaker || row.has_taker_flow;
    if (row.oi_total_usd != null && row.minute_ts >= a.oiTs) { a.oi = row.oi_total_usd; a.oiTs = row.minute_ts; }
    if (row.funding_rate != null && row.minute_ts >= a.fundingTs) { a.funding = row.funding_rate; a.fundingTs = row.minute_ts; }
    a.anyOi = a.anyOi || row.has_oi; a.anyFunding = a.anyFunding || row.has_funding;
  }
  return [...buckets.values()]
    .sort((x, y) => x.minute_ts - y.minute_ts)
    .map((a): CanonicalRowV2 => ({
      schema_version: 2, minute_ts: a.minute_ts, symbol: a.symbol,
      open: a.open, high: a.high, low: a.low, close: a.close, volume: a.volume, turnover: a.turnover,
      oi_total_usd: a.anyOi ? a.oi : null, funding_rate: a.anyFunding ? a.funding : null,
      liq_long_usd: a.anyLiq ? a.liqLong : null, liq_short_usd: a.anyLiq ? a.liqShort : null,
      taker_buy_volume_usd: a.anyTaker ? a.takerBuy : null, taker_sell_volume_usd: a.anyTaker ? a.takerSell : null,
      has_oi: a.anyOi, has_funding: a.anyFunding, has_liquidations: a.anyLiq, has_taker_flow: a.anyTaker,
    } as CanonicalRowV2));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/research-math/resample.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/resample.ts src/research-math/resample.test.ts
git commit -m "feat(research-math): canonical-row resampling"
```

---

### Task C6: Term config + cadence inference + inclusion

**Files:**
- Create: `src/research-math/term-config.ts`
- Test: `src/research-math/term-config.test.ts`

**Interfaces:**
- Consumes: `CanonicalRowV2`.
- Produces: `TermKey = 'micro'|'short'|'swing'|'long'`; `TermConfig` (per spec §5); `TERM_CONFIGS: readonly TermConfig[]`; `inferCadenceMs(rows): number | null` (smallest positive gap between consecutive `minute_ts`); `isTermIncluded(cadenceMs, barCount, cfg): boolean` (`cadenceMs <= cfg.tfMs && barCount >= cfg.minBars`).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { TERM_CONFIGS, inferCadenceMs, isTermIncluded } from './term-config.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

const at = (ts: number) => ({ minute_ts: ts } as CanonicalRowV2);

describe('inferCadenceMs', () => {
  it('returns the smallest gap between timestamps', () => {
    expect(inferCadenceMs([at(0), at(60_000), at(120_000)])).toBe(60_000);
    expect(inferCadenceMs([at(0), at(3_600_000)])).toBe(3_600_000);
    expect(inferCadenceMs([])).toBeNull();
  });
});

describe('isTermIncluded', () => {
  it('includes a term only if cadence ≤ tf and enough bars', () => {
    const micro = TERM_CONFIGS.find((t) => t.key === 'micro')!;
    expect(isTermIncluded(60_000, micro.minBars, micro)).toBe(true);
    expect(isTermIncluded(3_600_000, 9999, micro)).toBe(false); // cadence 1h can't make 1m
    expect(isTermIncluded(60_000, micro.minBars - 1, micro)).toBe(false); // too few bars
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/research-math/term-config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

export type TermKey = 'micro' | 'short' | 'swing' | 'long';

export interface TermConfig {
  readonly key: TermKey;
  readonly label: string;
  readonly tfMs: number;
  readonly maxRows: number;
  readonly minBars: number;
  readonly emaFast: number;
  readonly emaSlow: number;
  readonly rsiPeriod: number;
  readonly atrPeriod: number;
  readonly realizedVolWindow: number;
  readonly macd: readonly [number, number, number];
  readonly bbPeriod: number;
  readonly bbK: number;
  readonly stoch: readonly [number, number, number];
  readonly adxPeriod: number;
  readonly swingWindow: number;
  readonly oiPctWindow: number;
}

const MIN = 60_000;

export const TERM_CONFIGS: readonly TermConfig[] = [
  {
    key: 'micro', label: 'Micro (1m)', tfMs: MIN, maxRows: 30, minBars: 30,
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, realizedVolWindow: 14,
    macd: [8, 21, 5], bbPeriod: 8, bbK: 2, stoch: [5, 3, 3], adxPeriod: 9, swingWindow: 60, oiPctWindow: 30,
  },
  {
    key: 'short', label: 'Short (5m)', tfMs: 5 * MIN, maxRows: 24, minBars: 30,
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, realizedVolWindow: 14,
    macd: [8, 21, 5], bbPeriod: 10, bbK: 2, stoch: [5, 3, 3], adxPeriod: 9, swingWindow: 48, oiPctWindow: 24,
  },
  {
    key: 'swing', label: 'Swing (15m)', tfMs: 15 * MIN, maxRows: 24, minBars: 30,
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, realizedVolWindow: 14,
    macd: [12, 26, 9], bbPeriod: 20, bbK: 2, stoch: [14, 3, 3], adxPeriod: 14, swingWindow: 48, oiPctWindow: 24,
  },
  {
    key: 'long', label: 'Long (1h)', tfMs: 60 * MIN, maxRows: 24, minBars: 28,
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, realizedVolWindow: 14,
    macd: [12, 26, 9], bbPeriod: 20, bbK: 2, stoch: [14, 3, 3], adxPeriod: 14, swingWindow: 48, oiPctWindow: 24,
  },
];

export function inferCadenceMs(rows: readonly Pick<CanonicalRowV2, 'minute_ts'>[]): number | null {
  let min: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].minute_ts - rows[i - 1].minute_ts;
    if (gap > 0 && (min === null || gap < min)) min = gap;
  }
  return min;
}

export function isTermIncluded(cadenceMs: number, barCount: number, cfg: TermConfig): boolean {
  return cadenceMs <= cfg.tfMs && barCount >= cfg.minBars;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/research-math/term-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/term-config.ts src/research-math/term-config.test.ts
git commit -m "feat(research-math): term config + cadence inference"
```

---

### Task D1: `buildMarketContextMath` (assembly)

**Files:**
- Create: `src/research-math/market-context-math.ts`
- Test: `src/research-math/market-context-math.test.ts`

**Interfaces:**
- Consumes: all of C1–C6, `CanonicalRowV2` (port), `Direction` (`../domain/strategy-profile.ts`), `MarketRegime` (`../ports/platform-gateway.port.ts`).
- Produces: types `CoverageFlags`, `TermMathRow`, `TermIndicatorSnapshot`, `TermMath`, `MarketContextMath`, `MarketContextMathInput` (per spec §6); `buildMarketContextMath(input: MarketContextMathInput, nowMs: number): MarketContextMath`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildMarketContextMath } from './market-context-math.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

function series(n: number, cadence: number, withTaker: boolean): CanonicalRowV2[] {
  return Array.from({ length: n }, (_, i) => ({
    schema_version: 2, minute_ts: i * cadence, symbol: 'BTCUSDT',
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
    oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: withTaker ? 6 : null, taker_sell_volume_usd: withTaker ? 4 : null,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: withTaker,
  } as CanonicalRowV2));
}

const base = {
  symbol: 'BTCUSDT', direction: 'long' as const, regime: 'ranging' as const,
  requiredFeatures: ['oi', 'funding', 'cvd'], window: { fromMs: 0, toMs: 1 },
};

describe('buildMarketContextMath', () => {
  it('renders the micro term from dense 1m data with real CVD when taker present', () => {
    const math = buildMarketContextMath({ ...base, rows: series(120, 60_000, true) }, 1_700_000_000_000);
    const micro = math.terms.find((t) => t.config.key === 'micro');
    expect(micro).toBeDefined();
    expect(math.coverage.hasTaker).toBe(true);
    expect(micro!.rows.at(-1)!.cvd).not.toBeNull();
    expect(micro!.rows.length).toBe(micro!.config.maxRows);
  });

  it('drops sub-hour terms and marks CVD n/a for a coarse 1h, taker-less source', () => {
    const math = buildMarketContextMath({ ...base, rows: series(60, 3_600_000, false) }, 1_700_000_000_000);
    expect(math.terms.map((t) => t.config.key)).toEqual(['long']);
    expect(math.coverage.hasTaker).toBe(false);
    expect(math.terms[0].indicators.cvdNet).toBeNull();
    expect(math.notes.some((n) => /taker/i.test(n))).toBe(true);
  });

  it('returns zero terms with a note when there are no rows', () => {
    const math = buildMarketContextMath({ ...base, rows: [] }, 1_700_000_000_000);
    expect(math.terms).toEqual([]);
    expect(math.notes.length).toBeGreaterThan(0);
  });

  it('is deterministic for the same input + nowMs', () => {
    const rows = series(120, 60_000, true);
    const a = buildMarketContextMath({ ...base, rows }, 42);
    const b = buildMarketContextMath({ ...base, rows }, 42);
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/research-math/market-context-math.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';
import type { Direction } from '../domain/strategy-profile.ts';
import type { MarketRegime } from '../ports/platform-gateway.port.ts';
import { ema, rsi, macd, type MacdPoint } from './indicators/trend.ts';
import { atr, realizedVol, bollinger, type BollingerPoint } from './indicators/volatility.ts';
import { stochastic, adx, type StochPoint, type AdxPoint } from './indicators/oscillators.ts';
import {
  swingHighLow, fibonacci, cvd, oiDelta, pctChangeOverWindow, liquidationAggregates, type FibLevels,
} from './indicators/levels.ts';
import { resampleRows } from './resample.ts';
import { TERM_CONFIGS, inferCadenceMs, isTermIncluded, type TermConfig } from './term-config.ts';

export interface CoverageFlags {
  readonly hasOhlc: boolean; readonly hasOi: boolean; readonly hasFunding: boolean;
  readonly hasLiquidations: boolean; readonly hasTaker: boolean;
}

export interface TermMathRow {
  readonly tsMs: number;
  readonly open: number | null; readonly high: number | null; readonly low: number | null; readonly close: number;
  readonly volume: number | null;
  readonly emaFast: number | null; readonly emaSlow: number | null;
  readonly rsi: number | null; readonly atr: number | null;
  readonly oi: number | null; readonly oiDelta: number | null; readonly cvd: number | null;
  readonly liqLong: number | null; readonly liqShort: number | null;
}

export interface TermIndicatorSnapshot {
  readonly close: number;
  readonly emaFast: number | null; readonly emaSlow: number | null;
  readonly emaTrend: 'above' | 'below' | 'cross' | 'unknown';
  readonly rsi: number | null; readonly rsiState: 'overbought' | 'oversold' | 'neutral' | 'unknown';
  readonly atr: number | null; readonly realizedVol: number | null;
  readonly macd: MacdPoint | null; readonly bollinger: BollingerPoint | null;
  readonly stochastic: StochPoint | null; readonly adx: AdxPoint | null;
  readonly fibonacci: FibLevels | null;
  readonly oiChangePct: number | null; readonly funding: number | null;
  readonly cvdNet: number | null; readonly cvdTrend: 'rising' | 'falling' | 'flat' | 'unknown';
  readonly liqLongTotal: number | null; readonly liqShortTotal: number | null; readonly liqImbalance: number | null;
}

export interface TermMath {
  readonly config: TermConfig; readonly barCount: number;
  readonly rows: readonly TermMathRow[]; readonly indicators: TermIndicatorSnapshot; readonly coverage: CoverageFlags;
}

export interface MarketContextMath {
  readonly symbol: string; readonly generatedAtMs: number;
  readonly window: { fromMs: number; toMs: number };
  readonly direction: Direction; readonly regime: MarketRegime;
  readonly requiredFeatures: readonly string[];
  readonly coverage: CoverageFlags; readonly terms: readonly TermMath[]; readonly notes: readonly string[];
}

export interface MarketContextMathInput {
  readonly symbol: string; readonly rows: readonly CanonicalRowV2[];
  readonly direction: Direction; readonly regime: MarketRegime;
  readonly requiredFeatures: readonly string[];
  readonly window: { fromMs: number; toMs: number };
  readonly terms?: readonly TermConfig[];
}

function coverageOf(rows: readonly CanonicalRowV2[]): CoverageFlags {
  return {
    hasOhlc: rows.some((r) => r.open != null && r.high != null && r.low != null),
    hasOi: rows.some((r) => r.has_oi),
    hasFunding: rows.some((r) => r.has_funding),
    hasLiquidations: rows.some((r) => r.has_liquidations),
    hasTaker: rows.some((r) => r.has_taker_flow),
  };
}

function rsiState(v: number | null): TermIndicatorSnapshot['rsiState'] {
  if (v == null) return 'unknown';
  if (v >= 70) return 'overbought';
  if (v <= 30) return 'oversold';
  return 'neutral';
}

function emaTrend(fast: number | null, slow: number | null): TermIndicatorSnapshot['emaTrend'] {
  if (fast == null || slow == null) return 'unknown';
  if (Math.abs(fast - slow) / (Math.abs(slow) || 1) < 1e-6) return 'cross';
  return fast > slow ? 'above' : 'below';
}

function cvdTrendOf(cvdSeries: readonly (number | null)[]): TermIndicatorSnapshot['cvdTrend'] {
  const defined = cvdSeries.filter((v): v is number => v != null);
  if (defined.length < 2) return 'unknown';
  const d = defined[defined.length - 1] - defined[0];
  if (Math.abs(d) < 1e-9) return 'flat';
  return d > 0 ? 'rising' : 'falling';
}

function buildTerm(rows: readonly CanonicalRowV2[], cfg: TermConfig): TermMath {
  const cov = coverageOf(rows);
  const closes = rows.map((r) => r.close);
  const highs = rows.map((r) => r.high);
  const lows = rows.map((r) => r.low);
  const oiArr = rows.map((r) => (r.has_oi ? r.oi_total_usd : null));
  const buys = rows.map((r) => (r.has_taker_flow ? r.taker_buy_volume_usd : null));
  const sells = rows.map((r) => (r.has_taker_flow ? r.taker_sell_volume_usd : null));
  const liqL = rows.map((r) => (r.has_liquidations ? r.liq_long_usd : null));
  const liqS = rows.map((r) => (r.has_liquidations ? r.liq_short_usd : null));

  const emaF = ema(closes, cfg.emaFast);
  const emaS = ema(closes, cfg.emaSlow);
  const rsiArr = rsi(closes, cfg.rsiPeriod);
  const atrArr = cov.hasOhlc ? atr(highs, lows, closes, cfg.atrPeriod) : new Array(rows.length).fill(null);
  const rvArr = realizedVol(closes, cfg.realizedVolWindow);
  const macdArr = macd(closes, cfg.macd[0], cfg.macd[1], cfg.macd[2]);
  const bbArr = bollinger(closes, cfg.bbPeriod, cfg.bbK);
  const stochArr = cov.hasOhlc ? stochastic(highs, lows, closes, cfg.stoch[0], cfg.stoch[1], cfg.stoch[2]) : new Array(rows.length).fill(null);
  const adxArr = cov.hasOhlc ? adx(highs, lows, closes, cfg.adxPeriod) : new Array(rows.length).fill(null);
  const cvdArr = cov.hasTaker ? cvd(buys, sells) : new Array(rows.length).fill(null);
  const oiDeltaArr = oiDelta(oiArr);

  const tableRows: TermMathRow[] = rows.map((r, i) => ({
    tsMs: r.minute_ts,
    open: r.open ?? null, high: r.high ?? null, low: r.low ?? null, close: r.close, volume: r.volume ?? null,
    emaFast: emaF[i], emaSlow: emaS[i], rsi: rsiArr[i], atr: atrArr[i],
    oi: cov.hasOi ? r.oi_total_usd : null, oiDelta: oiDeltaArr[i], cvd: cvdArr[i],
    liqLong: cov.hasLiquidations ? r.liq_long_usd : null, liqShort: cov.hasLiquidations ? r.liq_short_usd : null,
  })).slice(-cfg.maxRows);

  const last = rows.length - 1;
  const swing = cov.hasOhlc ? swingHighLow(highs, lows, cfg.swingWindow) : null;
  const liq = liquidationAggregates(liqL, liqS);
  const indicators: TermIndicatorSnapshot = {
    close: closes[last],
    emaFast: emaF[last], emaSlow: emaS[last], emaTrend: emaTrend(emaF[last], emaS[last]),
    rsi: rsiArr[last], rsiState: rsiState(rsiArr[last]),
    atr: atrArr[last], realizedVol: rvArr[last],
    macd: macdArr[last], bollinger: bbArr[last], stochastic: stochArr[last], adx: adxArr[last],
    fibonacci: swing ? fibonacci(swing.swingHigh, swing.swingLow) : null,
    oiChangePct: cov.hasOi ? pctChangeOverWindow(oiArr, cfg.oiPctWindow) : null,
    funding: cov.hasFunding ? (rows[last].funding_rate ?? null) : null,
    cvdNet: cov.hasTaker ? (cvdArr[last] ?? null) : null, cvdTrend: cov.hasTaker ? cvdTrendOf(cvdArr) : 'unknown',
    liqLongTotal: liq.longTotal, liqShortTotal: liq.shortTotal, liqImbalance: liq.imbalance,
  };

  return { config: cfg, barCount: rows.length, rows: tableRows, indicators, coverage: cov };
}

export function buildMarketContextMath(input: MarketContextMathInput, nowMs: number): MarketContextMath {
  const configs = input.terms ?? TERM_CONFIGS;
  const overall = coverageOf(input.rows);
  const notes: string[] = [];
  const terms: TermMath[] = [];
  const cadence = inferCadenceMs(input.rows);

  if (input.rows.length === 0 || cadence == null) {
    notes.push('No market history rows available for this symbol/window.');
    return {
      symbol: input.symbol, generatedAtMs: nowMs, window: input.window,
      direction: input.direction, regime: input.regime, requiredFeatures: input.requiredFeatures,
      coverage: overall, terms: [], notes,
    };
  }

  for (const cfg of configs) {
    const resampled = cfg.tfMs === cadence ? [...input.rows] : resampleRows(input.rows, cfg.tfMs);
    if (!isTermIncluded(cadence, resampled.length, cfg)) {
      if (cadence > cfg.tfMs) notes.push(`Term ${cfg.label} skipped: source cadence ${Math.round(cadence / 60_000)}m is coarser than the term timeframe.`);
      else notes.push(`Term ${cfg.label} skipped: only ${resampled.length} bars (need ${cfg.minBars}).`);
      continue;
    }
    terms.push(buildTerm(resampled, cfg));
  }

  if (!overall.hasTaker) notes.push('Taker flow absent in this source → CVD shown as n/a.');
  if (!overall.hasOhlc) notes.push('OHLC high/low absent → ATR/Stochastic/ADX/Fibonacci shown as n/a.');

  return {
    symbol: input.symbol, generatedAtMs: nowMs, window: input.window,
    direction: input.direction, regime: input.regime, requiredFeatures: input.requiredFeatures,
    coverage: overall, terms, notes,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/research-math/market-context-math.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/market-context-math.ts src/research-math/market-context-math.test.ts
git commit -m "feat(research-math): buildMarketContextMath assembly"
```

---

### Task D2: `formatMarketContextMath` (markdown)

**Files:**
- Create: `src/research-math/format-market-context-math.ts`
- Test: `src/research-math/format-market-context-math.test.ts`

**Interfaces:**
- Consumes: `MarketContextMath`, `TermMath`, `TermMathRow` (D1).
- Produces: `formatMarketContextMath(math: MarketContextMath): string`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildMarketContextMath } from './market-context-math.ts';
import { formatMarketContextMath } from './format-market-context-math.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

function series(n: number, cadence: number, withTaker: boolean): CanonicalRowV2[] {
  return Array.from({ length: n }, (_, i) => ({
    schema_version: 2, minute_ts: i * cadence, symbol: 'BTCUSDT',
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
    oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: withTaker ? 6 : null, taker_sell_volume_usd: withTaker ? 4 : null,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: withTaker,
  } as CanonicalRowV2));
}

const base = {
  symbol: 'BTCUSDT', direction: 'long' as const, regime: 'ranging' as const,
  requiredFeatures: ['oi', 'funding', 'cvd'], window: { fromMs: 0, toMs: 7_200_000 },
};

describe('formatMarketContextMath', () => {
  it('emits a header, the required features, a coverage line and one section per term', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: series(120, 60_000, true) }, 0));
    expect(md).toContain('## Market Context: BTCUSDT');
    expect(md).toContain('bias: long');
    expect(md).toContain('Required features: oi, funding, cvd');
    expect(md).toContain('### Micro (1m)');
    expect(md).toMatch(/\| ts \|/);
  });

  it('renders n/a for CVD and a Notes block when taker is absent', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: series(60, 3_600_000, false) }, 0));
    expect(md).toContain('### Long (1h)');
    expect(md.toLowerCase()).toContain('n/a');
    expect(md).toContain('> Notes:');
  });

  it('is deterministic', () => {
    const rows = series(120, 60_000, true);
    expect(formatMarketContextMath(buildMarketContextMath({ ...base, rows }, 0)))
      .toEqual(formatMarketContextMath(buildMarketContextMath({ ...base, rows }, 0)));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/research-math/format-market-context-math.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { MarketContextMath, TermMath, TermMathRow } from './market-context-math.ts';

function num(v: number | null, digits = 2): string {
  return v == null ? 'n/a' : Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function summaryLine(t: TermMath): string {
  const i = t.indicators;
  const parts = [
    `EMA${'​'}fast/slow ${num(i.emaFast)}/${num(i.emaSlow)} (${i.emaTrend})`,
    `RSI ${num(i.rsi)} (${i.rsiState})`,
    `ATR ${num(i.atr)}`,
    `realizedVol ${i.realizedVol == null ? 'n/a' : (i.realizedVol * 100).toFixed(3) + '%'}`,
    i.macd ? `MACD ${num(i.macd.line)}/${num(i.macd.signal)}/${num(i.macd.hist)}` : 'MACD n/a',
    i.bollinger ? `BB %B ${num(i.bollinger.pctB)} bw ${(i.bollinger.bandwidth * 100).toFixed(2)}%` : 'BB n/a',
    i.stochastic ? `Stoch ${num(i.stochastic.k)}/${num(i.stochastic.d)}` : 'Stoch n/a',
    i.adx ? `ADX ${num(i.adx.adx)} (+DI ${num(i.adx.plusDi)} -DI ${num(i.adx.minusDi)})` : 'ADX n/a',
    i.fibonacci ? `Fib 0.618=${num(i.fibonacci.levels['0.618'])}` : 'Fib n/a',
    `OIΔ ${i.oiChangePct == null ? 'n/a' : i.oiChangePct.toFixed(2) + '%'}`,
    `CVD ${i.cvdNet == null ? 'n/a' : num(i.cvdNet) + ' (' + i.cvdTrend + ')'}`,
    `liq L/S ${num(i.liqLongTotal)}/${num(i.liqShortTotal)} (imb ${num(i.liqImbalance)})`,
    `funding ${i.funding == null ? 'n/a' : i.funding}`,
  ];
  return parts.join(' · ');
}

function rowLine(r: TermMathRow): string {
  return `| ${isoMinute(r.tsMs)} | ${num(r.open)} | ${num(r.high)} | ${num(r.low)} | ${num(r.close)} | ${num(r.volume, 0)} | ${num(r.emaFast)} | ${num(r.emaSlow)} | ${num(r.rsi)} | ${num(r.atr)} | ${num(r.oi, 0)} | ${num(r.oiDelta, 0)} | ${r.cvd == null ? 'n/a' : num(r.cvd, 0)} | ${num(r.liqLong, 0)} | ${num(r.liqShort, 0)} |`;
}

function termSection(t: TermMath): string {
  const header = `### ${t.config.label} · ${t.barCount} bars`;
  const cols = `| ts | open | high | low | close | vol | ema${t.config.emaFast} | ema${t.config.emaSlow} | rsi${t.config.rsiPeriod} | atr${t.config.atrPeriod} | oi | oiΔ | cvd | liqL | liqS |`;
  const sep = `|----|------|------|-----|-------|-----|------|-------|-------|-------|----|-----|-----|------|------|`;
  return [header, summaryLine(t), '', cols, sep, ...t.rows.map(rowLine)].join('\n');
}

export function formatMarketContextMath(math: MarketContextMath): string {
  const c = math.coverage;
  const cov = `Coverage: OHLC ${c.hasOhlc ? '✓' : '✗'} · OI ${c.hasOi ? '✓' : '✗'} · funding ${c.hasFunding ? '✓' : '✗'} · liquidations ${c.hasLiquidations ? '✓' : '✗'} · taker ${c.hasTaker ? '✓' : '✗'}`;
  const lines: string[] = [
    `## Market Context: ${math.symbol} — regime: ${math.regime} · bias: ${math.direction}`,
    `Required features: ${math.requiredFeatures.join(', ') || '(none)'}`,
    cov,
    `Window: ${isoMinute(math.window.fromMs)} → ${isoMinute(math.window.toMs)}`,
    '',
  ];
  for (const t of math.terms) { lines.push(termSection(t), ''); }
  if (math.notes.length > 0) lines.push(`> Notes: ${math.notes.join(' ')}`);
  return lines.join('\n').trimEnd() + '\n';
}
```

> Note: `formatMarketContextMath` uses `new Date(ms)` with an explicit `ms` argument — this is pure (no argless `new Date()`), so determinism holds.
>
> Correction: in `summaryLine`, the first array entry's template literal must read exactly `EMA ${num(i.emaFast)}/${num(i.emaSlow)} (${i.emaTrend})` — one plain ASCII space after `EMA`, with no stray or zero-width characters.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/research-math/format-market-context-math.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/format-market-context-math.ts src/research-math/format-market-context-math.test.ts
git commit -m "feat(research-math): formatMarketContextMath markdown renderer"
```

---

### Task E1: `ResearcherInput` field + `buildPrompt` injection

**Files:**
- Modify: `src/ports/researcher.port.ts` (add field + import)
- Modify: `src/adapters/researcher/mastra-researcher.ts` (`buildPrompt`)
- Test: `src/adapters/researcher/mastra-researcher.test.ts` (extend)

**Interfaces:**
- Consumes: `MarketContextMath` (D1), `formatMarketContextMath` (D2).
- Produces: `ResearcherInput.marketContextMath?: MarketContextMath`.

- [ ] **Step 1: Add the field to the port**

In `src/ports/researcher.port.ts`, add the import and the optional field:

```ts
import type { MarketContextMath } from '../research-math/market-context-math.ts';
// ... inside ResearcherInput:
  marketContextMath?: MarketContextMath;
```

- [ ] **Step 2: Write the failing buildPrompt tests**

Add to `mastra-researcher.test.ts`:

```ts
import { buildMarketContextMath } from '../../research-math/market-context-math.ts';
// (reuse an existing makeInput helper in this file, or inline a minimal ResearcherInput)

it('injects the formatted market-context block when marketContextMath is present', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    schema_version: 2, minute_ts: i * 60_000, symbol: 'BTCUSDT',
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
    oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
  }));
  const math = buildMarketContextMath({
    symbol: 'BTCUSDT', rows: rows as any, direction: 'long', regime: 'ranging',
    requiredFeatures: ['oi'], window: { fromMs: 0, toMs: 1 },
  }, 0);
  const prompt = buildPrompt({ ...makeBaseInput(), marketContextMath: math });
  expect(prompt).toContain('## Market Context: BTCUSDT');
  expect(prompt).not.toContain('Market context features: {'); // raw JSON line replaced
});

it('falls back to the raw features line when marketContextMath is absent', () => {
  const prompt = buildPrompt(makeBaseInput());
  expect(prompt).toContain('Market context features:');
});
```

> If the test file lacks a `makeBaseInput()` helper, add one that returns a minimal valid `ResearcherInput` (profile, marketContext `{symbol,ts,features:{}}`, marketRegime, similarHypotheses `[]`, maxHypotheses 2).

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts`
Expected: FAIL (block not injected / raw line still present).

- [ ] **Step 4: Modify `buildPrompt`**

In `src/adapters/researcher/mastra-researcher.ts`, add the import:

```ts
import { formatMarketContextMath } from '../../research-math/format-market-context-math.ts';
```

Replace the market-context features line (currently `` `Market context features: ${JSON.stringify(input.marketContext.features)}` ``) with a conditional:

```ts
    input.marketContextMath
      ? formatMarketContextMath(input.marketContextMath)
      : `Market context features: ${JSON.stringify(input.marketContext.features)}`,
```

(Keep `Market regime: ${input.marketRegime}` as-is; the block already restates regime but the standalone line is harmless and preserves the existing contract.)

- [ ] **Step 5: Run to verify pass + snapshot update**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts`
Expected: PASS. If an existing snapshot covers `buildPrompt`, update it: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts -u`.

- [ ] **Step 6: Commit**

```bash
git add src/ports/researcher.port.ts src/adapters/researcher/mastra-researcher.ts src/adapters/researcher/mastra-researcher.test.ts
git commit -m "feat(research-math): inject market-context math block into researcher prompt"
```

---

### Task E2: Handler — fetch history, build math, attach

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts`
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (extend)

**Interfaces:**
- Consumes: `services.marketHistory` (B2), `buildMarketContextMath` (D1), `MARKET_HISTORY_LOOKBACK_DAYS`.
- Produces: `marketContextMath` on the `propose(...)` input; `researcher.market_history_unavailable` event on failure.

- [ ] **Step 1: Write the failing handler test**

Extend the handler test with a fake `marketHistory` that returns dense 1m rows, and assert the researcher received `marketContextMath`. Use the existing handler-test harness (fakes for platform/botResults/etc.); add:

```ts
const marketHistory = {
  getRows: async () => Array.from({ length: 60 }, (_, i) => ({
    schema_version: 2, minute_ts: i * 60_000, symbol: 'BTCUSDT',
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
    oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
  })),
};
// capture what propose() received:
let captured: any;
const researcher = { adapter: 'fake', model: 'x', propose: async (input: any) => { captured = input; return { hypotheses: [], researchSummary: '' }; } };
// ... run the handler with services including marketHistory + researcher ...
expect(captured.marketContextMath).toBeDefined();
expect(captured.marketContextMath.terms.length).toBeGreaterThan(0);
```

Add a second test: when `marketHistory.getRows` throws, the handler still calls `propose` (with `marketContextMath` undefined) and does not crash.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: FAIL (`captured.marketContextMath` undefined).

- [ ] **Step 3: Implement the handler change**

After `marketContext` / `marketRegime` are fetched and before the `propose(...)` call, add (mirroring the existing `tradeEvidence` try/catch):

```ts
let marketContextMath;
try {
  const lookbackDays = Number(process.env.MARKET_HISTORY_LOOKBACK_DAYS ?? '7');
  const toMs = Date.parse(ts);
  const fromMs = toMs - lookbackDays * 86_400_000;
  const rows = await services.marketHistory.getRows({ symbol, fromMs, toMs });
  marketContextMath = buildMarketContextMath({
    symbol, rows,
    direction: profile.direction,
    regime: marketRegime,
    requiredFeatures: profile.requiredMarketFeatures,
    window: { fromMs, toMs },
  }, Date.now());
} catch (err) {
  services.events?.emit?.({ type: 'researcher.market_history_unavailable', correlationId: task.correlationId });
  marketContextMath = undefined;
}
```

Add the import at the top:

```ts
import { buildMarketContextMath } from '../../research-math/market-context-math.ts';
```

Add `marketContextMath` to the `propose(...)` object literal:

```ts
output = await services.researcher.propose({
  profile, marketContext, marketRegime, similarHypotheses, botResults, tradeEvidence,
  maxHypotheses: effectiveMax, marketContextMath,
}, makeOnUsage(task, services));
```

> Match the exact event-emit shape used by the existing `researcher.trade_evidence_unavailable` emission in this file; copy that call's structure rather than the placeholder above.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(research-math): build market-context math in the research handler"
```

---

### Task E3: Commit the rendered block as an artifact

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts`
- Modify: `src/orchestrator/app-services.ts` (ensure `artifactStore` is reachable from the handler if not already)
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (extend)

**Interfaces:**
- Consumes: `ArtifactStore.put` (confirm signature in `src/ports/*artifact*.ts`), `formatMarketContextMath` (D2).
- Produces: an `ArtifactRef` persisted for the cycle (best-effort; never fails the cycle).

- [ ] **Step 1: Confirm the `ArtifactStore.put` signature**

Read `src/adapters/artifact/in-memory-artifact-store.ts` and its port to get `put`'s exact parameters (content, content-type/kind, naming) and return type. Use that exact signature in Steps 2–3.

- [ ] **Step 2: Write the failing test**

Using `InMemoryArtifactStore`, assert that after a successful cycle with non-empty `marketContextMath`, exactly one artifact whose content contains `## Market Context:` was `put`. Assert that when `put` throws, the cycle still completes (best-effort).

```ts
import { InMemoryArtifactStore } from '../../adapters/artifact/in-memory-artifact-store.ts';
// inject artifactStore into services; after running the handler:
const stored = artifactStore.list?.() ?? /* inspect via the store's get/keys */;
expect(stored.some((a) => a.content.includes('## Market Context:'))).toBe(true);
```

- [ ] **Step 3: Implement the commit**

After `marketContextMath` is built (Task E2) and is non-undefined with at least one term, render + persist best-effort:

```ts
if (marketContextMath && marketContextMath.terms.length > 0) {
  try {
    const markdown = formatMarketContextMath(marketContextMath);
    await services.artifactStore.put(/* exact args per Step 1: e.g. */ {
      content: markdown, contentType: 'text/markdown',
      name: `market-context-math/${task.correlationId}.md`,
    });
  } catch { /* best-effort: never fail the cycle on artifact commit */ }
}
```

Add the import:

```ts
import { formatMarketContextMath } from '../../research-math/format-market-context-math.ts';
```

> Phoenix attach: if the handler already runs inside a traced span (observability shipped), add the artifact URI / a short digest as a span attribute next to where other research-cycle attributes are set. If there is no obvious span handle in this handler, leave a one-line `// TODO(phoenix): attach artifact ref to span` ONLY here is not allowed — instead, follow the existing pattern used by `completion-summary` artifact commits; if none exists in this handler, the artifact `put` alone satisfies the "commit" criterion and Phoenix attachment is deferred to a follow-up noted in the spec §14.

- [ ] **Step 4: Run to verify pass + full suite**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Then the whole suite: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts src/orchestrator/app-services.ts
git commit -m "feat(research-math): commit market-context math markdown as an artifact"
```

---

## Follow-up (out of scope for this plan)

- **Phase F — GARCH(1,1):** add `garch?: { sigmaForecast; expectedMovePct }` to `TermIndicatorSnapshot`; clean-room MLE/variance-targeting fit over close returns; surface in the summary line. Separate PR.
- **Indicator long tail:** CCI/DEMA/WMA/Squeeze/Pressure/pivots — add to the relevant `indicators/*` module by demand (spec §11 Phase E).
- **Sub-project 2 (trading-mock-platform):** extend `fetch-snapshot` to acquire taker + emit dense 1m `rowsBySymbol`; commit a multi-thousand-row fixture so the demo shows full multi-term + CVD. Own spec.
- **Sub-project 3 (DCA signal-graph):** volume-anomaly (Hawkes/CUSUM/BOCPD) + GARCH source + `outputNode`; needs a new tick/aggTrade source. Own spec.

---

## Self-Review

**Spec coverage:** §3 architecture → Tasks B1–E3; §4 plumbing → B1/B2; §5 engine → C1–C6; §6 model → D1; §7 format → D2; §8 integration → E1–E3; §9 determinism/coverage-honesty → enforced in D1/D2 + tests; §10 decomposition → Follow-up section; §11 roadmap B–E → this plan, F → Follow-up. Success criteria 1–6 (§13) covered by D2/E1 (markdown replaces JSON), C2/C4 (real ATR/CVD), D1 (data-driven terms + notes), E3 (artifact), C* purity (no deps), E1/E2 tests (no regression).

**Placeholder scan:** Indicator/resample/build/format code is complete. Two deliberate "confirm exact signature" notes remain (B2 `HistoricalClient` ctor; E3 `ArtifactStore.put`) — these are read-then-use steps against vendored/existing code, not invented APIs, and each task says where to read the real shape. The E3 Phoenix note explicitly degrades to "artifact `put` alone satisfies the criterion" so there is no unimplementable step.

**Type consistency:** `TermMathRow` uses `emaFast/emaSlow/rsi/atr` consistently in D1 and D2; `MacdPoint/BollingerPoint/StochPoint/AdxPoint/FibLevels` defined in C1–C4 and consumed by name in D1; `CanonicalRowV2` re-exported in B1 and imported from the port everywhere; `CoverageFlags` fields (`hasOhlc/hasOi/hasFunding/hasLiquidations/hasTaker`) consistent across D1/D2.
