# R1 — Cycle-2 loop closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every accepted strategy revision (not only consolidated) re-baselines and returns to paper via the existing `strategy.baseline → strategy.wfo → paper.start` chain, and WFO is enqueued only when baseline validation passes.

**Architecture:** Three surgical changes. (1) `strategy-baseline.handler.ts` gains a generalized `revisionId` writeback field (with a transient `consolidatedRevisionId` alias) and a uniform W4 gate on the WFO enqueue. (2) `revision-build.handler.ts` ACCEPT path adds an else-branch, mutually exclusive with the consolidation trigger, that re-baselines the accepted composed revision directly. (3) `revision-consolidate.handler.ts` migrates its caller to the new field name.

**Tech Stack:** TypeScript (`node --experimental-strip-types`), Vitest, Drizzle (unchanged here), pnpm. Handlers are `WorkflowHandler`s wired through `AppServices`.

## Global Constraints

- Lab imports carry the `.ts` extension. No TS parameter properties.
- No new env vars. The direct-rebaseline path is gated by the existing `consolidator === null` default; paper intake stays gated downstream by `LAB_PAPER_INTAKE_URL`.
- Ready-bundle mode NEVER calls `strategyBuilder.build` — deterministic `reconstructStrategyBundle` only (hash stability; the G1 self-block).
- Branch: `feat/r1-cycle2-loop-closure` (base main `49009ed`). Spec: `docs/superpowers/specs/2026-07-12-r1-cycle2-loop-closure-design.md`.
- Full verification per task: `npx tsc --noEmit` clean + the task's test file green; final task also runs `npx vitest run`.

---

### Task 1: `strategy.baseline` handler — `revisionId` alias + uniform W4 gate

**Files:**
- Modify: `src/orchestrator/handlers/strategy-baseline.handler.ts` (schema ~13-21; the block ~65-94)
- Test: `src/orchestrator/handlers/strategy-baseline.handler.test.ts`

**Interfaces:**
- Consumes: existing `StrategyBaselinePayloadSchema`, `services.revisions.updateStatus`, `services.taskQueue`, `services.events.append`, `event(taskId, type, payload)`.
- Produces: `strategy.baseline` payload now accepts `revisionId?: string` (preferred) and `consolidatedRevisionId?: string` (deprecated alias). New event type `strategy.baseline.wfo_skipped` with payload `{ strategyProfileId, experimentId, verdict, reason: 'baseline_not_passed' }`. WFO enqueue happens iff `baselineValidationStatus === 'passed'`.

- [ ] **Step 1: Write the failing tests** (append to the `describe('strategyBaselineHandler', …)` block)

The existing tests already cover the happy path: default verdict `PAPER_CANDIDATE` → `strategy.wfo` enqueued (test "builds, persists ref…"), and `consolidatedRevisionId` + `PASS`/`PAPER_CANDIDATE` → writeback `passed` (tests "patches consolidated revision…", "maps PAPER_CANDIDATE…"). Those remain green and now double as the transient-alias + passed→wfo coverage. Add the not-passed and new-field cases:

```typescript
  it('does NOT enqueue strategy.wfo on a FAIL baseline; emits wfo_skipped + writes failed status', async () => {
    const now = '2026-01-01T00:00:00Z';
    const revisions = new InMemoryStrategyRevisionRepository();
    await revisions.create({
      id: 'R', strategyProfileId: 'prof-1', version: 2, hypothesisIds: [], mergedRuleSet: {},
      status: 'accepted', kind: 'composed', baselineValidationStatus: 'pending', createdAt: now, updatedAt: now,
    } as StrategyRevision);
    const { services, queued } = await makeFakeServices({ revisions, verdict: 'FAIL' });
    const appendSpy = vi.spyOn(services.events, 'append');

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1', revisionId: 'R' }), services);

    expect((queued as unknown[]).filter((t) => (t as { taskType: string }).taskType === 'strategy.wfo')).toHaveLength(0);
    expect(appendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'strategy.baseline.wfo_skipped' }));
    expect((await revisions.findById('R'))?.baselineValidationStatus).toBe('failed');
  });

  it('does NOT enqueue strategy.wfo on an INCONCLUSIVE baseline; writes inconclusive status', async () => {
    const now = '2026-01-01T00:00:00Z';
    const revisions = new InMemoryStrategyRevisionRepository();
    await revisions.create({
      id: 'R', strategyProfileId: 'prof-1', version: 2, hypothesisIds: [], mergedRuleSet: {},
      status: 'accepted', kind: 'composed', baselineValidationStatus: 'pending', createdAt: now, updatedAt: now,
    } as StrategyRevision);
    const { services, queued } = await makeFakeServices({ revisions, verdict: 'INCONCLUSIVE' });

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1', revisionId: 'R' }), services);

    expect((queued as unknown[]).filter((t) => (t as { taskType: string }).taskType === 'strategy.wfo')).toHaveLength(0);
    expect((await revisions.findById('R'))?.baselineValidationStatus).toBe('inconclusive');
  });

  it('writes back via the new revisionId field and enqueues wfo on PASS', async () => {
    const now = '2026-01-01T00:00:00Z';
    const revisions = new InMemoryStrategyRevisionRepository();
    await revisions.create({
      id: 'R', strategyProfileId: 'prof-1', version: 2, hypothesisIds: [], mergedRuleSet: {},
      status: 'accepted', kind: 'composed', baselineValidationStatus: 'pending', createdAt: now, updatedAt: now,
    } as StrategyRevision);
    const { services, queued } = await makeFakeServices({ revisions, verdict: 'PASS' });

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1', revisionId: 'R' }), services);

    expect((await revisions.findById('R'))?.baselineValidationStatus).toBe('passed');
    expect((queued as unknown[]).filter((t) => (t as { taskType: string }).taskType === 'strategy.wfo')).toHaveLength(1);
  });

  it('fresh-profile FAIL baseline (no revisionId) also skips wfo (uniform W4 scope)', async () => {
    const { services, queued } = await makeFakeServices({ verdict: 'FAIL' });
    const appendSpy = vi.spyOn(services.events, 'append');

    await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1' }), services);

    expect((queued as unknown[]).filter((t) => (t as { taskType: string }).taskType === 'strategy.wfo')).toHaveLength(0);
    expect(appendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'strategy.baseline.wfo_skipped' }));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/orchestrator/handlers/strategy-baseline.handler.test.ts`
Expected: the 4 new tests FAIL — current handler enqueues `strategy.wfo` unconditionally and the schema rejects/ignores `revisionId` for writeback.

- [ ] **Step 3: Update the payload schema** (`strategy-baseline.handler.ts` ~13-21)

Replace the schema's link field:

```typescript
export const StrategyBaselinePayloadSchema = z.object({
  strategyProfileId: z.string().min(1),
  sourceTaskId: z.string().optional(),
  // Ready-bundle mode (re-baseline of a clean/composed source): reconstruct deterministically
  // instead of an LLM rebuild, which would drift the bundleHash.
  bundleArtifactRef: z.custom<ArtifactRef>((v) => typeof v === 'object' && v !== null).optional(),
  // When set, the baseline outcome is written back onto this revision (consolidated OR composed accepted).
  revisionId: z.string().optional(),
  /** @deprecated transient alias for `revisionId`; drop in a follow-up once the queue drains past this deploy. */
  consolidatedRevisionId: z.string().optional(),
});
```

- [ ] **Step 4: Restructure the completion block** (`strategy-baseline.handler.ts`, replace current lines ~65-94)

```typescript
  const revisionId = parsed.data.revisionId ?? parsed.data.consolidatedRevisionId;

  // Verdict -> baselineValidationStatus, computed for EVERY run so the W4 gate below is uniform.
  // PASS/PAPER_CANDIDATE -> 'passed'; INCONCLUSIVE -> 'inconclusive'; FAIL/MODIFY -> 'failed'.
  const baselineValidationStatus =
    verdict === 'PASS' || verdict === 'PAPER_CANDIDATE' ? 'passed'
    : verdict === 'INCONCLUSIVE' ? 'inconclusive'
    : 'failed';

  if (revisionId) {
    await services.revisions.updateStatus(revisionId, {
      baselineValidationStatus,
      baselineExperimentId: experimentId,
      baselineTaskId: task.id,
      updatedAt: new Date().toISOString(),
    });
  }

  // W4: only a passing baseline earns the expensive WFO sweep. failed/inconclusive stop here.
  if (baselineValidationStatus === 'passed') {
    await createAndEnqueueTask(
      {
        taskType: 'strategy.wfo',
        source: task.source,
        payload: { baselineExperimentId: experimentId },
        correlationId: task.correlationId,
        dedupeKey: `strategy.wfo:${experimentId}`,
      },
      { repo: services.researchTasks, queue: services.taskQueue },
    );
  } else {
    await services.events.append(event(task.id, 'strategy.baseline.wfo_skipped', {
      strategyProfileId, experimentId, verdict, reason: 'baseline_not_passed',
    }));
  }

  await services.events.append(event(task.id, 'strategy.baseline.completed', {
    strategyProfileId, experimentId, verdict, bundleHash: bundle.bundleHash,
  }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/orchestrator/handlers/strategy-baseline.handler.test.ts`
Expected: PASS (all — the 4 new + the pre-existing tests, which still hold: default `PAPER_CANDIDATE`→passed→wfo; `consolidatedRevisionId` alias writeback).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/handlers/strategy-baseline.handler.ts src/orchestrator/handlers/strategy-baseline.handler.test.ts
git commit -m "feat(r1): revisionId alias + uniform W4 gate on strategy.baseline wfo enqueue"
```

---

### Task 2: `revision-build` — direct re-baseline of accepted revisions (W1 fix)

**Files:**
- Modify: `src/orchestrator/handlers/revision-build.handler.ts` (ACCEPT path, the consolidation-trigger `if` ~264-278)
- Test: `src/orchestrator/handlers/revision-flow.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's `strategy.baseline` payload (`revisionId`, `bundleArtifactRef`). In-scope locals at the ACCEPT point: `revisionId` (accepted revision id), `bundleArtifactRef` (accepted candidate's bundle ref), `strategyProfileId`, `accepted.compositionDepth`, `now()`, `createAndEnqueueTask`, `services.revisions.updateStatus`.
- Produces: on accept with consolidation NOT firing, a `strategy.baseline` task with `dedupeKey` `strategy.baseline:accepted:${revisionId}` and the accepted revision set to `baselineValidationStatus: 'pending'`.

- [ ] **Step 1: Write the failing tests** (`revision-flow.integration.test.ts` — reuse the existing accepted-path harness in this file: the executor fake, `makeServices`/composition, and the flow that drives a revision to ACCEPT. Only the assertions and the `consolidator`/`consolidationDepthThreshold` service overrides are new.)

```typescript
  it('re-baselines an accepted revision directly when consolidation is off (W1)', async () => {
    // build services with consolidator null (default) so the direct path is taken;
    // drive the flow to an ACCEPT (reuse the existing accepted-combo harness in this file).
    // After the run:
    const baselineTasks = queued.filter((t) => t.taskType === 'strategy.baseline');
    expect(baselineTasks).toHaveLength(1);
    expect(baselineTasks[0]).toMatchObject({
      dedupeKey: expect.stringMatching(/^strategy\.baseline:accepted:/),
      payload: expect.objectContaining({ revisionId: expect.any(String), bundleArtifactRef: expect.anything() }),
    });
    expect(queued.filter((t) => t.taskType === 'revision.consolidate')).toHaveLength(0);
    // the accepted revision was marked pending for re-baseline:
    const accepted = await services.revisions.findLatestAccepted('<profileId used by the harness>');
    expect(accepted?.baselineValidationStatus).toBe('pending');
  });

  it('does NOT direct-rebaseline when consolidation fires (mutual exclusion)', async () => {
    // build services with a non-null consolidator and consolidationDepthThreshold = 1 so the
    // accepted revision's newDepth (>= 2) crosses the threshold; drive the same ACCEPT flow.
    expect(queued.filter((t) => t.taskType === 'revision.consolidate')).toHaveLength(1);
    expect(queued.filter((t) => t.taskType === 'strategy.baseline')).toHaveLength(0);
  });
```

(Set the service overrides through the same `makeServices`/composition the file already uses. A minimal non-null consolidator is any object satisfying the `services.consolidator` port shape the file's other consolidation tests construct — reuse that fixture.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/orchestrator/handlers/revision-flow.integration.test.ts`
Expected: the first new test FAILS — with consolidation off, no `strategy.baseline` is currently enqueued (the W1 dead-end).

- [ ] **Step 3: Add the else-branch** (`revision-build.handler.ts`, extend the consolidation-trigger `if`)

```typescript
    const newDepth = (accepted.compositionDepth ?? 1) + 1;
    if (services.consolidator !== null && services.consolidationDepthThreshold > 0 && newDepth >= services.consolidationDepthThreshold) {
      await createAndEnqueueTask(
        {
          taskType: 'revision.consolidate', source: task.source,
          payload: { revisionId, strategyProfileId }, correlationId: task.correlationId,
          dedupeKey: `revision.consolidate:${revisionId}`,
        },
        { repo: services.researchTasks, queue: services.taskQueue },
      );
    } else {
      // R1 (W1 fix): no consolidation -> re-baseline the accepted composed revision directly so it
      // returns to paper via the same strategy.baseline -> wfo -> paper.start chain. Mutually
      // exclusive with the consolidation branch (which re-baselines the consolidated revision),
      // so an accepted revision is never re-baselined twice / double-submitted to paper.
      await services.revisions.updateStatus(revisionId, { baselineValidationStatus: 'pending', updatedAt: now() });
      await createAndEnqueueTask(
        {
          taskType: 'strategy.baseline', source: task.source,
          payload: { strategyProfileId, bundleArtifactRef, revisionId },
          correlationId: task.correlationId,
          dedupeKey: `strategy.baseline:accepted:${revisionId}`,
        },
        { repo: services.researchTasks, queue: services.taskQueue },
      );
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/orchestrator/handlers/revision-flow.integration.test.ts`
Expected: PASS (both new tests + the file's existing tests). If a pre-existing test that drives to ACCEPT now also observes a new `strategy.baseline` enqueue, update that assertion to account for it (the accepted-with-consolidation-off path now enqueues one).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/revision-build.handler.ts src/orchestrator/handlers/revision-flow.integration.test.ts
git commit -m "feat(r1): re-baseline any accepted revision when consolidation is off (close W1)"
```

---

### Task 3: migrate the consolidation caller to `revisionId`

**Files:**
- Modify: `src/orchestrator/handlers/revision-consolidate.handler.ts` (`acceptConsolidation`, the `strategy.baseline` enqueue payload)
- Test: `src/orchestrator/handlers/revision-consolidate.handler.test.ts`

**Interfaces:**
- Consumes: Task 1's `revisionId` payload field.
- Produces: `acceptConsolidation` emits `strategy.baseline` with `revisionId: newId` (was `consolidatedRevisionId: newId`); writeback still lands on the consolidated revision (Task 1 resolves either field).

- [ ] **Step 1: Update the failing test** (`revision-consolidate.handler.test.ts` — the test asserting the re-baseline enqueue payload)

Change the assertion on the enqueued `strategy.baseline` payload from `consolidatedRevisionId` to `revisionId`:

```typescript
    expect(baselineTask?.payload).toMatchObject({ revisionId: expect.any(String), bundleArtifactRef: expect.anything() });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts`
Expected: FAIL — the handler still emits `consolidatedRevisionId`.

- [ ] **Step 3: Migrate the payload** (`revision-consolidate.handler.ts`, in `acceptConsolidation`'s `createAndEnqueueTask`)

```typescript
      payload: { strategyProfileId: R.strategyProfileId, bundleArtifactRef: cleanRef, revisionId: newId },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/handlers/revision-consolidate.handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean tsc; full suite green (0 failures).

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/revision-consolidate.handler.ts src/orchestrator/handlers/revision-consolidate.handler.test.ts
git commit -m "refactor(r1): migrate consolidation re-baseline caller to revisionId field"
```

---

## Self-review notes

- **Spec coverage:** §3.1 → Task 2; §3.2 (rename + alias + caller migration + back-compat) → Task 1 (schema/resolve/back-compat via existing tests) + Task 3 (caller); §3.3 (uniform W4 gate) → Task 1; §5 tests → Tasks 1-3; §6 deferred (fresh-profile rescue policy) → intentionally NOT implemented.
- **Behavior-change note:** Task 1 makes fresh-profile Cycle-1 baselines with FAIL/INCONCLUSIVE verdicts skip WFO (was unconditional). This is the ratified uniform W4 scope; covered by the "fresh-profile FAIL" test. If any existing Cycle-1 baseline test asserts a WFO enqueue on a non-`passed` fixture verdict, update it (change the fixture verdict to a passing one, or assert the skip).
- **Transient alias:** deliberately kept in Task 1; the follow-up cleanup that removes `consolidatedRevisionId` is out of scope for R1 and should be a separate commit after the queue drains.
