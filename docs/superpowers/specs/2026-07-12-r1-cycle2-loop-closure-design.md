# R1 — Cycle-2 loop closure (accepted revision → paper) + W4 WFO gate

**Date:** 2026-07-12
**Status:** design approved (brainstorming), ready for writing-plans
**Source:** `docs/research/2026-07-11-hypothesis-evaluation-workflow-review.md` — W1 (loop dead-end) + W4 (unconditional WFO enqueue).
**Related:** G2b paper bridge (`paper-start.handler.ts`), G3 revisions (`revision-build.handler.ts`), G3b consolidation (`revision-consolidate.handler.ts`), G1 baseline lane (`strategy-baseline.handler.ts`).

---

## 1. Problem

**W1 — the improvement loop is a dead-end by default.** In `revision-build.handler.ts`, once a revision is accepted (`status: 'accepted'`, `revision.accepted` emitted), the ONLY follow-up trigger is G3b consolidation:

```
if (services.consolidator !== null && services.consolidationDepthThreshold > 0 && newDepth >= threshold)
  → enqueue revision.consolidate
```

With `CONSOLIDATOR_ADAPTER=off` (the default → `consolidator === null`), nothing fires. The accepted, improved revision is persisted and then sits there — it never re-baselines and never returns to paper. The re-baseline→paper machinery lives ONLY inside `acceptConsolidation` (the consolidation ACCEPT path). So an accepted revision that isn't consolidated is a terminal state.

**W4 — `strategy.baseline` enqueues `strategy.wfo` unconditionally** (`strategy-baseline.handler.ts:81-90`), even when baseline validation returned FAIL/MODIFY/INCONCLUSIVE. The expensive LLM WFO sweep burns budget on a branch whose base didn't validate.

## 2. Goal

Close the loop: **every** accepted revision (not only consolidated) re-baselines and returns to paper through the existing chain, and WFO only runs when the baseline validates.

Non-goals (explicitly out of R1): new paper path (reuse `baseline → wfo → paper.start`), consolidation changes, DSR/OOS rigor (that's the backtester Phase E reconciliation, `docs/research/2026-07-12-backtester-phase-e-lab-reconciliation.md`), a fresh-profile "rescue via WFO" policy (deferred — see §6).

## 3. Design

Three changes. The existing chain `strategy.baseline → strategy.wfo → paper.start` (paper.start fires only on a PAPER_CANDIDATE WFO champion) is reused verbatim.

### 3.1 Generalize the re-baseline trigger (`revision-build.handler.ts`, ACCEPT path)

The consolidation trigger and a new direct re-baseline are **mutually exclusive** at the accept point — consolidation re-baselines the *consolidated* revision; when it doesn't fire, we re-baseline the *accepted composed* revision directly. Mutual exclusion prevents a double re-baseline / double paper submission.

```
// after revision.accepted is emitted:
const newDepth = (accepted.compositionDepth ?? 1) + 1;
if (services.consolidator !== null && services.consolidationDepthThreshold > 0 && newDepth >= threshold) {
  // unchanged: enqueue revision.consolidate (it re-baselines the consolidated revision)
} else {
  // NEW: direct re-baseline of the accepted revision in ready-bundle mode
  await services.revisions.updateStatus(revisionId, { baselineValidationStatus: 'pending', updatedAt: now() });
  await createAndEnqueueTask({
    taskType: 'strategy.baseline', source: task.source,
    payload: { strategyProfileId, bundleArtifactRef, revisionId },  // bundleArtifactRef = the local at the ACCEPT point = the accepted candidate's bundle ref
    correlationId: task.correlationId,
    dedupeKey: `strategy.baseline:accepted:${revisionId}`,
  }, { repo: services.researchTasks, queue: services.taskQueue });
}
```

- `bundleArtifactRef` is the local at the ACCEPT point. It holds the **accepted candidate's** bundle ref: ACCEPT `break`s the greedy loop *before* the next reduction (reduction only runs at the end of the loop body after a REJECT), so the local reflects any greedy hypothesis drops that produced the accepted combo. Ready-bundle mode → `reconstructStrategyBundle` reconstructs deterministically (hash-verified, NO LLM rebuild — the drift that self-blocked WFO in G1).
- `revisionId` is the accepted revision's id (the `revisionId` local already in scope).
- dedupeKey namespaced `:accepted:` (distinct from consolidation's `:consolidated:`) → one re-baseline per accepted revision, idempotent.

### 3.2 Generalize the `strategy.baseline` payload link field (`consolidatedRevisionId` → `revisionId`)

The ready-bundle writeback target is "the revision this baseline validates" — consolidated OR composed. Introduce a general `revisionId` field, **keeping `consolidatedRevisionId` as a transient deprecated alias** so `strategy.baseline` tasks already queued (or deduped) with the old field name don't silently lose their writeback across the deploy:

- `StrategyBaselinePayloadSchema`: add `revisionId?: string`; keep `consolidatedRevisionId?: string` marked `@deprecated`.
- Resolve once: `const revisionId = parsed.data.revisionId ?? parsed.data.consolidatedRevisionId;`
- Writeback block: `if (revisionId)` → `updateStatus(revisionId, { baselineValidationStatus, baselineExperimentId, baselineTaskId, updatedAt })`.
- Migrate the single new-code caller `acceptConsolidation` (`revision-consolidate.handler.ts`): emit `revisionId: newId` (not `consolidatedRevisionId`). (Fresh-profile baselines — CLI, onboard chain — set neither; unaffected.)
- **Cleanup later:** drop the `consolidatedRevisionId` alias in a separate commit once the queue has drained past the deploy.

### 3.3 W4 gate — WFO only after a passing baseline (`strategy-baseline.handler.ts`)

Hoist the verdict→status mapping OUT of the (now `revisionId`) writeback block so it is computed for **every** baseline run, then gate the WFO enqueue on it uniformly:

```
const baselineValidationStatus =
  verdict === 'PASS' || verdict === 'PAPER_CANDIDATE' ? 'passed'
  : verdict === 'INCONCLUSIVE' ? 'inconclusive'
  : 'failed';

if (revisionId) {  // resolved = parsed.data.revisionId ?? parsed.data.consolidatedRevisionId (§3.2)
  await services.revisions.updateStatus(revisionId, { baselineValidationStatus, baselineExperimentId: experimentId, baselineTaskId: task.id, updatedAt: ... });
}

if (baselineValidationStatus === 'passed') {
  await createAndEnqueueTask({ taskType: 'strategy.wfo', payload: { baselineExperimentId: experimentId }, ... });  // unchanged shape
} else {
  await services.events.append(event(task.id, 'strategy.baseline.wfo_skipped', { strategyProfileId, experimentId, verdict, reason: 'baseline_not_passed' }));
}

await services.events.append(event(task.id, 'strategy.baseline.completed', { strategyProfileId, experimentId, verdict, bundleHash }));  // still always fires
```

**Uniform scope (ratified):** the gate applies to ALL `strategy.baseline` runs — fresh-profile Cycle-1 onboarding included. Rationale: once the handler has a verdict, `failed`/`inconclusive` should not launch the expensive downstream by default, regardless of caller. The failure branch is observable via `wfo_skipped`, not silent.

**Fresh-profile INCONCLUSIVE rescue hatch (added post-review):** one explicit, named exception — `allowWfoOnInconclusiveForFreshProfile = !revisionId && baselineValidationStatus === 'inconclusive'`. A fresh-profile Cycle-1 baseline (no `revisionId`) that comes back INCONCLUSIVE (too few trades to validate — e.g. long_oi on the demo fixture, tradeCount≈0) STILL enqueues WFO, because the sweep is the intended rescue to find params that generate enough trades. FAIL still stops; revision re-baselines (`revisionId` present) stay strict on INCONCLUSIVE. In-code named policy, no env var. Gate becomes `if (baselineValidationStatus === 'passed' || allowWfoOnInconclusiveForFreshProfile)`.

## 4. Data flow

```
revision accepted (composed, consolidation off)
  → revision-build sets revision.baselineValidationStatus='pending', then enqueues strategy.baseline { bundleArtifactRef, revisionId }
    → strategy.baseline validates (ready-bundle, hash-verified) → writes status to the revision
      → passed     → strategy.wfo → WFO contour → paper.start (on PAPER_CANDIDATE) → platform intake
      → failed/inconc → stop; strategy.baseline.wfo_skipped
```

Consolidation-on path is unchanged: accepted → revision.consolidate → (consolidated) strategy.baseline { revisionId: consolidatedId } → same downstream.

## 5. Testing

- **revision-build** (`revision-flow.integration.test.ts`): (a) accepted revision, `consolidator: null` → enqueues `strategy.baseline` with `revisionId` + `:accepted:` dedupeKey, NOT `revision.consolidate`; sets `baselineValidationStatus:'pending'`. (b) `consolidator` set + depth ≥ threshold → enqueues `revision.consolidate`, NOT a direct `strategy.baseline` (mutual exclusion). (c) reject path → neither.
- **strategy.baseline** (`strategy-baseline.handler.test.ts`): (a) `revisionId` present + verdict PASS/PAPER_CANDIDATE → writeback `passed` + enqueues `strategy.wfo`. (b) verdict FAIL/MODIFY → writeback `failed`, NO `strategy.wfo`, emits `wfo_skipped`. (c) verdict INCONCLUSIVE → writeback `inconclusive`, NO `strategy.wfo`, emits `wfo_skipped`. (d) fresh-profile (no `revisionId`) + PASS → `strategy.wfo` enqueued, no writeback. (e) fresh-profile + FAIL → NO `strategy.wfo` + `wfo_skipped` (documents the uniform-scope behavior change). Existing "enqueues strategy.wfo" tests: ensure their fake `runStrategyBaselineValidation` returns a PASS-class verdict (adjust fixtures where they don't).
- **revision-consolidate** (`revision-consolidate.handler.test.ts`): caller migrated — `strategy.baseline` payload carries `revisionId`, writeback still lands on the consolidated revision.
- **strategy.baseline back-compat** (`strategy-baseline.handler.test.ts`): a payload with the deprecated `consolidatedRevisionId` (no `revisionId`) still writes back to that revision — locks the transient alias (§3.2) until the cleanup commit removes it.

## 6. Deferred follow-ups (not R1)

- **Consolidation-reject re-baseline fall-through** (whole-branch review Important #1): under `CONSOLIDATOR_ADAPTER` on, when consolidation is triggered but then REJECTs (any of its ~11 fail-safe returns: `missing_run_context`, `bundle_invalid`, parity `REJECT`, `concurrent_revision`, …), the accepted revision `R` stays accepted and is never re-baselined — because the direct re-baseline lives in the `else` of the consolidation-*fires* condition. So the W1 dead-end reopens for that config. Off by default (consolidator null; also awaits the mastra adapter), so the default deploy is correct. Fix: on a consolidation reject, fall through to a direct re-baseline of `R` (in `revision-consolidate.handler.ts`'s reject paths, or a re-check in `revision-build`). Ticket this.
- ~~`allowWfoOnInconclusiveForFreshProfile`~~ — DONE in R1 (see §3.3 rescue hatch), promoted from deferred after the whole-branch review confirmed the demo fixture yields INCONCLUSIVE.

## 7. Invariants / gotchas

- Ready-bundle mode NEVER calls `strategyBuilder.build` — deterministic reconstruction only (hash stability; the G1 self-block).
- Mutual exclusion of consolidate vs direct re-baseline at the accept point is load-bearing (double paper-submit otherwise).
- No new env; the direct path is gated by the existing consolidator-null default. Paper intake still gated downstream by `LAB_PAPER_INTAKE_URL`.
- `strategy.baseline.completed` fires on every run regardless of the WFO branch.
