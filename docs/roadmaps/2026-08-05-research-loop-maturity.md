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
