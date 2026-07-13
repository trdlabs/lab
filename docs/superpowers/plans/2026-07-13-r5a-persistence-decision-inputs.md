# R5a — Persistence decision-inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the revision evaluator's decision inputs — a versioned policy, a typed `selectionEvaluation` snapshot (baseline+candidate+thresholds+verdict), and an extended `holdoutValidation` (holdout baseline + verdict) — so the R5b cycle-scorecard can explain any revision outcome (accepted OR rejected) without reconstructing thresholds from code constants.

**Architecture:** Hoist the four hardcoded thresholds in `evaluateRevision` into an explicit versioned `RevisionEvaluatorPolicy` input. Add a `selectionEvaluation` JSONB column on `strategy_revision` and extend the existing `holdout_validation` JSONB payload. `revision-build` writes both at its terminal branches, whenever a real baseline↔candidate comparison actually happened.

**Tech Stack:** TypeScript (`node --experimental-strip-types`), Drizzle/Postgres, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-07-13-r5-cycle-scorecard-design.md` §0/§4 (commit `ac45e25`).

**Scope:** ONLY R5a. R5b (cycle-scorecard consumer) is a SEPARATE plan written later, after R5a ships and the actual persisted types are re-verified.

## Global Constraints

- **Runtime:** `node --experimental-strip-types`. NO TypeScript parameter properties (`constructor(private x)`) — break at runtime; an AST-guard test blocks them.
- **Additive + back-compat only:** new `selection_evaluation` column is nullable; `HoldoutValidation` gains only optional fields; existing rows/behavior unchanged. Migration is a single additive `ALTER TABLE ... ADD COLUMN`.
- **No-shortcuts:** the **same** `RevisionEvaluatorPolicy` object handed to `evaluateRevision` is what gets persisted — never reconstruct thresholds from current constants at read time.
- **Exact policy fields (verbatim):** `RevisionEvaluatorPolicy = { evaluatorVersion: string; minTrades: number; minNetPnlImprovementUsd: number; maxDrawdownRegressionPct: number; topTradeContributionPct: number }`. Defaults: `evaluatorVersion: REVISION_EVALUATOR_VERSION` (`'revision-combo-v1'`), `minTrades: 20`, `minNetPnlImprovementUsd: 0`, `maxDrawdownRegressionPct: 2.0`, `topTradeContributionPct: 50`.
- `selectionEvaluation` is written for accepted AND rejected terminals **only when a baseline↔candidate comparison actually happened**. `comparison_baseline_unavailable` / `candidate_run_unavailable` → NO snapshot (field stays `undefined`).
- Use `pnpm typecheck`. Run vitest via `node --experimental-strip-types node_modules/vitest/vitest.mjs run <file>`.
- TDD, frequent commits.

## File Structure

- **Modify** `src/validation/revision-evaluator.ts` — add `RevisionEvaluatorPolicy` + `DEFAULT_REVISION_EVALUATOR_POLICY` + `RevisionDecision`; make `evaluateRevision(input, policy)`.
- **Modify** `src/domain/strategy-revision.ts` — `SelectionEvaluation` type + `StrategyRevision.selectionEvaluation?`; extend `HoldoutValidation`.
- **Create** `migrations/0024_*.sql` — additive `selection_evaluation jsonb`.
- **Modify** `src/db/schema.ts` — `selectionEvaluation` column on `strategyRevision`.
- **Modify** `src/adapters/repository/drizzle-strategy-revision.repository.ts` — create-map + `toDomain` + updateStatus patch.
- **Modify** `src/adapters/repository/in-memory-strategy-revision.repository.ts` — round-trip the new field.
- **Modify** `src/ports/strategy-revision.repository.ts` — add `selectionEvaluation` to the `updateStatus` `Pick<>`.
- **Modify** `src/orchestrator/handlers/revision-build.handler.ts` — pass policy; write `selectionEvaluation` + extended `holdoutValidation` at terminals.

---

## Task 1: Versioned `RevisionEvaluatorPolicy` + `evaluateRevision(input, policy)`

**Files:**
- Modify: `src/validation/revision-evaluator.ts`
- Modify: `src/orchestrator/handlers/revision-build.handler.ts` (the two `evaluateRevision(...)` call-sites — pass `DEFAULT_REVISION_EVALUATOR_POLICY` so behavior is identical and typecheck stays green)
- Test: `src/validation/revision-evaluator.test.ts`

**Interfaces:**
- Produces: `RevisionEvaluatorPolicy` (5 fields above), `DEFAULT_REVISION_EVALUATOR_POLICY`, `RevisionDecision = 'ACCEPT' | 'REJECT'`, `evaluateRevision(input: { accepted: BacktestMetricBlock; candidate: BacktestMetricBlock }, policy: RevisionEvaluatorPolicy): RevisionVerdict`. `RevisionComparisonInput` loses `minTrades` (now in policy).

- [ ] **Step 1: Write the failing test** — a non-default policy changes the ladder outcome

Append to `src/validation/revision-evaluator.test.ts`:

```ts
import { evaluateRevision, DEFAULT_REVISION_EVALUATOR_POLICY, REVISION_EVALUATOR_VERSION } from './revision-evaluator.ts';

const M = (over: Record<string, number> = {}) => ({
  netPnlUsd: 1000, maxDrawdownPct: 10, totalTrades: 50, topTradeContributionPct: 20,
  sharpeRatio: 1, winRatePct: 55, profitFactor: 2, ...over,
}) as never;

describe('evaluateRevision — policy-driven thresholds', () => {
  it('DEFAULT policy carries the exact shipped values', () => {
    expect(DEFAULT_REVISION_EVALUATOR_POLICY).toEqual({
      evaluatorVersion: REVISION_EVALUATOR_VERSION,
      minTrades: 20, minNetPnlImprovementUsd: 0, maxDrawdownRegressionPct: 2.0, topTradeContributionPct: 50,
    });
  });

  it('uses policy.maxDrawdownRegressionPct (not a literal 2.0)', () => {
    const input = { accepted: M(), candidate: M({ netPnlUsd: 1100, maxDrawdownPct: 13 }) }; // +3pp drawdown
    // default (2.0) → REJECT drawdown_regression; loosened (5.0) → ACCEPT
    expect(evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY).decision).toBe('REJECT');
    expect(evaluateRevision(input, { ...DEFAULT_REVISION_EVALUATOR_POLICY, maxDrawdownRegressionPct: 5.0 }).decision).toBe('ACCEPT');
  });

  it('uses policy.topTradeContributionPct (not a literal 50)', () => {
    const input = { accepted: M(), candidate: M({ netPnlUsd: 1100, topTradeContributionPct: 45 }) };
    expect(evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY).decision).toBe('ACCEPT'); // 45 < 50
    expect(evaluateRevision(input, { ...DEFAULT_REVISION_EVALUATOR_POLICY, topTradeContributionPct: 40 }).decision).toBe('REJECT'); // 45 >= 40
  });

  it('uses policy.minTrades', () => {
    const input = { accepted: M(), candidate: M({ netPnlUsd: 1100, totalTrades: 10 }) };
    expect(evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY).reasons).toEqual(['insufficient_sample']); // 10 < 20
    expect(evaluateRevision(input, { ...DEFAULT_REVISION_EVALUATOR_POLICY, minTrades: 5 }).decision).toBe('ACCEPT'); // 10 >= 5
  });
});
```

Also UPDATE every EXISTING call in this test file from `evaluateRevision({ accepted, candidate, minTrades: N })` to `evaluateRevision({ accepted, candidate }, { ...DEFAULT_REVISION_EVALUATOR_POLICY, minTrades: N })` — the signature changed.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/validation/revision-evaluator.test.ts`
Expected: FAIL — `DEFAULT_REVISION_EVALUATOR_POLICY` not exported / `evaluateRevision` arity mismatch.

- [ ] **Step 3: Refactor `revision-evaluator.ts`**

Replace the type/function region:

```ts
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

export const REVISION_EVALUATOR_VERSION = 'revision-combo-v1';

/** Versioned, explicit evaluator thresholds. Persisted verbatim (no reconstruction from constants). */
export interface RevisionEvaluatorPolicy {
  evaluatorVersion: string;
  minTrades: number;
  minNetPnlImprovementUsd: number;
  maxDrawdownRegressionPct: number;
  topTradeContributionPct: number;
}

export const DEFAULT_REVISION_EVALUATOR_POLICY: RevisionEvaluatorPolicy = {
  evaluatorVersion: REVISION_EVALUATOR_VERSION,
  minTrades: 20,
  minNetPnlImprovementUsd: 0,
  maxDrawdownRegressionPct: 2.0,
  topTradeContributionPct: 50,
};

export interface RevisionComparisonInput {
  accepted: BacktestMetricBlock;
  candidate: BacktestMetricBlock;
}

export type RevisionVerdict =
  | { decision: 'ACCEPT'; reasons: string[] }
  | { decision: 'REJECT'; reasons: string[] };

export type RevisionDecision = RevisionVerdict['decision'];

/**
 * Ladder (first match wins), all thresholds from `policy`:
 * 1. candidate.totalTrades < policy.minTrades → REJECT 'insufficient_sample'
 * 2. (candidate.netPnlUsd - accepted.netPnlUsd) <= policy.minNetPnlImprovementUsd → REJECT 'no_improvement_over_accepted'
 * 3. (candidate.maxDrawdownPct - accepted.maxDrawdownPct) > policy.maxDrawdownRegressionPct → REJECT 'drawdown_regression'
 * 4. candidate.topTradeContributionPct >= policy.topTradeContributionPct → REJECT 'fragile_pnl'
 * 5. else → ACCEPT ['pnl_improved']
 */
export function evaluateRevision(input: RevisionComparisonInput, policy: RevisionEvaluatorPolicy): RevisionVerdict {
  const { accepted, candidate } = input;

  if (candidate.totalTrades < policy.minTrades) {
    return { decision: 'REJECT', reasons: ['insufficient_sample'] };
  }
  const deltaNetPnlUsd = candidate.netPnlUsd - accepted.netPnlUsd;
  if (deltaNetPnlUsd <= policy.minNetPnlImprovementUsd) {
    return { decision: 'REJECT', reasons: ['no_improvement_over_accepted'] };
  }
  const deltaMaxDrawdownPct = candidate.maxDrawdownPct - accepted.maxDrawdownPct;
  if (deltaMaxDrawdownPct > policy.maxDrawdownRegressionPct) {
    return { decision: 'REJECT', reasons: ['drawdown_regression'] };
  }
  if (candidate.topTradeContributionPct >= policy.topTradeContributionPct) {
    return { decision: 'REJECT', reasons: ['fragile_pnl'] };
  }
  return { decision: 'ACCEPT', reasons: ['pnl_improved'] };
}
```

- [ ] **Step 4: Update the two `revision-build` call-sites (keep typecheck green)**

In `src/orchestrator/handlers/revision-build.handler.ts`, add to the `revision-evaluator.ts` import: `DEFAULT_REVISION_EVALUATOR_POLICY`.

Replace the train-selection call:
```ts
      verdict = evaluateRevision({ accepted: selectionBaselineMetrics, candidate: result.metrics }, DEFAULT_REVISION_EVALUATOR_POLICY);
```
Replace the holdout-confirm call:
```ts
      ? evaluateRevision({ accepted: hBaseM, candidate: hCandM }, DEFAULT_REVISION_EVALUATOR_POLICY)
```
(Both drop the old inline `minTrades: 20` — it now lives in the policy. Behavior is identical.)

- [ ] **Step 5: Run tests**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/validation/revision-evaluator.test.ts src/orchestrator/handlers/revision-flow.integration.test.ts`
Expected: PASS (new policy tests green; revision-flow unchanged — behavior identical).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add src/validation/revision-evaluator.ts src/validation/revision-evaluator.test.ts src/orchestrator/handlers/revision-build.handler.ts
git commit -m "feat(r5a): versioned RevisionEvaluatorPolicy as explicit evaluateRevision input"
```

---

## Task 2: Domain types — `SelectionEvaluation` + `HoldoutValidation` extension

**Files:**
- Modify: `src/domain/strategy-revision.ts`
- Test: `src/domain/strategy-revision.test.ts` (create if absent, else append)

**Interfaces:**
- Consumes: `RevisionEvaluatorPolicy`, `RevisionDecision` (Task 1); `BacktestMetricBlock` (`../ports/platform-gateway.port.ts`).
- Produces: `SelectionEvaluation`; `StrategyRevision.selectionEvaluation?: SelectionEvaluation`; `HoldoutValidation` gains `trainBaselineMetrics?`, `holdoutBaselineMetrics?: BacktestMetricBlock`, `holdoutDecision?: RevisionDecision`, `holdoutReasons?: string[]`, `policy?: RevisionEvaluatorPolicy`.

- [ ] **Step 1: Write the failing test** — a type-shape assertion via a constructed value

Append to `src/domain/strategy-revision.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { SelectionEvaluation, HoldoutValidation, StrategyRevision } from './strategy-revision.ts';
import { DEFAULT_REVISION_EVALUATOR_POLICY } from '../validation/revision-evaluator.ts';

const metrics = { netPnlUsd: 1000, maxDrawdownPct: 10, totalTrades: 50, topTradeContributionPct: 20, sharpeRatio: 1, winRatePct: 55, profitFactor: 2 } as never;

describe('R5a domain types', () => {
  it('SelectionEvaluation carries baseline+candidate+policy+verdict', () => {
    const se: SelectionEvaluation = {
      evaluatorVersion: 'revision-combo-v1', baselineMetrics: metrics, candidateMetrics: metrics,
      thresholds: DEFAULT_REVISION_EVALUATOR_POLICY, decision: 'REJECT', reasons: ['drawdown_regression'],
    };
    expect(se.decision).toBe('REJECT');
  });

  it('HoldoutValidation accepts the new holdout-baseline + verdict fields', () => {
    const hv: HoldoutValidation = {
      mode: 'trade_based', reason: 'holdout_failed', trainMetrics: {}, holdoutMetrics: {},
      trainBaselineMetrics: metrics, holdoutBaselineMetrics: metrics,
      holdoutDecision: 'REJECT', holdoutReasons: ['no_improvement_over_accepted'], policy: DEFAULT_REVISION_EVALUATOR_POLICY,
    };
    expect(hv.holdoutDecision).toBe('REJECT');
  });

  it('StrategyRevision carries optional selectionEvaluation', () => {
    const r = { selectionEvaluation: undefined } as Partial<StrategyRevision>;
    expect('selectionEvaluation' in r).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/domain/strategy-revision.test.ts`
Expected: FAIL — `SelectionEvaluation` not exported / new `HoldoutValidation` fields rejected by tsc.

- [ ] **Step 3: Add the types**

In `src/domain/strategy-revision.ts`, add imports near the top:
```ts
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { RevisionDecision, RevisionEvaluatorPolicy } from '../validation/revision-evaluator.ts';
```

Add the `SelectionEvaluation` type (near `HoldoutValidation`):
```ts
/** Persisted decision-inputs of the revision's selection-window evaluation (R5a). */
export interface SelectionEvaluation {
  evaluatorVersion: string;
  baselineMetrics: BacktestMetricBlock;
  candidateMetrics: BacktestMetricBlock;
  thresholds: RevisionEvaluatorPolicy;
  decision: RevisionDecision;
  reasons: string[];
}
```

Extend `HoldoutValidation` (append optional fields to the existing interface):
```ts
export interface HoldoutValidation {
  mode: 'none' | 'trade_based';
  t?: string;
  reason: HoldoutValidationReason;
  lowConfidence?: boolean;
  trainMetrics?: Record<string, unknown>;
  holdoutMetrics?: Record<string, unknown>;
  // R5a: full baseline↔candidate comparison + verdict on both windows (explainable ROBUSTNESS)
  trainBaselineMetrics?: BacktestMetricBlock;
  holdoutBaselineMetrics?: BacktestMetricBlock;
  holdoutDecision?: RevisionDecision;
  holdoutReasons?: string[];
  policy?: RevisionEvaluatorPolicy;
}
```

Add to `StrategyRevision` (after `holdoutValidation?`):
```ts
  selectionEvaluation?: SelectionEvaluation;
```

- [ ] **Step 4: Run test + typecheck**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/domain/strategy-revision.test.ts && pnpm typecheck`
Expected: PASS; no type errors (confirm no import cycle — `revision-evaluator.ts` imports only from `ports/`, not from `domain/strategy-revision.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/domain/strategy-revision.ts src/domain/strategy-revision.test.ts
git commit -m "feat(r5a): SelectionEvaluation type + extended HoldoutValidation"
```

---

## Task 3: Persistence — migration + schema + drizzle + in-memory + port

**Files:**
- Create: `migrations/0024_r5a_selection_evaluation.sql`
- Modify: `src/db/schema.ts` (`strategyRevision`, near `holdout_validation` at :376)
- Modify: `src/adapters/repository/drizzle-strategy-revision.repository.ts` (create-map, `strategyRevisionToDomain`, updateStatus patch)
- Modify: `src/adapters/repository/in-memory-strategy-revision.repository.ts`
- Modify: `src/ports/strategy-revision.repository.ts` (`updateStatus` `Pick<>` at :14)
- Test: `src/adapters/repository/drizzle-strategy-revision.repository.test.ts`, `src/adapters/repository/in-memory-strategy-revision.repository.test.ts`

**Interfaces:**
- Consumes: `SelectionEvaluation`, extended `HoldoutValidation` (Task 2).
- Produces: `selectionEvaluation` round-trips through both repos; `updateStatus` accepts `selectionEvaluation` in its patch.

- [ ] **Step 1: Write the failing tests**

Append to `src/adapters/repository/drizzle-strategy-revision.repository.test.ts`:

```ts
describe('strategyRevisionToDomain (selectionEvaluation mapping)', () => {
  it('maps a NULL selection_evaluation column to undefined', () => {
    const domain = strategyRevisionToDomain(baseRow());
    expect(domain.selectionEvaluation).toBeUndefined();
  });
  it('round-trips a present selectionEvaluation', () => {
    const se = { evaluatorVersion: 'revision-combo-v1', baselineMetrics: {} as never, candidateMetrics: {} as never,
      thresholds: { evaluatorVersion: 'revision-combo-v1', minTrades: 20, minNetPnlImprovementUsd: 0, maxDrawdownRegressionPct: 2, topTradeContributionPct: 50 },
      decision: 'REJECT' as const, reasons: ['drawdown_regression'] };
    const domain = strategyRevisionToDomain({ ...baseRow(), selectionEvaluation: se });
    expect(domain.selectionEvaluation).toEqual(se);
  });
});
```
Add `selectionEvaluation: null` to the `baseRow()` factory in that test file.

Append to `src/adapters/repository/in-memory-strategy-revision.repository.test.ts` a round-trip: create a revision, `updateStatus(id, { selectionEvaluation: se, ... })`, `findById`, assert `selectionEvaluation` and the new `holdoutValidation` fields survive (whitelist-drop guard).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/adapters/repository/drizzle-strategy-revision.repository.test.ts src/adapters/repository/in-memory-strategy-revision.repository.test.ts`
Expected: FAIL — `selectionEvaluation` column/field unknown.

- [ ] **Step 3: Migration**

Create `migrations/0024_r5a_selection_evaluation.sql`:
```sql
ALTER TABLE "strategy_revision" ADD COLUMN "selection_evaluation" jsonb;
```

- [ ] **Step 4: Schema column**

In `src/db/schema.ts`, in the `strategyRevision` table (after the `holdoutValidation` line :376), add:
```ts
  selectionEvaluation: jsonb('selection_evaluation').$type<SelectionEvaluation>(),
```
Import `SelectionEvaluation` from `../domain/strategy-revision.ts` in schema.ts (follow how `HoldoutValidation` is imported there).

- [ ] **Step 5: Drizzle repo**

In `src/adapters/repository/drizzle-strategy-revision.repository.ts`:
- `strategyRevisionToDomain`: add `selectionEvaluation: row.selectionEvaluation ?? undefined,` (mirror the `holdoutValidation` mapping).
- `create`: map `selectionEvaluation: revision.selectionEvaluation ?? null,` into the insert values (mirror `holdoutValidation`).
- `updateStatus`: include `selectionEvaluation` in the column set it writes when present in the patch (mirror how `holdoutValidation` is written in the patch).

- [ ] **Step 6: Port patch type**

In `src/ports/strategy-revision.repository.ts` at the `updateStatus` `Partial<Pick<StrategyRevision, ...>>`, add `'selectionEvaluation'` to the union (alongside `'holdoutValidation'`).

- [ ] **Step 7: In-memory repo**

In `src/adapters/repository/in-memory-strategy-revision.repository.ts`, ensure `create` and `updateStatus` carry `selectionEvaluation` (if the repo builds a whitelisted object per field, add `selectionEvaluation`; the round-trip test from Step 1 is the guard against a silent drop). `holdoutValidation`'s new nested fields ride for free (stored as the whole object).

- [ ] **Step 8: Run tests + typecheck**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/adapters/repository/drizzle-strategy-revision.repository.test.ts src/adapters/repository/in-memory-strategy-revision.repository.test.ts && pnpm typecheck`
Expected: PASS; no type errors.

- [ ] **Step 9: Commit**

```bash
git add migrations/0024_r5a_selection_evaluation.sql src/db/schema.ts src/adapters/repository/drizzle-strategy-revision.repository.ts src/adapters/repository/in-memory-strategy-revision.repository.ts src/ports/strategy-revision.repository.ts src/adapters/repository/drizzle-strategy-revision.repository.test.ts src/adapters/repository/in-memory-strategy-revision.repository.test.ts
git commit -m "feat(r5a): persist selectionEvaluation (migration 0024) + round-trip both repos"
```

---

## Task 4: `revision-build` writes the decision-inputs at terminals

**Files:**
- Modify: `src/orchestrator/handlers/revision-build.handler.ts`
- Test: `src/orchestrator/handlers/revision-flow.integration.test.ts`

**Interfaces:**
- Consumes: `SelectionEvaluation` (Task 2), `DEFAULT_REVISION_EVALUATOR_POLICY` (Task 1, already imported in Task 1 Step 4). Repo `updateStatus` accepts `selectionEvaluation` (Task 3).
- Produces: accepted/rejected revisions carry `selectionEvaluation` when a comparison happened; `holdoutValidation` carries `trainBaselineMetrics`/`holdoutBaselineMetrics`/`holdoutDecision`/`holdoutReasons`/`policy`.

**Context — where each terminal is (post-R3a line refs, locate by content):** the greedy loop's train verdict is finalized right after the preservation-gate block (inside `if (result.status === 'completed' && result.metrics)`). Terminal `updateStatus` sites: accepted (`status: 'accepted'`), holdout-failed reject (`verdictReason: 'holdout_failed'`), combo reject (`verdictReason: allRejectReasons.join(', ')`). `comparison_baseline_unavailable` (`verdictReason: 'comparison_baseline_unavailable'`) — comparison did NOT happen, so it must NOT write `selectionEvaluation`.

- [ ] **Step 1: Write the failing tests**

Add to `src/orchestrator/handlers/revision-flow.integration.test.ts` (model on the existing accepting/rejecting fixtures + `makeFakeExecutor`/`makeRejectExecutor`/`makeHoldoutExecutor`):

```ts
it('accepted revision persists selectionEvaluation with decision ACCEPT', async () => {
  // ...seed an accepting cycle (existing helper)...
  const v = (await services.revisions.listByProfile('p1')).find((r) => r.status === 'accepted')!;
  expect(v.selectionEvaluation).toBeDefined();
  expect(v.selectionEvaluation!.decision).toBe('ACCEPT');
  expect(v.selectionEvaluation!.thresholds.maxDrawdownRegressionPct).toBe(2.0);
});

it('rejected revision with a real comparison persists selectionEvaluation with decision REJECT', async () => {
  // ...seed a cycle whose combo evaluation REJECTS on a completed candidate run
  //    (makeRejectExecutor: comparison_baseline present, candidate present, verdict REJECT drawdown_regression)...
  const v = (await services.revisions.listByProfile('p1')).at(-1)!;
  expect(v.status).toBe('rejected');
  expect(v.selectionEvaluation).toBeDefined();               // comparison happened
  expect(v.selectionEvaluation!.decision).toBe('REJECT');
});

it('holdout-failed rejection persists holdout verdict on holdoutValidation', async () => {
  // ...makeHoldoutExecutor({ holdoutPasses: false }) → train ACCEPT, holdout REJECT...
  const v = (await services.revisions.listByProfile('p1')).at(-1)!;
  expect(v.status).toBe('rejected');
  expect(v.selectionEvaluation!.decision).toBe('ACCEPT');    // train accepted
  expect(v.holdoutValidation!.holdoutDecision).toBe('REJECT');
  expect(v.holdoutValidation!.holdoutBaselineMetrics).toBeDefined();
});

it('comparison_baseline_unavailable leaves selectionEvaluation undefined', async () => {
  // ...executor whose comparison_baseline run is unavailable → verdictReason comparison_baseline_unavailable...
  const v = (await services.revisions.listByProfile('p1')).at(-1)!;
  expect(v.status).toBe('rejected');
  expect(v.verdictReason).toBe('comparison_baseline_unavailable');
  expect(v.selectionEvaluation).toBeUndefined();             // no comparison → no snapshot
});
```

> Adapt seeding to the file's actual executor fixtures. If a fixture for the `comparison_baseline_unavailable` path doesn't exist, add a minimal executor returning a non-`completed` `comparison_baseline` run (mirror the existing `makeVetoExecutor`/`makeRejectExecutor` shape).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/revision-flow.integration.test.ts`
Expected: FAIL — `selectionEvaluation`/new holdout fields undefined.

- [ ] **Step 3: Capture the selection-window snapshot after each real verdict**

In `revision-build.handler.ts`, declare before the greedy loop (near `let firedPreservation`):
```ts
  let selectionEvaluation: import('../../domain/strategy-revision.ts').SelectionEvaluation | undefined;
```
Inside `if (result.status === 'completed' && result.metrics) { ... }`, AFTER the preservation-gate block finalizes `verdict` (i.e. as the last statement of that `if`), add:
```ts
      selectionEvaluation = {
        evaluatorVersion: DEFAULT_REVISION_EVALUATOR_POLICY.evaluatorVersion,
        baselineMetrics: selectionBaselineMetrics,
        candidateMetrics: result.metrics,
        thresholds: DEFAULT_REVISION_EVALUATOR_POLICY,
        decision: verdict.decision,
        reasons: verdict.reasons,
      };
```
(This captures the LAST real comparison; on the `else` branch — `candidate_run_unavailable` — it is not set, so no snapshot for a comparison that didn't happen.)

- [ ] **Step 4: Extend the holdout-validation writes**

In the holdout block, both `holdoutValidation = { ... }` assignments (the `holdout_failed` and the `holdout_passed` branches) gain:
```ts
        trainBaselineMetrics: selectionBaselineMetrics,
        holdoutBaselineMetrics: hBaseM,
        holdoutDecision: holdoutVerdict.decision,
        holdoutReasons: holdoutVerdict.reasons,
        policy: DEFAULT_REVISION_EVALUATOR_POLICY,
```
(`hBaseM` is the holdout baseline metrics already computed; `holdoutVerdict` is the local verdict.)

- [ ] **Step 5: Write `selectionEvaluation` into the terminal `updateStatus` calls**

Add `selectionEvaluation,` to the `updateStatus(revisionId, { ... })` patch at these terminals: the accepted branch (`status: 'accepted'`), the holdout-failed branch (`verdictReason: 'holdout_failed'`), and the combo-reject branch (`verdictReason: allRejectReasons.join(', ')`). Do NOT add it to the `comparison_baseline_unavailable` branch (`selectionEvaluation` is `undefined` there anyway — leave that patch untouched).

- [ ] **Step 6: Run tests + full suite + typecheck**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/revision-flow.integration.test.ts && pnpm typecheck`
Expected: PASS. Then the full suite:
Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run`
Expected: 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/handlers/revision-build.handler.ts src/orchestrator/handlers/revision-flow.integration.test.ts
git commit -m "feat(r5a): revision-build persists selectionEvaluation + holdout verdict at terminals"
```

---

## Self-Review

**1. Spec coverage (§4):** §4.1 versioned policy → Task 1; §4.2 selectionEvaluation (accepted+rejected, comparison-gated) → Tasks 2+4; §4.3 holdout extension → Tasks 2+4; §4.4 persistence (migration/schema/drizzle/in-memory/round-trip) → Task 3. Уточнение 1 (rejected uses a real comparison; comparison_baseline_unavailable = absent) → Task 4 Step 1 tests. ✅

**2. Placeholder scan:** every code step shows code; the two adapt-notes (existing test call-site updates in Task 1; executor fixtures in Task 4) are concrete conditional instructions, not placeholders. ✅

**3. Type consistency:** `RevisionEvaluatorPolicy`/`RevisionDecision`/`evaluateRevision(input, policy)` consistent Task 1↔2↔4; `SelectionEvaluation` fields identical Task 2 (def) ↔ Task 3 (persist) ↔ Task 4 (write); `HoldoutValidation` new fields identical Task 2 ↔ Task 4; migration `selection_evaluation` ↔ schema `jsonb('selection_evaluation')` ↔ domain `selectionEvaluation`. ✅

**Flagged risk for implementer/reviewer:** Task 1 changes `evaluateRevision`'s arity — the two revision-build call-sites are updated in the same task (Step 4) to keep typecheck green; a reviewer should confirm no third call-site exists (`rg -n "evaluateRevision(" src/` — only revision-build + tests today). Task 4's terminal edits must land `selectionEvaluation` at exactly the three comparison-happened terminals and NOT at `comparison_baseline_unavailable` — the four Step-1 tests pin this.
