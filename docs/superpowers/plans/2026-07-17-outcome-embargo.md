# Outcome Embargo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Mandatory controller review:** Tasks 4, 6, and 10 carry the durable embargo invariants (S1 egress + evidence event; S2 write/read sanitize; layer-1 sentinel). The controller MUST review their diffs and test output line-by-line before proceeding to the next task. The remaining tasks are guard coverage and may be reviewed at normal depth.

**Goal:** Durable policy preventing held-out / qualification outcome data (metrics, verdicts, window boundaries) from entering LLM generation context — including via retry, requeue, persistence reload, event payloads, RAG, or summary projections.

**Architecture:** One pure policy module (`src/research/outcome-embargo.ts`) enforced at three runtime seams — WFO prompt egress (incl. removing the `periodTo`=T field from two WFO port inputs), retry-feedback construction+consumption, and adapter-level scrub inside the Mastra WFO prompt builders — plus test-only guards for the channels already closed by shape (digest projection, RAG document, similar-hypothesis summary, event payloads). Verified by a three-layer sentinel harness (orchestration port-input capture / real-adapter prompt capture / dedicated WFO integration).

**Tech Stack:** TypeScript (node `--experimental-strip-types`), Vitest, zod, existing in-memory fakes (`test/support/make-services.ts`, WFO fakes with `.calls` arrays).

**Spec:** `docs/superpowers/specs/2026-07-17-outcome-embargo-design.md` (approved). Read §3 (embargo set), §4 (invariants I-E1…I-E5), §6 (seams S1–S5) before starting.

## Global Constraints

- **Always-on, no config flag** (I-E3). Never add an env var for the embargo.
- **Never modify the canonical `RunResultSummary`**, persistence writes, deterministic evaluators, scorecards, or read-API outputs (I-E4, spec §6.1/§6.3). Scrub happens ONLY on generation-lane egress.
- New agent event type `outcome_embargo.scrubbed`, payload exactly `{ site, removedKeys }` — **key names/paths only, never values**. Do NOT add it to `PAYLOAD_ALLOWLIST` in `src/read-api/mappers.ts`.
- Embargoed key tokens: `holdout | heldout | oos | promotion | qualification` + segment sequences `out_of_sample` and `evaluation_window` (token-wise, NOT substring — `choose` must not match; `evaluation` alone and `windowSize` alone must not match).
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
    'evaluationWindow', 'evaluation_window', 'evaluationWindowFrom',
  ])('embargoes %s', (key) => {
    expect(isEmbargoedMetricKey(key)).toBe(true);
  });

  it.each([
    'choose',        // 'oos' is a substring but NOT a segment
    'netPnlUsd', 'sharpe', 'maxDrawdownPct', 'totalTrades', 'winRate', 'profitFactor',
    'sampleSize',    // 'sample' alone is not embargoed
    'outOf', 'ofSample', // incomplete out_of_sample sequence
    'evaluation', 'windowSize', 'window', // incomplete evaluation_window sequence
    'selectionEvaluation', // legit revision field — 'evaluation' without 'window'
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

  it('drops a TOP-LEVEL evaluationWindow subtree (window dates must not survive outside promotion)', () => {
    const { scrubbed, removedKeys } = scrubMetricsBag({
      sharpe: 1.2,
      evaluationWindow: { from: '2031-12-31T00:00:00Z', to: '2031-12-31T23:59:59Z' },
    });
    expect(scrubbed).toEqual({ sharpe: 1.2 });
    expect(removedKeys).toEqual(['evaluationWindow']);
    expect(JSON.stringify(scrubbed)).not.toContain('2031-12-31');
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
/** Multi-segment sequences embargoed even though their individual tokens are not. */
const EMBARGOED_SEQUENCES: readonly (readonly string[])[] = [
  ['out', 'of', 'sample'],
  ['evaluation', 'window'],
];

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
  for (const seq of EMBARGOED_SEQUENCES) {
    for (let i = 0; i + seq.length <= segs.length; i += 1) {
      if (seq.every((tok, j) => segs[i + j] === tok)) return true;
    }
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

(b) extend `seedBaseline` with an extras hook — add to its `opts` object type:

```ts
  // Embargo-test hook: extra keys merged into the persisted TRAIN metrics (the
  // agent-facing block), simulating an SDK/mapper widening. Default: none.
  trainMetricsExtras?: Record<string, unknown>;
```

and inside the `if (opts.boundary.mode !== 'none')` block change the train-run
`markCompleted` call to merge them:

```ts
    await opts.strategyBacktests.markCompleted(trainRunId, {
      metrics: {
        ...metrics({ totalTrades: trainTotalTrades, profitFactor: 1.2, sharpe: 2 }),
        ...(opts.trainMetricsExtras ?? {}),
      } as never,
      artifactRefs: [], platformContractVersion: 'v1', finishedAt: NOW,
    });
```

Do NOT change `seedBaseline`'s return value or any of its existing call sites —
the new field is optional and inert when absent.

(c) append the test:

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
      trainMetricsExtras: {
        holdoutSharpe: 9.99,
        promotion: { verdict: 'passed' },
        outOfSampleNetPnl: 123.45,
        evaluationWindow: { from: '2031-12-31T00:00:00.000Z', to: '2031-12-31T23:59:59.000Z' },
      },
    });

    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);
    await svc.runWalkForwardOptimization(input);

    // No embargo keys or sentinel values in ANY captured LLM port input:
    const captured = JSON.stringify({ gate1: gate1.calls, sweep: sweepDesigner.calls });
    expect(captured).not.toContain('holdoutSharpe');
    expect(captured).not.toContain('promotion');
    expect(captured).not.toContain('outOfSample');
    expect(captured).not.toContain('evaluationWindow');
    expect(captured).not.toContain('9.99');
    expect(captured).not.toContain('123.45');
    expect(captured).not.toContain('2031-12-31');
    // Boundary date T absent from port inputs (periodTo removed in Task 3):
    expect(captured).not.toContain(T);
    // Positive control — train metrics survive the scrub:
    expect(gate1.calls[0]!.baselineMetrics.totalTrades).toBe(5);
    expect(sweepDesigner.calls[0]!.baselineTrainSummary.sharpe).toBeDefined();
    // Scrub evidence event, names only:
    const scrubEvents = appended.filter((e) => e.type === 'outcome_embargo.scrubbed');
    expect(scrubEvents.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(scrubEvents)).not.toContain('9.99');
    expect(JSON.stringify(scrubEvents)).not.toContain('2031-12-31');
    expect(scrubEvents[0]!.payload['site']).toBe('wfo.gate1.baselineMetrics');
    expect(scrubEvents[0]!.payload['removedKeys']).toEqual(
      expect.arrayContaining(['holdoutSharpe', 'promotion', 'outOfSampleNetPnl', 'evaluationWindow']),
    );
  });
});
```

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
  holdoutSharpe: SENTINEL_NUM,
  promotion: { verdict: 'passed', evaluationWindow: { from: SENTINEL_DATE, to: SENTINEL_DATE } },
  // TOP-LEVEL window subtree — must be caught by the evaluation_window sequence,
  // not merely hidden under the removed promotion key:
  evaluationWindow: { from: SENTINEL_DATE, to: SENTINEL_DATE },
} as unknown as BacktestMetricBlock;

function assertClean(prompt: string): void {
  expect(prompt).not.toContain('holdout');
  expect(prompt).not.toContain('promotion');
  expect(prompt).not.toContain('evaluationWindow');
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
  let retryFeedback: { decision: string; reasons: string[] } | undefined;
  if (payload.feedback) {
    const sanitizedFeedback = sanitizeRetryFeedback(payload.feedback);
    retryFeedback = { decision: sanitizedFeedback.feedback.decision, reasons: sanitizedFeedback.feedback.reasons };
    if (sanitizedFeedback.removedKeys.length > 0) {
      // Every scrub hit is evidenced — index paths only, never the dropped text.
      await services.events.append({
        id: randomUUID(), taskId: task.id, type: 'outcome_embargo.scrubbed',
        payload: { site: 'researchRunCycle.retryFeedback', removedKeys: sanitizedFeedback.removedKeys },
        createdAt: new Date().toISOString(),
      });
    }
  }
```

(`randomUUID` is already imported at the top of this handler.)

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

Append to `src/operator/strategy-retrieval-document.test.ts` — the file already defines the fixture factory `makeProfile(over: Partial<StrategyProfile> = {}): StrategyProfile` and imports both `buildStrategyRetrievalText` and `buildStrategyRetrievalDocument`:

```ts
describe('outcome embargo (S4) — retrieval document', () => {
  it('renders byte-identically when the profile carries runtime embargo extras', () => {
    const clean = makeProfile();
    const dirty = {
      ...clean,
      holdoutValidation: { holdoutSharpe: 987654.321 },
      promotion: { verdict: 'passed' },
      evaluationWindow: { from: '2031-12-31', to: '2031-12-31' },
    } as unknown as StrategyProfile;
    expect(buildStrategyRetrievalText(dirty)).toBe(buildStrategyRetrievalText(clean));
  });

  it('document content and contentHash are unaffected by runtime embargo extras', () => {
    const opts = { embedding: [0.1, 0.2], embeddingModel: 'm', indexVersion: 1, indexedAt: '2026-01-01T00:00:00Z' };
    const clean = makeProfile();
    const dirty = { ...clean, holdoutValidation: { t: '2031-12-31' } } as unknown as StrategyProfile;
    const a = buildStrategyRetrievalDocument(clean, opts);
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
import { buildPrompt as analystPrompt } from './analyst/mastra-strategy-analyst.ts';
import type { ResearcherInput } from '../ports/researcher.port.ts';
import type { StrategyProfile, AnalystProfileOutput } from '../domain/strategy-profile.ts';

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
    const cleanAnalystProfile: AnalystProfileOutput = {
      direction: 'long',
      coreIdea: 'Buy when open interest spikes above the 20-bar mean.',
      summary: 'A long-only strategy that enters when OI momentum is strong.',
      requiredMarketFeatures: ['oi', 'funding'],
      entryConditions: ['OI > 20-bar mean * 1.05', 'Price above EMA20'],
      exitConditions: ['Stop-loss at -2%', 'Take-profit at +4%'],
      timeframes: ['5m'],
      indicators: ['EMA20'],
      parameters: [{ name: 'oiMultiplier', value: 1.05, unit: null, description: 'OI threshold multiplier', tunable: true }],
      watchLifecycleSummary: 'Scan every bar for OI spike',
      positionManagementSummary: 'Partial exit at TP1',
      riskManagementSummary: 'Fixed stop at -2%',
      runnerOwnedAuthorities: ['position sizing', 'fills'],
      confidence: 0.8,
      unknowns: ['Slippage model'],
      evidence: ['OI spike precedes price move (backtested 3 months)'],
    };
    const dirtyProfile = { ...cleanAnalystProfile, ...EXTRAS } as AnalystProfileOutput;
    expect(buildStrategyUserMessage(dirtyProfile)).toBe(buildStrategyUserMessage(cleanAnalystProfile));
    expect(buildStrategyUserMessage(dirtyProfile)).not.toContain(String(SENTINEL));
  });

  it('strategy-analyst prompt renders only the operator-supplied source (no outcome path)', () => {
    // StrategyAnalyst input = the raw strategy source the operator submitted (kind/title/uri/
    // content). It has no automated outcome-bearing input; this guard freezes that property.
    const clean = { kind: 'article', title: 'OI strategy', uri: 'memory://src', content: 'Buy on OI spike.' };
    const dirty = { ...clean, ...EXTRAS };
    type AI = Parameters<typeof analystPrompt>[0];
    expect(analystPrompt(dirty as unknown as AI)).toBe(analystPrompt(clean as unknown as AI));
    expect(analystPrompt(dirty as unknown as AI)).not.toContain(String(SENTINEL));
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
- Verify only: `src/orchestrator/handlers/paper-monitor.handler.test.ts` (existing exact-payload pin; no change expected)

- [ ] **Step 1: research-run-cycle sentinel tests**

Append to `src/orchestrator/handlers/research-run-cycle.handler.test.ts`, inside the top-level `describe('researchRunCycleHandler')`. The file already provides everything needed: `makeServices`, `capturingResearcher(out)` (records the `ResearcherInput`), `profile()` (id `'p1'`), `task(payload)` (id `'t1'`), `seedProfile(services)`, and the pattern `await services.revisions.create(revision)` (see the `activeOverlayRules` describe block at the bottom of the file):

```ts
  describe('outcome embargo (layer 1) — researcher input purity', () => {
    const SENTINEL = '987654.321';
    const SENTINEL_DATE = '2031-12-31T23:59:59.000Z';

    it('an accepted revision with holdoutValidation never leaks it into the researcher input', async () => {
      const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
      const services = makeServices({ researcher: cap.port });
      await seedProfile(services);
      const rev: StrategyRevision = {
        id: 'rev-emb', strategyProfileId: 'p1', version: 1, hypothesisIds: ['h1'],
        mergedRuleSet: {
          order: ['h1'],
          rules: [{ appliesTo: 'long', rules: [{ when: 'oi rises', action: 'skip_entry', params: {} }] }],
          theses: ['safe thesis'],
        },
        status: 'accepted',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      };
      await services.revisions.create({
        ...rev,
        // Runtime holdout payload as the R3a gate persists it on accepted revisions:
        holdoutValidation: {
          holdoutMetrics: { sharpe: Number(SENTINEL) },
          trainMetrics: { sharpe: 1 },
          holdoutDecision: 'FAIL', holdoutReasons: ['holdout_failed'],
          t: SENTINEL_DATE, mode: 'trade_based',
        },
      } as unknown as StrategyRevision);

      await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

      const captured = JSON.stringify(cap.captured());
      expect(captured).not.toContain(SENTINEL);
      expect(captured).not.toContain(SENTINEL_DATE);
      expect(captured).not.toContain('holdoutValidation');
      // positive control: the accepted revision's rules DID reach the researcher
      expect(captured).toContain('oi rises');
    });

    it('a legacy persisted payload with dirty feedback reaches the researcher sanitized + is evidenced', async () => {
      const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
      const services = makeServices({ researcher: cap.port });
      await seedProfile(services);

      await researchRunCycleHandler(task({
        strategyProfileId: 'p1', cycleDepth: 1,
        feedback: {
          hypothesisId: 'h1', decision: 'FAIL',
          reasons: ['no_improvement_over_baseline', `holdout_failed: sharpe=${SENTINEL}`],
        },
      }), services);

      const captured = JSON.stringify(cap.captured());
      expect(captured).not.toContain(SENTINEL);
      // positive control: the allowlisted reason survived
      expect(captured).toContain('no_improvement_over_baseline');
      // every scrub hit is evidenced — index paths only, never the dropped text
      const events = await services.events.listByTask('t1');
      const scrub = events.filter((e) => e.type === 'outcome_embargo.scrubbed');
      expect(scrub).toHaveLength(1);
      expect(scrub[0]!.payload).toEqual({
        site: 'researchRunCycle.retryFeedback', removedKeys: ['reasons[1]'],
      });
    });
  });
```

`capturingResearcher`, `seedProfile`, `task`, and `researchRunCycleHandler` already exist in this file; `StrategyRevision` is already imported there. No new imports are needed.

- [ ] **Step 2: W3 payload — verify existing pin**

No new code. The W3 id-only invariant is ALREADY frozen by the existing test in `src/orchestrator/handlers/paper-monitor.handler.test.ts` (the `window_complete` test asserts `expect(queuedCycleTask?.payload).toEqual({ strategyProfileId: 'prof-1', paperRunId: 'run-live-3' })` — an exact-object match, so no metric/window key can ever ride the Cycle-2 trigger unnoticed). Confirm the assertion is still present and exact (`toEqual` with the full literal, not `toMatchObject`); if it ever degrades to a partial match, restore the exact form.

- [ ] **Step 3: Run to verify**

Run: `pnpm vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts src/orchestrator/handlers/paper-monitor.handler.test.ts`
Expected: PASS. (The revision sentinel test should pass already — the handler maps only `mergedRuleSet`-derived fields; it exists to catch future widening. The dirty-feedback test passes thanks to Task 6's read-side sanitize + event.)

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "test(embargo): layer-1 orchestration sentinel — researcher input purity incl. legacy dirty feedback"
```

---

### Task 11: S5 — event payload regression guards

**Files:**
- Test: `src/orchestrator/handlers/cycle-scorecard.handler.test.ts` (extend)
- Test: `src/read-api/mappers.test.ts` (extend)

- [ ] **Step 1: `cycle.scorecard.built` exact-payload test**

Append to `src/orchestrator/handlers/cycle-scorecard.handler.test.ts`, inside the top-level `describe('cycleScorecardHandler')`. The file already defines the helpers used below: `buildTask(id, hypId, correlationId)`, `hypothesis(id, over)`, `backtestRun(id, hypId, correlationId)`, `evaluation(id, backtestRunId, hypId, decision, createdAt)`, `T(n)`, and `scorecardTask(payload, overrides)`:

```ts
  it('outcome embargo (S5): cycle.scorecard.built payload is exactly { correlationId }', async () => {
    const services = makeServices();
    await services.researchTasks.create(buildTask('bt-h1', 'h1', 'c-emb'));
    await services.hypotheses.create(hypothesis('h1', { status: 'proxy_passed' }));
    const run1 = backtestRun('run-h1', 'h1', 'c-emb');
    await services.backtests.createSubmitted(run1);
    await services.evaluations.create(evaluation('e-h1', 'run-h1', 'h1', 'PASS', T(1)));

    const task = scorecardTask({
      correlationId: 'c-emb', strategyProfileId: 'p1', sourceTaskId: 'src-1',
      terminalOutcome: { kind: 'no_candidates', reason: 'none' },
    });
    await cycleScorecardHandler(task, services);

    const events = await services.events.listByTask(task.id);
    const built = events.filter((e) => e.type === 'cycle.scorecard.built');
    expect(built).toHaveLength(1);
    expect(built[0]!.payload).toEqual({ correlationId: 'c-emb' });
  });
```

Note: if `terminalOutcome.kind: 'no_candidates'` is not a valid kind in `CycleScorecardPayloadSchema`, reuse the exact `terminalOutcome` literal from the file's first happy-path test (`{ kind: 'accepted', reason: 'pnl_improved' }` with `revisionId`/roster fixtures as that test seeds them) — the assertion under test is only the event payload shape.

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
