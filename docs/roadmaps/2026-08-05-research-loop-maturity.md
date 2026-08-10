# Research-loop maturity — lab-local roadmap entry (2026-08-05)

Canonical cross-repo status lives in the control-center
[initiative registry](../../../control-center/docs/delivery/cross-repo-initiatives.md)
and the
[lab-research-loop-maturity card](../../../control-center/docs/delivery/initiatives/lab-research-loop-maturity.md);
this file keeps only lab's local slice (registry rule: no plan duplication).

Full review: control-center `docs/analysis/26-lab-llm-research-loop-review.md` —
lab as an autonomous LLM researcher vs the industry (WorldQuant BRAIN,
RD-Agent(Q), Chain-of-Alpha, QuantAgent, XAlpha, QuantaAlpha,
TradingAgents/FinMem). The review's «do not break» list — deterministic verdict
ladders, DSR/battery, Outcome-Embargo, token budget — is lab's current strength
and stays untouched.

## Lab's part — `proposed`

Item numbers mirror the card.

- **Р1 — research memory (highest value).** Today the researcher sees one last
  FAIL/MODIFY feedback and nothing older; cycle scorecards persist but have no
  consumer. Step 1: feed persisted scorecard aggregates + the profile's full
  FAIL-code history into the researcher prompt (data already persisted). Step 2:
  a persistent structural-lessons pool (positive/negative, mechanism-level, no
  observed magnitudes — embargo-compatible by construction; the prompt-embargo
  test extends to cover it) with retrieval into the prompt. Industry pattern:
  Chain-of-Alpha deprecated pool, QuantAgent KB, XAlpha failure patterns.
- **Р2 (lab side) — novelty-signal consumer.** Once backtester E5a runs in log
  mode, surface the advisory novelty score in evaluation/scorecard; co-design
  the promotion-time enforce policy (pool of admitted strategies, BRAIN-style
  threshold ≈ 0.7 with the «+10 % Sharpe» exception) with backtester.
- **Р3 — cutoff discipline.** Record model-id + knowledge-cutoff in the
  evidence of every LLM-produced artifact (hypothesis, bundle); add an
  IS-vs-paper «pre/post-cutoff decay» cut to the scorecard (paper is a forward
  test past the cutoff by construction — the property is real but unmeasured);
  a perturbation leakage test (XAlpha-style) later, after the
  `agent-eval-cadence` contour exists.
- **Р4 — LLM client hardening.** `resolveLanguageModel` passes only `apiKey`
  today (no timeout / retry / limiter / cache — load-readiness §4.7 still
  holds). Add per-call timeout + bounded retry with jitter + a concurrency
  semaphore + provider prompt-caching; attach the backlogged cheap→deep model
  cascade to this same layer.
- **Р7 — bandit routing** of research directions (loss / profit / sweep axes /
  regime) over scorecard statistics — strictly after Р1 (the bandit needs the
  memory's data). Pattern: RD-Agent(Q) contextual Thompson sampling.
- **Р8 — hygiene.** Stale `candidate` revision sweep (P0-3 tail — a crash
  between create and terminalization still leaves an eternal candidate);
  revisit the W5 `proxy_*`-orphan trade-off as volume grows.

## Wave 2 additions (2026-08-05, reviews 27 + 28) — `proposed`

Source: control-center `docs/analysis/27` (Chain-of-Alpha / QuantAgent / XAlpha read
first-hand) and `docs/analysis/28` (execution-layer landscape, ~30 systems). Item
numbers mirror the card's «Дополнение 2026-08-05» table.

- **Р1+ (refines Р1).** Memory format per XAlpha: GOOD summary = transferable
  mechanism principles + an explicit «do not copy verbatim» constraint; BAD =
  {failure type, failed assumption, avoidance rule, repair condition}; buffer
  with diversity limits and post-injection clearing. FAA lesson: attach feedback
  to the hypothesis's **final** form after a MODIFY chain, not the seed form
  (synergy with the Р6 `derivedFrom` contract).
- **Р2+ (refines Р2).** Two-threshold novelty: a soft advisory threshold during
  search (novelty score into generator feedback) and a hard one at promotion —
  confirmed independently by XAlpha (0.95 generation / 0.60 library) and
  Chain-of-Alpha (Diversity feedback axis).
- **Р3+ (refines Р3).** Perturbation leakage tests made concrete: truncation +
  future-noise of the input; earlier values must be invariant. Home: the
  builder eval harness.
- **Н3 — tri-alignment gate before the backtest.** Three separate verdicts:
  (1) the code implements the thesis, (2) the mechanism as implemented is
  financially sound, (3) the thesis itself is sound. Sits between builder and
  the overlay run; reuse the critic slot (currently off) by changing its role
  from «critique the idea» to «check idea ↔ code»; repair may fix either the
  code or the hypothesis text. Mandatory agreement measurement — see Б7.
- **Н4 — hypothesis complexity discount.** Trivial metric on our closed rule
  vocabulary (rules × params); advisory discount in scoring or a soft prompt
  limit for the researcher.
- **Б4 — static rule audit before any run.** Dead branches, never-true
  conditions, profile conflicts (model: KryllOS AI Audit); deterministic,
  merges naturally with Н3.
- **Б5 — content-hash LLM cache as evidence.** SHA-256(prompt+model) → frozen
  response: reproducibility + audit trail + cost savings (model:
  ai-hedge-fund); implemented inside the Р4 client wrapper.
- **Б7 — agreement measurement for LLM proxy gates.** Smoke gate (lab#207) and
  the future Н3 gate measured against actual backtest verdicts, with drift
  alerts — the QuantAgent anti-lesson (judge agreement never measured) and the
  Auto-Quant oracle-gaming episode (the repair loop became the overfitting
  engine).

Anti-lessons pinned by the same wave (do not «improve» these away): no observed
magnitudes into the loop in any compression (our embargo is stricter than all
three systems); no inheriting the industry's missing multiple-testing
correction; no weakening the enforced promotion ladder.

## Wave 3 additions (2026-08-10, review 31 — Vibe-Trading) — `proposed`

Source: control-center `docs/analysis/31` (HKUDS/Vibe-Trading read from
source, ~327k LOC — the largest live open-source system of our own class B).
Item numbers mirror the card's «Дополнение 2026-08-10» table.

- **ВТ1 — Research-Goal container.** A long-lived research goal above
  individual cycles: owner acceptance criteria, evidence rows verified against
  artifacts (hash / existing run), a fail-closed completion audit (a goal
  cannot close without verified evidence per required criterion), and budgets.
  The missing frame for Р7 (the bandit needs both Р1's statistics and a goal
  to optimize) and for explicit stop criteria. Model: Vibe-Trading `src/goal/`
  (goals / criteria / evidence / audits). Priority: medium, after Р1.
- **ВТ4 — methodology fingerprint (refines Р3, pairs with Б5).** Hash(system
  prompt, model, capability catalog, package versions) recorded in the
  evidence of every LLM-produced artifact, invariant to run-id/time, plus a
  diff report «what changed between runs»; model-id + cutoff (Р3) becomes a
  special case of the fingerprint. Model: `governance/manifest.py`.
- **ВТ5 — decay lifecycle for admitted strategies.** Rolling paper/live
  metrics vs the backtest baseline, thresholds + warning counters, automatic
  monitoring → decayed → retired transitions; retires a strategy when its edge
  is gone — paper.monitor watches bot health today, not edge decay. Model:
  `strategy_store/decay.py`.

Confirmations without new items: Р3+ perturbation leakage testing got a second
independent cost proof — Vibe-Trading runs poison-the-future invariance on
100 % of a 462-factor catalog in CI (`test_lookahead.py`); their
generated-code preflight is another (weaker, structure-only) reference for
Б4/Н3. Anti-lesson, sharpened: Vibe-Trading has DSR / CSCV / purged-CV
implemented in a library but wired into no decision path, and the verdict
belongs to the LLM — exactly the «statistics exist, the verdict ignores them»
gap our break battery closed. Validation-side samples of the same review (Б1
poison-future pattern, Б2 random control with a no-default-argument rail) are
tracked by the control-center `research-validation-hardening` card.

Related, tracked elsewhere:
- Eval cadence (Р5) — control-center
  [`agent-eval-cadence`](../../../control-center/docs/delivery/initiatives/agent-eval-cadence.md)
  card (EV-1/EV-2), reinforced by review 26: an eval run is required in any PR
  touching a prompt or a model.
- `derivedFrom` + semantic hypothesis dedup (Р6) — R12 tail of
  [`research-validation-hardening`](2026-07-23-research-validation-hardening.md);
  review 26 raises its priority (without lineage the DSR trial counter
  undercounts families).
- Builder Reflexion retry + semantic smoke gate — already recorded:
  [`2026-08-05-actor-s4-llm-authoring.md`](2026-08-05-actor-s4-llm-authoring.md)
  (lab#207).
