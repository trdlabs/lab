# R3a — revision holdout gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merged revision is ACCEPTed only after it holds up on a holdout window the selection never saw — split the eval window at boundary T, run greedy selection on train `[from..T)`, gate final ACCEPT on a confirming holdout run `[T..to)`.

**Architecture:** Three tasks, all in `revision-build.handler.ts` + persistence. Task 1 adds the `holdoutValidation` persistence surface (mirrors R2's `preservationGate` field exactly). Task 2 computes the boundary from a full-window baseline run and wires the observable skip paths (insufficient data / fetch failure → accept-as-today + flag + event). Task 3 activates the gate for `trade_based`: selection on train (separate train baseline), confirming holdout run, downgrade-only gate, holdout run as the accepted run-context.

**Tech Stack:** TypeScript (`node --experimental-strip-types`), Vitest, Drizzle (Postgres), pnpm. Reuses `resolveHoldoutBoundary`, `encodeTrainPeriod`/`encodeHoldoutPeriod`, `evaluateRevision`, `applyRevisionPreservationGate`, the revision run executor.

## Global Constraints

- Lab imports carry the `.ts` extension. No TS parameter properties. No new env var.
- Period windows use `encodeTrainPeriod(from, T, timeframe)` / `encodeHoldoutPeriod(T, to)` from `src/research/period-encoding.ts` — NEVER hand-write `{ from, to: T }`.
- Boundary policy is `DEFAULT_HOLDOUT_POLICY` from `src/domain/research-experiment.ts` (same as Cycle 1).
- The gate is **downgrade-only**: it can turn a train-ACCEPT into a reject, never an accept. `mode:'none'` / `boundary_unavailable` must NOT stall the loop (accept-as-today + observable flag).
- Full-window baseline run derives T only; selection compares within the train window against a **separate** train baseline — never the full-window `baselineMetrics`.
- Branch `feat/r3a-revision-holdout-gate` (base main `642911c`). Spec `docs/superpowers/specs/2026-07-12-r3a-revision-holdout-gate-design.md`.
- Verify per task: `npx tsc --noEmit` clean + the task's test file(s) green; final task runs `npx vitest run`.

---

### Task 1: `holdoutValidation` persistence surface

**Files:**
- Modify: `src/domain/strategy-revision.ts` (add the type + optional field)
- Create: `migrations/<generated>_*.sql` (nullable additive `holdout_validation jsonb` on `strategy_revision`)
- Modify: `src/db/schema.ts` (column), `src/adapters/repository/drizzle-strategy-revision.repository.ts` (create + toDomain + updateStatus patch), `src/adapters/repository/in-memory-strategy-revision.repository.ts` (updateStatus whitelist)
- Test: `src/adapters/repository/in-memory-strategy-revision.repository.test.ts` (and the drizzle repo test if one exists)

**Interfaces:**
- Produces: `HoldoutValidationReason = 'skipped_insufficient_history' | 'skipped_insufficient_trades' | 'boundary_unavailable' | 'holdout_passed' | 'holdout_failed'`; `interface HoldoutValidation { mode: 'none' | 'trade_based'; t?: string; reason: HoldoutValidationReason; lowConfidence?: boolean; trainMetrics?: Record<string, unknown>; holdoutMetrics?: Record<string, unknown> }`; `StrategyRevision.holdoutValidation?: HoldoutValidation`; `updateStatus` patch accepts `holdoutValidation`.

**This mirrors the `preservationGate` field added in R2 slice 1a (migration `0021_fat_the_initiative`, domain + drizzle + in-memory + round-trip test).** Follow that exact pattern — read those changes first (`git log -p --all -- src/adapters/repository/in-memory-strategy-revision.repository.ts | head -120`).

- [ ] **Step 1: Add the type + field** (`src/domain/strategy-revision.ts`)

```typescript
export type HoldoutValidationReason =
  | 'skipped_insufficient_history'
  | 'skipped_insufficient_trades'
  | 'boundary_unavailable'
  | 'holdout_passed'
  | 'holdout_failed';

export interface HoldoutValidation {
  mode: 'none' | 'trade_based';
  t?: string;
  reason: HoldoutValidationReason;
  lowConfidence?: boolean;
  trainMetrics?: Record<string, unknown>;
  holdoutMetrics?: Record<string, unknown>;
}
```

Add to `interface StrategyRevision` (near `preservationGate?`): `holdoutValidation?: HoldoutValidation;`

- [ ] **Step 2: Add the column** (`src/db/schema.ts`, on the `strategy_revision` table, next to `preservation_gate`):

```typescript
  holdoutValidation: jsonb('holdout_validation').$type<HoldoutValidation>(),
```

Import `HoldoutValidation` from the domain module (mirror how `PreservationMetadata` is imported there).

- [ ] **Step 3: Generate the migration** — run the repo's drizzle migration generator (same command that produced `0021_*`; check `package.json` scripts, e.g. `pnpm drizzle-kit generate` or `pnpm db:generate`). It must emit a single `ALTER TABLE "strategy_revision" ADD COLUMN "holdout_validation" jsonb;` (nullable, additive). If the toolchain isn't available, hand-write that one-line migration file with the next sequence number + a snapshot entry mirroring `0022`'s shape.

- [ ] **Step 4: Wire the drizzle repo** (`drizzle-strategy-revision.repository.ts`): in `create`, map `holdoutValidation: r.holdoutValidation` (mirror `preservationGate`); in `strategyRevisionToDomain`, `holdoutValidation: row.holdoutValidation ?? undefined`; in `updateStatus`, add `'holdoutValidation'` to the `Pick<>` union and `if (patch.holdoutValidation !== undefined) set.holdoutValidation = patch.holdoutValidation;`.

- [ ] **Step 5: Wire the in-memory repo + write the round-trip test.** In `in-memory-strategy-revision.repository.ts` `updateStatus`, add `holdoutValidation` to the whitelisted patch fields (THIS is the 7cb7a8d bug class — the whitelist silently drops unlisted fields). Add to `in-memory-strategy-revision.repository.test.ts`:

```typescript
it('round-trips holdoutValidation through create + updateStatus + findById', async () => {
  const repo = new InMemoryStrategyRevisionRepository();
  const now = '2026-01-01T00:00:00Z';
  await repo.create({ id: 'R', strategyProfileId: 'p', version: 2, hypothesisIds: [], mergedRuleSet: {}, status: 'accepted', kind: 'composed', createdAt: now, updatedAt: now } as StrategyRevision);
  const hv = { mode: 'trade_based', t: '2026-06-25T00:00:00Z', reason: 'holdout_passed', lowConfidence: false, trainMetrics: { netPnlUsd: 10 }, holdoutMetrics: { netPnlUsd: 8 } } as const;
  await repo.updateStatus('R', { holdoutValidation: hv, updatedAt: now });
  expect((await repo.findById('R'))?.holdoutValidation).toEqual(hv);
});
```

- [ ] **Step 6: Run tests + tsc + commit**

Run: `npx vitest run src/adapters/repository/in-memory-strategy-revision.repository.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

```bash
git add -A && git commit -m "feat(r3a): holdoutValidation persistence surface on strategy_revision"
```

---

### Task 2: boundary computation + observable skip paths

**Files:**
- Modify: `src/orchestrator/handlers/revision-build.handler.ts` (after Step 8 baseline, ~350)
- Test: `src/orchestrator/handlers/revision-flow.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's `holdoutValidation`; `resolveHoldoutBoundary` (`src/research/holdout-boundary-resolver.ts`), `DEFAULT_HOLDOUT_POLICY`, `services.runTrades.getRunTrades`, `HoldoutBoundary`.
- Produces: a `boundary: HoldoutBoundary` local in scope for Task 3; on `mode:'none'` / boundary-fetch-failure, a `holdoutValidation` value + `revision.holdout_skipped` event, and the greedy loop/ACCEPT proceed on the full window unchanged.

- [ ] **Step 1: Write failing tests** (`revision-flow.integration.test.ts`) — reuse the file's accepted-path harness. The existing fixtures have short periods → `mode:'none'` (`insufficient_history`), so most existing tests exercise this path already; the new tests assert the flag + event:

```typescript
  it('records a holdout skip on insufficient history and still accepts (full-window)', async () => {
    // drive an accepted revision with the existing short-window harness; after the run:
    const rev = await services.revisions.findLatestAccepted('<profileId>');
    expect(rev?.holdoutValidation?.mode).toBe('none');
    expect(rev?.holdoutValidation?.reason).toBe('skipped_insufficient_history');
    expect((await eventTypes(services)).includes('revision.holdout_skipped')).toBe(true);
  });

  it('fails soft to boundary_unavailable when baseline trades cannot be fetched', async () => {
    // build services whose runTrades.getRunTrades throws; drive an accepted revision:
    const rev = await services.revisions.findLatestAccepted('<profileId>');
    expect(rev?.holdoutValidation?.reason).toBe('boundary_unavailable');
    // still accepted (not rejected) on the full window:
    expect(rev?.status).toBe('accepted');
  });
```

(Match the file's real harness/helper names — read the accepted-path tests first. `eventTypes` is illustrative of the file's event-collection helper.)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/orchestrator/handlers/revision-flow.integration.test.ts -t "holdout skip|boundary_unavailable"`
Expected: FAIL — no `holdoutValidation`/`revision.holdout_skipped` yet.

- [ ] **Step 3: Insert boundary resolution** (`revision-build.handler.ts`, immediately after the `if (!baselineMetrics) { ...reject... return; }` block, ~line 350). Add imports at top: `import { resolveHoldoutBoundary } from '../../research/holdout-boundary-resolver.ts';`, `import { encodeTrainPeriod, encodeHoldoutPeriod } from '../../research/period-encoding.ts';`, `import { DEFAULT_HOLDOUT_POLICY } from '../../domain/research-experiment.ts';`, and `HoldoutBoundary` / `HoldoutValidation` types.

```typescript
  // --- R3a: OOS holdout boundary (fixed once from the full-window baseline trades) ---
  let boundary: HoldoutBoundary = { mode: 'none', lowConfidence: false, reason: 'insufficient_history' };
  let holdoutValidation: HoldoutValidation | undefined;
  try {
    const fullBaselineTrades = await services.runTrades.getRunTrades(baselinePlatformRunId!);
    boundary = resolveHoldoutBoundary(fullBaselineTrades, runConfig.period, DEFAULT_HOLDOUT_POLICY);
  } catch (err) {
    holdoutValidation = { mode: 'none', reason: 'boundary_unavailable' };
    await services.events.append(event(task.id, 'revision.holdout_skipped', { revisionId, reason: 'boundary_unavailable', detail: errMsg(err) }));
  }
  if (!holdoutValidation && boundary.mode === 'none') {
    const reason = boundary.reason === 'insufficient_trades' ? 'skipped_insufficient_trades' : 'skipped_insufficient_history';
    holdoutValidation = { mode: 'none', reason };
    await services.events.append(event(task.id, 'revision.holdout_skipped', { revisionId, reason }));
  }
```

- [ ] **Step 4: Persist the flag in the ACCEPT + reject paths.** In the ACCEPT `updateStatus` (~436) add `holdoutValidation: holdoutValidation ?? undefined,`; in the reject `updateStatus` (~480) add the same. (Task 3 sets the `trade_based` `holdoutValidation`; for now only the skip values flow.)

- [ ] **Step 5: Run tests + tsc**

Run: `npx vitest run src/orchestrator/handlers/revision-flow.integration.test.ts && npx tsc --noEmit`
Expected: PASS (new + existing — existing accepted-path tests now also carry `holdoutValidation.mode==='none'`; if any asserts the exact revision shape, update it to allow the additive field).

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/revision-build.handler.ts src/orchestrator/handlers/revision-flow.integration.test.ts
git commit -m "feat(r3a): revision holdout boundary + observable skip paths (insufficient/unavailable)"
```

---

### Task 3: activate the gate for `trade_based` (train selection + holdout confirm)

**Files:**
- Modify: `src/orchestrator/handlers/revision-build.handler.ts` (selection window ~352-433; holdout confirm before the ACCEPT persist ~435)
- Test: `src/orchestrator/handlers/revision-flow.integration.test.ts`

**Interfaces:**
- Consumes: Task 2's `boundary`/`holdoutValidation`; `encodeTrainPeriod`/`encodeHoldoutPeriod`; `evaluateRevision`; `applyRevisionPreservationGate`; the executor.
- Produces: for `trade_based`, selection runs on `[from..T)` vs a train baseline, then a confirming holdout run gates ACCEPT; on PASS the revision's `metrics`/`comboBacktestRunId` = the holdout candidate run; `revision.holdout_validated` emitted.

- [ ] **Step 1: Write failing tests** (`revision-flow.integration.test.ts`). Build a harness with a full-window baseline whose trades satisfy `DEFAULT_HOLDOUT_POLICY` (≥ `minTradesTrain` + `minTradesHoldout`) so `resolveHoldoutBoundary` returns `trade_based` with a `t`. The revision run executor fake must return per-run metrics keyed by the run's `period` (train vs holdout) so the two windows differ.

```typescript
  it('trade_based: accepts only after a passing holdout confirm; primary run = holdout run', async () => {
    // fake executor: train candidate PASS vs train baseline; holdout candidate also PASS vs holdout baseline
    // (metrics keyed by run.period.to === T for train, run.period.from === T for holdout)
    const rev = await services.revisions.findLatestAccepted('<profileId>');
    expect(rev?.status).toBe('accepted');
    expect(rev?.holdoutValidation?.mode).toBe('trade_based');
    expect(rev?.holdoutValidation?.reason).toBe('holdout_passed');
    expect(rev?.holdoutValidation?.trainMetrics).toBeDefined();
    expect(rev?.holdoutValidation?.holdoutMetrics).toBeDefined();
    // primary run-context is the holdout run:
    expect(rev?.comboBacktestRunId).toBe('<holdout candidate runId from the fake>');
    expect((await eventTypes(services))).toContain('revision.holdout_validated');
  });

  it('trade_based: rejects holdout_failed when the train-accepted candidate degrades on holdout', async () => {
    // fake executor: train candidate PASS; holdout candidate DEGRADES vs holdout baseline
    const rev = await services.revisions.findLatestByProfile('<profileId>'); // however the file reads the built revision
    expect(rev?.status).toBe('rejected');
    expect(rev?.verdictReason).toBe('holdout_failed');
    expect(rev?.holdoutValidation?.reason).toBe('holdout_failed');
    // not merged: no strategy.baseline / revision.consolidate enqueued
    expect((await eventTypes(services))).not.toContain('revision.accepted');
  });
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/orchestrator/handlers/revision-flow.integration.test.ts -t "trade_based"`
Expected: FAIL — selection still runs on the full window; no holdout confirm.

- [ ] **Step 3: Swap the selection window + baseline for `trade_based`.** Just before the greedy loop (~352), introduce the selection config + selection baseline. For `mode:'none'`/unavailable they equal the full-window values (no behavior change); for `trade_based` they are the train values.

```typescript
  // R3a: selection runs on the TRAIN window against a TRAIN baseline when a boundary exists;
  // otherwise on the full window against the full baseline (unchanged behavior).
  let selectionConfig = runConfig;
  let selectionBaselineMetrics = baselineMetrics;
  let selectionBaselinePlatformRunId = baselinePlatformRunId;
  if (boundary.mode === 'trade_based' && boundary.t) {
    selectionConfig = { ...runConfig, period: encodeTrainPeriod(runConfig.period.from, boundary.t, runConfig.timeframe) };
    const tb = await services.revisionRunExecutor.execute({
      revisionId, label: 'train_baseline', strategyBundle: baseBundle,
      strategyProfileId, run: selectionConfig, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
    });
    if (tb.status !== 'completed' || !tb.metrics) {
      // train baseline unavailable: fall back to the full-window gate-skipped path
      holdoutValidation = { mode: 'none', reason: 'boundary_unavailable' };
      await services.events.append(event(task.id, 'revision.holdout_skipped', { revisionId, reason: 'boundary_unavailable', detail: 'train_baseline_unavailable' }));
      boundary = { mode: 'none', lowConfidence: false, reason: 'insufficient_history' };
    } else {
      selectionBaselineMetrics = tb.metrics;
      selectionBaselinePlatformRunId = tb.platformRunId;
    }
  }
```

Then in the greedy loop body, replace `run: runConfig` → `run: selectionConfig` (both the candidate execute ~368 and — already done above — the baseline), `baselineMetrics` → `selectionBaselineMetrics` (evaluateRevision ~374 and the R2 aggregate ~381-382), and `baselinePlatformRunId` → `selectionBaselinePlatformRunId` (the R2 `getRunTrades` ~377 and `gateOn` ~359). This keeps R2 comparing same-window (train) trades.

- [ ] **Step 4: Insert the holdout confirmation** between the greedy loop and the ACCEPT persist (~434, before `if (verdict.decision === 'ACCEPT' && acceptedRun && acceptedMetrics)`).

```typescript
  // R3a: holdout confirmation — a train-accepted candidate must not degrade on [T..to).
  if (boundary.mode === 'trade_based' && boundary.t && verdict.decision === 'ACCEPT' && acceptedRun && acceptedMetrics) {
    const holdoutConfig = { ...runConfig, period: encodeHoldoutPeriod(boundary.t, runConfig.period.to) };
    const hBase = await services.revisionRunExecutor.execute({
      revisionId, label: 'holdout_baseline', strategyBundle: baseBundle,
      strategyProfileId, run: holdoutConfig, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
    });
    const hCand = await services.revisionRunExecutor.execute({
      revisionId, label: 'holdout_candidate', strategyBundle: assembled,
      strategyProfileId, run: holdoutConfig, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
    });
    const hBaseM = hBase.status === 'completed' ? hBase.metrics : undefined;
    const hCandM = hCand.status === 'completed' ? hCand.metrics : undefined;
    const holdoutVerdict = hBaseM && hCandM
      ? evaluateRevision({ accepted: hBaseM, candidate: hCandM, minTrades: 20 })
      : { decision: 'REJECT' as const, reasons: ['holdout_run_unavailable'] };
    const trainMetrics = acceptedMetrics as unknown as Record<string, unknown>;
    if (holdoutVerdict.decision !== 'ACCEPT') {
      holdoutValidation = { mode: 'trade_based', t: boundary.t, reason: 'holdout_failed', lowConfidence: boundary.lowConfidence,
        trainMetrics, holdoutMetrics: (hCandM as unknown as Record<string, unknown>) ?? undefined };
      await services.revisions.updateStatus(revisionId, {
        status: 'rejected', verdictReason: 'holdout_failed', preservationGate: firedPreservation ?? undefined,
        holdoutValidation, updatedAt: now(),
      });
      await services.events.append(event(task.id, 'revision.holdout_validated', {
        revisionId, version, mode: 'trade_based', t: boundary.t, decision: holdoutVerdict.decision, reasons: holdoutVerdict.reasons,
      }));
      await services.events.append(event(task.id, 'revision.rejected', { revisionId, version, reasons: ['holdout_failed'] }));
      return;
    }
    // holdout passed: the holdout run becomes the accepted run-context.
    holdoutValidation = { mode: 'trade_based', t: boundary.t, reason: 'holdout_passed', lowConfidence: boundary.lowConfidence,
      trainMetrics, holdoutMetrics: hCandM as unknown as Record<string, unknown> };
    acceptedRun = hCand;
    acceptedMetrics = hCandM;
    await services.events.append(event(task.id, 'revision.holdout_validated', {
      revisionId, version, mode: 'trade_based', t: boundary.t, decision: 'ACCEPT', trainMetrics, holdoutMetrics: hCandM,
    }));
  }
```

The existing ACCEPT persist (~436) already writes `metrics: acceptedMetrics` + `comboBacktestRunId: acceptedRun.runId` — now the holdout run — plus the `holdoutValidation` added in Task 2 Step 4. No further change to the accept block.

- [ ] **Step 5: Run tests + tsc + full suite**

Run: `npx vitest run src/orchestrator/handlers/revision-flow.integration.test.ts && npx tsc --noEmit && npx vitest run`
Expected: focused green (trade_based PASS + FAIL, plus Task 2's skip tests), clean tsc, full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/revision-build.handler.ts src/orchestrator/handlers/revision-flow.integration.test.ts
git commit -m "feat(r3a): trade_based holdout gate — train selection + holdout confirm (closes M3)"
```

---

## Self-review notes

- **Spec coverage:** §3.1 boundary → Task 2; §3.2 mode:'none'/normalized reasons → Task 2; §3.2 trade_based train-selection + holdout-confirm + gate + lowConfidence-still-applies → Task 3; §3.3 R2 composition (veto on train runs) → Task 3 Step 3; §3.4 persistence + primary-run + events → Task 1 (surface) + Task 2/3 (values); §5 tests → Tasks 1-3.
- **Downgrade-only:** the holdout stage only runs when the greedy loop already reached `ACCEPT`; it can `return` a reject but never creates an accept from a reject.
- **R2 same-window:** Task 3 Step 3 repoints the R2 veto's `getRunTrades` at the train baseline/candidate runs, so preservation compares train-vs-train (not train-vs-full).
- **Existing tests:** all current revision-flow fixtures are short-window → `mode:'none'` → Task 2/3 leave their accept/reject behavior intact (only the additive `holdoutValidation` field + `revision.holdout_skipped` event appear). Update any test that asserts an exact revision object or an exact event list.
- **Deferred (not here):** window-binding to real history + per-hypothesis holdout (R3b); full A/B/C + multi-fold via E3 (R3c); the extra holdout runs' cost (spec §6).
