# R1 #1 — Consolidation-reject fallback baseline (+ success-path crash-safety)

Source finding: `docs/research/2026-07-12-lab-code-review-bugs-and-bottlenecks.md` — R1 follow-up #1
("consolidation-reject fall-through", deferred from PR #154). Gates the enabling of the LLM
consolidator (`CONSOLIDATOR_ADAPTER=mastra`).

## Problem

`revisionBuildHandler` re-baselines an accepted composed revision through one of two **mutually
exclusive** branches (`src/orchestrator/handlers/revision-build.handler.ts:607-634`):

- `newDepth >= consolidationDepthThreshold` (and a consolidator is wired) → enqueue
  `revision.consolidate` for R, and do **not** enqueue R's own `strategy.baseline`.
- otherwise → set `R.baselineValidationStatus='pending'` and enqueue
  `strategy.baseline` with `dedupeKey = strategy.baseline:accepted:${R.id}`.

The consolidation branch delegates R's return-to-paper to `revisionConsolidateHandler`, which is
expected to re-baseline **either** the consolidated successor (success) **or** R itself (failure).
Today it only does the former:

1. **Reject fall-through (the headline bug).** Every terminal failure funnels through the local
   `reject(reason, extra)` closure, which appends `revision.consolidation_rejected` and returns.
   R stays `accepted` but is **never baselined** — it never re-enters `strategy.baseline → wfo →
   paper.start`. R is stranded permanently.
2. **Success-path crash gap.** `acceptConsolidation` does `revisions.create(consolidated)` then a
   separate `createAndEnqueueTask(strategy.baseline)`. A crash between them leaves the consolidated
   revision with no baseline task. On retry the top-of-handler idempotency guard
   (`findConsolidatedOf(revisionId)` truthy) emits `already_consolidated` and returns **without**
   baselining the orphaned child — the same stranding, on the success path.
3. **Over-broad create-catch.** `acceptConsolidation`'s `catch` treats *any* `create` error as a
   concurrent-consolidation race (`concurrent_revision`, no baseline). A transient/unknown DB error
   is silently swallowed as if a winner existed, and a genuine version conflict caused by a
   *non-consolidated* revision is not distinguished from the child-race.

## Approach

Route **every** baseline enqueue in this handler through one idempotent helper,
`ensureBaselineForRevision`, and attach a fallback (or child-recovery) baseline to every exit that
otherwise strands a revision. No new repository methods, no schema change: classification uses the
existing `findConsolidatedOf` and `listByProfile` reads. All changes live in
`revision-consolidate.handler.ts` and its test.

### Idempotency primitive — `ensureBaselineForRevision`

```ts
/**
 * The single idempotent baseline-enqueue path for this handler. Enqueues a ready-bundle
 * strategy.baseline for `revision` under `dedupeKey`, unless a task already exists for that key
 * (in which case it neither re-enqueues nor touches revision status). Returns whether it deduped.
 */
async function ensureBaselineForRevision(
  task: ResearchTask,
  services: AppServices,
  revision: StrategyRevision,
  dedupeKey: string,
): Promise<boolean /* deduped */> {
  if (!revision.bundleArtifactRef) {
    // Programming error: every call site must pass a revision with a persisted bundle. Never
    // enqueue a baseline with an undefined bundleArtifactRef (silent downstream failure).
    throw new Error(`ensureBaselineForRevision: revision ${revision.id} has no bundleArtifactRef`);
  }
  const existing = await services.researchTasks.findByDedupeKey(dedupeKey);
  if (existing) return true; // do NOT reset baselineValidationStatus — never roll a completed baseline back to 'pending'
  await services.revisions.updateStatus(revision.id, { baselineValidationStatus: 'pending', updatedAt: now() });
  await createAndEnqueueTask(
    {
      taskType: 'strategy.baseline', source: task.source,
      payload: { strategyProfileId: revision.strategyProfileId, bundleArtifactRef: revision.bundleArtifactRef, revisionId: revision.id },
      correlationId: task.correlationId, dedupeKey,
    },
    { repo: services.researchTasks, queue: services.taskQueue },
  );
  return false;
}
```

Rationale for the pieces:

- **Explicit `bundleArtifactRef` guard.** `StrategyRevision.bundleArtifactRef` is optional in the
  domain type. R's presence is guaranteed by the `not_consolidatable` guard, but a `findConsolidatedOf`
  child is a freshly-read domain object whose field is only *conventionally* set. Missing ref →
  throw (worker retry), never enqueue with `undefined`.
- **`findByDedupeKey` gate before `updateStatus`.** This is the correctness fix for retries.
  Scenario: attempt-1 enqueues the baseline, then its final event throws; the baseline runs and
  completes as `passed`; the worker retries the consolidate task. Without the gate, attempt-2 would
  unconditionally write `baselineValidationStatus='pending'` (clobbering `passed`) and then
  `createAndEnqueueTask` would dedup on the *completed* row — leaving R stuck `pending` with no job
  ever running again. With the gate, the existing (completed) task short-circuits: status untouched,
  `deduped=true`. `createAndEnqueueTask` performs its own `findByDedupeKey` dedup on enqueue; this
  helper's gate additionally protects the *status write*, which `createAndEnqueueTask` does not own.

### Trigger-revision determination (no heuristic)

R = `services.revisions.findById(payload.revisionId)`. The payload (`revisionId`, `strategyProfileId`)
is sufficient — `revisionId` deterministically identifies R. R is loaded and validated
(`status==='accepted'`, `kind==='composed'`, `bundleArtifactRef` present) by the existing
`not_consolidatable` guard **before** any `reject()` path. The fallback baselines exactly `R.id`,
using `R.strategyProfileId` / `R.bundleArtifactRef` from the loaded revision. No "find the latest
accepted revision" heuristic anywhere.

### The converged `reject` helper

Move the `reject` closure definition to **after** the `not_consolidatable` guard so it closes over
the validated, non-null `R` (the idempotency/`not_consolidatable` skips use `consolidation_skipped`
directly and never call `reject`, so moving it down is safe). New body:

```ts
const reject = async (reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
  await services.events.append(event(task.id, 'revision.consolidation_rejected', { fromRevisionId: R.id, reason, ...extra }));
  // R1 #1 fallback: re-baseline the original accepted revision directly (ready-bundle mode),
  // identical to revision-build's non-consolidation branch — a terminal consolidation failure must
  // still return R to paper, not strand it accepted-but-never-baselined. Reuse of the
  // `accepted:${R.id}` dedupeKey is byte-identical to what revision-build would have enqueued and
  // is a safety-net against ever double-baselining R (the two producers are mutually exclusive).
  const deduped = await ensureBaselineForRevision(task, services, R, `strategy.baseline:accepted:${R.id}`);
  await services.events.append(event(task.id, 'revision.reject_rebaselined', { revisionId: R.id, reason, deduped }));
};
```

**Every** reject reason falls back uniformly: `reconstruct_failed`, `missing_run_context` (×2),
`consolidator_disabled`, `consolidator_error`, `bundle_invalid`, `consolidation_run_unavailable`,
parity `REJECT` (`verdict.reasons.join(',')`), and the new `concurrent_version_conflict`. Each one
leaves R accepted-but-unbaselined today; each now re-baselines R.

### `already_consolidated` — child-recovery (success-path crash-safety)

```ts
const existingChild = await services.revisions.findConsolidatedOf(revisionId);
if (existingChild) {
  const deduped = await ensureBaselineForRevision(task, services, existingChild, `strategy.baseline:consolidated:${existingChild.id}`);
  await services.events.append(event(task.id, 'revision.consolidation_skipped',
    { revisionId, reason: 'already_consolidated', newRevisionId: existingChild.id, deduped }));
  return;
}
```

If the crash happened before the child's baseline was enqueued, the retry enqueues it now (repair);
if after, `deduped=true` and nothing is double-enqueued. R is never fallback-baselined here — the
consolidated child supersedes R.

### `acceptConsolidation` — success via helper + classified create-catch

Success path (after `create` + the `revision.consolidated` event) replaces the inline enqueue with:

```ts
await ensureBaselineForRevision(task, services, consolidated, `strategy.baseline:consolidated:${newId}`);
```

Create-catch classification (replaces the blanket `concurrent_revision` skip). It reads
`listByProfile` **once** and derives both the child and the occupant from that single snapshot —
never two separate reads (see the TOCTOU note below):

```ts
try {
  await services.revisions.create(consolidated);
} catch (err) {
  // Single snapshot: deriving child and occupant from the SAME read avoids a TOCTOU misclassification.
  const revisions = await services.revisions.listByProfile(R.strategyProfileId);

  const child = revisions.find((v) => v.kind === 'consolidated' && v.consolidatedFromRevisionId === R.id);
  if (child) {
    // A concurrent consolidation won version R.version+1. Ensure ITS baseline (crash-safe), not R's.
    const deduped = await ensureBaselineForRevision(task, services, child, `strategy.baseline:consolidated:${child.id}`);
    await services.events.append(event(task.id, 'revision.consolidation_skipped',
      { revisionId: R.id, reason: 'concurrent_revision', newRevisionId: child.id, detail: errMsg(err), deduped }));
    return;
  }

  const occupant = revisions.find((v) => v.version === R.version + 1);
  if (occupant) {
    // Genuine version conflict with a non-consolidated revision → R has no consolidated successor →
    // fall back to R via the converged reject helper (emits rejected + reject_rebaselined).
    await reject('concurrent_version_conflict', { occupantRevisionId: occupant.id });
    return;
  }

  // Version R.version+1 is free in the snapshot ⇒ create failed for a transient/unknown reason, not a
  // version conflict. Do not pretend a concurrency winner exists — rethrow so the worker retries.
  throw err;
}
```

Classification correctness (confirmed by reviewer): version is unique per `(strategyProfileId,
version)`; the child predicate on the snapshot first separates the child-race; then an occupant at
`R.version+1` in the same snapshot means a real conflict with a non-child; a version that is free
*in the snapshot* after a `create` error means it was not a conflict, so the original error must
propagate. This uses only existing repo reads — no DB error-code introspection (the in-memory adapter
throws a plain code-less `Error`, so `.code === '23505'` classification would not be adapter-agnostic).

**TOCTOU note (single-snapshot invariant):** the earlier draft read `findConsolidatedOf(R.id)` and
then `listByProfile` separately. A child committing *between* those two reads would be missed by
`findConsolidatedOf` yet appear in `listByProfile` as an occupant → misclassified as
`concurrent_version_conflict` → R baselined instead of the child. Deriving both from one
`listByProfile` snapshot removes the window. If the child commits *after* the snapshot, it is absent
from the snapshot as both child **and** occupant → the `throw err` branch runs → the worker retry
re-enters the handler, hits the top-of-handler `already_consolidated` guard, and recovers the child's
baseline. The rethrow branch is therefore safe under a post-snapshot child commit.

**`reject` must be defined before `acceptConsolidation` is invoked** so the create-catch can call it.
Since `acceptConsolidation` is the handler's final statement and `reject` is defined right after the
`not_consolidatable` guard, `reject` (closing over R) is passed into `acceptConsolidation` (add a
parameter) — the closure already has R in scope at the call site.

### Mutual exclusion (verification)

Exactly one baseline target per handler invocation, because every non-success terminal `return`s
before the success enqueue:

| Exit | Baseline target | dedupeKey |
|------|-----------------|-----------|
| success (`acceptConsolidation`) | consolidated child | `strategy.baseline:consolidated:${newId}` |
| `already_consolidated` | existing child | `strategy.baseline:consolidated:${child.id}` |
| create-catch, child found (`concurrent_revision`) | that child | `strategy.baseline:consolidated:${child.id}` |
| create-catch, occupant found (`concurrent_version_conflict`) | R | `strategy.baseline:accepted:${R.id}` |
| any `reject(...)` reason | R | `strategy.baseline:accepted:${R.id}` |
| `not_consolidatable`, invalid-payload throw | none | — |

R's key `accepted:${R.id}` is identical to revision-build's mutually-exclusive normal-path key, so
even a hypothetical double-fire collapses via dedup. A consolidated child and R never share a key.

### Enqueue-gap durability (honest residual)

`createAndEnqueueTask` persists the `research_task` row (`status='queued'`) **before** calling
`queue.enqueue`. If `enqueue` throws, the row exists but no job does; the throw propagates → worker
retry. On retry, `ensureBaselineForRevision`'s `findByDedupeKey` finds the queued row → `deduped=true`
→ it does **not** re-enqueue, so **BullMQ retry alone does not repair the missing job**. Actual
delivery is completed by the **P1-1 boot sweeper (`reconcileQueuedTasks`, PR #176)** on the next
worker boot, which re-enqueues stranded `queued` rows. This is the accepted residual: the fallback
baseline is durable-at-next-boot in the enqueue-gap case, immediate otherwise.

### Observability

- `revision.reject_rebaselined { revisionId, reason, deduped }` — R fell back to a direct baseline
  (with the failure reason and whether it deduped).
- `revision.consolidation_rejected { fromRevisionId, reason, ... }` — unchanged trigger, now always
  paired with a `reject_rebaselined`. `concurrent_version_conflict` additionally carries
  `occupantRevisionId`.
- `revision.consolidation_skipped { ..., deduped }` — `already_consolidated` / `concurrent_revision`
  now carry the recovered child id and `deduped`.

## Scope

- **Modify:** `src/orchestrator/handlers/revision-consolidate.handler.ts` — add
  `ensureBaselineForRevision`; move + enrich `reject` (fallback); enrich `already_consolidated`
  (child recovery); route `acceptConsolidation` success through the helper; classify its create-catch.
- **Modify:** `src/orchestrator/handlers/revision-consolidate.handler.test.ts` — see Testing.

## Out of scope

- `revision-build.handler.ts` (read-only reference), R5b, schema/migrations (`baselineValidationStatus`
  and `research_task.available_at` already exist), Cycle-1, the `strategy.baseline` handler.
- New repository methods or DB error-code (23505) classification (P1-25 territory).
- Continuous (non-boot) reconciliation of the enqueue gap (owned by P1-1).

## Testing

`src/orchestrator/handlers/revision-consolidate.handler.test.ts`. Fixtures already present:
`seedConsolidatableRevision`, `makeServices`, `FakeStrategyConsolidator`, `fakeExecutor`,
`acceptedMetrics`, `InMemoryQueueAdapter`.

**Reject paths — now fall back (parametrized over every reason).** For each of `reconstruct_failed`,
`missing_run_context` (comboBacktestRunId absent), `missing_run_context` (platformRun null),
`consolidator_disabled`, `consolidator_error`, `bundle_invalid`, `consolidation_run_unavailable`,
divergent-metrics parity `REJECT`: assert (a) `revision.consolidation_rejected` emitted; (b) exactly
one `strategy.baseline` enqueued under `strategy.baseline:accepted:${R.id}` with payload
`{ strategyProfileId: R.strategyProfileId, bundleArtifactRef: R.bundleArtifactRef, revisionId: R.id }`;
(c) `revision.reject_rebaselined { revisionId: R.id, reason, deduped:false }`; (d) R's
`baselineValidationStatus==='pending'`.

**Invert the existing "divergent metrics … no baseline enqueued" test** (lines ~341-360): the old
`expect(...taskType==='strategy.baseline').toBe(false)` encoded the exact bug — flip it to the
fallback assertions above. Flag explicitly in the plan and the review package as an intentional
spec-correcting inversion, not a weakened test.

**Idempotency / retry regression (reviewer-mandated).** Seed a consolidatable R; pre-create a
*completed* baseline task under `strategy.baseline:accepted:${R.id}` and set R's
`baselineValidationStatus='passed'`. Drive a reject (e.g. `consolidator_disabled`). Assert: R's
status stays `passed` (not rolled back to `pending`); no new `strategy.baseline` job enqueued
(queue length unchanged); `revision.reject_rebaselined.deduped === true`.

**`already_consolidated` — child recovery.** (a) Seed R + a `kind:'consolidated'` child of R with
**no** baseline task → run handler → asserts one `strategy.baseline:consolidated:${child.id}`
enqueued, skip event `{reason:'already_consolidated', newRevisionId, deduped:false}`. (b) Same but a
baseline task for the child already exists → asserts `deduped:true`, no new job.

**Split the existing "UNIQUE collision" test (lines ~477+) into three:**
- `concurrent_revision` (snapshot classification): pre-seed a `kind:'consolidated'`,
  `consolidatedFromRevisionId=R.id` revision at `R.version+1` — so it is present in the
  `listByProfile` snapshot the create-catch reads. `create` throws → the snapshot's child predicate
  matches → one baseline `consolidated:${child.id}`, skip event `concurrent_revision` with
  `newRevisionId`; R **not** fallback-baselined (no `accepted:${R.id}` task, no `reject_rebaselined`
  event); `findConsolidatedOf(R.id)` returns the seeded child. This exercises that the child is
  discovered from the single `listByProfile` snapshot, and that a child at `R.version+1` is
  classified as the child-race, not as an occupant version-conflict.
- `concurrent_version_conflict`: pre-seed a `kind:'composed'` competitor at `R.version+1` (the
  current fixture) → `create` throws → no child → occupant found → `revision.consolidation_rejected
  {reason:'concurrent_version_conflict', occupantRevisionId}` + `revision.reject_rebaselined
  {revisionId:R.id, deduped:false}` + one baseline `accepted:${R.id}`; `findConsolidatedOf(R.id)`
  null.
- `unknown create error`: inject a revisions repo whose `create` throws a generic error and whose
  `listByProfile` returns no row at `R.version+1` → handler **rethrows** (assert
  `expect(handler(...)).rejects`); no baseline enqueued.

**Regression — unchanged behavior:** `not_consolidatable` (×3: not accepted / kind consolidated / no
bundleArtifactRef) still skip with no baseline; invalid payload still throws; `acceptConsolidation`
success still materializes the consolidated revision (verbatim fields, reset depth, `pending`) and
enqueues exactly one `consolidated:${newId}` baseline + `revision.consolidated`; Style-A dropped
hypothesis still not rescued; success-then-retry still hits `already_consolidated` (now with child
recovery, `deduped:true` on the second run).

**`ensureBaselineForRevision` guard:** a revision with `bundleArtifactRef` undefined → helper throws
(unit-level, e.g. via the `already_consolidated` path with a child missing the ref).
