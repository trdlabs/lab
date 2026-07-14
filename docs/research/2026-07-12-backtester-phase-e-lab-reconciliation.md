# Backtester Phase E ↔ trading-lab reconciliation

**Date:** 2026-07-12
**Status:** cross-repo boundary SSOT (living). Supersedes ad-hoc mentions of backtester rigor work in the lab roadmap.
**Sources:** `backtester/docs/ROADMAP.md` §"Phase E", `backtester/docs/FEATURE-PARITY.md`, `backtester/docs/superpowers/specs/2026-07-12-e1a-metrics-catalog-design.md` (E1a shipped, commit `2e0bbdf` in worktree `sorted-juggling-spindle`).
**Related lab docs:** `docs/research/2026-07-11-hypothesis-evaluation-workflow-review.md` (R1–R14), `docs/superpowers/specs/2026-06-30-backtest-research-orchestrator-roadmap.md` (G-roadmap, phases A–F / gaps G1–G7).

---

## §1. Name-collision resolution (read first)

Two unrelated "Phase E"s exist in the ecosystem:

| Phrase | Repo | Meaning |
| --- | --- | --- |
| **backtester Phase E (rigor)** | `backtester` | research rigor / anti-overfitting track (E1–E5). THIS document. |
| **lab Phase E (office panels)** | `lab` G-roadmap §6.1 | trading-office UI panels (experiment list / fold timeline / regime heatmap). Unrelated. |

**Convention:** always prefix with the repo — *"backtester Phase E"* or *"lab Phase E"* — never bare "Phase E". No letter rename (avoids churning shipped-plan references); the convention plus this note is the fix.

---

## §2. What backtester Phase E is

Anti-overfit track, **not** a performance track (the A–D scaling ladder is deliberately paused — no bottleneck today). Motivation: the C/D scaling work *amplifies* selection bias (the more variants the LLM loop can afford, the stronger the survivorship overfit), so rigor is the track that will eventually *re-justify* Tier-3 scaling by generating the load.

Dependency-ordered, every slice additive (rides the existing requested-`metrics` mechanism → unrequested ⇒ byte-identical results, golden-gate INV preserved):

| Slice | What | Status |
| --- | --- | --- |
| **E1a** | metric catalog: Sortino/Calmar/CAGR/SQN + return moments for DSR | ✅ shipped (`2e0bbdf`) |
| **E1b** | machine-readable failure channel: quality vector + failure-mode (`no_entries`/`suspected_overfit`/`complexity_violation`/`hypothesis_mismatch`) + per-trade diagnostics artifact | ⏳ next |
| **E2** | trial ledger + **Deflated Sharpe gate** (advisory-first); N-per-hypothesis-family; DSR + N into signed evidence | 📋 |
| **E3** | walk-forward split as first-class request param (folds = deterministic sub-runs on the existing queue); CPCV+PBO later | ✅ merged dark upstream (E3a + E3b, backtester PR #121, flag OFF; lab consumer not started — see R3b-2) |
| **E4** | server-declared held-out OOS qualification window the lab/LLM loop cannot iterate against | ✅ merged dark upstream (E4a + E4b, backtester PR #128, flag OFF; platform admission PR #118 also merged dark — enforcement NOT enabled) |
| **E5** | novelty gate: daily-PnL-delta correlation of candidate vs admitted pool; novelty score in `RunResultSummary` | 📋 |

---

## §3. Build-vs-consume decisions (ratified 2026-07-12)

The core reframing: backtester Phase E takes server-side ownership of statistical rigor that the lab roadmap had parked as data-gated future work. Lab therefore **consumes, not rebuilds** in three places:

1. **DSR → consume from E2, do NOT build in lab.** Reverses lab **R13** (which staged DSR as a *maybe-later advisory scorecard field*). Backtester computes DSR server-side from Sharpe + return moments and records DSR + N into the signed evidence bundle. Lab's job shrinks to: surface DSR + N in the scorecard (R5) and honor them as advisory inputs. Lab does not own the DSR math.
2. **Multi-fold WFA → delegate folds to E3, do NOT orchestrate folds in lab.** Simplifies lab **R13 (multi-fold half) / G-roadmap Phase B-full**. E3 makes the split scheme a request parameter; folds are deterministic sub-runs that get dedup/coalescing/horizontal-workers for free. Lab requests the split and consumes per-fold metrics + fold-stability, instead of driving folds through `ParamGridRunner`. (The lab-side 1-fold holdout already shipped (PR #119) stays; the *multi*-fold generalization moves server-side.) Lab **R14 (regime breakdown)** stays lab-owned — it consumes the per-fold/regime metadata E3 returns.
3. **Trial-count N (selection bias) → server-side counter.** Partially closes lab **R7** ("из N проверенных"). Backtester sees every run (fingerprint layer) and owns the N counter. Lab owns only the **family-identity layers** that make N meaningful (§4, L1/L2).

Non-reversals (lab still owns): R1 (close the Cycle-2 loop), R2 (trade-preservation gate — shipped), R4 (feedback into prompt), R5 (scorecard artifact).

---

## §4. E1–E5 → lab obligation map

Phase E is two-sided — almost every slice has a lab counterpart, and most land on code lab **already has**:

| backtester slice | lab obligation | Lands on |
| --- | --- | --- |
| **E1a** (done) | request the new metrics; surface in scorecard | R5; likely SDK bump for the widened `RunResultSummary.metrics` |
| **E1b** | researcher loop consumes the failure channel | **direct receiver for lab R4 / W2 / W3** — the dead `payload.feedback` retry path + unrendered `minuteContext`/decision-log |
| **E2 (DSR)** | consume DSR + N from evidence (do not build) | R13 reversal (§3.1), R7 |
| **E2 (family identity)** | **L1**: `derivedFrom` field on the bundle manifest (new, small contract addition) — lab sets it when chaining edited bundles. **L2**: wire lab's existing (advisory) similarity ports into the **pre-submit** path + stamp `familyHint` on submit so N is inherited, not reset | `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts` + `pg-hybrid-strategy-similarity.adapter.ts` (already implemented, advisory) — the E2 plan explicitly leans on them |
| **E3 (WF)** | request split scheme; consume per-fold metrics | R13 (multi-fold) / Phase B-full delegation (§3.2); feeds R14 regime breakdown. **Also the target home for R3b-2 (per-hypothesis OOS):** deferred from lab (brainstorm 2026-07-13) — a faithful lab-side per-hypothesis train/holdout would need a blocking cycle-head baseline run for one immutable boundary T, and `research-run-cycle` has no backtest-execution today. E3b (temporal WF folds) is **already implemented + merged in the backtester** — R3b-2 waits NOT on E3b implementation but on the rollout chain: **SDK release → capability/version negotiation → lab consumer → staging validation → flag enable.** R3b-2 becomes a pure consumer of those folds for the hypothesis overlay (split = request param, engine returns per-fold metrics, no lab fold-orchestration, no lab metric-recompute) + a downgrade-only gate over the ladder. No separate lab implementation is started now. R3a's trade-count boundary stays for the merged-revision gate; a per-hypothesis trade-powered boundary is a later add-on only if temporal folds prove too weak. |
| **E4 (held-out)** | **Outcome Embargo** on agent-memory: RAG must never expose held-out/qualification-period outcomes back into generation (else the RAG layer becomes the test-leak channel) | R3 (OOS discipline, Cycle 2) |
| **E5 (novelty)** | consume novelty score from `RunResultSummary` as a loop reward; feed confirmed behavioral matches back to the L2 semantic layer | strategy-discovery floor |

**Family-identity authority hierarchy** (mirrors lab's existing `EvidencePolicy` rule "fingerprint is the only exact-duplicate authority; semantic matches are always *similar*, never *the same*"): L0 fingerprint (exists) → L1 hypothesis-id + `derivedFrom` lineage → L2 pre-submit semantic similarity (lab) → L3 PnL-delta correlation (= E5, the final arbiter; correlated trials shrink effective N).

---

## §5. Open contract items lab must add (tracked)

Small, additive, unlocked as the matching backtester slice lands:

- [ ] `derivedFrom` on the bundle manifest (L1) — set when lab chains an edited bundle into an existing family. Blocks on: E2 contract shape.
- [ ] `familyHint` on the submit path (L2) — stamped from a pre-submit similarity hit so N is inherited. Blocks on: E2.
- [ ] Wire `SimilarHypothesisSearchPort` into pre-submit/pre-codegen (currently advisory-only, not gating). Lab-only; can start ahead of E2 as advisory-in-loop.
- [ ] Request the E1a metrics + SDK bump for the widened `RunResultSummary.metrics`. Ready now (E1a shipped).
- [ ] Consume E1b failure channel in the researcher prompt (= R4 done properly). Blocks on: E1b.
- [ ] **Outcome Embargo on agent memory (E4/E4b) — lab-owned, HARD PRODUCTION BLOCKER.** Owner:
  lab (alexxxnikolskiy); no other repo can close this. The upstream dependency is no longer the
  blocker: backtester E4a+E4b are merged dark (their PR #128, gate flag OFF) and the platform
  v2-verifier/admission is merged dark (their PR #118, flag OFF) — E4b production enablement now
  waits on **this item** plus real-v2 integration validation. Remaining lab work: window/budget
  policy decision → implementation + tests → deploy. Canonical cross-repo status, enable order,
  and rollback:
  [E4b card in control-center](../../../control-center/docs/delivery/initiatives/e4b-heldout-promotion-enforcement.md)
  — local docs keep only this ownership line, not the rollout plan.

---

## §6. Sequencing vs current lab work

- **R1 (close the Cycle-2 loop) is NOT blocked by Phase E** — it is about returning an accepted revision to paper, orthogonal to rigor. Proceed with R1 as planned.
- The Phase-E lab obligations slot in **as the matching backtester slice ships**: E1a-metrics consumption + L2 pre-submit wiring can start now (both are lab-only or already-shipped-upstream); E1b/E2/E3/E4/E5 consumers wait on their upstream.
- When picking up R3/R4/R13/R14, re-read §3–§4 here first — the build-vs-consume boundary changes what lab actually implements.
