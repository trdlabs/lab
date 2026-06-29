# Design: per-trade market-context math + researcher capability menu

- **Date:** 2026-06-29
- **Status:** Approved design (brainstorming complete) → ready for implementation plan
- **Owner:** Alexander Nikolskiy
- **Parent:** `commitXTermMath` engine (PR #99 + Phase E #103 + precision #106, all on `main`). Found by tracing what the researcher actually receives.
- **Scope:** Give the strategy researcher, for each losing trade it already gets as forensic evidence, the indicator suite + rich market fields computed **on that trade's own window** (aligned to the trade, not a separate symbol-level snapshot), and add an explicit capability menu to the researcher's system prompt. One spec, three folded parts (A per-trade indicators, B rich per-minute fields, C capability menu).

---

## 1. Context & problem

The research cycle (`research-run-cycle.handler.ts`) sends the researcher (`buildPrompt`, `mastra-researcher.ts`):
- the strategy profile, market regime, similar past hypotheses, a bot-results digest;
- a **symbol-level `marketContextMath`** block — the full indicator suite over a recent window `[ts−7d, ts]` (multi-term 1m/5m/15m/1h), with a Coverage line and per-term summaries;
- **forensic trade evidence** for the worst losing trades (`selectSuspiciousTradeIds`: `realizedPnl < 0`, sorted worst-first, top `TRADE_EVIDENCE_MAX = 5`): per trade — entry/exit price, pnl, holding, closeReason, lifecycle events, and a per-minute context window of **raw `close / volume / oi / liqLong / liqShort` only**.

Two gaps surfaced:
1. **Indicators are never aligned to the trades.** They live only in the symbol-level recent-window block; the per-trade minute context carries no indicators and no `taker / funding / high / low`. So the researcher cannot see "what RSI/ATR/MACD/Pivots/CVD read **when this trade entered and lost**".
2. **No explicit capability menu.** The researcher's system prompt (`researcher.agent.ts`) lists only the terse `LAB_FEATURE_CATALOG`; the richer curated `PLATFORM_DATA_CAPABILITIES` is injected only into the critic/refiner agents, and no indicator menu exists. The LLM infers available indicators from numbers in the block rather than being told.

**Design pivot (decided):** reuse the existing, proven math engine (`buildMarketContextMath` + indicators + `priceNum`) on each losing trade's window, fetched via the existing `MarketHistoryReadPort.getRows` (which returns the full `CanonicalRowV2` — OHLCV + oi + funding + liq + taker). This delivers indicators **and** the rich fields in one move (A+B), with zero new indicator math.

---

## 2. Goals / non-goals

**Goals**
1. For each selected losing trade, compute the indicator suite over its own window `[entryMs − warmup, exitMs]` and surface, per term (micro 1m + short 5m): an indicator **snapshot at the entry bar** and **at the exit bar**, plus a short micro-bar table of the trade's trajectory — coverage-honest (`n/a` driven by the same flags).
2. Inject this per-trade context into the researcher prompt **alongside** the existing forensic evidence (pnl + lifecycle + closeReason stay).
3. Give the researcher an explicit `RESEARCHER_CAPABILITIES` menu (available data dimensions + indicator names) in its system prompt.
4. Reuse the existing engine and formatter helpers; zero new indicator math; pure/deterministic; both gates green.

**Non-goals**
- No change to the symbol-level `marketContextMath` block (it stays as the "current market structure" view).
- No change to the indicator functions, `term-config`, or `format-market-context-math`'s table (only reuse).
- No widening of the narrow `TradeMinuteContextPoint` / trade-evidence read port — per-trade context uses `MarketHistoryReadPort` instead, which already carries the rich fields.
- No swing/long terms per trade (a single trade's window won't hold enough 15m/1h bars; coverage-honest drop).
- No GARCH, no new data source, no new runtime dependency.

---

## 3. Architecture & data flow

```
research-run-cycle.handler.ts
  ├─ botResults (existing)
  ├─ select worst-N losing trade ids (existing selectSuspiciousTradeIds — UNCHANGED)
  ├─ tradeEvidence = getTradeEvidence(ids)            (existing: pnl + lifecycle + raw minute ctx — UNCHANGED)
  ├─ for each fetched TradeEvidenceBundle with closedAtMs != null (≤ TRADE_EVIDENCE_MAX):   [NEW]
  │     window = [bundle.enteredAtMs − warmupMs, bundle.closedAtMs]
  │     rows = marketHistory.getRows({ symbol: bundle.symbol, fromMs, toMs })   (full CanonicalRowV2)
  │     tradeContext = buildTradeContextMath({ rows, entryMs, exitMs, ... }, nowMs)
  │     (graceful try/catch per trade; a failure drops that trade's context, never the cycle)
  ├─ researcher.propose({ ..., tradeEvidence, tradeContexts? }, opts)                    [NEW field]
  └─ (artifact commit of the symbol-level block stays as-is)
            │
            ▼
   mastra-researcher.ts buildPrompt(input)
     └─ ... forensic evidence ... + (input.tradeContexts ? per-trade math sections : nothing)
   researcher.agent.ts INSTRUCTIONS += RESEARCHER_CAPABILITIES                           [NEW]
```

**Source = the already-fetched `TradeEvidenceBundle`** (no new selection / no `ClosedTrade` plumbing): each bundle carries `symbol`, `enteredAtMs` (entry), `closedAtMs` (exit, `number | null`), `realizedPnl`/`pnlPct` (string), and `closeReason`. The per-trade window uses `enteredAtMs`/`closedAtMs`; the **symbol is the bundle's own** (correct even if a run mixes symbols). Bundles with `closedAtMs == null` (still-open) are skipped. `realizedPnl`/`pnlPct` strings are parsed to numbers (`pnlPct → null` when non-finite).

**Module layout (new):**
```
src/research-math/trade-context-math.ts          # buildTradeContextMath + TradeContextMath type   [pure]
src/research-math/format-trade-context-math.ts    # formatTradeContextMath(markdown)                 [pure]
src/mastra/agents/researcher-capabilities.ts      # RESEARCHER_CAPABILITIES menu string
```
Edits: `ResearcherInput` (+`tradeContexts?`), `mastra-researcher.ts buildPrompt` (inject), `researcher.agent.ts` (append menu), `research-run-cycle.handler.ts` (gather per-trade context).

---

## 4. The per-trade engine (Phase A+B) — reuse, no new math

`trade-context-math.ts`:

```ts
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';
import type { Direction } from '../domain/strategy-profile.ts';
import type { MarketRegime } from '../ports/platform-gateway.port.ts';
import { buildMarketContextMath, type TermMath, type TermMathRow } from './market-context-math.ts';
import { TERM_CONFIGS, type TermConfig } from './term-config.ts';

/** micro(1m)+short(5m) only — a single trade's window can't hold enough swing/long bars. */
export const TRADE_TERM_CONFIGS: readonly TermConfig[] =
  TERM_CONFIGS.filter((t) => t.key === 'micro' || t.key === 'short');

export interface TradeContextMath {
  readonly tradeId: string;
  readonly symbol: string;
  readonly entryMs: number;
  readonly exitMs: number;
  readonly realizedPnl: number;
  readonly pnlPct: number | null;
  readonly closeReason: string | null;
  readonly atEntry: readonly TermMath[];   // indicator snapshots at the entry bar (per term)
  readonly atExit: readonly TermMath[];    // indicator snapshots at the exit bar (per term)
  readonly microRows: readonly TermMathRow[]; // last N micro(1m) rows through exit (trajectory)
  readonly notes: readonly string[];          // coverage-honest gaps (warmup-too-short, taker absent, …)
}

export interface TradeContextMathInput {
  readonly tradeId: string; readonly symbol: string;
  readonly rows: readonly CanonicalRowV2[];
  readonly entryMs: number; readonly exitMs: number;
  readonly realizedPnl: number; readonly pnlPct: number | null; readonly closeReason: string | null;
  readonly direction: Direction; readonly regime: MarketRegime;
  readonly requiredFeatures: readonly string[];
  readonly microTableRows?: number; // default 10
}

export function buildTradeContextMath(input: TradeContextMathInput, nowMs: number): TradeContextMath;
```

Mechanism (maximal reuse of the audited engine — `buildTradeContextMath` orchestrates, computes nothing itself):
- **`atEntry`**: find the entry-bar index `entryIdx = last i where rows[i].minute_ts <= entryMs`; call
  `buildMarketContextMath({ symbol, rows: rows.slice(0, entryIdx + 1), direction, regime, requiredFeatures, window: { fromMs: rows[0].minute_ts, toMs: entryMs }, terms: TRADE_TERM_CONFIGS }, nowMs).terms`.
  Because the engine snapshots the **last** bar, truncating at `entryIdx` makes the entry bar the snapshot bar → indicators "as of entry". A term with too few warmup bars before entry is dropped by the engine's `minBars` gate → a coverage note (honest).
- **`atExit`**: same call on the full `rows` (snapshot = last bar ≈ exit) → `.terms`; the micro term's `.rows` (last `microTableRows`) become `microRows`.
- **`notes`**: union of the two builds' notes, deduped; plus a `warmup` note when a term present at exit is absent at entry.
- Pure, deterministic (`nowMs` passed in). No I/O. No `Date.now`/`Math.random`. `noUncheckedIndexedAccess`-safe (`!`/guards only where loop/length proven; empty `rows` → both term lists empty + a note, never throws).

`TermMathRow` / `TermMath` / `TermIndicatorSnapshot` are imported from `market-context-math.ts` (already exported).

---

## 5. The per-trade formatter (Phase A+B) — `format-trade-context-math.ts`

Reuses `summaryLine`-style rendering and `priceNum` precision (extract/share the existing helpers as needed; if `summaryLine`/`priceNum` are module-private in `format-market-context-math.ts`, export them for reuse rather than duplicating — DRY). Compact, LLM-friendly:

````markdown
### Trade abc123 · ESPORTSUSDT · pnl -42.10 (-3.8%) · close=stop_loss
entry 2026-06-18 14:30 → exit 2026-06-18 15:10 (40m)
@entry  Micro(1m): EMA … RSI … ATR … MACD … BB %B … Stoch … ADX … Fib … Pivots … Squeeze … Pressure … CVD …
@entry  Short(5m): …
@exit   Micro(1m): …
@exit   Short(5m): …
| ts | open | high | low | close | vol | ema9 | ema21 | rsi14 | atr14 | oi | oiΔ | cvd | liqL | liqS |
| …last ~10 micro bars through exit… |
> Notes: <coverage gaps, e.g. taker absent → CVD/Pressure n/a; warmup too short for Short@entry>
````

`formatTradeContextMath(tc: TradeContextMath): string`. A combined `formatTradeContexts(tcs): string` joins sections under a `## Per-trade context (losing trades)` header. `n/a` driven by coverage flags; never fabricated. Bounded by `microTableRows` (default 10) × ≤5 trades × (micro+short summaries).

---

## 6. Integration (Phase A+B + C)

- **`ResearcherInput`** (`src/ports/researcher.port.ts`): add `readonly tradeContexts?: readonly TradeContextMath[];` (additive-optional).
- **`buildPrompt`** (`mastra-researcher.ts`): after `forensicBundleText(input.tradeEvidence)`, when `input.tradeContexts?.length`, append `formatTradeContexts(input.tradeContexts)`. Forensic pnl/lifecycle text stays. Fallback: absent field → nothing added (existing behaviour).
- **Handler** (`research-run-cycle.handler.ts`): the existing `selectSuspiciousTradeIds` + `getTradeEvidence` stay unchanged. After the bundles are fetched, iterate them: for each bundle with `closedAtMs != null`, window = `[enteredAtMs − warmupMs, closedAtMs]`, `rows = marketHistory.getRows({ symbol: bundle.symbol, fromMs, toMs })`, then `buildTradeContextMath({ tradeId: bundle.tradeId, symbol: bundle.symbol, rows, entryMs: bundle.enteredAtMs, exitMs: bundle.closedAtMs, realizedPnl: Number(bundle.realizedPnl), pnlPct: Number.isFinite(Number(bundle.pnlPct)) ? Number(bundle.pnlPct) : null, closeReason: bundle.closeReason, direction: profile.direction, regime: marketRegime, requiredFeatures: profile.requiredMarketFeatures }, Date.now())`. Collect into `tradeContexts`; per-trade `try/catch` (a bad window/read is skipped with an event, never fails the cycle); attach to `propose(...)` via conditional spread when non-empty. Env `TRADE_CONTEXT_WARMUP_MIN` (default **150**); the trade count is naturally bounded by `TRADE_EVIDENCE_MAX = 5` (the bundle count).
- **C — `RESEARCHER_CAPABILITIES`** (`src/mastra/agents/researcher-capabilities.ts`): a curated, **separate** menu string (NOT the shared `PLATFORM_DATA_CAPABILITIES` — critic/refiner keep theirs). Lists: available data (OHLCV, volume, OI + trend, long/short liquidations, funding, taker/CVD) and the indicator vocabulary the block exposes (EMA, RSI, ATR, realizedVol, MACD, Bollinger %B/bandwidth, Stochastic, ADX/DI, Fibonacci, classic Pivots, TTM Squeeze, taker Pressure, OIΔ, CVD, liquidation aggregates, funding). Closes with the standing guard "execution/fills/leverage/sizing stay runner-owned." Appended to `researcher.agent.ts` `INSTRUCTIONS`.

---

## 7. Cross-cutting principles

- **Reuse over reinvention:** `buildTradeContextMath` orchestrates `buildMarketContextMath`; no indicator/resample/format math is re-implemented.
- **Determinism & no-lookahead:** windows strictly backward; `atEntry` consumes only rows up to the entry bar (no post-entry leakage into the entry snapshot); `nowMs` injected.
- **Coverage honesty:** `n/a` and notes driven by the source rows' `has_*` flags and the engine's term-inclusion gate; no fabricated values.
- **Token discipline:** lean per-trade shape (2 term-summaries × {entry,exit} + ~10 micro rows) × ≤5 trades; respects the research-cycle token budget.
- **Fail-soft:** per-trade and whole-feature failures degrade to "no per-trade context" + an event, never failing the cycle.

---

## 8. Testing strategy

- **`buildTradeContextMath`** (unit): entry/exit index resolution (incl. exact-boundary `minute_ts`); `atEntry` snapshot differs from `atExit` on a trending window; warmup-too-short → short term absent at entry with a note; no-taker window → CVD/Pressure `n/a`; empty/too-short rows → empty terms + note, no throw; determinism for same input+`nowMs`; no `NaN`.
- **`formatTradeContextMath`** (snapshot): header (id/symbol/pnl/closeReason/entry→exit), the four `@entry`/`@exit` summary lines, the micro table, `n/a` rendering, Notes; sub-dollar precision via `priceNum`.
- **Handler** (unit): selects losing trades, builds per-trade contexts, attaches `tradeContexts` to `propose`; per-trade `getRows` failure → that trade skipped + event, cycle still completes; zero losing trades → no `tradeContexts`.
- **`buildPrompt`** (unit): with `tradeContexts` present the per-trade sections appear after forensic evidence; absent → unchanged.
- **Researcher agent** (unit): `RESEARCHER_CAPABILITIES` present in the agent's instructions; the shared `PLATFORM_DATA_CAPABILITIES` wiring to critic/refiner is unchanged.
- **Both gates:** `npm run typecheck` exit 0 + `npx vitest run` green.

---

## 9. Risks & open questions

- **Demo organic coverage:** the fake builder yields a single *winning* trade (no losers) — so the demo won't organically exercise per-trade context. Verify with a seeded/golden losing trade or a real run; the unit tests carry correctness. (Tracked, not a blocker.)
- **Warmup tuning:** 150 min is a starting default; refine from live runs (per the owner). Too-short warmup is handled honestly (term dropped + note), not silently.
- **`getRows` cost:** ≤5 extra windowed reads per cycle against the mock/real platform; windows are bounded (`warmup + holding`). Acceptable; per-trade `try/catch` isolates slow/failed reads.
- **Open trades:** bundles with `closedAtMs == null` are skipped (no exit bar to anchor the @exit snapshot). These are not "losing closed trades" anyway (`selectSuspiciousTradeIds` targets realized losers), so the skip is expected, not lossy.

---

## 10. Success criteria

1. For each losing trade in the prompt, the researcher sees indicator snapshots **at entry and at exit** plus a micro trajectory, computed on that trade's window, with honest `n/a`.
2. The rich fields (taker/funding/OHLC) are present per trade via `MarketHistoryReadPort` (no narrow-port widening).
3. The researcher's system prompt carries an explicit `RESEARCHER_CAPABILITIES` menu (data + indicators).
4. Forensic pnl/lifecycle and the symbol-level `marketContextMath` block are unchanged.
5. Zero new indicator math, zero new runtime deps, pure/deterministic, fail-soft; typecheck exit 0 + full suite green.
