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

---

## 8. Cycle-close trigger robustness (P0-1 / P0-2 — folded in 2026-07-12)

Source: code review `docs/research/2026-07-12-lab-code-review-bugs-and-bottlenecks.md` §P0-1/§P0-2; roadmap §8 triage assigns both to this slice. Both are bugs in the exact loop this slice closes: the `revision.build` trigger that batches a cycle's `proxy_passed` hypotheses.

### 8.1 The two bugs
- **P0-1 (zero-fire race):** the trigger in `backtest-completed.handler.ts` evaluates `others.every(terminal)` excluding only itself, but the worker flips a task to `completed` only AFTER its handler returns (`worker.ts:20-23`). At `LAB_QUEUE_CONCURRENCY ≥ 2` the two last `backtest.completed` handlers run concurrently, each sees the other `running`, both conclude "not terminal", and `revision.build` never fires. (This is the constraint that pins `LAB_QUEUE_CONCURRENCY=1` today.)
- **P0-2 (trigger lost on non-`backtest.completed` terminal exit):** the trigger lives only in `backtest-completed.handler`, but `hypothesis.build` has terminal exits that never produce a `backtest.completed` (all are `return`s: `missing_platform_run_config`, `builder_failed`, invalid bundle, `backtest.reused`, `datasets_unavailable`; plus throw-after-3-attempts). If the last chain member to terminalize is one of these, the trigger never runs — even at concurrency=1.

### 8.2 Design (ratified): unconditional trigger + authoritative self-recheck (P0-1 direction b)
One shared primitive, race-free by construction, covering both bugs.

**`src/orchestrator/cycle-close.ts`:**
- `CYCLE_CHAIN_TYPES = ['hypothesis.build','backtest.completed','research.run_cycle']`, `CYCLE_CLOSE_MAX_WAIT_ATTEMPTS = 40`, `CYCLE_CLOSE_WAIT_DELAY_MS = 15_000`.
- `enqueueCycleClose({correlationId, strategyProfileId, source, services})` — enqueues `revision.build` with **base** dedupeKey `revision.build:${correlationId}`. NO terminality gate at the call site (this is what kills the P0-1 race — nothing racy is evaluated at trigger time; the enqueue is unconditional and the base dedupeKey absorbs the storm of concurrent/repeated triggers into ONE row).
- `isCycleChainTerminal(correlationId, services)` — `listByCorrelationAndTypes(cid, CYCLE_CHAIN_TYPES).every(terminal)`. Carries a `TODO(P1-2)`: currently `queued` is non-terminal (blocking); tolerating stale `queued` older than a horizon is deferred to P1-2 (strict scope-guard).

**`revisionBuildHandler` Step-0 self-gate** (the authoritative decision, over settled statuses — revision.build runs as its own later task, so the finishers' statuses are written by then):
- Add `waitAttempt?: number` to `RevisionBuildPayloadSchema`.
- If `!isCycleChainTerminal(correlationId)`: if `waitAttempt >= CYCLE_CLOSE_MAX_WAIT_ATTEMPTS` → emit `revision.build.abandoned {correlationId, waitAttempt}` and return (observable, not a silent orphan); else self-requeue a **delayed** revision.build with attempt-scoped dedupeKey `revision.build:${cid}:wait${n+1}` (the base key is already `completed`, so a fresh key is required to re-enqueue), `delayMs: CYCLE_CLOSE_WAIT_DELAY_MS`, `payload.waitAttempt: n+1`; emit `revision.build.deferred {correlationId, waitAttempt}`; return. If terminal → proceed to the existing Step 1+ (unchanged). `revision.build` is not one of `CYCLE_CHAIN_TYPES`, so no exclude-self is needed.

Why the P0-1 status-race is closed: the trigger is unconditional, so P0-1's "both see running" can no longer yield zero enqueues — at least one `revision.build` row always exists. The terminality decision is deferred to that row's own execution, which the self-requeue re-evaluates until statuses settle. Budget `40 × 15s = 10min` is generous vs ~23s/backtest; on exhaustion `abandoned` fires rather than looping forever.

**Scope of the guarantee (whole-branch review, 2026-07-12):** `isCycleChainTerminal` is authoritative only over settled **chain-type rows** (`CYCLE_CHAIN_TYPES`). It does NOT wait on an async backtest that is in-flight but has no `backtest.completed` row yet — the resume/callback path routes through `backtest.resume`, which is not a chain type. On the **async backtester path at `LAB_QUEUE_CONCURRENCY ≥ 2`** an early sibling trigger can therefore observe an all-terminal chain prematurely and burn the base key, orphaning the cycle. This is **pre-existing** (the old inline `allTerminal` check in `backtest-completed.handler` had the identical blind spot) and NOT regressed by this slice; the synchronous demo/mock path resolves the poll before `hypothesis.build` returns, so `backtest.completed` exists in time and the gate is exact. **Follow-up (P1, gates raising concurrency on the async path):** make terminality account for submitted/in-flight `BacktestRun`s (or add `backtest.resume` to `CYCLE_CHAIN_TYPES` + a submitted-run check). So: this slice unblocks concurrency on the **synchronous** path; the async path needs that follow-up first.

### 8.3 Call sites
- `backtest-completed.handler.ts:199-215` — replace the racy `allTerminal`-gated block with an unconditional `enqueueCycleClose(...)` (keep the fail-soft try/catch → `revision.build_trigger_failed`).
- `hypothesis-build.handler.ts` — call `enqueueCycleClose(...)` immediately before each of the 5 domain-terminal `return`s (lines ~64/80/91/105/114). The normal-success path (which spawns a backtest → later `backtest.completed`) does NOT call it.
- Throw-after-3-attempts is covered **transitively**: any earlier chain member's trigger already has a self-requeue loop polling terminality, which re-checks after the final `failed` write. A cycle where every hypothesis throws has no `proxy_passed` to orphan. (Defensive comment; maxAttempts is NOT threaded into the worker.)

### 8.4 Tests
- **P0-1:** simulate two concurrent last-finishers (both chain tasks left non-terminal in the repo while both `backtest.completed` handlers run) → assert exactly one `revision.build` enqueued (base dedupeKey). Then, with statuses settled, the handler re-check proceeds to build.
- **P0-2:** with `builder_failed` and `datasets_unavailable` as the last chain member → assert `revision.build` is eventually enqueued (trigger fired from the domain-terminal return).
- **self-gate:** non-terminal chain → `revision.build` defers (delayed self-requeue with `wait${n}` key + `revision.build.deferred`), does NOT build; terminal chain → builds; `waitAttempt ≥ cap` → `revision.build.abandoned`, no build, no further requeue.

### 8.5 Scope guard
Do NOT fold P0-3 (revision.build idempotency), P0-4 (run-executor resume-or-adopt), or P1-2 (intake-bypassing enqueues) — staged separately in the roadmap triage. The primitive leaves a `TODO(P1-2)` in `isCycleChainTerminal` and must not worsen them.
