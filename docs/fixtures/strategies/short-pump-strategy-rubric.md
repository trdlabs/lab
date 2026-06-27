# Rubric: short_pump StrategyProfile evaluation

Score the candidate StrategyProfile against these dimensions (each 0–1). Use the source
description and the research notes as ground truth. Penalize invented specifics.

## Dimensions

1. **Direction** — Net bias is short-only. No long branch invented.
2. **Core idea** — Mean-reversion after a sharp pump; enter short on a confirmed rollover backed by OI stalling/declining + a liquidation cascade. Not trend-following.
3. **Market features** — Names the real data needs: OHLCV (1m candles), open interest (OI), liquidations (funding optional). No technical indicators claimed (the strategy is rule-based).
4. **Entry trigger** — Pump detection (~10% rise) → watch → confirmed rollover (price falling / red candles), OI stalling/declining, liquidations present near the high.
5. **Exit ladder** — TP1 (−3.5%, partial), TP2 (−5%, full), hard stop (+12%), time exit (180m). Move stop to breakeven after TP1.
6. **Position management** — DCA averaging (max two adds on further spikes up); breakeven after TP1.
7. **Boundary discipline** — Treats position sizing, leverage, fills, fees, exchange, and instrument universe as runner/platform-owned. Does NOT invent exact leverage or base order size. DCA size multipliers are hints only.
8. **Unknowns honesty** — Flags missing sizing/leverage, fees, exchange, and instrument universe (or equivalents) rather than fabricating them.

## Hallucination flags (list any present)

- Invented leverage (e.g. "10x") or base order size (e.g. "$100").
- Invented fees, commissions, exchange, or specific instrument list.
- Claimed technical indicators or a trailing stop (the strategy uses neither).
- A long entry branch (the strategy is short-only).

## Missing-from-profile (list rubric items the profile omitted)

Note any of dimensions 1–8 the profile fails to cover.
