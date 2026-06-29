# Platform handoff prompt — expose per-trade entry/exit prices + lifecycle via ops-read

> Paste this into the **trading-platform** instance. It owns the implementation; trading-lab consumes the contract below. (This file lives in trading-lab only as the agreed handoff record.)

---

## Task: surface per-trade entry/exit prices + a lifecycle timeline on ops-read (Surface A, ops.3)

### Why
trading-lab's strategy researcher analyzes **losing trades** to propose overlay hypotheses. It already gets per-trade **indicator** context (EMA/RSI/ATR/MACD/Pivots/Squeeze/Pressure/CVD…) — computed lab-side from market history. What it **cannot derive** and needs from the platform:
1. the actual **entry/exit prices** of each closed trade;
2. the trade's **lifecycle timeline** — entry / DCA adds / TP / SL / stop-update / exit, with `tsMs`, `price`, `qty`.

These are execution facts only the platform knows (canonical trade-journal / DB). Today's ops-read exposes neither: `ClosedTrade` (dto.ts) has pnl but no prices; `DecisionLogEntry` is redacted run-level (no `tradeId`, no lifecycle); `OperationalEvent` is redacted text. So lab's forensic per-trade evidence path is empty.

### Investigate first (before fixing the wire)
Confirm the canonical trade-journal (`src/canonical/writers/trade_journal_writer.ts` + its DB tables) actually records **per-trade fill/management events keyed by `tradeId`** (entry / DCA / TP / SL / stop-update / exit with ts/price/qty). 
- If yes → expose them (below).
- If it records only open/close (no DCA/TP/SL granularity) → scope the lifecycle to **what truly exists** (at minimum `entry` + `exit` events with prices) and document the gap. **Do NOT synthesize events that did not happen.**

### Change A — enrich `ClosedTrade` with prices
In `src/operations/dto.ts`, add to `ClosedTrade`:
```ts
readonly entryPrice: string | null;   // avg entry, pnl::text precision; null when unavailable
readonly exitPrice: string | null;    // avg exit
```
Source from the same canonical aggregation as `realizedPnl`; serve on the existing `/ops/trades?runId=` list (`trades-reader` source + `list-trades` handler). Keep the row flat/cheap.

### Change B — new batch endpoint: per-trade lifecycle
`GET /ops/trade-evidence?tradeIds=<id1>,<id2>,…` (batch; cap e.g. ≤ 25). Surface-A page envelope `{ items, nextCursor }` of **self-contained** per-trade evidence:
```ts
interface TradeEvidence {
  readonly tradeId: string;
  readonly runId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly entryPrice: string | null;
  readonly exitPrice: string | null;
  readonly realizedPnl: string;
  readonly pnlPct: string;
  readonly closeReason: string | null;
  readonly lifecycle: readonly TradeLifecycleEvent[];  // chronological
}
interface TradeLifecycleEvent {
  readonly tsMs: number;
  readonly type: 'entry' | 'dca' | 'tp' | 'sl' | 'exit' | 'stop_update';
  readonly price: string | null;
  readonly qty: string | null;
  readonly note?: string | null;   // optional, redaction-safe
}
```
Source `lifecycle` from the canonical trade-journal (per-trade events keyed by `tradeId`). Follow Surface A conventions: bearer auth (ops.3); existing redaction policy (prices/qty are numeric execution facts — confirm they're exposable; `note` must be redaction-safe); `{items,nextCursor}` envelope + opaque cursor; the dto.ts types + handler/source split (mirror `list-trades.ts` + `trades-reader.ts`).

### Acceptance
- `/ops/trades` rows carry real `entryPrice`/`exitPrice` (non-null for the demo fixture's closed trades).
- `GET /ops/trade-evidence?tradeIds=…` returns self-contained evidence with a real `lifecycle` for those trades.
- **Bake into the mock-platform fixture** (`2026-06-16-to-18-extended`, the ESPORTSUSDT losers) so trading-lab can integration-verify the full forensic path.
- ops.3 contract-version bump; update `@trading-platform/sdk/ops-read` types (enriched `ClosedTrade` + new `TradeEvidence`/`TradeLifecycleEvent`) and cut an SDK release (trading-lab consumes SDK types).

### NOT in scope
- **No raw per-minute OHLCV/oi/liq window.** trading-lab already fetches market bars itself (`MarketHistoryReadPort`) and computes richer per-trade indicators; do not duplicate market data on ops-read.

### Lab-side contract (for reference — trading-lab builds the HTTP adapter to this)
trading-lab will map `TradeEvidence` → its local `TradeEvidenceBundle` (`entryPrice`/`exitPrice`/`lifecycleEvents` from this response; `minuteContext` dropped). The shape above matches lab's existing `TradeLifecycleEvidence` (`type: 'entry'|'dca'|'tp'|'sl'|'exit'|'stop_update'`, `price?`, `qty?`, `note?`).
