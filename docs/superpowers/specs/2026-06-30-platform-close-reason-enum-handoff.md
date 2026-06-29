# Platform handoff prompt — type `ClosedTrade.closeReason` as a canonical `CloseReason` enum

> Paste this into the **trading-platform** instance. It owns the implementation; trading-lab consumes the contract below. (This file lives in trading-lab only as the agreed handoff record.)
>
> **Bundle this with the pending [trade-evidence handoff](2026-06-29-platform-trade-evidence-handoff.md)** (entry/exit prices + lifecycle). One ops.3 contract bump + one SDK release should deliver all three: prices, lifecycle, and the typed `closeReason`.

> **✅ SHIPPED (2026-06-30) — trading-platform PR #33 (396cc63), ops.4→ops.5, SDK `@trading-platform/sdk` 0.9.0.** Delivered exactly as specced: `ClosedTrade`/`TradeEvidence.closeReason: CloseReason | null` (the 10-value enum below) + `closeReasonRaw: string | null`, **and** the bundled prices + lifecycle (`entryPrice`/`exitPrice`, full `TradeEvidence.lifecycle[]`). Lab consumes it (`@trading-platform/sdk` 0.9.0). **Still pending:** the mock-platform fixture must bake ≥2 distinct typed winner close-reasons for live integration-verify (separate mock-platform instance + VPS — `scratchpad/HANDOFF-close-reason-mock.md`). Platform investigate-finding: host-owned breakeven (long_oi) isn't written as its own exit-reason → classified by the recorded reason (gap documented, `other` fallback); for long_oi the ≥2 distinct winner reasons are `take_profit_final` (tp2) vs `time_exit`/`signal_exit`.

---

## Task: promote `ClosedTrade.closeReason` (and `TradeEvidence.closeReason`) from free-form `string | null` to a canonical `CloseReason` enum on ops-read (Surface A, ops.3)

### Why
trading-lab's strategy researcher is gaining a **two-pass** design: a loss-reduction pass over losing trades and a **profit-improvement pass over winning trades** (propose bigger TP / trailing / hold-longer hypotheses). For the profit pass, lab must **select** which winners to surface — and the most informative winners are the ones whose exit *left money on the table*: trades that exited **early / partially** (e.g. closed at tp1 or moved-to-breakeven) rather than running to the final target.

That selection needs to branch on *how the trade closed*. Today ops-read exposes `ClosedTrade.closeReason: string | null` — **free-form**, strategy-defined, with no stable vocabulary (`RunSummary.exitReasons` confirms it is a histogram of arbitrary strings, not an enum). trading-lab cannot reliably classify "early exit" from an untyped string without hardcoding one strategy's private reason names. Per lab's no-shortcuts principle, the fix belongs upstream: the platform owns the canonical exit taxonomy and should expose it typed.

### Investigate first (before fixing the wire)
The structured signal already exists in the canonical trade-journal — surface it, do not synthesize it:
- `trade_closed` lifecycle events carry a free-form `reason: string` (`src/canonical/contracts/trade_lifecycle_event.ts:59`). Audit what values it actually takes across the demo fixture + real runs.
- Layered exits (Feature 013) are recorded structurally: `tp_armed` events carry `tpLevel: number` + `tpAction: TpAction` (`arm_breakeven | observe_only | partial_close_reserved | close_reserved`). So "closed at tp1 vs tp2" is **derivable** from the tp-level events + which fill closed the residual position — it does not have to come from the free-form `reason` string alone.

**Map what truly exists to the canonical enum below; for anything the journal does not distinguish, emit `other` and document the gap. Do NOT invent reasons the kernel never recorded.**

### Change A — define a canonical `CloseReason` enum
In `src/operations/dto.ts` (ops-read DTOs), add:
```ts
export type CloseReason =
  | 'take_profit_final'   // ran to the final / highest configured TP target
  | 'take_profit_partial' // residual closed at an earlier TP level (tp1/intermediate) — the "exited early" case
  | 'stop_loss'           // hard stop hit
  | 'breakeven'           // stop had been armed to breakeven, then hit (no profit / ~flat)
  | 'trailing_stop'       // trailing stop hit after it engaged
  | 'signal_exit'         // strategy emitted an explicit exit/reversal signal
  | 'time_exit'           // max-hold / time stop
  | 'liquidation'         // exchange liquidation
  | 'manual'              // operator / external close
  | 'other';              // recorded but not classifiable into the above (carry the raw string in closeReasonRaw)
```
Notes for the mapper:
- `take_profit_partial` vs `take_profit_final` is the discriminator lab's selection cares about most: a winner closed by an **intermediate** TP level (tp1, partial) is the prime "TP too small / should have trailed / held for tp2" candidate; a winner that reached the **final** target is already near-optimal. Derive this from `tpLevel` (and whether a higher configured level existed) on the closing fill, not from the reason string.
- `breakeven` = a winning-or-flat trade whose move-to-BE stop closed it (derive from a preceding `tp_armed` with `tpAction='arm_breakeven'` followed by the BE stop fill).
- Keep the original free-form value too — add `readonly closeReasonRaw: string | null` alongside, so nothing is lost and `other` is auditable.

### Change B — type the field on the read DTOs
- `ClosedTrade.closeReason`: change `string | null` → `CloseReason | null` (null only when genuinely unknown), and add `closeReasonRaw: string | null`. Served on the existing `/ops/trades?runId=` list (`trades-reader` source + `list-trades` handler).
- `TradeEvidence.closeReason` (the per-trade evidence DTO from the bundled trade-evidence handoff): type it `CloseReason | null` identically, + `closeReasonRaw`.
- `RunSummary.exitReasons` (`Record<string, number>`) may stay raw-keyed, or additionally expose a `closeReasons: Record<CloseReason, number>` rollup — lab does not require this, mention only if cheap.

### Acceptance
- `/ops/trades` rows carry a typed `closeReason: CloseReason | null` + `closeReasonRaw` (non-null `closeReason` for the demo fixture's closed trades; at least the winners are classified into `take_profit_partial` / `take_profit_final` / `breakeven` where the journal distinguishes them).
- `GET /ops/trade-evidence` items carry the same typed `closeReason` + `closeReasonRaw`.
- **Bake into the mock-platform fixture** (`2026-06-16-to-18-extended`, the ESPORTSUSDT trades) so trading-lab can integration-verify winner selection — the fixture's winning trades must exhibit at least two distinct close reasons (e.g. some `take_profit_partial`, some `take_profit_final`) so the selection branch is exercisable.
- ops.3 contract-version bump; update `@trading-platform/sdk/ops-read` types (`CloseReason` + the two enriched DTOs) and cut **one** SDK release that also carries the trade-evidence handoff's prices + lifecycle. Document the close-reason → canonical mapping (and any `other` fallbacks) in the SDK changelog.

### NOT in scope
- No change to the *kernel's* exit logic or the strategy-facing reason vocabulary — this is purely a read-surface classification/typing of facts already in the journal.
- No new raw market data (lab fetches bars itself, per the trade-evidence handoff).

### Lab-side contract (for reference — trading-lab builds the selection to this)
trading-lab's winner-selection will read `ClosedTrade.isWin === true` to partition winners, then prioritize `closeReason ∈ { take_profit_partial, breakeven, signal_exit, time_exit }` (the "exited early / left headroom" set) over `take_profit_final` / `trailing_stop`, and render the raw + canonical reason in the per-trade context block. Until this ships, lab falls back to a post-exit-headroom ranking (vocabulary-free) behind the existing integration switch; the typed enum replaces the fallback once the SDK release lands.
