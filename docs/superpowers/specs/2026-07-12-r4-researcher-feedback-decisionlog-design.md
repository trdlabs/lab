# R4 — feedback threading + bounded decision-log into the researcher prompt

**Date:** 2026-07-12
**Status:** design approved (brainstorming), ready for writing-plans
**Source:** `docs/research/2026-07-11-hypothesis-evaluation-workflow-review.md` R4 (closes W2/W3 — the LLM doesn't see what we think it sees).
**Boundary:** `docs/research/2026-07-12-backtester-phase-e-lab-reconciliation.md` — this is the lab-side core; the additive backtester **E1b** structured-failure channel is a later consume, NOT built here.

## 1. Problem

Two inputs the researcher is assumed to see but doesn't:
- **W2 — retry feedback is dead.** On a FAIL/MODIFY retry, `backtest-completed.handler` sets `research.run_cycle` `payload.feedback = { hypothesisId, decision, reasons }` (schema field exists at `research-run-cycle.handler.ts:37`), but the run-cycle handler never threads it into `ResearcherInput`, so the next attempt's prompt has no memory of why the last one failed.
- **W3 — decision log is unwired.** `BotResultsReadPort.getDecisionLog(runId)` (+ fixture/http adapters) is implemented but never called in the research flow, so the bot's own per-decision reasoning ("why entered / why not exited earlier") never reaches the prompt.

**Third W3 item — `minuteContext` is still fetched, just not rendered (dead IO), and R4 stops the fetch.** `forensicBundleText` (`mastra-researcher.ts:107-119`) already renders only header + lifecycle (the raw minute lines were removed by the 2026-06-17 slice), BUT the fetch is still live: `TradeEvidenceBundle` still carries `minuteContext`, `TradeEvidenceQuery` still requires `minuteWindowBefore/After`, and `research-run-cycle.handler.ts:214-217` still calls `getTradeEvidence({ tradeIds, minuteWindowBefore: 20, minuteWindowAfter: 180 })`. So −20/+180 per-minute rows are fetched and discarded every cycle. R4 **Task 0** stops this by requesting a `0/0` window (see §3.0) — small surface, and the market values the LLM needs at entry/exit/micro come from `tradeContexts`, not this evidence path.

## 2. Goal

Give the researcher enough grounded context to understand **what actually went wrong in the losing trades and form a corrective hypothesis** — specifically: (a) the prior attempt's verdict + reasons, explicitly framed as *must be addressed, not repeated*, and (b) a bounded decision-log excerpt for the losing trades (the bot's own reasoning at each decision), via a narrow token-aware lab contract, not the raw SDK DTO.

**What is already covered (no R4 work):** market values at the decision points — OI, long/short liquidations, CVD, price, volume — are ALREADY rendered per losing trade via `tradeContexts` (`formatTradeContexts`): `atEntry`/`atExit`/`atPostExit` term-math snapshots plus the per-minute `microRows` (`TermMathRow = { close, volume, oi, oiDelta, cvd, liqLong, liqShort, rsi, atr, … }`) over the exit micro-window. This structured math supersedes the raw `minuteContext` −20/+180 dump (which is still fetched but no longer rendered — Task 0 stops that fetch). So R4 does NOT add a market snapshot; it adds the missing **"why"** and links it to those already-present market values via `relatedTradeId` (the LLM cross-references excerpt → trade context). Market snapshots at non-entry/exit decision points (e.g. a mid-trade hold) are a deferred optional (§6), not this slice.

## 3. Design

### 3.0 Task 0 — stop the dead minuteContext fetch (`research-run-cycle.handler.ts`)

Change the `getTradeEvidence` call (currently `:214-217`) from `minuteWindowBefore: 20, minuteWindowAfter: 180` to `minuteWindowBefore: 0, minuteWindowAfter: 0`. The adapters already accept `0/0` (http-trade-evidence adapter tests cover it), returning bundles with empty `minuteContext` and the prices + lifecycle that `forensicBundleText` actually renders. This removes the −20/+180 per-minute fetch/transfer that is discarded every cycle. No change to `TradeEvidenceBundle`/`TradeEvidenceQuery` shapes (the fields stay, just requested empty) — keeps the surface tiny and reversible.

### 3.1 `ResearcherInput` contract additions (`src/ports/researcher.port.ts`)

```typescript
export interface DecisionExcerpt {
  runId: string;
  timestampMs?: number;
  action?: string;      // <- DecisionLogEntry.category
  reason?: string;      // <- DecisionLogEntry.reason
  summary?: string;     // <- DecisionLogEntry.safeMessage
  relatedTradeId?: string; // set when the entry's tsMs falls in a selected losing trade's window
}

export interface ResearcherInput {
  // ...existing fields...
  retryFeedback?: { decision: string; reasons: readonly string[] };
  decisionExcerpts?: readonly DecisionExcerpt[];
}
```

The narrow `DecisionExcerpt` insulates the prompt-builder from the ops-read SDK DTO shape (a future `DecisionLogEntry` field can't silently bloat the LLM input). SDK `DecisionLogEntry` (`{ category, runId, botId, symbol, side, reason, tsMs, safeMessage }`) is mapped in the handler, never passed through.

### 3.2 Assembly (`src/orchestrator/handlers/research-run-cycle.handler.ts`)

- **retryFeedback:** when `payload.feedback` is present, set `input.retryFeedback = { decision: payload.feedback.decision, reasons: payload.feedback.reasons }`. (Drop `hypothesisId` — not needed in the prompt.)
- **decisionExcerpts (bounded):** after the losing/suspicious trades are selected (`selectSuspiciousTrades`, already capped by `TRADE_EVIDENCE_MAX`), group them by their `runId`; for each **distinct** run: `getDecisionLog(runId)` **one page only** (no pagination walk); filter entries whose `tsMs` falls within a selected losing trade's window `[openedAtMs − DECISION_PRE_ENTRY_MARGIN_MS, closedAtMs]` (real `ClosedTrade` fields — `openedAtMs`/`closedAtMs`, `closedAtMs` may be null → use `openedAtMs` as the upper bound in that case; `DECISION_PRE_ENTRY_MARGIN_MS = 60_000`, so the entry decision itself — logged at or just before entry — is captured), stamping `relatedTradeId` = that trade's id; map to `DecisionExcerpt`; then apply a **global cap of `DECISION_EXCERPT_CAP = 20`** across all runs (deterministic order: by trade selection order, then `tsMs` ascending). **Overlapping windows:** if an entry's `tsMs` falls in more than one selected trade's window, the first trade in selection order wins (one `relatedTradeId` per entry, no duplicate excerpts). Attach to `input.decisionExcerpts`. Fetch is fail-soft: a `getDecisionLog` error drops excerpts for that run (empty), never fails the cycle.
- A small pure helper `toDecisionExcerpts(entries, losingTrades, cap): DecisionExcerpt[]` does the filter+map+cap (unit-testable without the handler).

### 3.3 Prompt rendering (`src/adapters/researcher/mastra-researcher.ts::buildPrompt`)

- **retryFeedback block** (both focuses, near the head when present):
  `Feedback from your last attempt — you MUST ADDRESS this, not merely repeat the previous hypothesis:\n  decision=<decision>\n  reasons: <r1; r2; …>`
- **decisionExcerpts block** (loss_reduction focus, after forensic/loser blocks, when present). Framed to make the LLM cross-reference the "why" with the trade's already-rendered market context (OI/liq/price at @entry/@exit/micro):
  `Decision-log excerpts (the bot's own reasoning — why it entered / why it did not exit earlier; cross-reference tradeId against the trade's @entry/@exit/micro market values above):\n  - [<action>] tsMs=<t> tradeId=<relatedTradeId> reason=<reason> :: <summary>` (one line per excerpt).
- Both omitted entirely when their field is absent/empty (byte-identical to today for the no-feedback / no-losers path).

## 4. Data flow

```
FAIL/MODIFY retry → backtest-completed sets run_cycle payload.feedback (exists today)
  → research-run-cycle handler:
      input.retryFeedback ← payload.feedback (decision, reasons)
      losers = selectSuspiciousTrades(botResults)
      for each distinct loser runId: getDecisionLog(runId) [1 page, fail-soft]
      input.decisionExcerpts ← toDecisionExcerpts(entries, losers, cap=20)
  → researcher.propose(input) → buildPrompt renders both blocks
```

## 5. Testing

- **buildPrompt** (`mastra-researcher.test.ts`): (a) `retryFeedback` present → prompt contains the block AND the literal "MUST ADDRESS … not merely repeat" guard. (b) `decisionExcerpts` present → prompt contains the excerpts block with action/reason/summary. (c) neither present → prompt byte-identical to current (no stray headers). Snapshot or explicit substring asserts.
- **Task 0** (`research-run-cycle.handler.test.ts`): `getTradeEvidence` is called with `minuteWindowBefore: 0, minuteWindowAfter: 0` (assert the query the handler passes).
- **toDecisionExcerpts** (unit): filters to losers' windows using `openedAtMs`/`closedAtMs` (incl. the `closedAtMs === null` case), stamps `relatedTradeId` (first trade in selection order wins on overlap), maps SDK fields → excerpt fields, applies the global cap of 20, handles empty input → `[]`.
- **research-run-cycle** (`research-run-cycle.handler.test.ts`): (a) `payload.feedback` present → `input.retryFeedback` threaded into the `propose` call (spy/fake researcher captures input). (b) losers present → `getDecisionLog` called once per distinct loser run (bounded, single page), result mapped+capped onto `input.decisionExcerpts`. (c) no losers → `getDecisionLog` not called, `decisionExcerpts` absent. (d) `getDecisionLog` throws → cycle still succeeds, that run's excerpts dropped.
- `fake-researcher` unaffected (ignores the new optional fields).

## 6. Scope guard / deferred
- **Market snapshot at NON-entry/exit decision points** (e.g. a mid-trade hold at minute 47): would need a narrow point-in-time market fetch keyed on each `DecisionLogEntry.tsMs`. Deferred — entry/exit/post + the exit micro-window (already rendered via `tradeContexts`) cover where most bad holds cluster; adding a per-timestamp market fetch is a separate port/adapter. If added later, extend `DecisionExcerpt` with an optional `market?: { price?, openInterest?, longLiquidations?, shortLiquidations?, volume? }` populated by that fetch.
- Backtester **E1b** structured-failure channel (quality vector, failure-mode category, per-trade diagnostics) is the additive upstream complement — consumed later, not built here (reconciliation §4).
- `TradeEvidenceBundle.minuteContext` / `TradeEvidenceQuery.minuteWindowBefore/After` fields are LEFT in place (Task 0 only requests `0/0`); removing the fields entirely is a larger cross-adapter cleanup, out of scope. Optionally correct the stale "fetched but not rendered" W3 note in the hypothesis-eval report once Task 0 lands.

## 7. Invariants / gotchas
- `decisionExcerpts` is bounded at three levels: one page per run, window-filtered to selected losers, global cap 20. No pagination walk.
- The retry-feedback prompt framing must say "address, not repeat" — the snapshot test asserts this literal, so the guard can't silently regress.
- New `ResearcherInput` fields are optional → every existing researcher call site and the fake stay valid.
