# R5b — Cycle Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit one deterministic, versioned, LLM-free cycle-scorecard artifact at every Cycle-2 close — authoritative from ledger rows, idempotent, produced even without a champion — so the outcome of a research cycle (counts, champion, robustness, selection-bias, verdict) is explainable from persisted data.

**Architecture:** A `finalizeCycle` terminal helper in `revision-build` enqueues a `cycle.scorecard` task (via `createAndEnqueueTask`, fail-soft) at every domain-terminal outcome. Its handler gathers an authoritative correlation-scoped snapshot, runs a pure `buildCycleScorecard`, and idempotently upserts into a new `cycle_scorecard` table. Consumes the R5a persistence (`selectionEvaluation` + extended `holdoutValidation`), already in main.

**Tech Stack:** TypeScript (`node --experimental-strip-types`), Drizzle/Postgres, Vitest, Hono (read-API), pnpm.

**Spec:** `docs/superpowers/specs/2026-07-13-r5-cycle-scorecard-design.md` §0/§5–§9 (commit `4daf850`, R5b part reconciled with merged R5a types + P1-1).

**Scope:** ONLY R5b. R5a (persistence decision-inputs) is already in main (`acae7fe`).

## Global Constraints

- **Runtime:** `node --experimental-strip-types`. NO TypeScript parameter properties.
- **Deterministic / LLM-free:** `buildCycleScorecard` is pure — no I/O, no clock, no LLM. `deltas` are derived from baseline/candidate metrics. `generatedAt` is a row metadata column, NOT inside the deterministic payload.
- **Authoritative rows, not events:** counts come from ledger rows (hypothesis.build tasks, evaluations, revision row); events are provenance only.
- **Additive / back-compat:** new table, new optional task type; no migration data-loss.
- **Idempotent, exactly-once logical:** `cycle_scorecard` has `UNIQUE(correlationId, schemaVersion)`; `dedupeKey = cycle.scorecard:${CYCLE_SCORECARD_SCHEMA_VERSION}:${correlationId}` (schemaVersion IN the key). `CYCLE_SCORECARD_SCHEMA_VERSION = 'cycle-scorecard-v1'`.
- **finalizeCycle is FAIL-SOFT** from revision-build: an enqueue failure emits `cycle.scorecard_enqueue_failed` and does NOT throw (must never re-play the revision's domain decision). It enqueues via `createAndEnqueueTask` so an orphaned `queued` row is reconciled by the P1-1 boot sweeper (already in main). `cycle.scorecard` is NOT added to `CYCLE_CHAIN_TYPES`.
- **finalizeCycle fires only on domain-terminal outcomes** (accepted / rejected / skipped / abandoned) — NOT on deferred/self-requeue (`:wait${n}` re-enqueue).
- **Handler failure:** gather/upsert failure THROWS → worker BullMQ `attempts:3`. There is NO generic dead-letter hook → the spec does not promise a `cycle.scorecard.failed` event; `cycle.scorecard.built` is at-least-once (document it).
- **R5a consumer contracts (spec §8):** `revisionAssessment.aggregate = null` when `revision.selectionEvaluation` is absent — this includes a rejected row whose FINAL greedy attempt had no comparison, AND `kind:'consolidated'` rows. `tradeSplit` (preservationGate, sticky-last) and `aggregate` (selectionEvaluation, final attempt) may describe different attempts — do NOT couple them.
- Use `pnpm typecheck`. Run vitest via `node --experimental-strip-types node_modules/vitest/vitest.mjs run <file>`. TDD, frequent commits.

## File Structure

- **Create** `src/domain/cycle-scorecard.ts` — `CycleScorecard` type + `CYCLE_SCORECARD_SCHEMA_VERSION`.
- **Create** `src/research/cycle-scorecard-builder.ts` — pure `buildCycleScorecard(snapshot)`.
- **Create** `src/ports/cycle-scorecard.repository.ts` — `CycleScorecardRepository { upsert, findByCorrelation }`.
- **Create** `src/adapters/repository/{drizzle,in-memory}-cycle-scorecard.repository.ts`.
- **Modify** `src/db/schema.ts` — `cycleScorecard` table → `pnpm db:generate` (next number, 0026+).
- **Create** `src/orchestrator/finalize-cycle.ts` — `finalizeCycle` terminal helper.
- **Create** `src/orchestrator/handlers/cycle-scorecard.handler.ts` — `WorkflowHandler`.
- **Create** `src/read-api/routes/cycle-scorecard.ts` — `GET /cycles/:correlationId/scorecard`.
- **Modify** `src/domain/schemas.ts` (`AGENT_TASK_TYPES` += `'cycle.scorecard'`), `src/orchestrator/handlers/revision-build.handler.ts` (capture eligible/considered + call finalizeCycle at terminals), `src/composition.ts` (repo + `router.register`), the read-API app wiring.

---

## Task 1: `CycleScorecard` domain type + schema version

**Files:**
- Create: `src/domain/cycle-scorecard.ts`
- Test: `src/domain/cycle-scorecard.test.ts`

**Interfaces:**
- Consumes (from R5a in main, `src/domain/strategy-revision.ts`): `SelectionEvaluation`, `HoldoutValidation`; `PreservationMetadata` (`src/validation/trade-preservation.ts`); `RevisionDecision`/`RevisionEvaluatorPolicy` (`src/validation/revision-evaluator.ts`); `BacktestMetricBlock` (`src/ports/platform-gateway.port.ts`); `EvaluationDecision` (`src/validation/evaluator.ts`).
- Produces: `CycleScorecard`, `CYCLE_SCORECARD_SCHEMA_VERSION`, sub-types `TerminalKind`, `ScorecardCounts`, `RevisionAssessment`, `ScorecardAggregate`, `RosterEntry`.

- [ ] **Step 1: Write the failing test** (RED gate = `pnpm typecheck`; type imports erase under strip-types)

Create `src/domain/cycle-scorecard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { CycleScorecard } from './cycle-scorecard.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from './cycle-scorecard.ts';

describe('CycleScorecard type', () => {
  it('schema version constant is cycle-scorecard-v1', () => {
    expect(CYCLE_SCORECARD_SCHEMA_VERSION).toBe('cycle-scorecard-v1');
  });

  it('constructs a full accepted-champion payload', () => {
    const sc: CycleScorecard = {
      schemaVersion: 'cycle-scorecard-v1',
      correlationId: 'c1', strategyProfileId: 'p1',
      terminalOutcome: { kind: 'accepted', reason: 'pnl_improved' },
      counts: { built: 3, evaluated: 3, eligible: 2, considered: 2, selected: 1, dropped: 1 },
      provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'r1', sourceTaskId: 't1' },
      revisionAssessment: {
        revisionId: 'r1', version: 2, status: 'accepted',
        aggregate: null, tradeSplit: null, robustness: null,
      },
      champion: { revisionId: 'r1', version: 2 },
      selectionBias: { n: 2, considered: 2, selected: 1 },
      roster: [{ hypId: 'h1', lastDecision: 'PASS', terminalStatus: 'merged', considered: true }],
      verdict: { decision: 'accepted', reason: 'pnl_improved' },
    };
    expect(sc.champion?.version).toBe(2);
  });

  it('allows null revisionAssessment/champion + null counts for a before-selection skipped cycle', () => {
    // null sets belong to before-selection terminals (no_baseline / abandoned), NOT no_eligible_hypotheses
    // (which is a KNOWN 0 → empty sets). See §3 / Task 4 terminal table.
    const sc: CycleScorecard = {
      schemaVersion: 'cycle-scorecard-v1', correlationId: 'c1', strategyProfileId: 'p1',
      terminalOutcome: { kind: 'skipped', reason: 'no_baseline' },
      counts: { built: 0, evaluated: 0, eligible: null, considered: null, selected: 0, dropped: 0 },
      eligibleUnavailableReason: 'terminated_before_selection',
      consideredUnavailableReason: 'terminated_before_selection',
      provenance: { mergeAttempted: false, candidateIncluded: 0 },
      revisionAssessment: null, champion: null,
      selectionBias: { n: null, considered: null, selected: 0 },
      roster: [], verdict: { decision: 'skipped', reason: 'no_baseline' },
    };
    expect(sc.revisionAssessment).toBeNull();
  });
});
```

- [ ] **Step 2: Run typecheck to verify RED**

Run: `pnpm typecheck`
Expected: FAIL — `./cycle-scorecard.ts` missing.

- [ ] **Step 3: Write the type**

Create `src/domain/cycle-scorecard.ts`:

```ts
// src/domain/cycle-scorecard.ts
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { RevisionDecision, RevisionEvaluatorPolicy } from '../validation/revision-evaluator.ts';
import type { SelectionEvaluation, HoldoutValidation } from './strategy-revision.ts';
import type { PreservationMetadata } from '../validation/trade-preservation.ts';
import type { EvaluationDecision } from '../validation/evaluator.ts';

export const CYCLE_SCORECARD_SCHEMA_VERSION = 'cycle-scorecard-v1';

export type TerminalKind = 'accepted' | 'rejected' | 'skipped' | 'abandoned';

export interface ScorecardCounts {
  built: number;
  evaluated: number;
  eligible: number | null;
  considered: number | null;
  selected: number;
  dropped: number;
}

/** §AGGREGATE — baseline-relative ladder from the revision's SelectionEvaluation; deltas derived by the builder. */
export interface ScorecardAggregate {
  evaluatorVersion: string;
  baselineMetrics: BacktestMetricBlock;
  candidateMetrics: BacktestMetricBlock;
  deltas: { netPnlUsd: number; maxDrawdownPct: number; totalTrades: number };
  thresholds: RevisionEvaluatorPolicy;
  decision: RevisionDecision;
  reasons: string[];
}

export interface RevisionAssessment {
  revisionId: string;
  version: number;
  status: 'accepted' | 'rejected';
  aggregate: ScorecardAggregate | null;      // null when selectionEvaluation absent (final attempt no comparison / consolidated)
  tradeSplit: PreservationMetadata | null;    // R2 (may reflect a different attempt than aggregate — do not couple)
  robustness: HoldoutValidation | null;       // R3a train/holdout + verdict
}

export interface RosterEntry {
  hypId: string;
  lastDecision: EvaluationDecision | null;
  terminalStatus: string;                     // hypothesis.status at scorecard time
  considered: boolean;
}

export interface CycleScorecard {
  schemaVersion: typeof CYCLE_SCORECARD_SCHEMA_VERSION;
  correlationId: string;
  strategyProfileId: string;
  terminalOutcome: { kind: TerminalKind; reason: string };
  counts: ScorecardCounts;
  eligibleUnavailableReason?: string;
  consideredUnavailableReason?: string;
  provenance: { mergeAttempted: boolean; candidateIncluded: number; revisionId?: string; sourceTaskId?: string };
  revisionAssessment: RevisionAssessment | null;
  champion: { revisionId: string; version: number } | null;
  selectionBias: { n: number | null; considered: number | null; selected: number };
  roster: RosterEntry[];
  verdict: { decision: string; reason: string };
}
```

> Verify the exact export names of `PreservationMetadata` (`src/validation/trade-preservation.ts`) and `EvaluationDecision` (`src/validation/evaluator.ts`) with `grep -n "export.*PreservationMetadata\|export.*EvaluationDecision"` before writing — use the real names.

- [ ] **Step 4: Typecheck GREEN + vitest smoke**

Run: `pnpm typecheck && node --experimental-strip-types node_modules/vitest/vitest.mjs run src/domain/cycle-scorecard.test.ts`
Expected: typecheck exit 0; 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/cycle-scorecard.ts src/domain/cycle-scorecard.test.ts
git commit -m "feat(r5b): CycleScorecard domain type + schema version"
```

---

## Task 2: Pure `buildCycleScorecard(snapshot)`

**Files:**
- Create: `src/research/cycle-scorecard-builder.ts`
- Test: `src/research/cycle-scorecard-builder.test.ts`

**Interfaces:**
- Consumes: `CycleScorecard` + sub-types (Task 1); `StrategyRevision` (`src/domain/strategy-revision.ts`); `HypothesisProposal` (`src/domain/hypothesis.ts`); `Evaluation` (`src/domain/evaluation.ts`).
- Produces: `CycleScorecardSnapshot` (the pure input shape) + `buildCycleScorecard(snapshot: CycleScorecardSnapshot): CycleScorecard`.

**Snapshot shape** (assembled by the handler in Task 5; the builder is pure over it):
```ts
export interface CycleScorecardSnapshot {
  correlationId: string;
  strategyProfileId: string;
  sourceTaskId: string;
  terminalOutcome: { kind: TerminalKind; reason: string };
  eligibleHypIds: string[] | null;     // null when the cycle terminated before selection
  consideredHypIds: string[] | null;
  revision: StrategyRevision | null;   // present when revisionId was set
  hypotheses: Array<{                   // one per cycleHypothesisId (validated working set)
    hypId: string;
    status: string;
    lastDecision: EvaluationDecision | null;   // last completed evaluation's decision, correlation-scoped
    evaluated: boolean;
  }>;
}
```

- [ ] **Step 1: Write the failing tests** (branch-by-branch, non-vacuous)

Create `src/research/cycle-scorecard-builder.test.ts`. Cover: accepted-champion (deltas computed from baseline/candidate); rejected (champion=null, revisionAssessment carries data, selected=0); rejected with `selectionEvaluation` absent → `aggregate=null`; `kind:'consolidated'` revision → `aggregate=null`; skipped (revision=null → revisionAssessment=null, eligible/considered null+reason); abandoned; dropped union-dedup (a hypId both `dropped_*` status and in `revision.dropped` counts once); eligible/considered from the passed sets vs null+reason.

```ts
import { describe, it, expect } from 'vitest';
import { buildCycleScorecard, type CycleScorecardSnapshot } from './cycle-scorecard-builder.ts';
import { DEFAULT_REVISION_EVALUATOR_POLICY } from '../validation/revision-evaluator.ts';

import type { StrategyRevision, HoldoutValidation } from '../domain/strategy-revision.ts';

const M = (o: Record<string, number> = {}) => ({
  netPnlUsd: 1000, netPnlPct: 10, totalTrades: 50, winRate: 0.55, profitFactor: 2,
  maxDrawdownPct: 10, expectancyUsd: 20, sharpe: 1, topTradeContributionPct: 20, ...o,
});

// Full StrategyRevision factory — NO `as never`; tsc checks the shape.
const rev = (over: Partial<StrategyRevision>): StrategyRevision => ({
  id: 'r1', strategyProfileId: 'p1', version: 2, hypothesisIds: [], dropped: [],
  mergedRuleSet: { order: [], rules: [] }, status: 'rejected', createdAt: 'now', updatedAt: 'now', ...over,
});

function baseSnapshot(over: Partial<CycleScorecardSnapshot> = {}): CycleScorecardSnapshot {
  return {
    correlationId: 'c1', strategyProfileId: 'p1', sourceTaskId: 't1',
    terminalOutcome: { kind: 'accepted', reason: 'pnl_improved' },
    eligibleHypIds: ['h1', 'h2'], consideredHypIds: ['h1', 'h2'],
    revision: null,
    hypotheses: [
      { hypId: 'h1', status: 'merged', lastDecision: 'PASS', evaluated: true },
      { hypId: 'h2', status: 'proxy_passed', lastDecision: 'PASS', evaluated: true },
    ],
    ...over,
  };
}

describe('buildCycleScorecard', () => {
  it('accepted champion: deltas computed, champion set, selected=1', () => {
    const revision = rev({
      status: 'accepted', hypothesisIds: ['h1'], verdictReason: 'pnl_improved',
      selectionEvaluation: {
        evaluatorVersion: 'revision-combo-v1', baselineMetrics: M({ netPnlUsd: 800 }), candidateMetrics: M({ netPnlUsd: 1000 }),
        thresholds: DEFAULT_REVISION_EVALUATOR_POLICY, decision: 'ACCEPT', reasons: ['pnl_improved'],
      },
    });
    const sc = buildCycleScorecard(baseSnapshot({ revision }));
    expect(sc.champion).toEqual({ revisionId: 'r1', version: 2 });
    expect(sc.counts.selected).toBe(1);
    expect(sc.revisionAssessment!.aggregate!.deltas.netPnlUsd).toBe(200); // 1000 - 800
    expect(sc.counts.eligible).toBe(2);
  });

  it('rejected: champion null, revisionAssessment carries aggregate, selected=0', () => {
    const revision = rev({
      status: 'rejected', hypothesisIds: ['h1'], verdictReason: 'drawdown_regression',
      selectionEvaluation: { evaluatorVersion: 'revision-combo-v1', baselineMetrics: M(), candidateMetrics: M({ maxDrawdownPct: 20 }),
        thresholds: DEFAULT_REVISION_EVALUATOR_POLICY, decision: 'REJECT', reasons: ['drawdown_regression'] },
    });
    const sc = buildCycleScorecard(baseSnapshot({ terminalOutcome: { kind: 'rejected', reason: 'drawdown_regression' }, revision }));
    expect(sc.champion).toBeNull();
    expect(sc.counts.selected).toBe(0);
    expect(sc.revisionAssessment!.aggregate!.decision).toBe('REJECT');
  });

  it('rejected with no selectionEvaluation → aggregate null (final attempt no comparison / consolidated)', () => {
    const revision = rev({ status: 'rejected', hypothesisIds: ['h1'], verdictReason: 'comparison_baseline_unavailable', selectionEvaluation: undefined });
    const sc = buildCycleScorecard(baseSnapshot({ terminalOutcome: { kind: 'rejected', reason: 'comparison_baseline_unavailable' }, revision }));
    expect(sc.revisionAssessment!.aggregate).toBeNull();
    expect(sc.champion).toBeNull();
  });

  it('abandoned/no_baseline (sets null) → eligible/considered null + reason', () => {
    const sc = buildCycleScorecard(baseSnapshot({
      terminalOutcome: { kind: 'abandoned', reason: 'wait_cap_exhausted' },
      eligibleHypIds: null, consideredHypIds: null, revision: null,
    }));
    expect(sc.revisionAssessment).toBeNull();
    expect(sc.counts.eligible).toBeNull();
    expect(sc.eligibleUnavailableReason).toBe('terminated_before_selection');
    expect(sc.selectionBias.n).toBeNull();
  });

  it('no_eligible_hypotheses (empty sets, NOT null) → eligible=0, no unavailable reason', () => {
    const sc = buildCycleScorecard(baseSnapshot({
      terminalOutcome: { kind: 'skipped', reason: 'no_eligible_hypotheses' },
      eligibleHypIds: [], consideredHypIds: [], revision: null,
    }));
    expect(sc.counts.eligible).toBe(0);            // selection ran, found nothing — a KNOWN 0
    expect(sc.eligibleUnavailableReason).toBeUndefined();
    expect(sc.selectionBias.n).toBe(0);
  });

  it('dropped is a union by hypId (status dropped_* ∪ revision.dropped, no double count)', () => {
    const revision = rev({ status: 'rejected', hypothesisIds: [], dropped: [{ hypothesisId: 'h1', reason: 'combo_fail_dropped' }], verdictReason: 'x', selectionEvaluation: undefined });
    const sc = buildCycleScorecard(baseSnapshot({
      terminalOutcome: { kind: 'rejected', reason: 'x' }, revision,
      hypotheses: [{ hypId: 'h1', status: 'dropped_combo_fail', lastDecision: 'FAIL', evaluated: true }],
    }));
    expect(sc.counts.dropped).toBe(1); // h1 in both sources → counted once
  });

  it('accepted CONSOLIDATED revision (no selectionEvaluation) → champion set, aggregate null', () => {
    // G3b path uses evaluateConsolidation, not evaluateRevision → kind:'consolidated' rows have no selectionEvaluation.
    const revision = rev({ status: 'accepted', kind: 'consolidated', hypothesisIds: ['h1'], verdictReason: 'consolidated', selectionEvaluation: undefined });
    const sc = buildCycleScorecard(baseSnapshot({ revision }));
    expect(sc.champion).toEqual({ revisionId: 'r1', version: 2 });   // still a champion
    expect(sc.revisionAssessment!.aggregate).toBeNull();             // but no aggregate to show
  });

  it('rejected: tradeSplit (preservationGate) + robustness (holdoutValidation) carried onto revisionAssessment', () => {
    const holdout = { mode: 'trade_based', reason: 'holdout_failed', holdoutDecision: 'REJECT', holdoutReasons: ['drawdown_regression'] } as HoldoutValidation;
    const preservation = { fired: true } as never; // adapt to the real PreservationMetadata shape (src/validation/trade-preservation.ts)
    const revision = rev({ status: 'rejected', hypothesisIds: ['h1'], verdictReason: 'holdout_failed', preservationGate: preservation, holdoutValidation: holdout, selectionEvaluation: undefined });
    const sc = buildCycleScorecard(baseSnapshot({ terminalOutcome: { kind: 'rejected', reason: 'holdout_failed' }, revision }));
    expect(sc.revisionAssessment!.tradeSplit).toBe(preservation);    // R2 veto visible even on a rejected row
    expect(sc.revisionAssessment!.robustness).toBe(holdout);         // R3a holdout verdict visible
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/research/cycle-scorecard-builder.test.ts`
Expected: FAIL — `./cycle-scorecard-builder.ts` missing.

- [ ] **Step 3: Write the builder**

Create `src/research/cycle-scorecard-builder.ts`:

```ts
// src/research/cycle-scorecard-builder.ts
import type { StrategyRevision } from '../domain/strategy-revision.ts';
import type { EvaluationDecision } from '../validation/evaluator.ts';
import {
  CYCLE_SCORECARD_SCHEMA_VERSION,
  type CycleScorecard, type TerminalKind, type RevisionAssessment, type ScorecardAggregate,
} from '../domain/cycle-scorecard.ts';

const DROPPED_STATUSES = new Set(['dropped_merge_conflict', 'dropped_combo_fail', 'dropped_unsupported_shape']);

export interface CycleScorecardSnapshot {
  correlationId: string;
  strategyProfileId: string;
  sourceTaskId: string;
  terminalOutcome: { kind: TerminalKind; reason: string };
  eligibleHypIds: string[] | null;
  consideredHypIds: string[] | null;
  revision: StrategyRevision | null;
  hypotheses: Array<{ hypId: string; status: string; lastDecision: EvaluationDecision | null; evaluated: boolean }>;
}

function buildAggregate(rev: StrategyRevision): ScorecardAggregate | null {
  const se = rev.selectionEvaluation;
  if (!se) return null; // final attempt had no comparison, or kind:'consolidated'
  return {
    evaluatorVersion: se.evaluatorVersion,
    baselineMetrics: se.baselineMetrics,
    candidateMetrics: se.candidateMetrics,
    deltas: {
      netPnlUsd: se.candidateMetrics.netPnlUsd - se.baselineMetrics.netPnlUsd,
      maxDrawdownPct: se.candidateMetrics.maxDrawdownPct - se.baselineMetrics.maxDrawdownPct,
      totalTrades: se.candidateMetrics.totalTrades - se.baselineMetrics.totalTrades,
    },
    thresholds: se.thresholds,
    decision: se.decision,
    reasons: se.reasons,
  };
}

export function buildCycleScorecard(s: CycleScorecardSnapshot): CycleScorecard {
  const rev = s.revision;
  const accepted = rev?.status === 'accepted';

  const built = s.hypotheses.length;
  const evaluated = s.hypotheses.filter((h) => h.evaluated).length;
  const eligible = s.eligibleHypIds === null ? null : s.eligibleHypIds.length;
  const considered = s.consideredHypIds === null ? null : s.consideredHypIds.length;
  const selected = accepted && rev ? new Set(rev.hypothesisIds).size : 0;

  const droppedIds = new Set<string>();
  for (const h of s.hypotheses) if (DROPPED_STATUSES.has(h.status)) droppedIds.add(h.hypId);
  for (const d of rev?.dropped ?? []) droppedIds.add(d.hypothesisId);
  const dropped = droppedIds.size;

  const candidateIncluded = rev ? new Set(rev.hypothesisIds).size : 0;
  const mergeAttempted = rev !== null && s.terminalOutcome.kind !== 'skipped';

  const consideredSet = new Set(s.consideredHypIds ?? []);
  const revisionAssessment: RevisionAssessment | null = rev
    ? {
        revisionId: rev.id, version: rev.version,
        status: accepted ? 'accepted' : 'rejected',
        aggregate: buildAggregate(rev),
        tradeSplit: rev.preservationGate ?? null,
        robustness: rev.holdoutValidation ?? null,
      }
    : null;

  return {
    schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
    correlationId: s.correlationId,
    strategyProfileId: s.strategyProfileId,
    terminalOutcome: s.terminalOutcome,
    counts: { built, evaluated, eligible, considered, selected, dropped },
    ...(eligible === null ? { eligibleUnavailableReason: 'terminated_before_selection' } : {}),
    ...(considered === null ? { consideredUnavailableReason: 'terminated_before_selection' } : {}),
    provenance: {
      mergeAttempted, candidateIncluded,
      ...(rev ? { revisionId: rev.id } : {}),
      sourceTaskId: s.sourceTaskId,
    },
    revisionAssessment,
    champion: accepted && rev ? { revisionId: rev.id, version: rev.version } : null,
    selectionBias: { n: eligible, considered, selected },
    roster: s.hypotheses.map((h) => ({
      hypId: h.hypId, lastDecision: h.lastDecision, terminalStatus: h.status, considered: consideredSet.has(h.hypId),
    })),
    verdict: { decision: s.terminalOutcome.kind, reason: s.terminalOutcome.reason },
  };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/research/cycle-scorecard-builder.test.ts && pnpm typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/research/cycle-scorecard-builder.ts src/research/cycle-scorecard-builder.test.ts
git commit -m "feat(r5b): pure buildCycleScorecard (deterministic, aggregate/robustness/counts)"
```

---

## Task 3: Persistence — `cycle_scorecard` table + repo

**Files:**
- Create: `src/ports/cycle-scorecard.repository.ts`, `src/adapters/repository/drizzle-cycle-scorecard.repository.ts`, `src/adapters/repository/in-memory-cycle-scorecard.repository.ts`
- Modify: `src/db/schema.ts` (new `cycleScorecard` table) → `pnpm db:generate`
- Test: `src/adapters/repository/drizzle-cycle-scorecard.repository.test.ts`, `src/adapters/repository/in-memory-cycle-scorecard.repository.test.ts`

**Interfaces:**
- Consumes: `CycleScorecard` (Task 1).
- Produces: `interface CycleScorecardRow { id, correlationId, strategyProfileId, schemaVersion, payload: CycleScorecard, generatedAt, createdAt, updatedAt }`; `CycleScorecardRepository { upsert(row): Promise<void>; findByCorrelationAndSchema(correlationId, schemaVersion): Promise<CycleScorecardRow | null>; findByCorrelation(correlationId): Promise<CycleScorecardRow[]> }`. Upsert is idempotent on `UNIQUE(correlationId, schemaVersion)`; the read-API uses `findByCorrelationAndSchema` (deterministic single row).

- [ ] **Step 1: Write the failing tests**

`in-memory` round-trip: `upsert` then `findByCorrelation` returns the row; a second `upsert` with the same `(correlationId, schemaVersion)` replaces (1 row, latest payload). `drizzle` mapper unit test (row→domain). **Gated Postgres integration** (mirror `drizzle-strategy-revision.repository.test.ts` gated block: `const url = process.env.DATABASE_URL; (url ? describe : describe.skip)(...)` with `createDbClient(url)`): upsert twice with identical `(correlationId, schemaVersion)` → `findByCorrelation` returns exactly ONE row with the second payload (idempotency proven against a real UNIQUE constraint).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/adapters/repository/in-memory-cycle-scorecard.repository.test.ts src/adapters/repository/drizzle-cycle-scorecard.repository.test.ts`
Expected: FAIL — repo/port missing.

- [ ] **Step 3: Port**

Create `src/ports/cycle-scorecard.repository.ts`:
```ts
import type { CycleScorecard } from '../domain/cycle-scorecard.ts';

export interface CycleScorecardRow {
  id: string;
  correlationId: string;
  strategyProfileId: string;
  schemaVersion: string;
  payload: CycleScorecard;
  generatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CycleScorecardRepository {
  /** Idempotent upsert on UNIQUE(correlationId, schemaVersion). */
  upsert(row: CycleScorecardRow): Promise<void>;
  /** Deterministic single-row lookup for the read-API — the (correlationId, schemaVersion) unique key. */
  findByCorrelationAndSchema(correlationId: string, schemaVersion: string): Promise<CycleScorecardRow | null>;
  /** All schema versions for a correlation (round-trip / diagnostics). */
  findByCorrelation(correlationId: string): Promise<CycleScorecardRow[]>;
}
```

- [ ] **Step 4: Schema table FIRST, then generate the migration**

In `src/db/schema.ts`, add a `cycleScorecard` pgTable (follow an existing table's idiom, e.g. `strategyRevision`):
```ts
export const cycleScorecard = pgTable('cycle_scorecard', {
  id: uuid('id').primaryKey().defaultRandom(),
  correlationId: text('correlation_id').notNull(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  schemaVersion: text('schema_version').notNull(),
  payload: jsonb('payload').$type<CycleScorecard>().notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uxCorrSchema: unique('ux_cycle_scorecard_corr_schema').on(t.correlationId, t.schemaVersion) }));
```
Import `CycleScorecard` + the drizzle helpers (`pgTable, text, jsonb, uuid, timestamp, unique`) as the file already does. Match the existing column-type conventions in `schema.ts` (confirm whether the repo stores timestamps as `timestamp` or `text` — mirror the `strategy_revision` table's `createdAt`/`updatedAt` exactly).

Run: `pnpm db:generate`
Expected: a new `migrations/0026_*.sql` (or next free index) + `migrations/meta/*_snapshot.json` + `_journal.json`, containing `CREATE TABLE "cycle_scorecard"` + the unique index. Open the .sql, confirm it only ADDS the table (no drift). Commit all generated files.

- [ ] **Step 5: Drizzle + in-memory repos**

`drizzle-cycle-scorecard.repository.ts`: `upsert` = `insert(...).onConflictDoUpdate({ target: [cycleScorecard.correlationId, cycleScorecard.schemaVersion], set: { payload, strategyProfileId, generatedAt, updatedAt } })`; `findByCorrelationAndSchema` = `select().where(and(eq(correlationId), eq(schemaVersion))).limit(1)` → row or null; `findByCorrelation` = `select().where(eq(correlationId))`; a `cycleScorecardToDomain(row)` mapper. `in-memory-cycle-scorecard.repository.ts`: a Map keyed by `${correlationId}::${schemaVersion}` for idempotency; `findByCorrelationAndSchema` = direct map lookup; `findByCorrelation` filters by correlationId. The in-memory idempotency test asserts a second `upsert` with the same key replaces (one entry), and `findByCorrelationAndSchema` returns the latest payload.

- [ ] **Step 6: Run non-gated tests + typecheck**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/adapters/repository/in-memory-cycle-scorecard.repository.test.ts src/adapters/repository/drizzle-cycle-scorecard.repository.test.ts && pnpm typecheck`
Expected: in-memory + drizzle-mapper pass; gated pg test skipped (no `DATABASE_URL`); typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add migrations/0026_*.sql migrations/meta/*_snapshot.json migrations/meta/_journal.json src/db/schema.ts src/ports/cycle-scorecard.repository.ts src/adapters/repository/drizzle-cycle-scorecard.repository.ts src/adapters/repository/in-memory-cycle-scorecard.repository.ts src/adapters/repository/in-memory-cycle-scorecard.repository.test.ts src/adapters/repository/drizzle-cycle-scorecard.repository.test.ts
git commit -m "feat(r5b): cycle_scorecard table + idempotent-upsert repo (drizzle + in-memory)"
```

> **Execution guard (controller):** the gated Postgres integration test MUST be run for real (not left skipped) — start `pgvector/pgvector:pg16` on a free port, `DATABASE_URL=… pnpm db:migrate`, then run the drizzle test with `DATABASE_URL` set and confirm the idempotency case is GREEN (mirrors the R5a Task 3 procedure).

---

## Task 4: `finalizeCycle` terminal helper + revision-build integration

**Files:**
- Create: `src/orchestrator/finalize-cycle.ts`
- Modify: `src/domain/schemas.ts` (`AGENT_TASK_TYPES` += `'cycle.scorecard'`), `src/orchestrator/handlers/revision-build.handler.ts`
- Test: `src/orchestrator/finalize-cycle.test.ts`, additions to `src/orchestrator/handlers/revision-flow.integration.test.ts`

**Interfaces:**
- Consumes: `createAndEnqueueTask` (`src/orchestrator/task-intake.ts` — `{ input: { taskType, source, correlationId, dedupeKey, payload }, deps: { repo, queue, now? } }`), `CYCLE_SCORECARD_SCHEMA_VERSION`.
- Produces: `finalizeCycle(args): Promise<void>` where `args = { outcome: FinalizeCycleOutcome; deps: { researchTasks; taskQueue; events } }`, and `FinalizeCycleOutcome = { correlationId; strategyProfileId; sourceTaskId; terminalOutcome: { kind: TerminalKind; reason: string }; revisionId?: string; eligibleHypIds?: string[]; consideredHypIds?: string[] }`. Enqueues a `cycle.scorecard` task carrying the outcome as payload.

- [ ] **Step 1: Write the failing tests**

`finalize-cycle.test.ts` (fakes: `InMemoryQueueAdapter`, in-memory research-task repo, in-memory events):
- (a) enqueues a `cycle.scorecard` task with `dedupeKey === 'cycle.scorecard:cycle-scorecard-v1:c1'` and the outcome as payload.
- (b) enqueue THROWS → emits `cycle.scorecard_enqueue_failed` and resolves (does NOT throw).
- (c) **enqueue THROWS *and* `events.append` THROWS → finalizeCycle still RESOLVES** (fully fail-soft, block 1). Use a queue whose `enqueue` rejects + an events fake whose `append` rejects; `await expect(finalizeCycle(...)).resolves.toBeUndefined()`.

**Terminal coverage (block 3) — enumerate ALL 11 domain-terminals of `revision-build` + the deferred non-terminal.** `revision-build.handler.ts` has exactly these terminal `return`s (verified): abandoned `:176`; skipped `no_baseline` `:199` (before `:219`); skipped `no_eligible_hypotheses` `:221`, `nothing_composable` `:275`, two more `revision.skipped` `:283`/`:305` (after `:219`); rejected `eval_window_inconsistent` `:341`, `comparison_baseline_unavailable` `:374` (after `:219`); rejected `holdout_failed` `:570`; accepted `:590`; rejected combo `:646`. The `revision.build.deferred` self-requeue `:190` is NOT terminal. Add to `revision-flow.integration.test.ts` a **table-driven** test that, per terminal, seeds the cycle to hit that branch and asserts exactly ONE `cycle.scorecard` enqueue with the expected `terminalOutcome.kind`/`reason` AND the expected set-shape:

| Terminal | kind | eligibleHypIds / consideredHypIds |
|---|---|---|
| abandoned (`:176`) | abandoned | **null / null** (before selection) |
| no_baseline (`:199`) | skipped | **null / null** (before `:219`) |
| no_eligible_hypotheses (`:221`) | skipped | **`[]` / `[]`** (selection ran, empty — NOT null, block 2) |
| nothing_composable (`:275`) | skipped | known sets |
| skipped `:283` / `:305` | skipped | known sets |
| eval_window_inconsistent (`:341`) | rejected | known sets |
| comparison_baseline_unavailable (`:374`) | rejected | known sets |
| holdout_failed (`:570`) | rejected | known sets |
| accepted (`:590`) | accepted | known sets |
| combo rejected (`:646`) | rejected | known sets |
| **deferred (`:190`)** | — | **NO `cycle.scorecard` enqueued at all** |

Also assert `cycle.scorecard` is NOT in `CYCLE_CHAIN_TYPES` (`import { CYCLE_CHAIN_TYPES } from '../cycle-close.ts'; expect(CYCLE_CHAIN_TYPES).not.toContain('cycle.scorecard')`).

> **No escape hatch — every one of the 11 terminals + the deferred case MUST have an assertion.** The invariant is "exactly one scorecard per domain-terminal, none on deferred"; leaving any branch unpinned re-opens the coverage gap. Where a branch is already exercised by an EXISTING revision-flow terminal test, add the `cycle.scorecard`-enqueue assertion (kind/reason/set-shape) INTO that existing test rather than duplicating the seeding; where no existing test hits a branch, add a dedicated one. The `revision.build.deferred` `:190` case asserts NO `cycle.scorecard` was enqueued.

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/finalize-cycle.test.ts src/orchestrator/handlers/revision-flow.integration.test.ts`
Expected: FAIL — `finalize-cycle.ts` missing; no scorecard enqueue from revision-build.

- [ ] **Step 3: Add the task type**

In `src/domain/schemas.ts`, add `'cycle.scorecard'` to the `AGENT_TASK_TYPES` array (this makes it a valid `AgentTaskType`).

- [ ] **Step 4: Write `finalizeCycle`**

Create `src/orchestrator/finalize-cycle.ts`:
```ts
// src/orchestrator/finalize-cycle.ts
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import { createAndEnqueueTask } from './task-intake.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION, type TerminalKind } from '../domain/cycle-scorecard.ts';

export interface FinalizeCycleOutcome {
  correlationId: string;
  strategyProfileId: string;
  sourceTaskId: string;
  terminalOutcome: { kind: TerminalKind; reason: string };
  revisionId?: string;
  eligibleHypIds?: string[];
  consideredHypIds?: string[];
}

export interface FinalizeCycleDeps {
  researchTasks: ResearchTaskRepository;
  taskQueue: TaskQueuePort;
  events: AgentEventRepository;
  now?: () => number;
}

/** Single terminal-close hook (mirrors enqueueCycleClose): enqueues one cycle.scorecard task per
 *  domain-terminal outcome. FAIL-SOFT — any failure is observable but never thrown, so the revision's
 *  domain decision is never re-played. Recovery caveat: createAndEnqueueTask does repo.create THEN
 *  queue.enqueue — the P1-1 boot sweeper reconciles an orphaned row ONLY IF repo.create already
 *  persisted the `queued` row (i.e. enqueue failed after create). A repo.create failure leaves no row,
 *  so the scorecard is simply absent (acceptable: the cycle stays terminal, no domain impact). Do NOT
 *  call on the deferred/self-requeue path. */
export async function finalizeCycle(args: { outcome: FinalizeCycleOutcome; deps: FinalizeCycleDeps }): Promise<void> {
  const { outcome, deps } = args;
  const source = 'cron'; // internal system-triggered; adjust to the source convention used by enqueueCycleClose
  try {
    await createAndEnqueueTask(
      {
        taskType: 'cycle.scorecard',
        source,
        correlationId: outcome.correlationId,
        dedupeKey: `cycle.scorecard:${CYCLE_SCORECARD_SCHEMA_VERSION}:${outcome.correlationId}`,
        payload: outcome,
      },
      { repo: deps.researchTasks, queue: deps.taskQueue, now: deps.now },
    );
  } catch (err) {
    // FULLY fail-soft: the observability event is ALSO best-effort. If both enqueue AND event-append
    // throw, finalizeCycle must still resolve — otherwise the worker re-runs revision-build and
    // re-plays the already-committed domain decision.
    try {
      await deps.events.append({
        taskId: outcome.sourceTaskId, type: 'cycle.scorecard_enqueue_failed',
        payload: { correlationId: outcome.correlationId, error: err instanceof Error ? err.message : String(err) },
      } as never);
    } catch {
      // swallow — nothing left to do; the cycle stays terminal, scorecard simply absent until reconciled
    }
  }
}
```

> Confirm the exact `source` value used by `enqueueCycleClose` in `cycle-close.ts` and the exact `events.append(event(...))` shape used elsewhere in the handler (there's an `event(taskId, type, payload)` helper) — match them so the emitted event is well-formed.

- [ ] **Step 5: Capture eligible/considered + call finalizeCycle at terminals in revision-build**

In `revision-build.handler.ts`:
1. At the eligible computation (`:219`, `const eligible = sortEligible(proposals).slice(0, services.revisionBatchMax)`), split so both sets are captured:
```ts
    const sortedEligible = sortEligible(proposals);
    const eligibleHypIds = sortedEligible.map((p) => p.id);                       // = N (pre-cap)
    const eligible = sortedEligible.slice(0, services.revisionBatchMax);
    const consideredHypIds = eligible.map((p) => p.id);                            // post-cap
```
2. At EVERY domain-terminal outcome, call `finalizeCycle` with the right `terminalOutcome` and (when past `:219`) the two sets. The terminals (locate by content):
   - accepted (`status: 'accepted'`) → `{ kind: 'accepted', reason: verdict.reasons.join(', ') }`, `revisionId`, both sets.
   - rejected: holdout_failed / eval_window_inconsistent / comparison_baseline_unavailable / combo (`allRejectReasons.join`) → `{ kind: 'rejected', reason: <that verdictReason> }`, `revisionId`, both sets (all are past `:219`).
   - skipped: `no_baseline` (`:199`, BEFORE `:219`) → OMIT the sets (null — selection never started). `no_eligible_hypotheses` (`:221`) → pass `eligibleHypIds: []`, `consideredHypIds: []` — selection RAN and found nothing; empty is KNOWN, NOT null (block 2). `nothing_composable` (`:275`) + the other `revision.skipped` (`:283`/`:305`) are after `:219` → include the captured sets.
   - abandoned (`revision.build.abandoned`, `:176`) → `{ kind: 'abandoned', reason: 'wait_cap_exhausted' }`, NO sets (null — before selection). Do NOT call on the intermediate `revision.build.deferred` `:wait${n}` self-requeue (`:190`).
   `sourceTaskId = task.id`; `strategyProfileId`, `correlationId` from scope.
   **Semantics of the sets:** `null`/omitted ⇒ scorecard `eligible`/`considered = null` + `terminated_before_selection` (only abandoned + no_baseline). `[]` ⇒ `eligible`/`considered = 0` (no_eligible_hypotheses). Non-empty ⇒ the count.

> This is the subtle task. To avoid a missed terminal, add a `finalizeCalled` guard or centralize the terminal returns through one helper if the handler shape allows; the Step-1 tests (accepted + skipped + not-in-CYCLE_CHAIN_TYPES) plus a per-terminal assertion pin coverage. If any terminal's `strategyProfileId`/`correlationId` is not in scope at that point, STOP and report — do not guess.

- [ ] **Step 6: Run tests + typecheck**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/finalize-cycle.test.ts src/orchestrator/handlers/revision-flow.integration.test.ts && pnpm typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/finalize-cycle.ts src/orchestrator/finalize-cycle.test.ts src/domain/schemas.ts src/orchestrator/handlers/revision-build.handler.ts src/orchestrator/handlers/revision-flow.integration.test.ts
git commit -m "feat(r5b): finalizeCycle terminal helper + revision-build enqueues cycle.scorecard"
```

---

## Task 5: `cycle.scorecard` handler + router registration + read-API

**Files:**
- Create: `src/orchestrator/handlers/cycle-scorecard.handler.ts`, `src/read-api/routes/cycle-scorecard.ts`
- Modify: `src/composition.ts` (repo + `router.register('cycle.scorecard', ...)`), the read-API app wiring
- Test: `src/orchestrator/handlers/cycle-scorecard.handler.test.ts`, `src/read-api/routes/cycle-scorecard.test.ts`

**Interfaces:**
- Consumes: `buildCycleScorecard` + `CycleScorecardSnapshot` (Task 2), `CycleScorecardRepository` (Task 3), `FinalizeCycleOutcome` (Task 4, the task payload). Repos already on services: `researchTasks` (`listByCorrelationAndTypes`), `hypotheses` (`findById`), `backtests` (`listByHypothesis`), `evaluations` (`listByBacktestRun`), `revisions` (`findById`), `events`.
- Produces: `cycleScorecardHandler: WorkflowHandler`; `services.cycleScorecards` (new); read-API `GET /cycles/:correlationId/scorecard`.

- [ ] **Step 1: Write the failing tests**

`cycle-scorecard.handler.test.ts`: given a seeded cycle (hypothesis.build tasks under a correlation + evaluations + a revision), dispatching a `cycle.scorecard` task builds and upserts a scorecard whose `counts.built` = number of build tasks, `champion` reflects the accepted revision, and `roster[].lastDecision` = the last completed evaluation's decision **scoped to that correlation** (seed a second evaluation on a run of a DIFFERENT correlation and assert it is ignored). Dispatching the SAME task twice → still ONE row (upsert idempotency). A gather failure (e.g. a throwing `hypotheses.findById`) → the handler THROWS (routes to worker retry), does not swallow.

`cycle-scorecard.test.ts` (read-API): build the app through the REAL `createReadApp(deps)` (with auth) — NOT an isolated `registerCycleScorecardRoutes` — so the test pins the actual route registration + `V1_PATHS` wiring. After a scorecard is persisted (in-memory repo in deps): an authorized `GET /cycles/:correlationId/scorecard` returns it (200 + payload); unknown correlationId → 404; a write method (`POST` on that path) → 405 method-not-allowed (proves the path is in `V1_PATHS`); unauthenticated → the app's standard auth rejection. Mirror how `completion-summary.test.ts` builds the app + supplies auth.

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/cycle-scorecard.handler.test.ts src/read-api/routes/cycle-scorecard.test.ts`
Expected: FAIL — handler/route missing.

- [ ] **Step 3: Write the handler**

Create `src/orchestrator/handlers/cycle-scorecard.handler.ts` — a `WorkflowHandler` that:
1. Parses the task payload as `FinalizeCycleOutcome` (validate with a zod schema mirroring the shape).
2. Gathers the snapshot (§5.2, authoritative):
   - `cycleHypothesisIds` = unique `payload.hypothesisId` of `researchTasks.listByCorrelationAndTypes(correlationId, ['hypothesis.build'])`.
   - Per hypId: `hypotheses.findById` (status); `backtests.listByHypothesis(hypId)` → filter `run.correlationId === correlationId` → per run `evaluations.listByBacktestRun` → the LAST completed evaluation = deterministic max by `(createdAt, id)`; `lastDecision` = its decision, `evaluated` = whether ≥1 exists.
   - `revision` = `revisions.findById(payload.revisionId)` when `revisionId` present, else null. **If `revisionId` is present but the revision is NOT found, OR its `strategyProfileId !== payload.strategyProfileId` → THROW** (a stale/mismatched pointer must route to worker retry, not silently produce a partial snapshot with `revision=null`).
   - `eligibleHypIds`/`consideredHypIds` from the payload (may be undefined → pass `null`; an empty `[]` stays `[]`, distinct from `null`).
3. `buildCycleScorecard(snapshot)`; `cycleScorecards.upsert({ id: randomUUID(), correlationId, strategyProfileId, schemaVersion, payload, generatedAt: new Date().toISOString(), createdAt: …, updatedAt: … })`.
4. `events.append(event(task.id, 'cycle.scorecard.built', { correlationId }))` — document at-least-once (a retry after a successful upsert but failed append repeats the event).
5. A gather/upsert error propagates (throw) → worker BullMQ retry.

- [ ] **Step 4: Register + wire**

- `src/orchestrator/app-services.ts`: add `cycleScorecards: CycleScorecardRepository` to the `AppServices` interface (this is the services/`HandlerDeps` type the handler reads).
- `src/composition.ts`: `const cycleScorecards = new DrizzleCycleScorecardRepository(db);` → add to the assembled services object; `router.register('cycle.scorecard', cycleScorecardHandler)` next to the other registrations (`:482+`).
- **Read-API wiring — three explicit edits** (mirror `completion-summary`):
  - `src/read-api/deps.ts`: add `cycleScorecards: CycleScorecardRepository` to the read-API deps interface.
  - `src/read-api/read-app.ts`: `import { registerCycleScorecardRoutes } from './routes/cycle-scorecard.ts';`, call it in the app builder next to `registerCompletionSummaryRoutes(...)`, and add `'/cycles/:correlationId/scorecard'` to the `V1_PATHS` array (`:15`) so the method-not-allowed guard (`:50`) covers it.
  - Ensure `composition.ts` (or wherever read-API deps are assembled) passes `cycleScorecards` into the read-API deps.

- [ ] **Step 5: Write the read-API route**

Create `src/read-api/routes/cycle-scorecard.ts` mirroring `completion-summary.ts`. **Deterministic — query the exact `(correlationId, CYCLE_SCORECARD_SCHEMA_VERSION)` unique key** (block 4), not `findByCorrelation()[0]` (unordered):
```ts
import { CYCLE_SCORECARD_SCHEMA_VERSION } from '../../domain/cycle-scorecard.ts';

export function registerCycleScorecardRoutes(app, deps) {
  app.get('/cycles/:correlationId/scorecard', async (c) => {
    const row = await deps.cycleScorecards.findByCorrelationAndSchema(
      c.req.param('correlationId'), CYCLE_SCORECARD_SCHEMA_VERSION,
    );
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(row.payload);
  });
}
```
(Match the actual Hono handler signature + deps-injection idiom used by the sibling routes.)

- [ ] **Step 6: Run tests + full suite + typecheck**

Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run src/orchestrator/handlers/cycle-scorecard.handler.test.ts src/read-api/routes/cycle-scorecard.test.ts && pnpm typecheck`
Expected: PASS; typecheck 0. Then the full suite:
Run: `node --experimental-strip-types node_modules/vitest/vitest.mjs run`
Expected: 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/handlers/cycle-scorecard.handler.ts src/orchestrator/handlers/cycle-scorecard.handler.test.ts \
        src/read-api/routes/cycle-scorecard.ts src/read-api/routes/cycle-scorecard.test.ts \
        src/orchestrator/app-services.ts src/read-api/deps.ts src/read-api/read-app.ts src/composition.ts
git commit -m "feat(r5b): cycle.scorecard handler (authoritative snapshot + upsert) + read-API route"
```
(All four wiring files — `app-services.ts`, `deps.ts`, `read-app.ts`, `composition.ts` — MUST be in this commit; the `createReadApp` test fails without them.)

---

## Self-Review

**1. Spec coverage (§5–§7):** §5.4 payload → Task 1; pure builder + aggregate/deltas/counts/roster + R5a consumer contracts (aggregate=null) → Task 2; §5.6 table + idempotent upsert + gated pg → Task 3; §5.1/§5.3/§5.5 finalizeCycle (single terminal helper, 4 terminals not deferred, fail-soft via createAndEnqueueTask, dedupeKey with schemaVersion, not in CYCLE_CHAIN_TYPES) + eligible/considered capture → Task 4; §5.2 authoritative correlation-scoped snapshot (evaluation scope + (createdAt,id) tiebreak) + handler throw + read-API → Task 5. §8 at-least-once documented (Task 5 Step 3). ✅

**2. Placeholder scan:** every code step shows code; the verify-the-real-name notes (PreservationMetadata/EvaluationDecision export names; enqueueCycleClose source; Hono signature; schema timestamp convention) are concrete `grep`-first instructions, not placeholders. ✅

**3. Type consistency:** `CycleScorecard`/`CycleScorecardSnapshot`/`FinalizeCycleOutcome` shapes are consistent Task 1↔2↔4↔5; `eligibleHypIds`/`consideredHypIds` semantics (pre-cap = N / post-cap = considered) consistent Task 4 (capture) ↔ Task 2 (counts) ↔ spec §3; `dedupeKey` format identical Task 4 (finalizeCycle) ↔ spec §6; `CYCLE_SCORECARD_SCHEMA_VERSION` single source (Task 1). ✅

**Review-fix checklist (folded in):**
- **finalizeCycle fully fail-soft (block 1):** the `cycle.scorecard_enqueue_failed` `events.append` is itself wrapped in a nested `try/catch` — enqueue-throws AND append-throws → finalizeCycle still resolves (never re-plays the revision decision). Task 4 Step 1 test (c) pins this.
- **no_eligible ≠ null (block 2):** `null`/omitted sets ONLY for `abandoned` + `no_baseline` (before selection); `no_eligible_hypotheses` passes `[]` → `eligible=0` (a known zero). Task 2 has both cases; Task 4's terminal table encodes the set-shape per terminal.
- **Terminal coverage (block 3):** Task 4 Step 1 enumerates all 11 domain-terminals + the deferred `:190` no-enqueue case as a table. **This is the primary between-task review focus.**
- **Read-API deterministic (block 4):** route queries `findByCorrelationAndSchema(correlationId, CYCLE_SCORECARD_SCHEMA_VERSION)`, not `findByCorrelation()[0]`.
- Handler throws on a present-but-missing / wrong-profile `revisionId` (Task 5 Step 3); read-API wiring names `deps.ts`/`read-app.ts`/`V1_PATHS` explicitly (Task 5 Step 4); builder tests use a full `StrategyRevision` factory, no `as never` (Task 2).

**Flagged risks for implementer/reviewer:**
- **Task 4 terminal coverage** is the main risk: `finalizeCycle` must fire at every one of the 11 domain-terminal `return`s and NOT on the `revision.build.deferred` `:190` self-requeue — a missed terminal = a silently absent scorecard. The reviewer should enumerate the handler's terminal returns against the finalizeCycle call-sites one by one.
- **Migration number** is 0026+ (0025 already taken on main) — `pnpm db:generate` picks it; do not hardcode.
- **Gated pg test** (Task 3) must be run for real by the controller (pgvector Postgres), not left skipped — the idempotency guarantee is the point.
- Do NOT commit `.gortex/sidecar.sqlite-{shm,wal}` (now gitignored) or any daemon-volatile file.
