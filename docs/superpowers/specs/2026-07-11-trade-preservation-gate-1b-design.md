# Trade-Preservation Gate — Slice 1b (hypothesis proxy lane, cross-repo) Design Spec

**Date:** 2026-07-11
**Parent:** `docs/superpowers/specs/2026-07-11-trade-preservation-gate-design.md` (§1.5 slice split). Slice **1a is SHIPPED** (PR #147 → main `05170d3`, revision lane). This spec is **slice 1b** — extend the same veto to the **hypothesis proxy lane** (mechanism #1).
**Cross-repo:** yes — `backtester` (persist baseline trades) + `lab` (consume + gate). `@trdlabs/sdk` unaffected.
**Two plans:** `slice 1b-backtester` (ships first, additive/backward-compatible) then `slice 1b-lab`.

---

## 1. Problem & mechanism

The hypothesis proxy lane (`finalizeBacktestCompletion` ← `applyPlatformTerminalOutcome`) is a **single overlay run**: the backtester simulates baseline + variant internally (`runner.ts::runBacktest`), computes deltas (`computeComparison`), and **discards baseline trades** — `overlay-store.ts::persistOverlayArtifacts` persists only the headline (variant) `trades` artifact. lab gets the variant runId (→ variant trades) and baseline **aggregates only**. `comparison.baselineRunId` exists in the SDK contract but there is no baseline-trades artifact.

R2's trade-level veto needs BOTH runs' per-trade records. So 1b makes the backtester persist baseline trades as an additive artifact, and wires `applyBacktestPreservationGate` into the proxy lane.

**Why this lane matters despite proxy-PASS being non-terminal:** catching gaming at proxy time downgrades a gamed hypothesis to MODIFY (feeds the retry loop with a reason) before it ever becomes eligible for the revision combine. The revision lane (1a) remains the full-fidelity choke point.

---

## 2. Decisions (locked in brainstorming)

- **Exposure mechanism = B1** (artifact, not a typed SDK field). baseline trades are DATA — their home is the artifact contract, symmetric with `trades`. No `@trading-backtester/sdk` typed-contract field, no SDK release, no lab re-pin (subject to the version-compat check in §7).
- **fetch failure = fail-open + event** on BOTH lanes. absent-artifact (old backtester / non-comparison run) is always a graceful skip. A transport exception is also fail-open. The gate is a hardening layer, not a correctness gate; blocking the pipeline on a transient fetch is worse, and the proxy lane's PASS is non-terminal.
- **Scope = proxy lane only** (`finalizeBacktestCompletion`) + `evaluation.preservation_gate` column. The experiment/holdout path (`evaluateExperiment`) is a **deferred follow-up**, not this slice.
- **1a retrofit:** change the revision lane's fetches from fail-closed (current: throws) to fail-open + event, for consistency — closes the 1a residual.

---

## 3. Backtester (`slice 1b-backtester`)

### 3.1 Persist baseline-trades artifact
`apps/backtester/src/artifacts/overlay-store.ts::persistOverlayArtifacts`:
- Add an `ArtifactSpec` for baseline trades **gated on `outcome.comparison != null`** — the SAME signal the existing `comparison` artifact is already gated on in this function. Do NOT introduce a second source of truth (`outcome.variant != null`): in `runner.ts::runBacktest`, `variant` and `comparison` are set together (`comparison = computeComparison(baseline, variant)` runs in the same `if (overlays)` block), so `outcome.variant != null ⇔ outcome.comparison != null`. Reuse `comparison != null` for consistency with the sibling artifact; the plan adds an invariant test asserting the equivalence so a future divergence is caught.
  ```
  // inside the same `outcome.comparison != null ? [...] : []` block as the `comparison` artifact:
  { artifactType: BASELINE_TRADES, payload: outcome.baseline.trades, itemCount: outcome.baseline.trades.length }
  ```
- **Exact artifactType value: `'baseline-trades'`** — declared as a named constant `BASELINE_TRADES` (do NOT inline the bare string; both write-side and any read-side keying reference the constant to prevent drift). Place it beside the other artifact-type usages / in the artifact-type module.
- **Descriptor creation rule (exact):** the baseline-trades descriptor is created **iff** `outcome.comparison != null`. When there is no comparison (non-comparison run), the headline IS the baseline and the existing `trades` artifact already carries baseline trades — do NOT emit a separate baseline-trades artifact. When `outcome.comparison != null`, always emit it, **even if `outcome.baseline.trades` is empty**. Semantics for the consumer: **descriptor absent = feature/comparison unavailable** (old backtester or non-comparison run); **empty `[]` payload = artifact present, baseline genuinely produced zero trades**. Never emit an empty artifact to mean "unavailable".
- `closeReason` (incl. `end_of_data`) is already serialized into each trade row (engine `Trade.closeReason`); baseline trade rows carry it identically to variant rows. No writer change for that.
- Each artifact is content-hash addressed independently (`store.write(payload)`), so existing artifacts' `contentHash`es are unchanged. The new descriptor joins the manifest (which sorts specs by `artifactType`).

### 3.2 Contract version bump
- Bump `ARTIFACT_CONTRACT_VERSION` (`@trading-backtester/sdk/contracts`, currently `'022.1'`) → `'022.2'` (minor = additive, backward-compatible). Update `docs/ARCHITECTURE.md` parity-anchor line and any snapshot/fixture that pins the exact value.

### 3.3 Backtester tests
- New: comparison run emits a `baseline-trades` descriptor; non-comparison run does NOT; empty-baseline comparison emits an empty (`[]`) baseline-trades artifact (present, not absent).
- New invariant test: `outcome.variant != null ⇔ outcome.comparison != null` (guards against a future divergence that would desync the two comparison-run signals).
- Update: `comparison-wire.test.ts` and any artifact/manifest test asserting the exact descriptor set/count (the new descriptor is additive — adjust expected sets).
- **⚠️ byte-proof / golden guard:** verify no golden or byte-identity test asserts the exact manifest descriptor list in a way the additive descriptor breaks. If one does, update it as an intended additive change (document why). Existing per-artifact `contentHash`es must be unchanged.

### 3.4 Rollout
Additive + backward-compatible: an old backtester simply omits the artifact. **The running backtester image must be rebuilt/redeployed** for the service to emit it — an ops step, tracked, but lab does not block on it (see §7 rollout invariant).

---

## 4. Lab: read baseline trades (`slice 1b-lab`)

`RunTradesPort` gains:
```
getBaselineRunTrades(comparisonRunId: string): Promise<TradeRecord[] | null>
```
- **Param is the comparison/variant runId**, NOT a baseline runId — baseline trades live as an artifact of the *comparison* run, whose manifest is keyed by the headline (variant) runId. Name it `comparisonRunId` in the port to make that explicit.
- Implementation (`HttpBacktesterRunTradesAdapter`): `getArtifactManifest(comparisonRunId)` → find the descriptor where `artifactType === BASELINE_TRADES` (lab-side named constant, value `'baseline-trades'`) → `readArtifact` + `parseTrade` (carries `closeReason`, per slice 1a).
  - **Descriptor absent → return `null`** (feature/comparison unavailable → gate skips gracefully). Present → return the parsed array (possibly `[]`).
- **Fake/mock adapters:** back `getBaselineRunTrades` with a **separate** `baselineByRun: Record<string, TradeRecord[]>` fixture map — do NOT fall back to the regular `trades` map. Absent key → `null`. (Keeps tests honest: a swapped artifactType can't accidentally pass by reusing the variant trades.)

---

## 5. Lab: proxy-lane gate + persistence (`slice 1b-lab`)

### 5.1 `applyBacktestPreservationGate` wrapper
New export beside `applyRevisionPreservationGate` (`src/validation/apply-preservation-gate.ts`):
```
applyBacktestPreservationGate(
  outcome: EvaluationOutcome, baselineTrades, variantTrades, agg, thresholds,
) → { outcome: EvaluationOutcome, preservation: PreservationMetadata }
```
- Same shape as the 1a `applyRevisionPreservationGate`: when `outcome.decision ∉ {PASS, PAPER_CANDIDATE}` → return `{ outcome, preservation: null }` unchanged (no trade work); when would-accept → run `evaluateTradePreservation`, and on a fired veto downgrade the outcome.
- **Verdict mapping:** `end_of_data_position → INCONCLUSIVE`; `abstention_gaming → MODIFY`; `winner_degradation → MODIFY`. Reason appended to `outcome.reasons`. Downgrade-only, never upgrades.

### 5.2 Wiring into `finalizeBacktestCompletion` (`backtest-support.ts`)
After `const outcome = evaluateBacktest(c, services.evaluatorThresholds)`:
- Compute `gateOn = services.preservationGateEnabled` and `wouldAccept = outcome.decision ∈ {PASS, PAPER_CANDIDATE}`.
- If `gateOn && wouldAccept`:
  - **Lazily** fetch (mirrors the 1a lazy pattern — only when would-accept):
    - `variantTrades = await services.runTrades.getRunTrades(args.runId)`
    - `baselineTrades = await services.runTrades.getBaselineRunTrades(args.runId)` (args.runId = the completed comparison/variant run)
  - **Fail-open:**
    - `baselineTrades === null` → skip gate; emit `event(task.id, 'evaluation.preservation_skipped', { runId: args.runId, reason: 'artifact_unavailable' })`; `preservationGate` stays **null**; verdict unchanged.
    - fetch throws → catch; skip gate; emit `evaluation.preservation_skipped` with `reason: 'fetch_failed'` (+ `detail: errMsg`); `preservationGate` null; verdict unchanged.
  - Else apply `applyBacktestPreservationGate` with `agg = { baseline: {netPnlUsd,totalTrades}, variant: {netPnlUsd,totalTrades} }` from `c.baseline`/`c.variant`; take the (possibly downgraded) `outcome`; capture `preservation` metadata.
- Persist: the `Evaluation` row created here gains `preservationGate: <metadata | undefined>` — **only set when the gate actually ran** (fired OR not-fired). On skip it stays undefined/NULL. Do NOT write `fired:false` on a skip.
- `kill-switch off` (`preservationGateEnabled=false`) → `gateOn` false → neither `getRunTrades` nor `getBaselineRunTrades` is called. (`finalizeBacktestCompletion` performs no other trade fetch today — these preservation fetches are the only ones on this path.)

### 5.3 Persistence
- Migration **0022**: additive nullable `preservation_gate jsonb` on the `evaluation` table (`src/db/schema.ts:222`, `$type<PreservationMetadata>()`), mirroring the 1a `strategy_revision` column.
- `Evaluation` domain type (`src/domain/evaluation.ts`) gains `preservationGate?: PreservationMetadata`.
- The evaluations repository `create` maps the field (drizzle + any in-memory impl — check both, per the 1a in-memory gap lesson).

---

## 6. Lab: 1a revision-lane fail-open retrofit (`slice 1b-lab`)

`revision-build.handler.ts` — the 1a fetches (`getRunTrades(baselinePlatformRunId)` lazy + `getRunTrades(result.platformRunId)`) currently throw on error (fail-closed). Wrap them so a transport error is fail-open:
- On throw → emit `event(task.id, 'revision.preservation_skipped', { revisionId, reason: 'fetch_failed', detail: errMsg })`; skip the veto for that attempt; the verdict stays as `evaluateRevision` produced; `firedPreservation` stays null. The greedy loop continues normally.
- (Revision lane has no `artifact_unavailable` case — mechanism #2 completed runs always have a `trades` artifact.)

**Event naming (locked):** lane-namespaced to match existing events — `evaluation.preservation_skipped` (hypothesis proxy lane) and `revision.preservation_skipped` (revision lane). Each payload carries an explicit `reason: 'artifact_unavailable' | 'fetch_failed'`. (A shared event type would be acceptable only if its payload also carried `lane: 'hypothesis_proxy' | 'revision'` — we choose the lane-namespaced names instead.)

---

## 7. Rollout & version compatibility (critical)

- **Ship order:** `slice 1b-backtester` first (additive, backward-compatible), then `slice 1b-lab`. lab with new code against an old (not-yet-redeployed) backtester must be a no-op skip — see the acceptance invariant below.
- **⚠️ Version-compat check (backtester plan's MANDATORY FIRST block — "contract/version compatibility audit"):** `ARTIFACT_CONTRACT_VERSION` is bumped `022.1 → 022.2`. lab consumes the backtester SDK as a **pinned release tarball (`@trading-backtester/sdk` v0.7.0)**. Preliminary check (user-verified): lab's pinned `BacktesterClient.getArtifactManifest()` just returns the manifest JSON with no visible strict `artifactContractVersion` gate → `022.1 → 022.2` looks safe for lab. **The plan must still LOCK this** with a test or mini-script (parse a `022.2` manifest through the pinned client and assert it does not reject) — this is a rollout gate, not a code comment. If a strict version-lock is found after all: either (a) keep `022.1` and rely on additive-descriptor ignore semantics (consumers already iterate descriptors and ignore unknowns), or (b) re-pin lab's SDK (adds a lab task). Resolve and record which, before merging the backtester slice.

---

## 8. Config

Reuse slice-1a config: `services.preservationGateEnabled` + `services.preservationThresholds` (already on `AppServices`). Same `LAB_TRADE_PRESERVATION_*` env. No new env, no new thresholds.

---

## 9. Testing

**Backtester:** §3.3.

**Lab:**
- `getBaselineRunTrades`: present descriptor → parsed trades with `closeReason`; absent descriptor → `null`; fake/mock use the separate `baselineByRun` fixture.
- `applyBacktestPreservationGate`: each verdict mapping (EOD→INCONCLUSIVE, abstention/winner→MODIFY), downgrade-only, non-would-accept untouched.
- `finalizeBacktestCompletion` integration: veto downgrades PASS→MODIFY / PAPER_CANDIDATE→INCONCLUSIVE and persists `preservation_gate`; **fail-open** on `baselineTrades===null` → verdict unchanged + `evaluation.preservation_skipped {reason:'artifact_unavailable'}` + `preservation_gate` NULL; fail-open on fetch throw → same with `reason:'fetch_failed'`; kill-switch off → no preservation fetches.
- Migration 0022 applies cleanly (additive nullable; old rows NULL).
- 1a retrofit: revision-lane fetch throw → `revision.preservation_skipped {reason:'fetch_failed'}`, veto skipped, verdict = `evaluateRevision` output (regression on the existing revision-flow integration test).

---

## 10. Acceptance criteria

1. Comparison run (backtester) emits a `baseline-trades` artifact carrying baseline per-trade records incl. `closeReason`; non-comparison run does not; empty-baseline comparison emits an empty (present, not absent) artifact.
2. Proxy lane: a would-accept verdict on a genuinely gamed variant (abstention / winner-kill / end_of_data) is downgraded (MODIFY / INCONCLUSIVE) and `evaluation.preservation_gate` is persisted.
3. **Rollout invariant:** lab with the new code against an **old backtester** (no baseline-trades artifact) leaves the verdict unchanged and writes `evaluation.preservation_skipped` with `reason: 'artifact_unavailable'` (and `preservation_gate` NULL). No exception escapes `finalizeBacktestCompletion`.
4. Fail-open on a transport fetch error: verdict unchanged, `evaluation.preservation_skipped {reason:'fetch_failed'}`, no task abort.
5. 1a retrofit: a revision-lane fetch error is fail-open with `revision.preservation_skipped`, not an aborted `revision.build`.
6. `LAB_TRADE_PRESERVATION_GATE=off` → zero preservation trade fetches on the proxy lane.
7. Full suite green; `ARTIFACT_CONTRACT_VERSION` bump does not break lab's pinned SDK client (§7).

---

## 11. Out of scope

- experiment/holdout path (`evaluateExperiment`) gate wiring — deferred follow-up.
- Typed `ComparisonSummary.baselineTradesRef` (B2) — rejected in favor of B1.
- Multi-symbol matching; `closeReason` normalization (raw engine value used, `end_of_data` matched by literal).
- The 1a Minor follow-ups (shared `UpdateStatusPatch` type, unit boundary hardening) — separate cleanup, not gated by 1b.
