# Design: two-pass researcher + winning-trade context + profile-critical framing

- **Date:** 2026-06-30
- **Status:** Approved design (brainstorming complete) → ready for plan
- **Owner:** Alexander Nikolskiy
- **Parent:** the per-trade context line on `main` (Slice A #109 + post-exit tail #111). That work surfaced **losing** trades' `@entry`/`@exit`/`@post` indicator context to the researcher. This sub-project adds the symmetric **winning**-trade side and splits the researcher into two focused passes.
- **Scope (sub-project ①+②):** (①) source **winning** trades' per-trade context (reuse the existing engine), and (②) split the researcher into two focused LLM passes — a **loss-reduction** pass over losers and a **profit-improvement** pass over winners — plus framing both passes to treat the strategy profile **critically** (may relax / remove / replace existing checks, not only add).
- **Out of scope (separate future sub-projects):** ③ hypothesis-combination → ensemble backtest → paper promotion; (b) literal profile-code editing / check deletion via a rebuild path (vs. overlay-level relaxation, which IS in scope here).

---

## 1. Context & problem

`buildPrompt` (`mastra-researcher.ts`) makes **one** `agent.generate` call with everything mixed: profile + regime + symbol-level `marketContextMath` + `similarHypotheses` + bot digest + losers' forensic evidence + losers' `tradeContexts`. The researcher proposes up to N `hypothesis_overlay` drafts.

Two gaps:
1. **No winning-trade signal.** The per-trade context only carries losers (`realizedPnl < 0`). The researcher can reason "why did this lose → entry filter / tighten stop" but never "this winner exited early and price kept running → bigger TP / trail / hold longer." The post-exit tail (#111) makes that signal visible per trade — but no winners are ever selected.
2. **One overloaded prompt.** Folding loss-reduction and profit-improvement asks into a single call dilutes both and bloats context. The user's framing: two requests — "here are the losers, propose 5 hypotheses to cut the minus" and "here are the winners, propose 5 hypotheses to grow profit."
3. **Profile treated as a fixed baseline.** The prompt implicitly asks the researcher to *add* constraints. It should treat the profile as a **revisable hypothesis** — free to propose relaxing / removing / replacing existing checks and retiring stale rules when that improves trading.

**Decisions carried from brainstorming:**
- Split lives in the **handler** via a `focus` discriminator on `ResearcherInput` (not in the adapter, not a new port method). The handler builds two inputs and calls `propose()` twice.
- **Asymmetric, focused passes** (composition A): each pass sees only what it needs.
- Winner selection cannot key off `closeReason` (free-form `string | null` today). It keys off `isWin`, prioritizes early/headroom exits **once the platform ships the typed `CloseReason` enum** (handoff: `2026-06-30-platform-close-reason-enum-handoff.md`), and **falls back to a vocabulary-free post-exit-headroom ranking** until then.
- Profile-critical framing = overlay-level relaxation **(a)** using the existing `OVERLAY_ACTIONS` (`allow_entry` / `no_op` / exit actions counter a baked-in `skip_entry`); literal profile-code editing **(b)** is deferred.

---

## 2. Goals / non-goals

**Goals**
1. The researcher runs **two focused passes** per cycle: `loss_reduction` (losers) and `profit_improvement` (winners), each proposing up to 5 hypotheses; both drafts merge into the existing dedup→validate→build loop.
2. Winning trades are selected and given the same `@entry`/`@exit`/`@post` per-trade context as losers, so the profit pass can reason about exit improvement.
3. Both passes frame the profile critically and may propose relaxing/removing/replacing existing overlay checks (within the current overlay model), not only adding.
4. Reuse the per-trade engine/formatter; coverage-honest; fail-soft; cost-bounded (skip the profit pass with no winners); both gates green.

**Non-goals**
- No ③ (combination/ensemble/paper) — separate sub-project.
- No (b) literal profile-code mutation — overlay relaxation only.
- No change to the per-trade math engine, the symbol-level `marketContextMath`, the critic/refiner, or the overlay-action catalog.
- No new overlay actions — relaxation uses the existing `allow_entry`/`no_op`/exit vocabulary.

---

## 3. Design

### 3.1 `focus` discriminator + two-pass orchestration (`research-run-cycle.handler.ts`)
- `ResearcherInput` gains `readonly focus: ResearcherFocus` where `type ResearcherFocus = 'loss_reduction' | 'profit_improvement'`.
- The handler builds **two** inputs and calls `services.researcher.propose()` for each (sequentially — token kill-switch is checked between LLM calls as today):
  - **loss_reduction** — unchanged context: profile + regime + symbol `marketContextMath` + `similarHypotheses` + bot digest + **losers'** `tradeContexts` + forensic `tradeEvidence`. `maxHypotheses = 5`.
  - **profit_improvement** — profile + regime + symbol `marketContextMath` + bot digest + **winners'** `tradeContexts`. **No** forensic evidence, **no** `similarHypotheses` RAG (those serve loss analysis). `maxHypotheses = 5`.
- Both passes additionally receive the profile's **currently-active / validated overlay rules** (see §3.4) so the critical framing is concrete.
- **Gating:** the profit pass runs only if ≥1 winner was selected; otherwise it is skipped entirely (no LLM call, no cost). The loss pass runs whenever losers exist, exactly as today.
- Drafts from both passes are concatenated and flow into the **existing** dedup (fingerprint) → validate → build loop unchanged. Cross-pass duplicates are caught by the existing fingerprint dedup.

### 3.2 `buildPrompt` branches on `focus` (`mastra-researcher.ts`)
`buildPrompt(input)` reads `input.focus` to select:
- **Capability framing** — a `focus`-specific block. `loss_reduction` keeps the existing `@entry`/`@exit`/`@post` exit-quality framing (loss-cutting + entry filters). `profit_improvement` gets a new block: the `@post` tail shows whether price continued favourably after exit → propose **bigger take-profit / trailing / hold-longer / partial-scale-out adjustments** to capture left-on-the-table profit.
- **The ask line** — `loss_reduction`: "propose up to 5 hypotheses that reduce the loss on these trades." `profit_improvement`: "propose up to 5 hypotheses that improve realized profit on these (winning) trades — e.g. larger TP, trailing, later exit."
- **Profile-critical framing (both passes):** "Treat the strategy profile as a revisable hypothesis, not a fixed baseline. You may propose **relaxing, removing, or replacing** existing checks/filters and retiring stale rules — e.g. `allow_entry`/`no_op` to counter an over-restrictive baked-in `skip_entry`, or changing an exit rule — not only adding new constraints, whenever you judge it improves trading. The profile's currently-active rules are listed below; critique them."
- The trade-context section renders `input.tradeContexts` exactly as today (the formatter is sign-agnostic — winners render with the same `@entry`/`@exit`/`@post`).

### 3.3 Winner selection (`research-run-cycle.handler.ts`)
- **Partition:** `selectWinningTrades(botResults)` — winners are `isWin === true` (fallback `Number(realizedPnl) > 0` when `isWin == null`); breakeven (`isWin === null` and ~flat) belongs to neither set. Losers stay exactly as today (`selectSuspiciousTrades`, `realizedPnl < 0`) — unchanged.
- **Ranking / cap (`TRADE_CONTEXT_WINNERS_MAX`, default 5):**
  - **Typed path (after the platform `CloseReason` enum ships):** prioritize `closeReason ∈ { take_profit_partial, breakeven, signal_exit, time_exit }` (the "exited early / left headroom" set) over `{ take_profit_final, trailing_stop }`; tiebreak by recency. Cheap, no row fetch needed at selection time.
  - **Fallback path (until then, vocabulary-free):** bound the winner pool by recency (e.g. ≤ 2×cap), fetch each candidate's rows once, compute **post-exit favourable continuation** = the max favourable move from exit price to the tail's extreme in the trade's direction, and keep the top-`cap` by that "money-left-on-table" measure. The fetched rows are **reused** to build the per-trade context (no double fetch).
  - **Which path runs** is decided by whether `closeReason` carries recognized canonical `CloseReason` members (i.e. the SDK enum has shipped), not by the integration mode — a small `isTypedCloseReason()` guard. Until the typed values appear, the headroom fallback runs regardless of source. This keeps the two decoupled: a fixture can carry typed reasons before live HTTP does.
- The per-trade context loop runs over **losers ∪ selected winners**, calling the existing `buildTradeContextMath` (sign-agnostic) for each. The `realizedPnl`/`pnlPct`/`closeReason` already flow through.

### 3.4 Surface the profile's active overlay rules (both passes)
- The handler fetches the profile's **currently-validated hypotheses / active overlay rules** from the hypothesis-proposal repository (it already exposes `listByStrategyProfile` / `findLatestValidatedByProfile`; the plan pins which — filtered to `status === 'validated'`) and passes them on `ResearcherInput` as `readonly activeOverlayRules?: readonly ActiveOverlayRuleSummary[]` (a thin `{ thesis, ruleAction, status }` projection). Fail-soft: a repo error degrades to no active rules, never fails the cycle.
- `buildPrompt` renders them under an "Active overlay rules on this profile (critique these)" heading in both passes. Coverage-honest: none → "no active overlay rules yet" (then critique applies to the base profile only).

### 3.5 Origin tagging + observability
- Each emitted draft is tagged with its pass origin so downstream (and future ③) knows which hypotheses are profit-improvers. The tag rides as `origin: ResearcherFocus` on the proposal/hypothesis record (additive; null/`loss_reduction` for legacy single-pass rows).
- Per pass, emit `researcher.pass_completed { focus, hypothesisCount, correlationId }`.
- Token usage is attributed per pass via the existing `onUsage` hook; the cumulative token kill-switch already spans both calls.

---

## 4. Affected vs untouched

**Touched:** `ports/researcher.port.ts` (`ResearcherInput.focus`, `activeOverlayRules?`), `adapters/researcher/mastra-researcher.ts` (`buildPrompt` branch + profit capability block + critical framing), `adapters/researcher/fake-researcher.ts` (honor `focus`, trivial), `mastra/agents/researcher-capabilities.ts` (profit framing + critical-profile text), `orchestrator/handlers/research-run-cycle.handler.ts` (two-pass orchestration, `selectWinningTrades`, winner ranking + reuse-fetch, active-rules fetch, per-pass event, origin tag), the hypothesis/proposal record (additive `origin`).

**Untouched (reuse only):** the per-trade math engine (`research-math/*`), the symbol-level `marketContextMath`, the per-trade formatter, the `OVERLAY_ACTIONS` catalog, the critic/refiner, the validate→build→backtest pipeline.

---

## 5. Dependencies & sequencing

- **Platform `CloseReason` enum** (handoff `2026-06-30-platform-close-reason-enum-handoff.md`, bundled with the pending prices/lifecycle handoff): enables the cheap typed selection path. **Not blocking** — the headroom fallback ships and works without it; the typed path replaces the fallback when the SDK release lands.
- Builds on the merged per-trade context + post-exit tail (`main`). PR #111 (post-exit tail) should be merged before this lands (this sub-project assumes the `@post` tail exists).

---

## 6. Testing

- **`selectWinningTrades`** (unit): `isWin===true` selected; `isWin==null` + `realizedPnl>0` fallback selected; losers/breakeven excluded; cap honored; deterministic order.
- **Winner ranking** (unit): typed path orders the early/headroom `closeReason` set ahead of final/trailing; fallback path orders by post-exit favourable continuation (a winner whose tail continued favourably ranks above one that stalled) and reuses the fetched rows for context (assert no second fetch).
- **Two-pass handler** (unit): two `propose()` calls with `focus='loss_reduction'` then `'profit_improvement'`, correct trade subsets per pass (losers vs winners; forensic/similar only on loss); profit pass **skipped** when no winners; both passes' drafts merged through dedup→validate; per-pass `researcher.pass_completed` events; `origin` tag set per draft.
- **`buildPrompt`** (unit/snapshot): `focus`-specific capability block + ask line; the profit block names bigger-TP/trailing/hold-longer; the **critical-profile** framing (relax/remove/replace + `allow_entry`/`no_op`) appears in **both** passes; active overlay rules render (and degrade to "no active overlay rules yet"); winners render with the same `@entry`/`@exit`/`@post` formatter.
- **`RESEARCHER_CAPABILITIES`** (unit): profit-improvement framing + critical-profile terms present; loss framing retained; runner-owned guard intact.
- **Fake researcher** (unit): honors `focus` (distinct deterministic output per focus) so the fake-adapter demo path exercises both passes.
- **Both gates:** `npm run typecheck` exit 0 + `npx vitest run` green.

---

## 7. Risks & cost

- **Two LLM calls per cycle** ≈ doubles researcher cost when winners exist. Mitigated by the no-winners skip and the asymmetric (leaner) profit context; the cumulative token kill-switch bounds the worst case.
- **Fallback fetch cost:** the headroom fallback fetches rows for the winner pool (≤ 2×cap) before ranking; bounded and reused for context. The typed path removes this once the platform ships.
- **Demo data:** the mock fixture must contain winning trades with post-exit headroom for the profit pass to be live-verifiable; the `CloseReason` handoff's acceptance bakes ≥2 distinct winner close-reasons into the fixture.

---

## 8. Success criteria

1. Each cycle runs a loss-reduction pass (losers) and, when winners exist, a profit-improvement pass (winners), each yielding up to 5 hypotheses merged into the existing pipeline.
2. Winners carry the same `@entry`/`@exit`/`@post` per-trade context; selection prioritizes left-on-the-table exits (typed `closeReason` when available, post-exit-headroom fallback otherwise).
3. Both passes frame the profile critically (relax/remove/replace via existing overlay actions) and render the profile's active overlay rules for critique.
4. Drafts are origin-tagged; per-pass events emitted; profit pass skipped with no winners; engine/formatter/catalog/critic-refiner untouched; typecheck exit 0 + full suite green.
