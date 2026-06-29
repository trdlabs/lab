# Design: HTTP TradeEvidenceReadPort (lab side of Slice B)

- **Date:** 2026-06-29
- **Status:** Approved approach (form confirmed in brainstorming) → ready for plan
- **Owner:** Alexander Nikolskiy
- **Parent:** Slice A (per-trade context from ClosedTrades, PR #109 on `main`). The forensic per-trade evidence path is still stubbed (`MockTradeEvidenceAdapter`).
- **Companion (other repo):** the platform half — enrich `ClosedTrade` with prices + a new `GET /ops/trade-evidence` lifecycle endpoint — is handed off in `docs/superpowers/specs/2026-06-29-platform-trade-evidence-handoff.md` and owned by the trading-platform instance.
- **Scope:** the **trading-lab** side only — a real HTTP `TradeEvidenceReadPort` over the platform's (forthcoming) `/ops/trade-evidence` endpoint, wired in composition, plus rendering entry/exit prices + the lifecycle timeline in the researcher prompt and dropping the redundant raw minute-context. Built to the agreed contract; integration-verified once the platform ships it.

---

## 1. Context

Slice A made the per-trade **indicator** context populate from real ops-read `ClosedTrade`s. The remaining gap is the **forensic evidence** the researcher prompt renders via `forensicBundleText`: per losing trade — entry/exit **prices** and the **lifecycle timeline** (entry/DCA/TP/SL/stop-update/exit). The lab `TradeEvidenceReadPort` is wired only to `MockTradeEvidenceAdapter` (a stub returning a bundle for the magic id `mock_trade_001`); there is no HTTP adapter. The platform's current ops-read has neither prices nor lifecycle — both are added by the platform half (handoff doc). This slice builds the lab consumer.

**Decisions carried from brainstorming:**
- Prices + lifecycle come from the platform (execution facts lab can't derive). Raw per-minute OHLCV/oi/liq is **not** consumed here — lab already has market bars and computes richer per-trade indicators (Slice A), so the bundle's `minuteContext` is dropped (redundant).
- The lab `TradeEvidenceBundle`/`TradeLifecycleEvidence` types already match the platform `TradeEvidence`/`TradeLifecycleEvent` shape — the adapter is a thin map.

---

## 2. Goals / non-goals

**Goals**
1. A real `HttpTradeEvidenceAdapter implements TradeEvidenceReadPort` over the platform `GET /ops/trade-evidence?tradeIds=…` endpoint (Surface A, ops.3) — reusing the existing `OpsReadClient` (same base URL + bearer token as bot-results).
2. Wire it in `composition.ts`: select the HTTP adapter when ops-read is HTTP-integrated (mirror `HttpOpsReadAdapter` selection via `LAB_BOT_RESULTS_INTEGRATION`/`LAB_OPS_READ_URL`), else keep `MockTradeEvidenceAdapter`.
3. Update `forensicBundleText` to render **entry/exit prices + the lifecycle timeline** per trade and **stop rendering the raw minute-context window** (redundant with Slice A).
4. Coverage-honest + fail-soft (the handler already wraps `getTradeEvidence` in try/catch → empty on failure); pure mapping; both gates green.

**Non-goals**
- No platform/mock-platform change (the handoff doc owns that).
- No change to Slice A's per-trade context, the math engine, or `marketContextMath`.
- No raw-minute-window consumption.
- Live integration-verification is deferred until the platform ships `/ops/trade-evidence` + the fixture (this slice ships the lab consumer + unit tests against the contract).

---

## 3. Design

### 3.1 Wire DTO + client method
The platform `/ops/trade-evidence?tradeIds=a,b,c` returns a Surface-A page `{ items: TradeEvidence[], nextCursor }`. `TradeEvidence` (platform) shape — mirror it as a lab-local wire type (or consume the SDK type once the SDK release lands; until then a lab-local `interface TradeEvidenceRow` matching the handoff contract, replaced by the SDK import when available):
```ts
interface TradeEvidenceRow {
  tradeId: string; runId: string; symbol: string; side: 'long' | 'short';
  openedAtMs: number; closedAtMs: number | null;
  entryPrice: string | null; exitPrice: string | null;
  realizedPnl: string; pnlPct: string; closeReason: string | null;
  lifecycle: ReadonlyArray<{ tsMs: number; type: 'entry'|'dca'|'tp'|'sl'|'exit'|'stop_update'; price: string | null; qty: string | null; note?: string | null }>;
}
```

### 3.2 `HttpTradeEvidenceAdapter` (`src/adapters/platform/http-trade-evidence.adapter.ts`)
```ts
export class HttpTradeEvidenceAdapter implements TradeEvidenceReadPort {
  constructor(private readonly client: OpsReadClient) {}
  async getTradeEvidence(query: TradeEvidenceQuery): Promise<readonly TradeEvidenceBundle[]> { … }
}
```
- If `query.tradeIds` is empty → `[]` (no call).
- `GET /ops/trade-evidence?tradeIds=<join(',')>`, walking the `{items,nextCursor}` cursor to completion (reuse the `walk` pattern from `HttpOpsReadAdapter`).
- Map each `TradeEvidenceRow` → `TradeEvidenceBundle`:
  - `tradeId/runId/symbol/side/realizedPnl/pnlPct/closeReason` pass through; `enteredAtMs = openedAtMs`, `closedAtMs`; `entryPrice/exitPrice` pass through; `holdingDurationMs = closedAtMs != null ? closedAtMs − openedAtMs : null`.
  - `lifecycleEvents = lifecycle.map(e => ({ tsMs, type, price: e.price ?? null, qty: e.qty ?? null, note: e.note ?? null }))` (already the `TradeLifecycleEvidence` shape).
  - `minuteContext = []` (dropped — lab uses Slice A for the window).
- The `query.minuteWindowBefore/After` are ignored by this adapter (no raw window); kept on the port for back-compat (the handler still passes them — harmless).
- Pure mapping, no `Date.now`/`Math.random`. SDK import (if used) lives only in the adapter, per `sdk-import-boundary.guard` (DTO re-exported through the port if needed).

### 3.3 Composition wiring (`composition.ts`)
Mirror the bot-results selection: when `LAB_BOT_RESULTS_INTEGRATION === 'http'` (the demo/vps path that already builds the `OpsReadClient` for `HttpOpsReadAdapter`), wire `tradeEvidence: new HttpTradeEvidenceAdapter(opsReadClient)` reusing the **same** `OpsReadClient` instance/config. Otherwise keep `new MockTradeEvidenceAdapter()` (in-process/fixture default). No new env var — it follows the existing ops-read integration switch + URL/token.

### 3.4 Drop the raw minute-context lines (`mastra-researcher.ts` `forensicBundleText`)
`forensicBundleText` **already** renders the trade-level line *with* `entryPrice`/`exitPrice` (`'unknown'` when null) **and** the `lifecycle tsMs=… type=… price=… qty=… note=…` lines — these are populated automatically once the HTTP adapter fills the bundle. The only change here is to **remove the `minute tsMs=… close=… volume=… oi=… liquidationsLong=… liquidationsShort=…` raw-context lines** (redundant with Slice A's per-trade table; `minuteContext` is `[]` from the HTTP adapter anyway). After removal, the forensic section is: the trade line (symbol/tradeId/entry/exit prices/pnl/hold/closeReason) + the lifecycle timeline. Coverage stays honest — null prices render `unknown`, an empty lifecycle renders no event lines. Update the `forensicBundleText` unit test to assert the lifecycle lines render and the `minute …` lines do not.

---

## 4. Testing

- **`HttpTradeEvidenceAdapter`** (unit, fake `OpsReadClient`/fetch): maps a `/ops/trade-evidence` page → bundles (fields, `holdingDurationMs` derived, lifecycle mapped, `minuteContext === []`); paginates the cursor; empty `tradeIds` → no call → `[]`; an error from the client propagates (the handler's try/catch downgrades it). Mirrors `http-ops-read.adapter` tests + the `sdk-import-boundary.guard` if the SDK type is used.
- **Composition** (unit): `LAB_BOT_RESULTS_INTEGRATION='http'` → `tradeEvidence` is `HttpTradeEvidenceAdapter`; default → `MockTradeEvidenceAdapter`. (Mirror the bot-results composition test if present.)
- **`forensicBundleText`** (unit, `mastra-researcher.test.ts`): a bundle with prices + a 3-event lifecycle renders the trade line (with entry/exit prices, already supported) + the lifecycle lines, and emits **no `minute …` lines**; an empty-lifecycle / null-price bundle still renders the trade line (`unknown` prices) with no event/minute lines. (The prices/lifecycle rendering already exists; the test pins the minute-line removal.)
- **Both gates:** `npm run typecheck` exit 0 + `npx vitest run` green.

---

## 5. Success criteria

1. With the platform endpoint live (and the mock fixture baked), the researcher prompt's forensic section shows, per losing trade, entry/exit **prices** + the **lifecycle timeline**, and **no** raw per-minute window.
2. The HTTP adapter is a thin, pure map over `/ops/trade-evidence`, reusing the existing `OpsReadClient`; composition selects it on the HTTP integration path.
3. Slice A's per-trade indicator context, the math engine, and `marketContextMath` are untouched.
4. Fail-soft preserved; typecheck exit 0; full suite green. (Live integration-verify follows the platform release.)
