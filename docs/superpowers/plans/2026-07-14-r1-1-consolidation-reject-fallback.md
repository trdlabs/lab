# R1 #1 — Consolidation-reject fallback baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On any terminal consolidation reject, re-baseline the original accepted revision R directly (ready-bundle `strategy.baseline`), and make the consolidation success path crash-safe — so a revision is never stranded accepted-but-never-baselined.

**Architecture:** All changes are confined to `src/orchestrator/handlers/revision-consolidate.handler.ts` and its test. Every baseline enqueue in the handler is routed through one idempotent helper, `ensureBaselineForRevision`. The reject closure gains a fallback; `already_consolidated` and the `acceptConsolidation` create-catch gain child-recovery / version-conflict classification derived from a single `listByProfile` snapshot.

**Tech Stack:** Node `--experimental-strip-types`, Vitest 2.1.9 (`npx vitest run`), in-memory adapters for unit tests.

## Global Constraints

- **No TS parameter properties** (`constructor(private x)`) — banned by an AST guard test (node strip-types runtime).
- **Worktree edits only:** use plain Read/Edit/Write. Do NOT use gortex `edit_file`/`write_file` — in this worktree they write to the sibling main checkout.
- **Scope guard:** touch ONLY `revision-consolidate.handler.ts` + its test. Do NOT modify `revision-build.handler.ts` (read-only reference), R5b, DB schema/migrations, Cycle-1, the `strategy.baseline` handler, or any repository port/adapter. No new repository methods.
- **Dedupe keys (exact):** consolidated child → `strategy.baseline:consolidated:${revisionId}`; original accepted revision R → `strategy.baseline:accepted:${R.id}` (byte-identical to revision-build's mutually-exclusive normal-path key).
- **Throw-semantics:** `updateStatus` / `createAndEnqueueTask` errors propagate (worker retry). The enqueue-gap (row persisted, `queue.enqueue` throws) is repaired by the P1-1 boot sweeper on next boot, NOT by BullMQ retry — do not try to repair it here.
- **`ensureBaselineForRevision` never resets a completed baseline:** gate the `updateStatus('pending')` + enqueue behind `findByDedupeKey` — an existing task short-circuits (returns `deduped=true`) without touching revision status.
- Full design: `docs/superpowers/specs/2026-07-14-r1-1-consolidation-reject-fallback-design.md`.

---

## File Structure

- **Modify** `src/orchestrator/handlers/revision-consolidate.handler.ts`:
  - Add private `ensureBaselineForRevision(task, services, revision, dedupeKey): Promise<boolean>`.
  - Move the `reject` closure below the `not_consolidatable` guard so it closes over the validated `R`; add the R fallback.
  - `already_consolidated`: recover the child's baseline.
  - `acceptConsolidation`: route the success enqueue through the helper; classify the create-catch from a single `listByProfile` snapshot; accept a `reject` callback parameter.
- **Modify** `src/orchestrator/handlers/revision-consolidate.handler.test.ts`: invert the divergent-metrics test, parametrize reject-fallback, add retry-regression, add `already_consolidated` recovery, split the UNIQUE-collision test into three.

Current anchors (for orientation; verify at edit time): `acceptConsolidation` lines 33-73 (create ~55, catch 57-59, `revision.consolidated` 62-64, inline enqueue 66-73); `reject` closure 85-88; `already_consolidated` 90-92; `not_consolidatable` + R load 93-97; reject call-sites 100/103/108/109/116/119/125/128; `acceptConsolidation` call 131. Imports already include `createAndEnqueueTask`, `event`, `errMsg`, `StrategyRevision`, `AppServices`, `ResearchTask`.

---

## Task 1: Reject fallback via `ensureBaselineForRevision`

Delivers the headline R1 #1 fix: every terminal reject re-baselines R. Independently shippable — it fixes the stranding bug even without the Task 2 crash-safety hardening.

**Files:**
- Modify: `src/orchestrator/handlers/revision-consolidate.handler.ts`
- Test: `src/orchestrator/handlers/revision-consolidate.handler.test.ts`

**Interfaces:**
- Consumes: `createAndEnqueueTask` (already imported), `services.researchTasks.findByDedupeKey`, `services.revisions.updateStatus`, `now()` (local, line ~26).
- Produces (Task 2 consumes): `async function ensureBaselineForRevision(task: ResearchTask, services: AppServices, revision: StrategyRevision, dedupeKey: string): Promise<boolean /* deduped */>` — enqueues a ready-bundle `strategy.baseline` for `revision` under `dedupeKey` unless a task for that key already exists; throws if `revision.bundleArtifactRef` is absent; never resets a completed baseline's status. Also: the `reject` closure now closes over `R` and, after emitting `revision.consolidation_rejected`, calls `ensureBaselineForRevision(task, services, R, `strategy.baseline:accepted:${R.id}`)` then emits `revision.reject_rebaselined { revisionId, reason, deduped }`.

- [ ] **Step 1: Write the failing test — reject falls back to a baseline on R**

Add to the first `describe` block (`— guards, run-context, parity gate, fail-safe rejects`). This asserts the new fallback for a representative reject reason (`consolidator_disabled`):

```ts
it('reject fallback: consolidator_disabled re-baselines R directly (accepted:${R.id}) + reject_rebaselined event', async () => {
  const services = makeServices();
  const R = await seedConsolidatableRevision(services);
  services.consolidator = null; // -> reject('consolidator_disabled')

  await revisionConsolidateHandler(task(), services);

  const events = await services.events.listByTask('task-consolidate-1');
  expect(events.map((e) => e.type)).toEqual(['revision.consolidation_rejected', 'revision.reject_rebaselined']);
  expect(events[0]!.payload['reason']).toBe('consolidator_disabled');
  expect(events[1]!.payload).toMatchObject({ revisionId: R.id, reason: 'consolidator_disabled', deduped: false });

  const baseline = await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`);
  expect(baseline).not.toBeNull();
  expect(baseline!.taskType).toBe('strategy.baseline');
  expect(baseline!.payload).toMatchObject({ strategyProfileId: R.strategyProfileId, bundleArtifactRef: R.bundleArtifactRef, revisionId: R.id });

  const updated = await services.revisions.findById(R.id);
  expect(updated!.baselineValidationStatus).toBe('pending');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts -t "reject fallback: consolidator_disabled"`
Expected: FAIL — only `revision.consolidation_rejected` is emitted; no baseline task.

- [ ] **Step 3: Add `ensureBaselineForRevision`**

Insert this helper above `acceptConsolidation` (after the imports / `now` definition):

```ts
/**
 * The single idempotent baseline-enqueue path for this handler. Enqueues a ready-bundle
 * strategy.baseline for `revision` under `dedupeKey`, unless a task already exists for that key
 * (then it neither re-enqueues nor touches revision status — never rolls a completed baseline back
 * to 'pending'). Returns whether it deduped.
 */
async function ensureBaselineForRevision(
  task: ResearchTask,
  services: AppServices,
  revision: StrategyRevision,
  dedupeKey: string,
): Promise<boolean> {
  if (!revision.bundleArtifactRef) {
    throw new Error(`ensureBaselineForRevision: revision ${revision.id} has no bundleArtifactRef`);
  }
  const existing = await services.researchTasks.findByDedupeKey(dedupeKey);
  if (existing) return true;
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

- [ ] **Step 4: Move + enrich the `reject` closure**

Delete the current `reject` closure at line ~85. Re-declare it **after** the `not_consolidatable` guard (i.e. after `R` is loaded and validated non-null, before the first `reject(...)` call at line ~100). New form:

```ts
  // Defined after the not_consolidatable guard so it closes over the validated, non-null R.
  const reject = async (reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await services.events.append(event(task.id, 'revision.consolidation_rejected', { fromRevisionId: R.id, reason, ...extra }));
    // R1 #1: a terminal consolidation failure must still return R to paper. Re-baseline R directly
    // (ready-bundle), identical to revision-build's non-consolidation branch. Reusing the
    // accepted:${R.id} dedupeKey is a safety-net against ever double-baselining R.
    const deduped = await ensureBaselineForRevision(task, services, R, `strategy.baseline:accepted:${R.id}`);
    await services.events.append(event(task.id, 'revision.reject_rebaselined', { revisionId: R.id, reason, deduped }));
  };
```

Leave every existing `reject(...)` call-site unchanged (lines 100/103/108/109/116/119/125/128). Do NOT touch `acceptConsolidation` in this task (its create-catch still emits the old blanket skip — Task 2 fixes it).

- [ ] **Step 5: Run the new test to confirm it passes**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts -t "reject fallback: consolidator_disabled"`
Expected: PASS.

- [ ] **Step 6: Parametrize the fallback across every reject reason**

Add a table-driven test covering the remaining reject reasons, asserting each enqueues the `accepted:${R.id}` fallback + emits `reject_rebaselined`. Each row sets up the failure condition:

```ts
it.each([
  ['reconstruct_failed', (s: AppServices) => { /* corrupt bundleArtifactRef */ }],
  ['consolidator_error', (s: AppServices) => { /* consolidator.consolidate throws */ }],
  ['bundle_invalid',     (s: AppServices) => { /* consolidator output fails validateStrategyBundle */ }],
  ['consolidation_run_unavailable', (s: AppServices) => { /* executor returns non-completed */ }],
] as const)('reject fallback: %s re-baselines R (accepted:${R.id})', async (reason, arrange) => {
  const services = makeServices();
  const R = await seedConsolidatableRevision(services);
  arrange(services);

  await revisionConsolidateHandler(task(), services);

  const events = await services.events.listByTask('task-consolidate-1');
  expect(events.find((e) => e.type === 'revision.consolidation_rejected')!.payload['reason']).toContain(reason.split(':')[0]);
  const rebase = events.find((e) => e.type === 'revision.reject_rebaselined');
  expect(rebase!.payload).toMatchObject({ revisionId: R.id, deduped: false });
  expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).not.toBeNull();
});
```

Fill each `arrange` using the same failure setups the existing reject tests use (reconstruct: overwrite the bundle artifact with corrupt JSON; consolidator_error: a consolidator whose `consolidate` throws; bundle_invalid: a consolidator whose output fails `validateStrategyBundle`; run_unavailable: `fakeExecutor({ status: 'failed' })`). Copy the exact arrangement from each existing reject test (lines ~209-340) rather than re-inventing it. `missing_run_context` (×2) is covered by inverting the existing tests in Step 7.

- [ ] **Step 7: Invert the existing "divergent metrics … no baseline enqueued" + missing_run_context tests**

The existing test at lines ~341-360 asserts `expect(queued.some((q) => q.taskType === 'strategy.baseline')).toBe(false)` — that literal assertion encoded the R1 #1 bug. Change it to assert the fallback:

```ts
// was: expect(queued.some((q) => q.taskType === 'strategy.baseline')).toBe(false);
const fallback = await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`);
expect(fallback).not.toBeNull();
expect(fallback!.payload['revisionId']).toBe(R.id);
const evTypes = (await services.events.listByTask('task-consolidate-1')).map((e) => e.type);
expect(evTypes).toContain('revision.reject_rebaselined');
```

Also update the two `missing_run_context` tests (lines ~230, ~249): their titles say "no fallback to defaultPlatformRun" — that phrase is about the run-context, NOT the baseline; keep that assertion, and additionally assert the new `accepted:${R.id}` fallback baseline + `reject_rebaselined` event now exist.

**Reviewer note (put in the task report):** these inversions are intentional spec corrections — the old assertions asserted the exact behavior R1 #1 fixes, not a coincidental invariant.

- [ ] **Step 8: Write the failing retry-regression test (no status rollback)**

```ts
it('reject fallback is idempotent: a completed accepted-baseline is not rolled back, event deduped:true', async () => {
  const services = makeServices();
  const R = await seedConsolidatableRevision(services);

  // Simulate a prior fallback that already ran to completion.
  await services.researchTasks.create({
    id: 'rt-existing-baseline', taskType: 'strategy.baseline', source: task().source,
    correlationId: 'c-existing', dedupeKey: `strategy.baseline:accepted:${R.id}`, status: 'completed',
    payload: { strategyProfileId: R.strategyProfileId, bundleArtifactRef: R.bundleArtifactRef, revisionId: R.id },
    availableAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
  await services.revisions.updateStatus(R.id, { baselineValidationStatus: 'passed', updatedAt: '2026-01-01T00:00:00Z' });

  services.consolidator = null; // reject('consolidator_disabled')
  const beforeQueued = (services.taskQueue as InMemoryQueueAdapter).queued.length;

  await revisionConsolidateHandler(task(), services);

  expect((await services.revisions.findById(R.id))!.baselineValidationStatus).toBe('passed'); // NOT rolled back
  expect((services.taskQueue as InMemoryQueueAdapter).queued.length).toBe(beforeQueued);       // no new job
  const rebase = (await services.events.listByTask('task-consolidate-1')).find((e) => e.type === 'revision.reject_rebaselined');
  expect(rebase!.payload['deduped']).toBe(true);
});
```

(Verify the exact `ResearchTask` shape against `src/domain/types.ts` — include `availableAt` per the P1-1 field.)

- [ ] **Step 9: Run the full handler test file — all green**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts`
Expected: PASS (new fallback + retry-regression tests pass; inverted tests pass; all accept-path and skip-path tests still pass — Task 1 leaves `acceptConsolidation` behavior unchanged).

- [ ] **Step 10: Typecheck + commit**

Run: `npx tsc --noEmit` (expect clean), then:

```bash
git add src/orchestrator/handlers/revision-consolidate.handler.ts src/orchestrator/handlers/revision-consolidate.handler.test.ts
git commit -m "fix(revision-consolidate): fall back to direct R baseline on terminal consolidation reject (R1 #1)"
```

---

## Task 2: Success-path crash-safety (child recovery + classified create-catch)

Delivers the reviewer-mandated success-path hardening: `already_consolidated` recovers a crash-orphaned child's baseline; `acceptConsolidation`'s create-catch classifies child-race vs version-conflict vs unknown error from a single `listByProfile` snapshot; the success enqueue routes through `ensureBaselineForRevision`.

**Files:**
- Modify: `src/orchestrator/handlers/revision-consolidate.handler.ts`
- Test: `src/orchestrator/handlers/revision-consolidate.handler.test.ts`

**Interfaces:**
- Consumes: `ensureBaselineForRevision` and the `reject` closure from Task 1; `services.revisions.findConsolidatedOf`, `services.revisions.listByProfile` (existing).
- Produces: `acceptConsolidation` gains a `reject` parameter: `acceptConsolidation(task, services, { R, assembled, cleanRun }, reject)`. The handler passes its `reject` closure at the call site (line ~131).

- [ ] **Step 1: Write the failing test — `already_consolidated` recovers the child's baseline**

```ts
it('already_consolidated: recovers a crash-orphaned child baseline (consolidated:${child.id})', async () => {
  const services = makeServices();
  const R = await seedConsolidatableRevision(services);
  const child: StrategyRevision = {
    id: 'rev-child', strategyProfileId: R.strategyProfileId, version: R.version + 1,
    baseRevisionId: R.id, kind: 'consolidated', consolidatedFromRevisionId: R.id, semanticParentRevisionId: R.id,
    hypothesisIds: [...R.hypothesisIds], mergedRuleSet: R.mergedRuleSet, bundleArtifactRef: R.bundleArtifactRef,
    compositionDepth: 1, status: 'accepted', baselineValidationStatus: 'pending',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  await services.revisions.create(child); // child exists, but its baseline was never enqueued (crash gap)

  await revisionConsolidateHandler(task(), services);

  const baseline = await services.researchTasks.findByDedupeKey(`strategy.baseline:consolidated:${child.id}`);
  expect(baseline).not.toBeNull();
  expect(baseline!.payload['revisionId']).toBe(child.id);
  const skip = (await services.events.listByTask('task-consolidate-1')).find((e) => e.type === 'revision.consolidation_skipped');
  expect(skip!.payload).toMatchObject({ reason: 'already_consolidated', newRevisionId: child.id, deduped: false });
  // R itself is NOT fallback-baselined
  expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).toBeNull();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts -t "already_consolidated: recovers"`
Expected: FAIL — the current `already_consolidated` branch emits a skip with no `newRevisionId` and enqueues nothing.

- [ ] **Step 3: Implement `already_consolidated` child recovery**

Replace the current guard (lines ~90-92):

```ts
  const existingChild = await services.revisions.findConsolidatedOf(revisionId);
  if (existingChild) {
    const deduped = await ensureBaselineForRevision(task, services, existingChild, `strategy.baseline:consolidated:${existingChild.id}`);
    await services.events.append(event(task.id, 'revision.consolidation_skipped',
      { revisionId, reason: 'already_consolidated', newRevisionId: existingChild.id, deduped }));
    return;
  }
```

- [ ] **Step 4: Run Step 1 test — passes; run full file to catch the success-retry test**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts`
Expected: Step 1 passes. The existing `findConsolidatedOf(R.id) after success returns … (retry is a no-op)` test (line ~462) may now assert on a `newRevisionId`/`deduped` payload — update its assertion to allow the recovered-baseline payload and `deduped:true` on the second run (the first run enqueued `consolidated:${child.id}`, so retry dedups). Keep its "no NEW consolidated revision, queue length unchanged" intent.

- [ ] **Step 5: Route `acceptConsolidation` success through the helper + accept a `reject` param**

In `acceptConsolidation`, replace the inline `createAndEnqueueTask(...)` (lines ~66-73) with:

```ts
  await ensureBaselineForRevision(task, services, consolidated, `strategy.baseline:consolidated:${newId}`);
```

Change the signature to accept the reject callback:

```ts
async function acceptConsolidation(
  task: ResearchTask,
  services: AppServices,
  { R, assembled, cleanRun }: { R: StrategyRevision; assembled: AssembledStrategyBundle; cleanRun: RevisionRunResult },
  reject: (reason: string, extra?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
```

And update the call site (line ~131): `await acceptConsolidation(task, services, { R, assembled, cleanRun }, reject);`

Run the accept-path tests to confirm no regression: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts -t "accept path"` — the "enqueues exactly one ready-bundle strategy.baseline" test (line ~424) must still pass (same `consolidated:${newId}` key, payload, and `revision.consolidated` event).

- [ ] **Step 6: Write the failing tests — split the UNIQUE-collision test into three**

Delete the single existing `UNIQUE(strategyProfileId, version) collision` test (lines ~477-509). Add three:

```ts
it('concurrent_revision (snapshot): a consolidated child of R at v+1 → ensure child baseline, R not fallback', async () => {
  const services = makeServices();
  const R = await seedConsolidatableRevision(services);
  const competitor: StrategyRevision = {
    id: 'rev-child-concurrent', strategyProfileId: R.strategyProfileId, version: R.version + 1,
    baseRevisionId: R.id, kind: 'consolidated', consolidatedFromRevisionId: R.id, semanticParentRevisionId: R.id,
    hypothesisIds: [], mergedRuleSet: {}, bundleArtifactRef: R.bundleArtifactRef,
    compositionDepth: 1, status: 'accepted', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  await services.revisions.create(competitor);
  services.consolidator = new FakeStrategyConsolidator();
  services.revisionRunExecutor = fakeExecutor({ metrics: acceptedMetrics() }).executor;

  await revisionConsolidateHandler(task(), services);

  expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:consolidated:${competitor.id}`)).not.toBeNull();
  expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).toBeNull();
  const ev = (await services.events.listByTask('task-consolidate-1')).find((e) => e.type === 'revision.consolidation_skipped');
  expect(ev!.payload).toMatchObject({ reason: 'concurrent_revision', newRevisionId: competitor.id });
});

it('concurrent_version_conflict: a non-child revision occupies v+1 → fall back to R (accepted:${R.id})', async () => {
  const services = makeServices();
  const R = await seedConsolidatableRevision(services);
  const competitor: StrategyRevision = {
    id: 'rev-competitor', strategyProfileId: R.strategyProfileId, version: R.version + 1,
    hypothesisIds: [], mergedRuleSet: {}, status: 'accepted', kind: 'composed',
    compositionDepth: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  await services.revisions.create(competitor);
  services.consolidator = new FakeStrategyConsolidator();
  services.revisionRunExecutor = fakeExecutor({ metrics: acceptedMetrics() }).executor;

  await revisionConsolidateHandler(task(), services);

  const rejected = (await services.events.listByTask('task-consolidate-1')).find((e) => e.type === 'revision.consolidation_rejected');
  expect(rejected!.payload).toMatchObject({ reason: 'concurrent_version_conflict', occupantRevisionId: competitor.id });
  expect((await services.events.listByTask('task-consolidate-1')).some((e) => e.type === 'revision.reject_rebaselined')).toBe(true);
  expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).not.toBeNull();
  expect(await services.revisions.findConsolidatedOf(R.id)).toBeNull();
});

it('unknown create error: version v+1 free → rethrow (worker retry)', async () => {
  const services = makeServices();
  const R = await seedConsolidatableRevision(services);
  services.consolidator = new FakeStrategyConsolidator();
  services.revisionRunExecutor = fakeExecutor({ metrics: acceptedMetrics() }).executor;
  const realCreate = services.revisions.create.bind(services.revisions);
  services.revisions.create = async (r) => { if (r.kind === 'consolidated') throw new Error('boom-transient'); return realCreate(r); };

  await expect(revisionConsolidateHandler(task(), services)).rejects.toThrow('boom-transient');
  expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).toBeNull();
});
```

- [ ] **Step 7: Run them to confirm they fail**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts -t "concurrent_|unknown create error"`
Expected: FAIL — the current blanket catch emits `concurrent_revision` skip for all three and never rethrows / never falls back to R.

- [ ] **Step 8: Implement the single-snapshot create-catch classification**

Replace the `try/catch` around `services.revisions.create(consolidated)` (lines ~55-60) with:

```ts
  try {
    await services.revisions.create(consolidated);
  } catch (err) {
    // Single snapshot: derive child and occupant from the SAME read (avoids a TOCTOU where a child
    // committing between two separate reads is misclassified as a version-conflict).
    const revisions = await services.revisions.listByProfile(R.strategyProfileId);

    const child = revisions.find((v) => v.kind === 'consolidated' && v.consolidatedFromRevisionId === R.id);
    if (child) {
      const deduped = await ensureBaselineForRevision(task, services, child, `strategy.baseline:consolidated:${child.id}`);
      await services.events.append(event(task.id, 'revision.consolidation_skipped',
        { revisionId: R.id, reason: 'concurrent_revision', newRevisionId: child.id, detail: errMsg(err), deduped }));
      return;
    }

    const occupant = revisions.find((v) => v.version === R.version + 1);
    if (occupant) {
      await reject('concurrent_version_conflict', { occupantRevisionId: occupant.id });
      return;
    }

    throw err; // version v+1 free ⇒ not a conflict ⇒ transient/unknown ⇒ worker retry
  }
```

Note: `acceptConsolidation` must run the `revisions.create` (with this catch) BEFORE emitting `revision.consolidated`; keep the existing ordering (create → consolidated event → `ensureBaselineForRevision`).

- [ ] **Step 9: Run the three split tests — pass**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts -t "concurrent_|unknown create error"`
Expected: PASS.

- [ ] **Step 10: Run the full handler test file — all green**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts`
Expected: PASS (Task 1 + Task 2 tests; all pre-existing accept/skip/reject tests, updated where noted).

- [ ] **Step 11: Typecheck + commit**

Run: `npx tsc --noEmit` (expect clean), then:

```bash
git add src/orchestrator/handlers/revision-consolidate.handler.ts src/orchestrator/handlers/revision-consolidate.handler.test.ts
git commit -m "fix(revision-consolidate): success-path crash-safety — child recovery + classified create-catch (R1 #1)"
```

---

## Post-implementation

- [ ] Run the broader orchestrator suite to confirm no cross-handler regression: `npx vitest run src/orchestrator`.
- [ ] Whole-branch review (opus) over `git merge-base main HEAD..HEAD`, with the two intentional spec-correcting test changes (divergent-metrics inversion; UNIQUE-collision split) called out so they are not flagged as weakened tests.
