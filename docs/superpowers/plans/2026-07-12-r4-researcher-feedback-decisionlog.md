# R4 — feedback + decision-log into researcher prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The researcher prompt carries the prior attempt's verdict+reasons (framed "must address, not repeat") and a bounded decision-log excerpt for losing trades, and the dead −20/+180 minuteContext fetch is stopped.

**Architecture:** Four small tasks. Task 0 flips the trade-evidence fetch window to 0/0 (stops dead IO). Task 1 adds the narrow `DecisionExcerpt` contract + a pure `toDecisionExcerpts` helper. Task 2 wires the run-cycle handler (thread `payload.feedback`; fetch+map decision logs). Task 3 renders both blocks in `buildPrompt`. All new `ResearcherInput` fields are optional → existing call sites/the fake stay valid.

**Tech Stack:** TypeScript (`node --experimental-strip-types`), Vitest, pnpm. SDK ops-read DTOs via `@trdlabs/sdk/ops-read` re-exported through `bot-results-read.port.ts`.

## Global Constraints

- Lab imports carry the `.ts` extension. No TS parameter properties. No new env vars.
- `DECISION_EXCERPT_CAP = 20`, `DECISION_PRE_ENTRY_MARGIN_MS = 60_000`.
- `DecisionExcerpt` is a narrow lab shape — NEVER pass the raw SDK `DecisionLogEntry` into `ResearcherInput`/the prompt.
- decision-log fetch is bounded: one page per distinct loser run, no pagination walk, fail-soft (a `getDecisionLog` error drops that run's excerpts, never fails the cycle), global cap 20.
- Branch: `feat/r4-researcher-feedback-decisionlog` (base main, HEAD `10a54e0` = spec). Spec: `docs/superpowers/specs/2026-07-12-r4-researcher-feedback-decisionlog-design.md`.
- Verify per task: `npx tsc --noEmit` clean + the task's test file green; final task runs `npx vitest run`.

---

### Task 0: stop the dead minuteContext fetch (0/0 window)

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts:214-218`
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts`

**Interfaces:**
- Consumes: existing `services.tradeEvidence.getTradeEvidence({ tradeIds, minuteWindowBefore, minuteWindowAfter })`.
- Produces: nothing new — behavior change only (empty minuteContext requested).

- [ ] **Step 1: Write the failing test** (add to `research-run-cycle.handler.test.ts`, in the block that drives a cycle with suspicious trades). Capture the query passed to `getTradeEvidence` (spy or fake records its arg) and assert the window is 0/0:

```typescript
it('requests trade-evidence with a 0/0 minute window (no dead minuteContext fetch)', async () => {
  const calls: { minuteWindowBefore: number; minuteWindowAfter: number }[] = [];
  // reuse this file's cycle harness; make services.tradeEvidence.getTradeEvidence record its arg:
  const services = makeCycleServices(); // <- the file's existing helper that builds run-cycle services
  const orig = services.tradeEvidence.getTradeEvidence.bind(services.tradeEvidence);
  services.tradeEvidence.getTradeEvidence = async (q) => { calls.push({ minuteWindowBefore: q.minuteWindowBefore, minuteWindowAfter: q.minuteWindowAfter }); return orig(q); };
  await researchRunCycleHandler(cycleTaskWithSuspiciousTrades(), services); // <- existing harness task that yields suspicious losers
  expect(calls[0]).toEqual({ minuteWindowBefore: 0, minuteWindowAfter: 0 });
});
```

(Use the file's existing service/task builders — read the top of the test file and mirror the harness that already exercises the suspicious-trades → getTradeEvidence path. Only the arg-capture and the assertion are new.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts -t "0/0 minute window"`
Expected: FAIL — current call passes `20`/`180`.

- [ ] **Step 3: Change the fetch window** (`research-run-cycle.handler.ts`, the `getTradeEvidence` call ~214-218)

```typescript
      tradeEvidence = await services.tradeEvidence.getTradeEvidence({
        tradeIds: suspicious.map((t) => t.tradeId),
        minuteWindowBefore: 0,
        minuteWindowAfter: 0,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts -t "0/0 minute window"`
Expected: PASS. Also run the whole file — if a pre-existing test asserted the 20/180 window, update it to 0/0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(r4): stop the dead minuteContext fetch (0/0 trade-evidence window)"
```

---

### Task 1: `DecisionExcerpt` contract + `toDecisionExcerpts` pure helper

**Files:**
- Modify: `src/ports/researcher.port.ts` (add `DecisionExcerpt` + two `ResearcherInput` fields)
- Create: `src/research/decision-excerpts.ts`
- Test: `src/research/decision-excerpts.test.ts`

**Interfaces:**
- Produces:
  - `interface DecisionExcerpt { runId: string; timestampMs?: number; action?: string; reason?: string; summary?: string; relatedTradeId?: string }`
  - `ResearcherInput.retryFeedback?: { decision: string; reasons: readonly string[] }`
  - `ResearcherInput.decisionExcerpts?: readonly DecisionExcerpt[]`
  - `toDecisionExcerpts(entries: readonly DecisionLogEntry[], losers: readonly ClosedTrade[], cap?: number): DecisionExcerpt[]`
  - consts `DECISION_EXCERPT_CAP = 20`, `DECISION_PRE_ENTRY_MARGIN_MS = 60_000`

- [ ] **Step 1: Add the contract** (`src/ports/researcher.port.ts`)

Add the interface and the two optional fields to `ResearcherInput`:

```typescript
export interface DecisionExcerpt {
  runId: string;
  timestampMs?: number;
  action?: string;
  reason?: string;
  summary?: string;
  relatedTradeId?: string;
}
```

Inside `ResearcherInput` (after `activeOverlayRules?`):

```typescript
  retryFeedback?: { decision: string; reasons: readonly string[] };
  decisionExcerpts?: readonly DecisionExcerpt[];
```

- [ ] **Step 2: Write the failing helper tests** (`src/research/decision-excerpts.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { toDecisionExcerpts, DECISION_EXCERPT_CAP } from './decision-excerpts.ts';
import type { DecisionLogEntry, ClosedTrade } from '../ports/bot-results-read.port.ts';

function trade(over: Partial<ClosedTrade>): ClosedTrade {
  return { tradeId: 't1', runId: 'r1', symbol: 'HUSDT', side: 'long', openedAtMs: 1_000_000, closedAtMs: 2_000_000,
    entryPrice: null, exitPrice: null, realizedPnl: '-1', pnlPct: '-1', isWin: false, closeReason: null, closeReasonRaw: null, ...over };
}
function entry(over: Partial<DecisionLogEntry>): DecisionLogEntry {
  return { category: 'hold', runId: 'r1', botId: 'b1', symbol: 'HUSDT', side: 'long', reason: 'oi rising', tsMs: 1_500_000, safeMessage: 'held through pullback', ...over };
}

describe('toDecisionExcerpts', () => {
  it('keeps entries inside a loser window and maps SDK fields', () => {
    const r = toDecisionExcerpts([entry({})], [trade({})]);
    expect(r).toEqual([{ runId: 'r1', timestampMs: 1_500_000, action: 'hold', reason: 'oi rising', summary: 'held through pullback', relatedTradeId: 't1' }]);
  });
  it('captures the entry decision logged up to 60s before openedAtMs', () => {
    const r = toDecisionExcerpts([entry({ tsMs: 1_000_000 - 30_000 })], [trade({})]);
    expect(r).toHaveLength(1);
  });
  it('drops entries outside every window', () => {
    expect(toDecisionExcerpts([entry({ tsMs: 5_000_000 })], [trade({})])).toEqual([]);
  });
  it('requires same runId (no cross-run match on overlapping ts)', () => {
    expect(toDecisionExcerpts([entry({ runId: 'rX' })], [trade({ runId: 'r1' })])).toEqual([]);
  });
  it('treats closedAtMs null as an upper bound of openedAtMs', () => {
    const r = toDecisionExcerpts([entry({ tsMs: 1_000_000 })], [trade({ closedAtMs: null })]);
    expect(r).toHaveLength(1);
    expect(toDecisionExcerpts([entry({ tsMs: 1_500_000 })], [trade({ closedAtMs: null })])).toEqual([]);
  });
  it('on overlap, the first loser in selection order wins', () => {
    const losers = [trade({ tradeId: 'first', openedAtMs: 1_000_000, closedAtMs: 3_000_000 }),
                    trade({ tradeId: 'second', openedAtMs: 1_000_000, closedAtMs: 3_000_000 })];
    const r = toDecisionExcerpts([entry({ tsMs: 2_000_000 })], losers);
    expect(r[0]?.relatedTradeId).toBe('first');
  });
  it('caps at DECISION_EXCERPT_CAP, ordered by loser selection then tsMs', () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry({ tsMs: 1_100_000 + i }));
    const r = toDecisionExcerpts(entries, [trade({})]);
    expect(r).toHaveLength(DECISION_EXCERPT_CAP);
    expect(r[0]?.timestampMs).toBe(1_100_000);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/research/decision-excerpts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the helper** (`src/research/decision-excerpts.ts`)

```typescript
import type { DecisionLogEntry, ClosedTrade } from '../ports/bot-results-read.port.ts';
import type { DecisionExcerpt } from '../ports/researcher.port.ts';

export const DECISION_EXCERPT_CAP = 20;
export const DECISION_PRE_ENTRY_MARGIN_MS = 60_000;

/**
 * Pure filter+map+cap of decision-log entries to the narrow DecisionExcerpt shape. Keeps only
 * entries that fall in a selected losing trade's window [openedAtMs - margin, closedAtMs ?? openedAtMs]
 * AND share its runId. On overlap the first loser in selection order wins (one excerpt per entry).
 * Deterministic order: loser selection index, then tsMs ascending. Never mutates inputs, no clock.
 */
export function toDecisionExcerpts(
  entries: readonly DecisionLogEntry[],
  losers: readonly ClosedTrade[],
  cap: number = DECISION_EXCERPT_CAP,
): DecisionExcerpt[] {
  const windows = losers.map((t) => ({
    tradeId: t.tradeId,
    runId: t.runId,
    lo: t.openedAtMs - DECISION_PRE_ENTRY_MARGIN_MS,
    hi: t.closedAtMs ?? t.openedAtMs,
  }));
  const matched: Array<{ excerpt: DecisionExcerpt; order: number; tsMs: number }> = [];
  for (const e of entries) {
    const order = windows.findIndex((w) => w.runId === e.runId && e.tsMs >= w.lo && e.tsMs <= w.hi);
    if (order === -1) continue;
    matched.push({
      excerpt: {
        runId: e.runId,
        timestampMs: e.tsMs,
        action: e.category,
        reason: e.reason,
        summary: e.safeMessage,
        relatedTradeId: windows[order]!.tradeId,
      },
      order,
      tsMs: e.tsMs,
    });
  }
  matched.sort((a, b) => a.order - b.order || a.tsMs - b.tsMs);
  return matched.slice(0, cap).map((m) => m.excerpt);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/research/decision-excerpts.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc.

- [ ] **Step 6: Commit**

```bash
git add src/ports/researcher.port.ts src/research/decision-excerpts.ts src/research/decision-excerpts.test.ts
git commit -m "feat(r4): DecisionExcerpt contract + toDecisionExcerpts helper"
```

---

### Task 2: wire feedback + decision-log fetch into the run-cycle handler

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts` (after `suspicious`/`tradeEvidence` ~209-223; and the `ResearcherInput` object it builds ~360-375)
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts`

**Interfaces:**
- Consumes: `toDecisionExcerpts` (Task 1); `services.botResults.getDecisionLog(runId)` (returns `DecisionsPage` with `.items: DecisionLogEntry[]`); `payload.feedback` (`{ hypothesisId, decision, reasons }`); `suspicious: ClosedTrade[]`.
- Produces: the `ResearcherInput` passed to the researcher now carries `retryFeedback` (when `payload.feedback` present) and `decisionExcerpts` (when any matched).

- [ ] **Step 1: Write failing tests** (`research-run-cycle.handler.test.ts`)

```typescript
it('threads payload.feedback into researcher input as retryFeedback', async () => {
  const captured = captureResearcherInput(); // reuse the file's fake researcher that records propose(input)
  await researchRunCycleHandler(cycleTask({ feedback: { hypothesisId: 'h1', decision: 'FAIL', reasons: ['dd too high'] } }), captured.services);
  expect(captured.input?.retryFeedback).toEqual({ decision: 'FAIL', reasons: ['dd too high'] });
});

it('fetches getDecisionLog once per distinct loser run and attaches bounded excerpts', async () => {
  const runIds: string[] = [];
  const services = makeCycleServices(); // with >=1 suspicious loser
  const orig = services.botResults.getDecisionLog.bind(services.botResults);
  services.botResults.getDecisionLog = async (runId, cursor) => { runIds.push(runId); return orig(runId, cursor); };
  const captured = wrapCaptureResearcherInput(services);
  await researchRunCycleHandler(cycleTaskWithSuspiciousTrades(), services);
  // one call per DISTINCT loser run, single page (no cursor follow-up):
  expect(new Set(runIds).size).toBe(runIds.length);
  expect(captured.input?.decisionExcerpts && captured.input.decisionExcerpts.length).toBeGreaterThan(0);
  expect(captured.input!.decisionExcerpts!.length).toBeLessThanOrEqual(20);
});

it('is fail-soft: a getDecisionLog error drops that run\'s excerpts, cycle still succeeds', async () => {
  const services = makeCycleServices();
  services.botResults.getDecisionLog = async () => { throw new Error('ops-read down'); };
  const captured = wrapCaptureResearcherInput(services);
  await expect(researchRunCycleHandler(cycleTaskWithSuspiciousTrades(), services)).resolves.toBeUndefined();
  expect(captured.input?.decisionExcerpts ?? []).toEqual([]);
});

it('does not call getDecisionLog when there are no suspicious losers', async () => {
  let called = 0;
  const services = makeCycleServices({ noLosers: true });
  services.botResults.getDecisionLog = async (...a) => { called++; return { items: [], nextCursor: null, asOf: 0, window: {}, freshness: 'fresh' }; };
  await researchRunCycleHandler(cycleTask({}), services);
  expect(called).toBe(0);
});
```

(Reuse this file's existing harness for `makeCycleServices` / `cycleTask` / the fake researcher that captures `propose(input)`. If the file has no input-capturing fake, add a thin one that stores the last `input`. Names above are illustrative of the existing helpers — match what the file actually defines.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts -t "retryFeedback|getDecisionLog|fail-soft|no suspicious"`
Expected: FAIL — handler doesn't thread feedback or fetch decision logs yet.

- [ ] **Step 3: Add the assembly** (`research-run-cycle.handler.ts`, after the `tradeEvidence` try/catch block ~223, before the `ResearcherInput` is built)

```typescript
  // R4: bounded decision-log excerpts for the suspicious losers (fail-soft, one page per distinct run).
  const retryFeedback = payload.feedback
    ? { decision: payload.feedback.decision, reasons: payload.feedback.reasons }
    : undefined;

  let decisionExcerpts: DecisionExcerpt[] = [];
  if (suspicious.length > 0) {
    const distinctRunIds = [...new Set(suspicious.map((t) => t.runId))];
    const entries: DecisionLogEntry[] = [];
    for (const runId of distinctRunIds) {
      try {
        const page = await services.botResults.getDecisionLog(runId);
        entries.push(...page.items);
      } catch (err) {
        await services.events.append(event(task.id, 'researcher.decision_log_unavailable', { runId, error: errMsg(err) }));
      }
    }
    decisionExcerpts = toDecisionExcerpts(entries, suspicious);
  }
```

Add imports at the top: `import { toDecisionExcerpts } from '../../research/decision-excerpts.ts';` and, to the existing `bot-results-read.port.ts` type import, add `DecisionLogEntry`; add `DecisionExcerpt` to the existing `researcher.port.ts` type import.

- [ ] **Step 4: Attach to the researcher input** (`research-run-cycle.handler.ts`, in the `ResearcherInput` object literal ~360-375, alongside `tradeEvidence,`)

```typescript
      retryFeedback,
      decisionExcerpts: decisionExcerpts.length > 0 ? decisionExcerpts : undefined,
```

- [ ] **Step 5: Run tests + tsc**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(r4): thread retry feedback + bounded decision-log into researcher input"
```

---

### Task 3: render both blocks in `buildPrompt`

**Files:**
- Modify: `src/adapters/researcher/mastra-researcher.ts` (helpers + `buildPrompt` head ~131-137 and loss_reduction return ~161-168)
- Test: `src/adapters/researcher/mastra-researcher.test.ts`

**Interfaces:**
- Consumes: `ResearcherInput.retryFeedback`, `ResearcherInput.decisionExcerpts` (Task 1).
- Produces: prompt text — a retry-feedback block (both focuses) and a decision-excerpts block (loss_reduction).

- [ ] **Step 1: Write failing tests** (`mastra-researcher.test.ts` — this file already unit-tests `buildPrompt`/prompt text; mirror its style)

```typescript
it('renders the retry-feedback block with the address-not-repeat guard', () => {
  const prompt = buildPrompt(inputWith({ retryFeedback: { decision: 'MODIFY', reasons: ['pf below 1.2', 'dd 30%'] } }));
  expect(prompt).toContain('you MUST ADDRESS this, not merely repeat');
  expect(prompt).toContain('decision=MODIFY');
  expect(prompt).toContain('pf below 1.2; dd 30%');
});

it('renders decision-log excerpts with cross-reference framing', () => {
  const prompt = buildPrompt(inputWith({ focus: 'loss_reduction', decisionExcerpts: [
    { runId: 'r1', timestampMs: 1_500_000, action: 'hold', reason: 'oi rising', summary: 'held through pullback', relatedTradeId: 't7' },
  ] }));
  expect(prompt).toContain('Decision-log excerpts');
  expect(prompt).toContain('cross-reference tradeId');
  expect(prompt).toContain('[hold]');
  expect(prompt).toContain('tradeId=t7');
  expect(prompt).toContain('held through pullback');
});

it('omits both blocks when absent (no stray headers)', () => {
  const prompt = buildPrompt(inputWith({}));
  expect(prompt).not.toContain('you MUST ADDRESS');
  expect(prompt).not.toContain('Decision-log excerpts');
});
```

(`inputWith` = the file's existing helper for a minimal `ResearcherInput`; if absent, build a minimal valid input inline as the other tests in this file do. `buildPrompt` may be module-private — if the file tests via `MastraResearcher`/a fake agent capturing the prompt string, follow that pattern instead and assert on the captured prompt.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts -t "retry-feedback|decision-log excerpts|omits both"`
Expected: FAIL — blocks not rendered.

- [ ] **Step 3: Add the render helpers** (`mastra-researcher.ts`, near `forensicBundleText` ~107)

```typescript
function retryFeedbackText(fb: ResearcherInput['retryFeedback']): string[] {
  if (!fb) return [];
  return [
    'Feedback from your last attempt — you MUST ADDRESS this, not merely repeat the previous hypothesis:',
    `  decision=${fb.decision}`,
    `  reasons: ${fb.reasons.join('; ')}`,
  ];
}

function decisionExcerptsText(excerpts: ResearcherInput['decisionExcerpts']): string[] {
  if (!excerpts || excerpts.length === 0) return [];
  return [
    "Decision-log excerpts (the bot's own reasoning — why it entered / why it did not exit earlier;"
    + ' cross-reference tradeId against the trade\'s @entry/@exit/micro market values above):',
    ...excerpts.map((e) =>
      `  - [${e.action ?? 'unknown'}] tsMs=${e.timestampMs ?? 'unknown'} tradeId=${e.relatedTradeId ?? 'unknown'}`
      + ` reason=${e.reason ?? ''} :: ${e.summary ?? ''}`),
  ];
}
```

- [ ] **Step 4: Wire them into `buildPrompt`.** In the shared `head` array (~133-137), spread the feedback block so it appears for BOTH focuses:

```typescript
    ...retryFeedbackText(input.retryFeedback),
```

In the loss_reduction return array (~161-168, alongside `...forensicBundleText(input.tradeEvidence),` and `...loserBlock,`), spread the excerpts:

```typescript
    ...decisionExcerptsText(input.decisionExcerpts),
```

- [ ] **Step 5: Run tests + tsc + full suite**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts && npx tsc --noEmit && npx vitest run`
Expected: focused green, clean tsc, full suite green (0 failures).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/researcher/mastra-researcher.ts src/adapters/researcher/mastra-researcher.test.ts
git commit -m "feat(r4): render retry-feedback + decision-log blocks in the researcher prompt"
```

---

## Self-review notes

- **Spec coverage:** §3.0 → Task 0; §3.1 contract → Task 1; §3.2 assembly + bounded/fail-soft fetch → Task 2 (helper in Task 1); §3.3 rendering + guard → Task 3; §5 tests spread across Tasks 0-3; §6 deferred (non-entry/exit market snapshot; minuteContext field removal) intentionally NOT implemented.
- **Type consistency:** `DecisionExcerpt` fields (`runId`/`timestampMs`/`action`/`reason`/`summary`/`relatedTradeId`), `toDecisionExcerpts(entries, losers, cap?)`, `retryFeedback: { decision, reasons }`, consts `DECISION_EXCERPT_CAP`/`DECISION_PRE_ENTRY_MARGIN_MS` are identical across Tasks 1-3.
- **Harness reuse:** Tasks 0/2/3 tests reuse each file's existing cycle/prompt harness — the implementer must read the test file and mirror the real helper names (the plan's `makeCycleServices`/`inputWith`/`captureResearcherInput` are illustrative of the existing patterns, not guaranteed literal names).
- **No behavior change off the new paths:** all `ResearcherInput` additions are optional; `buildPrompt` blocks omit entirely when absent → byte-identical prompt for the no-feedback/no-losers case (locked by the "omits both blocks" test).
