# Outcome Embargo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable policy preventing held-out / qualification outcome data (metrics, verdicts, window boundaries) from entering LLM generation context — including via retry, requeue, persistence reload, event payloads, RAG, or summary projections.

**Architecture:** One pure policy module (`src/research/outcome-embargo.ts`) enforced at three runtime seams — WFO prompt egress (incl. removing the `periodTo`=T field from two WFO port inputs), retry-feedback construction+consumption, and adapter-level scrub inside the Mastra WFO prompt builders — plus test-only guards for the channels already closed by shape (digest projection, RAG document, similar-hypothesis summary, event payloads). Verified by a three-layer sentinel harness (orchestration port-input capture / real-adapter prompt capture / dedicated WFO integration).

**Tech Stack:** TypeScript (node `--experimental-strip-types`), Vitest, zod, existing in-memory fakes (`test/support/make-services.ts`, WFO fakes with `.calls` arrays).

**Spec:** `docs/superpowers/specs/2026-07-17-outcome-embargo-design.md` (approved). Read §3 (embargo set), §4 (invariants I-E1…I-E5), §6 (seams S1–S5) before starting.

## Global Constraints

- **Always-on, no config flag** (I-E3). Never add an env var for the embargo.
- **Never modify the canonical `RunResultSummary`**, persistence writes, deterministic evaluators, scorecards, or read-API outputs (I-E4, spec §6.1/§6.3). Scrub happens ONLY on generation-lane egress.
- New agent event type `outcome_embargo.scrubbed`, payload exactly `{ site, removedKeys }` — **key names/paths only, never values**. Do NOT add it to `PAYLOAD_ALLOWLIST` in `src/read-api/mappers.ts`.
- Embargoed key tokens: `holdout | heldout | oos | promotion | qualification` + segment sequence `out_of_sample` (token-wise, NOT substring — `choose` must not match).
- `SAFE_RETRY_REASONS` = evaluator codes (`insufficient_sample`, `no_improvement_over_baseline`, `drawdown_regression`, `fragile_pnl`, `strong_robust_edge`, `positive_edge`) ∪ preservation-veto codes (`end_of_data_position`, `abstention_gaming`, `winner_degradation`).
- **No TS parameter properties** (`constructor(private x)`) — broken under `--experimental-strip-types`; assign fields explicitly. Use `import type` for type-only imports. `.ts` extensions in relative imports.
- Code/comments/commits in English. Validation command: `pnpm check` (= `tsc -p tsconfig.json` + `vitest run`). For a single file: `pnpm vitest run <path>`.
- Branch: `feat/outcome-embargo` (already exists, spec committed).

---

### Task 1: Embargo key matcher + recursive scrub

**Files:**
- Create: `src/research/outcome-embargo.ts`
- Create: `src/research/outcome-embargo.test.ts`

**Interfaces:**
- Produces: `isEmbargoedMetricKey(key: string): boolean`; `scrubMetricsBag<T>(bag: T): { scrubbed: T; removedKeys: string[] }`. Later tasks import both from `../research/outcome-embargo.ts` (adapters) / `./outcome-embargo.ts` (research).

- [ ] **Step 1: Write the failing test**

```ts
// src/research/outcome-embargo.test.ts
import { describe, it, expect } from 'vitest';
import { isEmbargoedMetricKey, scrubMetricsBag } from './outcome-embargo.ts';

describe('isEmbargoedMetricKey', () => {
  it.each([
    'holdoutSharpe', 'holdout_net_pnl', 'heldoutSharpe', 'heldout_win_rate',
    'oos', 'oosSharpe', 'OOS_SHARPE',
    'promotion', 'promotionVerdict', 'promotion_reason',
    'qualification', 'qualificationEpochKey', 'qualification_epoch',
    'outOfSampleSharpe', 'out_of_sample_sharpe', 'metricsOutOfSample',
  ])('embargoes %s', (key) => {
    expect(isEmbargoedMetricKey(key)).toBe(true);
  });

  it.each([
    'choose',        // 'oos' is a substring but NOT a segment
    'netPnlUsd', 'sharpe', 'maxDrawdownPct', 'totalTrades', 'winRate', 'profitFactor',
    'sampleSize',    // 'sample' alone is not embargoed
    'outOf', 'ofSample', // incomplete out_of_sample sequence
  ])('allows %s', (key) => {
    expect(isEmbargoedMetricKey(key)).toBe(false);
  });
});

describe('scrubMetricsBag', () => {
  it('removes embargoed keys at the top level and reports their paths', () => {
    const { scrubbed, removedKeys } = scrubMetricsBag({
      netPnlUsd: 100, sharpe: 1.2, holdoutSharpe: 9.99, promotionVerdict: 1,
    });
    expect(scrubbed).toEqual({ netPnlUsd: 100, sharpe: 1.2 });
    expect(removedKeys.sort()).toEqual(['holdoutSharpe', 'promotionVerdict']);
  });

  it('recurses into nested objects and arrays (comparison / topN shapes)', () => {
    const topN = [
      { paramsHash: 'a', point: { x: 1 }, metrics: { sharpe: 2, holdout_net_pnl: 5 } },
      { paramsHash: 'b', point: { x: 2 }, metrics: { sharpe: 1, qualification: { epoch: 'e1' } } },
    ];
    const { scrubbed, removedKeys } = scrubMetricsBag(topN);
    expect(scrubbed).toEqual([
      { paramsHash: 'a', point: { x: 1 }, metrics: { sharpe: 2 } },
      { paramsHash: 'b', point: { x: 2 }, metrics: { sharpe: 1 } },
    ]);
    expect(removedKeys.sort()).toEqual(['[0].metrics.holdout_net_pnl', '[1].metrics.qualification']);
  });

  it('drops an embargoed subtree wholesale (a future promotion object)', () => {
    const { scrubbed, removedKeys } = scrubMetricsBag({
      metrics: { sharpe: 1 },
      promotion: { verdict: 'passed', evaluationWindow: { from: 'x', to: 'y' } },
    });
    expect(scrubbed).toEqual({ metrics: { sharpe: 1 } });
    expect(removedKeys).toEqual(['promotion']);
  });

  it('passes primitives and null through untouched', () => {
    expect(scrubMetricsBag(42).scrubbed).toBe(42);
    expect(scrubMetricsBag('s').scrubbed).toBe('s');
    expect(scrubMetricsBag(null).scrubbed).toBe(null);
    expect(scrubMetricsBag(42).removedKeys).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/research/outcome-embargo.test.ts`
Expected: FAIL — `Cannot find module './outcome-embargo.ts'` (or equivalent resolution error).

- [ ] **Step 3: Write the implementation**

```ts
// src/research/outcome-embargo.ts
/**
 * Outcome Embargo (E4b lab obligation) — durable policy: held-out / qualification
 * outcome data must never enter LLM generation context.
 * Spec: docs/superpowers/specs/2026-07-17-outcome-embargo-design.md
 *
 * Always on — no config flag (I-E3). Applies to the GENERATION lane only:
 * deterministic evaluators, persistence, scorecards, and the read-API keep
 * full access to holdout data and are never scrubbed.
 */

const EMBARGOED_TOKENS = new Set(['holdout', 'heldout', 'oos', 'promotion', 'qualification']);
/** Multi-segment sequence embargoed even though its individual tokens are not. */
const EMBARGOED_SEQUENCE = ['out', 'of', 'sample'] as const;

/** Lowercase segments split on snake_case / kebab-case / dot / camelCase boundaries. */
function segmentsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter((s) => s.length > 0);
}

export function isEmbargoedMetricKey(key: string): boolean {
  const segs = segmentsOf(key);
  if (segs.some((s) => EMBARGOED_TOKENS.has(s))) return true;
  for (let i = 0; i + EMBARGOED_SEQUENCE.length <= segs.length; i += 1) {
    if (EMBARGOED_SEQUENCE.every((tok, j) => segs[i + j] === tok)) return true;
  }
  return false;
}

export interface ScrubResult<T> {
  scrubbed: T;
  /** Dot/index-joined paths of removed keys — names only, NEVER values (spec §6.1). */
  removedKeys: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scrubValue(value: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => scrubValue(item, `${path}[${i}]`, removed));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (isEmbargoedMetricKey(k)) {
        removed.push(p);
        continue;
      }
      out[k] = scrubValue(v, p, removed);
    }
    return out;
  }
  return value;
}

/**
 * Recursively remove embargoed keys from a metric bag / nested structure
 * (comparison blocks, ranked topN, future SDK fields). Returns a scrubbed
 * deep copy + removed key paths. Primitives pass through unchanged.
 */
export function scrubMetricsBag<T>(bag: T): ScrubResult<T> {
  const removedKeys: string[] = [];
  const scrubbed = scrubValue(bag, '', removedKeys) as T;
  return { scrubbed, removedKeys };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/research/outcome-embargo.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/research/outcome-embargo.ts src/research/outcome-embargo.test.ts
git commit -m "feat(embargo): outcome-embargo key matcher + recursive metric-bag scrub"
```

---

### Task 2: SAFE_RETRY_REASONS + sanitizeRetryFeedback

**Files:**
- Modify: `src/research/outcome-embargo.ts` (append)
- Modify: `src/research/outcome-embargo.test.ts` (append)

**Interfaces:**
- Produces: `SAFE_RETRY_REASONS: ReadonlySet<string>`; `sanitizeRetryFeedback(feedback: RetryFeedback): SanitizedRetryFeedback` where `RetryFeedback = { readonly hypothesisId: string; readonly decision: string; readonly reasons: readonly string[] }` and `SanitizedRetryFeedback = { feedback: { hypothesisId: string; decision: string; reasons: string[] }; removedKeys: string[] }` (removedKeys entries look like `reasons[2]` — index paths, never reason text).

- [ ] **Step 1: Append the failing tests**

```ts
// append to src/research/outcome-embargo.test.ts
import { SAFE_RETRY_REASONS, sanitizeRetryFeedback } from './outcome-embargo.ts';
// (merge into the existing import statement at the top of the file)

describe('sanitizeRetryFeedback', () => {
  it('keeps allowlisted evaluator and preservation-veto reasons verbatim', () => {
    const out = sanitizeRetryFeedback({
      hypothesisId: 'h1', decision: 'FAIL',
      reasons: ['no_improvement_over_baseline', 'abstention_gaming'],
    });
    expect(out.feedback).toEqual({
      hypothesisId: 'h1', decision: 'FAIL',
      reasons: ['no_improvement_over_baseline', 'abstention_gaming'],
    });
    expect(out.removedKeys).toEqual([]);
  });

  it('drops unknown reasons fail-closed and reports index paths, never values', () => {
    const out = sanitizeRetryFeedback({
      hypothesisId: 'h1', decision: 'MODIFY',
      reasons: ['drawdown_regression', 'holdout_failed: sharpe=1.23', 'heldout window 2023-04-01'],
    });
    expect(out.feedback.reasons).toEqual(['drawdown_regression']);
    expect(out.removedKeys).toEqual(['reasons[1]', 'reasons[2]']);
    // paths must not embed the dropped strings
    expect(JSON.stringify(out.removedKeys)).not.toContain('sharpe');
    expect(JSON.stringify(out.removedKeys)).not.toContain('2023-04-01');
  });

  it('covers the full allowlist', () => {
    for (const r of ['insufficient_sample', 'no_improvement_over_baseline', 'drawdown_regression',
      'fragile_pnl', 'strong_robust_edge', 'positive_edge',
      'end_of_data_position', 'abstention_gaming', 'winner_degradation']) {
      expect(SAFE_RETRY_REASONS.has(r)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/research/outcome-embargo.test.ts`
Expected: FAIL — `sanitizeRetryFeedback` is not exported.

- [ ] **Step 3: Append the implementation**

```ts
// append to src/research/outcome-embargo.ts

/** Proxy-lane evaluator codes — src/validation/evaluator.ts (deterministic ladder). */
const EVALUATOR_REASONS = [
  'insufficient_sample', 'no_improvement_over_baseline', 'drawdown_regression',
  'fragile_pnl', 'strong_robust_edge', 'positive_edge',
] as const;
/** Preservation-veto codes — src/validation/trade-preservation.ts (R2 gate). */
const PRESERVATION_REASONS = ['end_of_data_position', 'abstention_gaming', 'winner_degradation'] as const;

/** Fail-closed allowlist for retry-feedback reasons (I-E5). */
export const SAFE_RETRY_REASONS: ReadonlySet<string> = new Set([...EVALUATOR_REASONS, ...PRESERVATION_REASONS]);

export interface RetryFeedback {
  readonly hypothesisId: string;
  readonly decision: string;
  readonly reasons: readonly string[];
}

export interface SanitizedRetryFeedback {
  feedback: { hypothesisId: string; decision: string; reasons: string[] };
  /** Index paths of dropped reasons (e.g. 'reasons[2]') — never the dropped text. */
  removedKeys: string[];
}

/**
 * Allowlist filter over retry-feedback reasons. Unknown values are DROPPED —
 * free-text reasons may embed embargoed metric/window text. Touches ONLY the
 * feedback object; control-plane payload fields (evalPlatformRun, …) are out
 * of scope by design (I-E2).
 */
export function sanitizeRetryFeedback(feedback: RetryFeedback): SanitizedRetryFeedback {
  const reasons: string[] = [];
  const removedKeys: string[] = [];
  feedback.reasons.forEach((r, i) => {
    if (SAFE_RETRY_REASONS.has(r)) reasons.push(r);
    else removedKeys.push(`reasons[${i}]`);
  });
  return {
    feedback: { hypothesisId: feedback.hypothesisId, decision: feedback.decision, reasons },
    removedKeys,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/research/outcome-embargo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research/outcome-embargo.ts src/research/outcome-embargo.test.ts
git commit -m "feat(embargo): SAFE_RETRY_REASONS allowlist + sanitizeRetryFeedback (fail-closed)"
```

---

### Task 3: Remove `periodTo` (= T) from the WFO agent ports

The boundary date T is embargoed (spec §3.3) and today leaks verbatim into the sweep-designer and result-interpreter prompts. Remove the field entirely — neither agent needs a calendar date; `roundsSoFar` already provides date-unbound round context.

**Files:**
- Modify: `src/ports/wfo-agents.port.ts` (SweepInput at line ~16, InterpretInput at line ~25)
- Modify: `src/adapters/wfo/mastra-sweep-designer.ts` (buildPrompt)
- Modify: `src/adapters/wfo/mastra-result-interpreter.ts` (buildPrompt)
- Modify: `src/research/experiment-service.ts` (two call sites inside `runWalkForwardOptimization`, lines ~547 and ~590)
- Modify: `src/adapters/wfo/fake-agents.test.ts` (fixture props at lines ~77, ~95, ~120, ~125)

**Interfaces:**
- Produces: `SweepInput` WITHOUT `periodTo`; `InterpretInput` WITHOUT `periodTo`. All later tasks assume the field is gone (compile-level guarantee that no adapter can render T).

- [ ] **Step 1: Remove the fields from the port**

In `src/ports/wfo-agents.port.ts` delete the line `periodTo: string; // = T` from BOTH `SweepInput` and `InterpretInput`.

- [ ] **Step 2: Run typecheck to surface every reference**

Run: `pnpm typecheck`
Expected: FAIL with errors in exactly: `src/adapters/wfo/mastra-sweep-designer.ts`, `src/adapters/wfo/mastra-result-interpreter.ts`, `src/research/experiment-service.ts`, `src/adapters/wfo/fake-agents.test.ts`. (If any OTHER file errors on `periodTo`, fix it the same way and note it in the commit message.)

- [ ] **Step 3: Fix the adapters**

In `src/adapters/wfo/mastra-sweep-designer.ts` remove the prompt line:

```ts
    `Period end (T, no data beyond this): ${input.periodTo}`,
```

In `src/adapters/wfo/mastra-result-interpreter.ts` remove the prompt line:

```ts
    `Period end (T, no data beyond this — no-leakage boundary): ${input.periodTo}`,
```

- [ ] **Step 4: Fix the experiment-service call sites**

In `src/research/experiment-service.ts`, `runWalkForwardOptimization`:

```ts
      const sweep = await this.d.sweepDesigner.design({
        profile: input.profile, baselineTrainSummary: baselineMetrics, tunableParams,
        restrictToEntryParams, maxPoints: budget.maxPointsPerRound,
      }, input.agentOpts);
```

(was: `..., restrictToEntryParams, periodTo: T, maxPoints: ...`), and

```ts
      const interpretation = await this.d.resultInterpreter.interpret({
        topN: ranked, roundsSoFar: r, maxRounds: budget.maxRounds,
      }, input.agentOpts);
```

(was: `topN: ranked, periodTo: T, roundsSoFar: r, ...`). Keep every OTHER use of `T` (`encodeTrainPeriod(..., T, ...)`, `encodeHoldoutPeriod(T, ...)`, `boundary.t`) — the boundary stays fully available to deterministic orchestration (I-E2).

- [ ] **Step 5: Fix the fake-agents test fixtures**

In `src/adapters/wfo/fake-agents.test.ts` delete the `periodTo: '2026-06-15',` property from all four call sites (lines ~77, ~95, ~120, ~125).

- [ ] **Step 6: Typecheck + full test run**

Run: `pnpm typecheck && pnpm vitest run src/adapters/wfo src/research/experiment-service.wfo.test.ts`
Expected: PASS — behavior unchanged (the field was prompt-only).

- [ ] **Step 7: Commit**

```bash
git add src/ports/wfo-agents.port.ts src/adapters/wfo/mastra-sweep-designer.ts src/adapters/wfo/mastra-result-interpreter.ts src/research/experiment-service.ts src/adapters/wfo/fake-agents.test.ts
git commit -m "feat(embargo): remove periodTo (holdout boundary T) from WFO agent inputs (S1)"
```

---

### Task 4: S1 — scrub + `outcome_embargo.scrubbed` event in experiment-service

**Files:**
- Modify: `src/research/experiment-service.ts` (`runWalkForwardOptimization`)
- Test: `src/research/experiment-service.wfo.test.ts` (extend)

**Interfaces:**
- Consumes: `scrubMetricsBag` from `./outcome-embargo.ts` (Task 1).
- Produces: agent event `outcome_embargo.scrubbed` `{ site: string, removedKeys: string[] }`; scrub sites named `wfo.gate1.baselineMetrics`, `wfo.sweepDesigner.baselineTrainSummary`, `wfo.resultInterpreter.topN`.

- [ ] **Step 1: Write the failing integration test**

In `src/research/experiment-service.wfo.test.ts`:

(a) extend `buildSvc` opts with an optional events override — change the signature object to add `events?: { append: (e: unknown) => Promise<void>; listByTask: () => Promise<never[]> };` and inside the `new ExperimentService({...})` replace `events: { append: async () => {}, listByTask: async () => [] },` with `events: (opts.events ?? { append: async () => {}, listByTask: async () => [] }) as never,`.

(b) append the test:

```ts
describe('outcome embargo (S1)', () => {
  it('scrubs embargoed metric keys from gate1/sweep inputs, emits scrubbed events, keeps train metrics', async () => {
    const gate1 = new FakeGate1();
    const sweepDesigner = new FakeSweepDesigner();
    const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: () => ({ totalTrades: 5 }),
      gate1, sweepDesigner,
      events: { append: async (e) => { appended.push(e as { type: string; payload: Record<string, unknown> }); }, listByTask: async () => [] },
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    // Inject embargo-shaped extras into the persisted TRAIN metrics (the agent-facing block):
    // the train member run is the one whose id starts with 'sbr-train-'.
    const all = await strategyBacktests.listByProfile?.('p1') ?? [];
    const train = all.find((r: { id: string }) => r.id.startsWith('sbr-train-'))
      ?? (() => { throw new Error('train run not found — check seedBaseline'); })();
    (train as { metrics: Record<string, unknown> }).metrics = {
      ...(train as { metrics: Record<string, unknown> }).metrics,
      holdoutSharpe: 9.99, promotion: { verdict: 'passed' }, outOfSampleNetPnl: 123.45,
    };

    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);
    await svc.runWalkForwardOptimization(input);

    // No embargo keys or sentinel values in ANY captured LLM port input:
    const captured = JSON.stringify({ gate1: gate1.calls, sweep: sweepDesigner.calls });
    expect(captured).not.toContain('holdoutSharpe');
    expect(captured).not.toContain('promotion');
    expect(captured).not.toContain('outOfSample');
    expect(captured).not.toContain('9.99');
    expect(captured).not.toContain('123.45');
    // Boundary date T absent from port inputs (periodTo removed in Task 3):
    expect(captured).not.toContain(T);
    // Positive control — train metrics survive the scrub:
    expect(gate1.calls[0]!.baselineMetrics.totalTrades).toBe(5);
    expect(sweepDesigner.calls[0]!.baselineTrainSummary.sharpe).toBeDefined();
    // Scrub evidence event, names only:
    const scrubEvents = appended.filter((e) => e.type === 'outcome_embargo.scrubbed');
    expect(scrubEvents.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(scrubEvents)).not.toContain('9.99');
    expect(scrubEvents[0]!.payload['site']).toBe('wfo.gate1.baselineMetrics');
    expect(scrubEvents[0]!.payload['removedKeys']).toEqual(
      expect.arrayContaining(['holdoutSharpe', 'promotion', 'outOfSampleNetPnl']),
    );
  });
});
```

Note: if `InMemoryStrategyBacktestRunRepository` has no `listByProfile`, use its actual list/find accessor (check `src/adapters/repository/in-memory-strategy-backtest-run.repository.ts`) or capture the train run id from `seedBaseline` by returning it (add a second return value `{ experimentId, trainRunId }` — adjust the two existing callers destructuring only the id). The mutation-by-reference trick works because the in-memory repo stores object references.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/research/experiment-service.wfo.test.ts`
Expected: FAIL — captured input still contains `holdoutSharpe` (no scrub yet).

- [ ] **Step 3: Implement scrub + event in `runWalkForwardOptimization`**

In `src/research/experiment-service.ts` add the import:

```ts
import { scrubMetricsBag } from './outcome-embargo.ts';
```

Right before the `// --- GATE1 ---` block add a local helper (uses `this.d.events`, `this.d.newId`, `this.d.now`, `input.taskId` — all already available in the method):

```ts
    // Outcome Embargo (S1): generation-lane egress scrub. Defense-in-depth — today these
    // blocks come from closed typed projections; the scrub guards against SDK/mapper widening.
    // Spec: docs/superpowers/specs/2026-07-17-outcome-embargo-design.md §6.2.
    const emitScrubbed = async (site: string, removedKeys: string[]): Promise<void> => {
      if (removedKeys.length === 0) return;
      await this.d.events.append({
        id: this.d.newId('evt'), taskId: input.taskId, type: 'outcome_embargo.scrubbed',
        payload: { site, removedKeys },
        createdAt: this.d.now(),
      });
    };
```

Replace the gate1 call:

```ts
    const gate1Baseline = scrubMetricsBag(baselineMetrics);
    await emitScrubbed('wfo.gate1.baselineMetrics', gate1Baseline.removedKeys);
    const gate1Decision = await this.d.gate1.decide({
      profile: input.profile, baselineMetrics: gate1Baseline.scrubbed, entryAffecting, hasEntrySignalEvidence,
    }, input.agentOpts);
```

(keep the `hasEntrySignalEvidence` computation on the UNscrubbed `baselineMetrics` — deterministic control-plane use).

Replace the sweep call (from Task 4 state):

```ts
      const sweepBaseline = scrubMetricsBag(baselineMetrics);
      await emitScrubbed('wfo.sweepDesigner.baselineTrainSummary', sweepBaseline.removedKeys);
      const sweep = await this.d.sweepDesigner.design({
        profile: input.profile, baselineTrainSummary: sweepBaseline.scrubbed, tunableParams,
        restrictToEntryParams, maxPoints: budget.maxPointsPerRound,
      }, input.agentOpts);
```

Replace the interpret call:

```ts
      const interpretTopN = scrubMetricsBag(ranked);
      await emitScrubbed('wfo.resultInterpreter.topN', interpretTopN.removedKeys);
      const interpretation = await this.d.resultInterpreter.interpret({
        topN: interpretTopN.scrubbed, roundsSoFar: r, maxRounds: budget.maxRounds,
      }, input.agentOpts);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/research/experiment-service.wfo.test.ts`
Expected: PASS (new test + all pre-existing WFO tests).

- [ ] **Step 5: Commit**

```bash
git add src/research/experiment-service.ts src/research/experiment-service.wfo.test.ts
git commit -m "feat(embargo): S1 recursive scrub + outcome_embargo.scrubbed event at WFO egress"
```

---

### Task 5: Adapter-level scrub in Mastra WFO prompt builders + prompt-capture tests

The Mastra adapters are the LAST point before the LLM — scrub there too (silent belt; the experiment-service seam remains the evidence-emitting authority).

**Files:**
- Modify: `src/adapters/wfo/mastra-gate1.ts`, `src/adapters/wfo/mastra-sweep-designer.ts`, `src/adapters/wfo/mastra-result-interpreter.ts`
- Create: `src/adapters/wfo/mastra-agents.prompt.test.ts`

**Interfaces:**
- Consumes: `scrubMetricsBag` from `../../research/outcome-embargo.ts`; `Gate1Input`/`SweepInput`/`InterpretInput` (post-Task-3, no `periodTo`).

- [ ] **Step 1: Write the failing prompt-capture test**

```ts
// src/adapters/wfo/mastra-agents.prompt.test.ts
import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraGate1 } from './mastra-gate1.ts';
import { MastraSweepDesigner } from './mastra-sweep-designer.ts';
import { MastraResultInterpreter } from './mastra-result-interpreter.ts';
import type { Gate1Input, SweepInput, InterpretInput } from '../../ports/wfo-agents.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { RankedPoint } from '../../research/top-n-prefilter.ts';

const SENTINEL_NUM = 987654.321;
const SENTINEL_DATE = '2031-12-31T23:59:59.000Z';

function capturingAgent(object: unknown): { agent: Agent; prompts: string[] } {
  const prompts: string[] = [];
  const agent = {
    generate: async (prompt: string) => {
      prompts.push(prompt);
      return { object, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    },
  } as unknown as Agent;
  return { agent, prompts };
}

const profile = { coreIdea: 'dump-bounce long' } as unknown as StrategyProfile;

/** Closed metric block + runtime embargo extras, as an SDK/mapper widening would deliver them. */
const dirtyMetrics = {
  netPnlUsd: 100, maxDrawdownPct: 3, totalTrades: 7, winRate: 0.5, profitFactor: 1.2,
  sharpe: 1.1, avgTradePnlUsd: 14, topTradeContributionPct: 20, exposureHours: 5,
  holdoutSharpe: SENTINEL_NUM, promotion: { verdict: 'passed', evaluationWindow: { from: SENTINEL_DATE, to: SENTINEL_DATE } },
} as unknown as BacktestMetricBlock;

function assertClean(prompt: string): void {
  expect(prompt).not.toContain('holdout');
  expect(prompt).not.toContain('promotion');
  expect(prompt).not.toContain(String(SENTINEL_NUM));
  expect(prompt).not.toContain(SENTINEL_DATE);
}

describe('WFO Mastra prompt builders — outcome embargo', () => {
  it('gate1 prompt scrubs embargo keys and keeps train metrics', async () => {
    const { agent, prompts } = capturingAgent({ decision: 'allow_exploratory_sweep', reason: 'r' });
    const input: Gate1Input = { profile, baselineMetrics: dirtyMetrics, entryAffecting: ['dump.minDropPct'], hasEntrySignalEvidence: true };
    await new MastraGate1(agent, 'test').decide(input);
    expect(prompts).toHaveLength(1);
    assertClean(prompts[0]!);
    expect(prompts[0]!).toContain('"netPnlUsd":100'); // positive control
  });

  it('sweep-designer prompt scrubs embargo keys and has no boundary-date field', async () => {
    const { agent, prompts } = capturingAgent({ grid: {}, rationale: 'r' });
    const input: SweepInput = {
      profile, baselineTrainSummary: dirtyMetrics,
      tunableParams: [], restrictToEntryParams: false, maxPoints: 4,
    };
    await new MastraSweepDesigner(agent, 'test').design(input);
    assertClean(prompts[0]!);
    expect(prompts[0]!).not.toContain('Period end'); // T line removed in Task 3
    expect(prompts[0]!).toContain('"sharpe":1.1');
  });

  it('result-interpreter prompt scrubs embargo keys nested inside topN', async () => {
    const { agent, prompts } = capturingAgent({ decision: 'stop' });
    const topN = [{
      paramsHash: 'ph1', point: { 'dump.minDropPct': 2 }, status: 'completed',
      metrics: dirtyMetrics, lowConfidence: false,
    }] as unknown as RankedPoint[];
    const input: InterpretInput = { topN, roundsSoFar: 1, maxRounds: 3 };
    await new MastraResultInterpreter(agent, 'test').interpret(input);
    assertClean(prompts[0]!);
    expect(prompts[0]!).toContain('ph1');
  });
});
```

Note: if `RankedPoint`/`GridResult` require extra fields, satisfy the type with the `as unknown as RankedPoint[]` cast already shown — the test exercises runtime scrubbing, not the type.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/adapters/wfo/mastra-agents.prompt.test.ts`
Expected: FAIL — prompts contain `holdoutSharpe` (adapters serialize verbatim).

- [ ] **Step 3: Add the scrub to all three buildPrompt functions**

In each of `mastra-gate1.ts`, `mastra-sweep-designer.ts`, `mastra-result-interpreter.ts` add:

```ts
import { scrubMetricsBag } from '../../research/outcome-embargo.ts';
```

`mastra-gate1.ts`:

```ts
function buildPrompt(input: Gate1Input): string {
  // Outcome Embargo: last-point-before-LLM scrub (silent belt; the experiment-service
  // seam emits the outcome_embargo.scrubbed evidence event).
  const { scrubbed: baselineMetrics } = scrubMetricsBag(input.baselineMetrics);
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Baseline train metrics: ${JSON.stringify(baselineMetrics)}`,
    `Entry-affecting tunable params: ${JSON.stringify(input.entryAffecting)}`,
    `Has entry-signal evidence: ${input.hasEntrySignalEvidence}`,
  ].join('\n');
}
```

`mastra-sweep-designer.ts`:

```ts
function buildPrompt(input: SweepInput): string {
  const { scrubbed: baselineTrainSummary } = scrubMetricsBag(input.baselineTrainSummary);
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Baseline train metrics: ${JSON.stringify(baselineTrainSummary)}`,
    `Tunable params: ${JSON.stringify(input.tunableParams)}`,
    `Restrict to entry-affecting params only: ${input.restrictToEntryParams}`,
    `Max grid points: ${input.maxPoints}`,
  ].join('\n');
}
```

`mastra-result-interpreter.ts`:

```ts
function buildPrompt(input: InterpretInput): string {
  const { scrubbed: topN } = scrubMetricsBag(input.topN);
  return [
    `Top-N ranked results: ${JSON.stringify(topN)}`,
    `Rounds so far: ${input.roundsSoFar}`,
    `Max rounds: ${input.maxRounds}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/adapters/wfo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/wfo/mastra-gate1.ts src/adapters/wfo/mastra-sweep-designer.ts src/adapters/wfo/mastra-result-interpreter.ts src/adapters/wfo/mastra-agents.prompt.test.ts
git commit -m "feat(embargo): adapter-level scrub in WFO Mastra prompt builders + prompt-capture tests"
```

---

### Task 6: S2 — sanitize retry feedback at construction AND consumption

Write side: embargoed content never persists into `research_task.payload.feedback` → durable across retry/requeue/replay. Read side: legacy payloads persisted BEFORE this change are sanitized on consumption too.

**Files:**
- Modify: `src/orchestrator/handlers/backtest-completed.handler.ts` (`enqueueResearchRetry`)
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts` (line ~260, `retryFeedback` construction)
- Test: `src/orchestrator/handlers/backtest-completed.handler.test.ts` (extend)

**Interfaces:**
- Consumes: `sanitizeRetryFeedback` from `../../research/outcome-embargo.ts` (Task 2).
- Produces: retry payload `feedback.reasons` ⊆ `SAFE_RETRY_REASONS`; `outcome_embargo.scrubbed` event with `site: 'enqueueResearchRetry.feedback'`.

- [ ] **Step 1: Write the failing tests**

Append to `src/orchestrator/handlers/backtest-completed.handler.test.ts` (inside the top-level `describe('backtestCompletedHandler')`):

```ts
  describe('outcome embargo (S2)', () => {
    it('drops non-allowlisted reasons from the persisted retry feedback, fail-closed', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({
          ...BASE_PAYLOAD, decision: 'FAIL', cycleDepth: 0,
          reasons: ['no_improvement_over_baseline', 'holdout_failed: sharpe=1.23', 'heldout window 2031-12-31'],
        }),
        s,
      );
      const enqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
      expect(enqueued).toHaveLength(1);
      const retryTask = await s.researchTasks.findById(enqueued[0]!.taskId);
      const feedback = (retryTask!.payload as { feedback: { reasons: string[] } }).feedback;
      expect(feedback.reasons).toEqual(['no_improvement_over_baseline']);
      // durable: the embargoed strings must not exist ANYWHERE in the persisted payload
      expect(JSON.stringify(retryTask!.payload)).not.toContain('sharpe=1.23');
      expect(JSON.stringify(retryTask!.payload)).not.toContain('2031-12-31');
      // scrub evidence event, paths only
      const events = await s.events.listByTask('task-bt-completed');
      const scrub = events.filter((e) => e.type === 'outcome_embargo.scrubbed');
      expect(scrub).toHaveLength(1);
      expect(scrub[0]!.payload).toEqual({
        site: 'enqueueResearchRetry.feedback',
        removedKeys: ['reasons[1]', 'reasons[2]'],
      });
    });

    it('keeps evalPlatformRun (orchestration window) verbatim in the retry payload (I-E2)', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      const evalPlatformRun = {
        datasetId: 'ds-1', symbols: ['BTCUSDT'], timeframe: '1m', seed: 42,
        period: { from: '2026-06-22T00:00:00.000Z', to: '2026-06-28T00:00:00.000Z' },
      };
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'MODIFY', cycleDepth: 0, reasons: ['drawdown_regression'], evalPlatformRun }),
        s,
      );
      const enqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
      const retryTask = await s.researchTasks.findById(enqueued[0]!.taskId);
      expect((retryTask!.payload as { evalPlatformRun: unknown }).evalPlatformRun).toEqual(evalPlatformRun);
      // no scrub event when nothing was dropped
      const events = await s.events.listByTask('task-bt-completed');
      expect(events.filter((e) => e.type === 'outcome_embargo.scrubbed')).toHaveLength(0);
    });
  });
```

Note: if the existing `evalPlatformRun` fixtures in `backtest-completed.eval-window.test.ts` use a different `PlatformRunConfig` shape, mirror that shape here (the schema is `PlatformRunConfigSchema` in `src/orchestrator/handlers/platform-run-config.schema.ts`).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/orchestrator/handlers/backtest-completed.handler.test.ts`
Expected: FAIL — `feedback.reasons` still contains all three strings.

- [ ] **Step 3: Implement the write-side sanitize**

In `src/orchestrator/handlers/backtest-completed.handler.ts` add the import:

```ts
import { sanitizeRetryFeedback } from '../../research/outcome-embargo.ts';
```

Inside `enqueueResearchRetry`, at the top of the function body:

```ts
  // Outcome Embargo (S2, I-E5): fail-closed reason allowlist BEFORE the payload is written —
  // embargoed content must never persist into research_task.payload.feedback (it would be
  // replayed verbatim on every retry/requeue). Touches ONLY feedback; evalPlatformRun and
  // other control-plane fields are exempt by design (I-E2).
  const sanitized = sanitizeRetryFeedback(feedback);
  if (sanitized.removedKeys.length > 0) {
    await services.events.append(event(task.id, 'outcome_embargo.scrubbed', {
      site: 'enqueueResearchRetry.feedback', removedKeys: sanitized.removedKeys,
    }));
  }
```

and replace `feedback` with `feedback: sanitized.feedback` in the payload object:

```ts
    payload: {
      strategyProfileId, cycleDepth: nextCycleDepth, feedback: sanitized.feedback,
      ...(symbol ? { symbol } : {}),
      ...(evalPlatformRun ? { evalPlatformRun } : {}),
    },
```

(`event` is already imported in this file from `./backtest-support.ts`.)

- [ ] **Step 4: Implement the read-side sanitize (legacy persisted payloads)**

In `src/orchestrator/handlers/research-run-cycle.handler.ts` add the import:

```ts
import { sanitizeRetryFeedback } from '../../research/outcome-embargo.ts';
```

Replace lines ~260-262:

```ts
  // R4: feedback from a previous FAIL/MODIFY cycle. Outcome Embargo (S2): re-sanitize on
  // consumption — payloads persisted before the embargo (or hand-injected via /tasks) may
  // carry non-allowlisted reason strings; they must never reach the researcher prompt.
  const retryFeedback = payload.feedback
    ? (() => {
        const { feedback } = sanitizeRetryFeedback(payload.feedback);
        return { decision: feedback.decision, reasons: feedback.reasons };
      })()
    : undefined;
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run src/orchestrator/handlers/backtest-completed.handler.test.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts src/orchestrator/handlers/backtest-completed.eval-window.test.ts`
Expected: PASS (new + all pre-existing; existing retry tests use allowlisted reasons like `no_improvement_over_baseline`, so they stay green).

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/backtest-completed.handler.ts src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/backtest-completed.handler.test.ts
git commit -m "feat(embargo): S2 retry-feedback allowlist at construction + consumption"
```

---

### Task 7: S3 — bot-results digest frozen-projection guard (test-only)

`BotRunResultDetail.summary` is a typed `RunSummary` rendered by an explicit allowlisted renderer. The seam is a guard test proving new fields (e.g. a future `promotion`) can NEVER appear in the digest. No production change; the DTO is never cast to a generic bag.

**Files:**
- Test: `src/adapters/researcher/bot-results-digest.test.ts` (extend)

- [ ] **Step 1: Write the test (expected to pass immediately — it freezes current behavior)**

Append to `src/adapters/researcher/bot-results-digest.test.ts`, reusing the file's existing `BotRunResultDetail` fixture (or building one exactly like the `detail` fixture in `src/adapters/researcher/mastra-researcher.test.ts` if this file has none):

```ts
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';

describe('outcome embargo (S3) — frozen projection', () => {
  const clean: BotRunResultDetail = {
    run: { runId: 'r1', mode: 'paper', status: 'finished', bundleId: null, strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] },
    summary: { runId: 'r1', excludesReconcile: true, asOf: 2, closedTrades: 2, wins: 1, losses: 1, breakeven: 0, winratePct: 50, pnlUsd: '7.5', avgPnl: '3.75', exitReasons: { tp: 1, stop_loss: 1 } },
    trades: [],
  };

  it('renders byte-identically when the summary carries runtime embargo extras', () => {
    const dirty = {
      ...clean,
      summary: {
        ...clean.summary,
        promotion: { verdict: 'passed' },
        holdoutSharpe: 987654.321,
        qualificationEpochKey: 'epoch-1',
        evaluationWindow: { from: '2031-12-31', to: '2031-12-31' },
      },
    } as unknown as BotRunResultDetail;
    expect(buildBotResultsDigestText([dirty])).toBe(buildBotResultsDigestText([clean]));
    expect(buildBotResultsDigestText([dirty])).not.toContain('987654');
  });
});
```

(Merge the `BotRunResultDetail` import with any existing import from that module; `buildBotResultsDigestText` is already imported in this test file.)

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run src/adapters/researcher/bot-results-digest.test.ts`
Expected: PASS — the renderer is an explicit projection. If it FAILS, the digest is interpolating unlisted fields; fix the renderer to explicit fields only, never by scrubbing the DTO.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/researcher/bot-results-digest.test.ts
git commit -m "test(embargo): S3 digest frozen-projection guard (runtime extras render byte-identically)"
```

---

### Task 8: S4 — shape guards for RAG document and similar-hypothesis summary (test-only)

**Files:**
- Test: `src/operator/strategy-retrieval-document.test.ts` (extend)
- Create: `src/adapters/similarity/similar-hypothesis-summary-shape.test.ts`

- [ ] **Step 1: RAG document byte-identity test**

Append to `src/operator/strategy-retrieval-document.test.ts`, reusing the file's existing `StrategyProfile` fixture (referred to below as `profileFixture` — substitute the actual fixture identifier used in that file):

```ts
describe('outcome embargo (S4) — retrieval document', () => {
  it('renders byte-identically when the profile carries runtime embargo extras', () => {
    const dirty = {
      ...profileFixture,
      holdoutValidation: { holdoutSharpe: 987654.321 },
      promotion: { verdict: 'passed' },
      evaluationWindow: { from: '2031-12-31', to: '2031-12-31' },
    } as unknown as typeof profileFixture;
    expect(buildStrategyRetrievalText(dirty)).toBe(buildStrategyRetrievalText(profileFixture));
  });

  it('document content and contentHash are unaffected by runtime embargo extras', () => {
    const opts = { embedding: [0.1, 0.2], embeddingModel: 'm', indexVersion: 1, indexedAt: '2026-01-01T00:00:00Z' };
    const dirty = { ...profileFixture, holdoutValidation: { t: '2031-12-31' } } as unknown as typeof profileFixture;
    const a = buildStrategyRetrievalDocument(profileFixture, opts);
    const b = buildStrategyRetrievalDocument(dirty, opts);
    expect(b.content).toBe(a.content);
    expect(b.contentHash).toBe(a.contentHash);
    expect(JSON.stringify(b)).not.toContain('2031-12-31');
  });
});
```

The second test also proves the indexer path is safe: `StrategyRetrievalIndexer._indexInternal` passes only the `StrategyProfile` into `buildStrategyRetrievalText`/`buildStrategyRetrievalDocument` (see `src/operator/strategy-retrieval-indexer.ts`) — no experiment/revision/outcome records enter document construction, and the success event payload carries ids/hash/model/version only.

- [ ] **Step 2: Similar-hypothesis summary key-set test**

```ts
// src/adapters/similarity/similar-hypothesis-summary-shape.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryLexicalSimilarHypothesisSearch } from './in-memory-lexical-similar-hypothesis-search.ts';
import type { HypothesisProposalRepository } from '../../ports/hypothesis-proposal.repository.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';

describe('outcome embargo (S4) — SimilarHypothesisSummary shape', () => {
  it('returns exactly {hypothesisId, thesis, status, score} even when proposals carry outcome data', async () => {
    const proposal = {
      id: 'h1', strategyProfileId: 'p1', thesis: 'oi recovery bounce', status: 'proxy_failed',
      proxyMetrics: { decision: 'FAIL', backtestRunId: 'bt1', deltaNetPnlUsd: -5, deltaMaxDrawdownPct: 1 },
      holdoutValidation: { holdoutSharpe: 987654.321 }, // runtime extra
    } as unknown as HypothesisProposal;
    const repo = { listByStrategyProfile: async () => [proposal] } as unknown as HypothesisProposalRepository;
    const search = new InMemoryLexicalSimilarHypothesisSearch(repo);

    const hits = await search.search('p1', 'oi recovery', 5);

    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0]!).sort()).toEqual(['hypothesisId', 'score', 'status', 'thesis']);
    expect(JSON.stringify(hits)).not.toContain('987654');
    expect(JSON.stringify(hits)).not.toContain('deltaNetPnlUsd');
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `pnpm vitest run src/operator/strategy-retrieval-document.test.ts src/adapters/similarity/similar-hypothesis-summary-shape.test.ts`
Expected: PASS (both freeze existing-by-shape behavior).

- [ ] **Step 4: Commit**

```bash
git add src/operator/strategy-retrieval-document.test.ts src/adapters/similarity/similar-hypothesis-summary-shape.test.ts
git commit -m "test(embargo): S4 shape guards — RAG document byte-identity + similar-hypothesis key set"
```

---

### Task 9: Layer-2 prompt byte-identity for researcher / builder / critic / consolidator

All four builders render explicit fields; freeze that with byte-identity tests. The critic and consolidator prompt functions are module-private — export them (same convention as `buildPrompt` in mastra-researcher / mastra-strategy-analyst and `buildPromptFor` in mastra-builder).

**Files:**
- Modify: `src/adapters/critic/mastra-critic.ts` (line ~6: `function buildPrompt` → `export function buildPrompt`)
- Modify: `src/adapters/consolidator/mastra-strategy-consolidator.ts` (line ~9: `function renderConsolidationPrompt` → `export function renderConsolidationPrompt`)
- Create: `src/adapters/prompt-embargo.test.ts`

- [ ] **Step 1: Export the two private builders** (one-word change each; no behavior change).

- [ ] **Step 2: Write the byte-identity tests**

```ts
// src/adapters/prompt-embargo.test.ts
import { describe, it, expect } from 'vitest';
import { buildPrompt as researcherPrompt } from './researcher/mastra-researcher.ts';
import { buildPromptFor as builderPrompt } from './builder/mastra-builder.ts';
import { buildPrompt as criticPrompt } from './critic/mastra-critic.ts';
import { renderConsolidationPrompt } from './consolidator/mastra-strategy-consolidator.ts';
import { buildStrategyUserMessage } from './builder/strategy-user-message.ts';
import type { ResearcherInput } from '../ports/researcher.port.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';

const SENTINEL = 987654.321;
const EXTRAS = {
  holdoutValidation: { holdoutSharpe: SENTINEL, holdoutDecision: 'FAIL' },
  promotion: { verdict: 'passed' },
  evaluationWindow: { from: '2031-12-31', to: '2031-12-31' },
};

/** Minimal valid researcher input (mirrors mastra-researcher.test.ts baseInput). */
const researcherInput: ResearcherInput = {
  profile: {
    coreIdea: 'idea', direction: 'long', requiredMarketFeatures: [],
    profile: {
      summary: 'Enter after a dump when OI recovers.',
      entryConditions: ['Dump >=10%'], exitConditions: ['TP +3.5%'],
      parameters: [{ name: 'dump.minDropPct', value: 10, unit: '%', description: 'min dump', tunable: true }],
      positionManagementSummary: 'One position.', riskManagementSummary: 'Overlays only.',
      unknowns: [], evidence: [],
    },
  } as unknown as StrategyProfile,
  marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: {} },
  marketRegime: 'ranging',
  similarHypotheses: [],
  maxHypotheses: 2,
  focus: 'loss_reduction',
};

describe('outcome embargo — generation prompt builders are explicit projections', () => {
  it('researcher prompt ignores runtime embargo extras on profile and input', () => {
    const dirty = {
      ...researcherInput,
      ...EXTRAS,
      profile: { ...researcherInput.profile, ...EXTRAS } as unknown as StrategyProfile,
    } as ResearcherInput;
    expect(researcherPrompt(dirty)).toBe(researcherPrompt(researcherInput));
    expect(researcherPrompt(dirty)).not.toContain(String(SENTINEL));
  });

  it('hypothesis-builder prompt ignores runtime embargo extras', () => {
    const hypothesis = {
      id: 'h1', thesis: 't', targetBehavior: 'b',
      ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
      requiredFeatures: ['oi'], expectedEffect: { metric: 'win_rate', direction: 'increase' },
    };
    const profile = { direction: 'long', requiredMarketFeatures: ['oi'] };
    const clean = { hypothesis, profile, sdkDoc: 'SDK DOC' };
    const dirty = {
      hypothesis: { ...hypothesis, ...EXTRAS },
      profile: { ...profile, ...EXTRAS },
      sdkDoc: 'SDK DOC',
    };
    type BI = Parameters<typeof builderPrompt>[0];
    expect(builderPrompt(dirty as unknown as BI)).toBe(builderPrompt(clean as unknown as BI));
  });

  it('critic prompt ignores runtime embargo extras', () => {
    const clean = {
      proposal: {
        thesis: 't', targetBehavior: 'b',
        ruleAction: { appliesTo: 'long', rules: [] },
        validationPlan: 'p', invalidationCriteria: ['x'],
      },
      profile: { coreIdea: 'idea' },
    };
    const dirty = {
      proposal: { ...clean.proposal, ...EXTRAS },
      profile: { ...clean.profile, ...EXTRAS },
    };
    type CI = Parameters<typeof criticPrompt>[0];
    expect(criticPrompt(dirty as unknown as CI)).toBe(criticPrompt(clean as unknown as CI));
  });

  it('consolidation prompt ignores runtime embargo extras on args', () => {
    const clean = { stackedSource: 'export default function () {}', mergedRuleSet: { rules: [], theses: [] } };
    const dirty = { ...clean, ...EXTRAS };
    type AR = Parameters<typeof renderConsolidationPrompt>[0];
    expect(renderConsolidationPrompt(dirty as unknown as AR)).toBe(renderConsolidationPrompt(clean as unknown as AR));
  });

  it('strategy-builder user message ignores runtime embargo extras on the analyst profile', () => {
    // buildStrategyUserMessage(profile: AnalystProfileOutput, feedback?: BuildFeedback)
    // Reuse the AnalystProfileOutput fixture from strategy-user-message.test.ts as `clean`
    // (import/extract it into a shared helper if it is file-local), then:
    const dirtyProfile = { ...cleanAnalystProfile, ...EXTRAS } as typeof cleanAnalystProfile;
    expect(buildStrategyUserMessage(dirtyProfile)).toBe(buildStrategyUserMessage(cleanAnalystProfile));
    expect(buildStrategyUserMessage(dirtyProfile)).not.toContain(String(SENTINEL));
  });
});
```

Note: if `ResearcherInput`'s `profile` fixture is rejected by the type, keep the `as unknown as StrategyProfile` casts — the point is runtime byte-identity, not the fixture's completeness.

- [ ] **Step 3: Run to verify**

Run: `pnpm vitest run src/adapters/prompt-embargo.test.ts`
Expected: PASS — every builder renders explicit fields only. A FAILURE here means a builder interpolates the whole input object; fix by rendering explicit fields, never by scrubbing.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add src/adapters/critic/mastra-critic.ts src/adapters/consolidator/mastra-strategy-consolidator.ts src/adapters/prompt-embargo.test.ts
git commit -m "test(embargo): layer-2 prompt byte-identity guards for researcher/builder/critic/consolidator"
```

---

### Task 10: Layer-1 orchestration integration — sentinel through research-run-cycle + W3 payload key set

**Files:**
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (extend)
- Test: `src/orchestrator/handlers/paper-monitor.handler.test.ts` (extend)

- [ ] **Step 1: research-run-cycle sentinel test**

Open `src/orchestrator/handlers/research-run-cycle.handler.test.ts` and copy the arrangement of its first passing happy-path test (services via `makeServices`, a persisted profile, a `research.run_cycle` task fixture). Add a capturing researcher and the sentinel revision:

```ts
import { FakeResearcher } from '../../adapters/researcher/fake-researcher.ts';
import type { ResearcherInput } from '../../ports/researcher.port.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';

class CapturingResearcher extends FakeResearcher {
  readonly inputs: ResearcherInput[] = [];
  override async propose(input: ResearcherInput) {
    this.inputs.push(input);
    return super.propose(input);
  }
}

describe('outcome embargo (layer 1) — researcher input purity', () => {
  const SENTINEL = '987654.321';
  const SENTINEL_DATE = '2031-12-31T23:59:59.000Z';

  it('an accepted revision with holdoutValidation never leaks it into the researcher input', async () => {
    const researcher = new CapturingResearcher();
    // Arrange services + profile + task exactly as the happy-path test in this file does,
    // passing `researcher` into makeServices overrides, THEN override the revisions read:
    const sentinelRevision = {
      id: 'rev-1', strategyProfileId: /* the profile id used by the fixture */ 'profile-1',
      status: 'accepted',
      mergedRuleSet: {
        rules: [{ when: 'oi rises', action: 'no_op', params: {} }],
        theses: [{ hypothesisId: 'h1', thesis: 'safe thesis', status: 'accepted_revision' }],
      },
      holdoutValidation: {
        holdoutMetrics: { sharpe: Number(SENTINEL) },
        trainMetrics: { sharpe: 1 },
        holdoutDecision: 'FAIL', holdoutReasons: ['holdout_failed'],
        t: SENTINEL_DATE, mode: 'trade_based',
      },
    } as unknown as StrategyRevision;
    s.revisions.findLatestAccepted = async () => sentinelRevision;

    await researchRunCycleHandler(taskFixture, s);

    expect(researcher.inputs.length).toBeGreaterThanOrEqual(1);
    const captured = JSON.stringify(researcher.inputs);
    expect(captured).not.toContain(SENTINEL);
    expect(captured).not.toContain(SENTINEL_DATE);
    expect(captured).not.toContain('holdoutValidation');
    // positive control: the accepted revision's rules DID reach the researcher
    expect(captured).toContain('oi rises');
  });

  it('a legacy persisted payload with dirty feedback reaches the researcher sanitized', async () => {
    const researcher = new CapturingResearcher();
    // Same arrangement; task payload simulates a pre-embargo persisted row:
    const dirtyTask = {
      ...taskFixture,
      payload: {
        ...taskFixture.payload,
        cycleDepth: 1,
        feedback: {
          hypothesisId: 'h1', decision: 'FAIL',
          reasons: ['no_improvement_over_baseline', `holdout_failed: sharpe=${SENTINEL}`],
        },
      },
    };

    await researchRunCycleHandler(dirtyTask, s);

    const captured = JSON.stringify(researcher.inputs);
    expect(captured).not.toContain(SENTINEL);
    // positive control: the allowlisted reason survived
    expect(captured).toContain('no_improvement_over_baseline');
  });
});
```

Where `s` / `taskFixture` / `researchRunCycleHandler` come from the file's existing fixtures; the ONLY new arrangements are the `researcher` override (`makeServices({ researcher, ... })`) and the two stubs shown. If `s.revisions` is read-only, override via `makeServices({ researcher, revisions: { ...realRevisionsFixture, findLatestAccepted: async () => sentinelRevision } as never })`.

- [ ] **Step 2: W3 payload key-set test**

Append to `src/orchestrator/handlers/paper-monitor.handler.test.ts`, inside the existing describe, reusing the file's fixture that drives a `window_complete` outcome (the test that already asserts a Cycle-2 `research.run_cycle` is enqueued):

```ts
  it('outcome embargo: the Cycle-2 trigger payload carries ids only — no metrics, no windows', async () => {
    // Arrange exactly as the existing window_complete test in this file, then:
    const enqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
    expect(enqueued).toHaveLength(1);
    const cycleTask = await s.researchTasks.findById(enqueued[0]!.taskId);
    expect(Object.keys(cycleTask!.payload as Record<string, unknown>).sort())
      .toEqual(['paperRunId', 'strategyProfileId']);
  });
```

(If the existing handler adds another id-only key to that payload, extend the expected array with it — the assertion's job is to freeze the key set so metrics/windows can never ride the W3 trigger unnoticed.)

- [ ] **Step 3: Run to verify**

Run: `pnpm vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts src/orchestrator/handlers/paper-monitor.handler.test.ts`
Expected: PASS. (The first sentinel test should pass already — the handler maps only `mergedRuleSet`-derived fields; it exists to catch future widening. The dirty-feedback test passes thanks to Task 6's read-side sanitize.)

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.test.ts src/orchestrator/handlers/paper-monitor.handler.test.ts
git commit -m "test(embargo): layer-1 orchestration sentinel — researcher input purity + W3 id-only payload"
```

---

### Task 11: S5 — event payload regression guards

**Files:**
- Test: `src/orchestrator/handlers/cycle-scorecard.handler.test.ts` (extend)
- Test: `src/read-api/mappers.test.ts` (extend)

- [ ] **Step 1: `cycle.scorecard.built` exact-payload test**

Append to `src/orchestrator/handlers/cycle-scorecard.handler.test.ts`, reusing the file's existing happy-path arrangement (the test that already drives `cycleScorecardHandler` to completion):

```ts
  it('outcome embargo (S5): cycle.scorecard.built payload is exactly { correlationId }', async () => {
    // Arrange exactly as the existing happy-path test, then:
    const events = await s.events.listByTask(task.id);
    const built = events.filter((e) => e.type === 'cycle.scorecard.built');
    expect(built).toHaveLength(1);
    expect(built[0]!.payload).toEqual({ correlationId: task.correlationId });
  });
```

- [ ] **Step 2: read-API deny-by-default test for the new event type**

Append to `src/read-api/mappers.test.ts` (it already imports `toAgentEventDto`; mirror its existing row fixtures):

```ts
  it('outcome embargo: outcome_embargo.scrubbed payload is NOT exposed through the read API', () => {
    const dto = toAgentEventDto({
      id: 'e1', taskId: 't1', type: 'outcome_embargo.scrubbed',
      payload: { site: 'wfo.gate1.baselineMetrics', removedKeys: ['holdoutSharpe'] },
      createdAt: '2026-01-01T00:00:00Z',
    } as never);
    expect(dto.payloadSummary).toBeUndefined(); // deny-by-default PAYLOAD_ALLOWLIST
  });
```

- [ ] **Step 3: Run to verify**

Run: `pnpm vitest run src/orchestrator/handlers/cycle-scorecard.handler.test.ts src/read-api/mappers.test.ts`
Expected: PASS (both freeze existing behavior; `outcome_embargo.scrubbed` is intentionally absent from `PAYLOAD_ALLOWLIST`).

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/handlers/cycle-scorecard.handler.test.ts src/read-api/mappers.test.ts
git commit -m "test(embargo): S5 event regressions — scorecard.built exact payload + read-API deny-by-default"
```

---

### Task 12: Docs + full validation

**Files:**
- Modify: `docs/research/2026-07-12-backtester-phase-e-lab-reconciliation.md` (§5 Outcome-Embargo checklist item)

- [ ] **Step 1: Update the reconciliation checklist**

In `docs/research/2026-07-12-backtester-phase-e-lab-reconciliation.md` §5, change the Outcome-Embargo item's checkbox line from `- [ ] **Outcome Embargo on agent memory (E4/E4b) — lab-owned, HARD PRODUCTION BLOCKER.**` to `- [x] **Outcome Embargo on agent memory (E4/E4b) — lab-owned, HARD PRODUCTION BLOCKER — IMPLEMENTED in lab** (spec `docs/superpowers/specs/2026-07-17-outcome-embargo-design.md`; deploy + E4b-card evidence pending).` Keep the rest of the item's text (ownership + card pointer) unchanged.

- [ ] **Step 2: Full validation**

Run: `pnpm check`
Expected: typecheck clean + full test suite PASS.

The passing pre-existing scorecard / scorecard-markdown / completion-summary suites are the
I-E4 observability-parity evidence (spec §7.6): no task in this plan touches those code
paths, so their unchanged green runs prove byte-identical observability output.

- [ ] **Step 3: Commit**

```bash
git add docs/research/2026-07-12-backtester-phase-e-lab-reconciliation.md
git commit -m "docs(embargo): mark lab Outcome-Embargo implemented in Phase-E reconciliation §5"
```

- [ ] **Step 4: Final review pass**

Re-read the spec's invariants I-E1…I-E5 against the diff (`git diff main...feat/outcome-embargo`). Confirm: no env flag introduced; no canonical `RunResultSummary`/persistence/scorecard writes modified; `outcome_embargo.scrubbed` absent from `PAYLOAD_ALLOWLIST`; `evalPlatformRun` untouched. Then hand off for PR (do NOT merge without user review).
