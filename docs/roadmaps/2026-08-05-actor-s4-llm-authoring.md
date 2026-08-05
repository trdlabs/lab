# Actor contract S4 — LLM authoring contour (lab-local roadmap entry, 2026-08-05)

Canonical cross-repo status lives in the control-center
[shared-execution-engine card](../../../control-center/docs/delivery/initiatives/shared-execution-engine.md)
(section «S4 / LLM-авторский контур», recorded 2026-08-05); this file keeps only
lab's local slice (registry rule: no plan duplication).

Full review: control-center `docs/analysis/25-event-driven-actor-contract-review.md`
(recommendation Р13) — currently on the control-center branch
`docs/event-driven-actor-contract-design`, next to the actor-contract spec itself.

## Lab's part — `proposed`, behind Ф6/S4 (the epic's return trigger)

Both items are S4 scope (event-driven bundle authoring). Audit of 2026-08-05:
the plumbing exists, the loop and the gate do not.

- **Production Reflexion retry for bundle authoring.** Today the production
  build path is single-shot: `authorStrategyBundleHandler` = build → assemble →
  validate (fail-closed: `rejected` → return, the builder is never re-invoked);
  the revision path validates the same way (its `MAX_RETRIES = 2` re-runs
  candidate backtests, not the builder). The seam already exists: `BuildFeedback`
  (`validation.violations` | `parity.diff`) in
  `src/ports/strategy-builder.port.ts`, `buildStrategyUserMessage(profile,
  feedback?)`, and a working build → validate → prove → feedback → loop lives in
  the F2a proof harness (`src/proof/builder-proof-loop.ts`). S4 requirement:
  production authoring of event-driven bundles runs through a capped Reflexion
  loop with structured errors (industry-measured effect: QuantCode-Bench
  75.8 → 97.5 % valid generations within 1.5–2.4 iterations). The cycle-level
  retry (`enqueueResearchRetry` + FAIL/MODIFY feedback through the
  Outcome-Embargo sanitizer) already exists and is a different loop — it
  iterates hypotheses after a backtest; it does not repair an invalid
  generation before one. Related tech-debt entry: «Builder Reflexion» in
  [`conversational-operator-roadmap.md`](../conversational-operator-roadmap.md)
  — same mechanism, now anchored to this initiative.
- **Semantic smoke gate (lab ↔ backtester seam).** Missing everywhere: a
  zero-trades strategy is only caught by the full WFO/holdout battery
  (`minTradesTrain: 50` / `minTradesHoldout: 30` → `insufficient_history` /
  FAIL) — i.e. after the most expensive step; lab's `make smoke` is
  infrastructure-only, and the trade-preservation gate guards revisions, not
  activation. Requirement: a cheap run of the freshly built bundle on a short
  reference fixture with an activation check (≥1 trade / ≥N decisions) BEFORE
  the full backtest is enqueued; the verdict feeds the same Reflexion loop as
  `BuildFeedback`. Catches the largest measured class of LLM generation
  failures (17.8 % — "signal conditions do not activate on data").
