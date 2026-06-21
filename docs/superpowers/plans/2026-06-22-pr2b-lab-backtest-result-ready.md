# PR2b PR1 (lab) — `backtest.result_ready` terminal event — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single hand-authored `backtest.result_ready` terminal agent-event to the lab's `backtestCompletedHandler`, symmetric with `research.run_cycle.completed`, so a downstream consumer can detect a finished per-hypothesis backtest from one event type.

**Architecture:** Purely additive. After the existing `switch (decision)` (which emits the five `hypothesis.*` events), append one more `AgentEvent` of type `backtest.result_ready` carrying `{decision, profileId, hypothesisId, backtestRunId}`. No status/return-contract change; the five `hypothesis.*` events stay. Dormant until the office (PR2) consumes it.

**Tech Stack:** TypeScript, `node --experimental-strip-types`, Vitest. Orchestrator handler pattern (`event()` helper + `services.events.append`).

## Global Constraints

- Runtime is `node --experimental-strip-types` — **no TS parameter properties** anywhere under `src/` (the AST guard `src/strip-types-no-param-properties.test.ts` fails the suite otherwise). This task adds only function-body statements, so it is unaffected, but keep any new code free of `constructor(private x)` forms.
- Additive only: the five existing `hypothesis.*` emissions MUST remain unchanged.
- `event(taskId, type, payload)` helper lives at `src/orchestrator/handlers/backtest-support.ts:14`; `services.events.append(...)` takes a single `AgentEvent` and is awaited.
- The in-scope profile field is `strategyProfileId`; the event payload key is `profileId` (mirror `completion-summary.ts:114`).

---

### Task 1: Emit `backtest.result_ready` as the handler's final event

**Files:**
- Modify: `src/orchestrator/handlers/backtest-completed.handler.ts` (handler ~`:53`, append after the `switch (decision)` block, before the handler falls off the end)
- Test: `src/orchestrator/handlers/backtest-completed.handler.test.ts` (add cases; mirror the existing test harness in this file — the in-memory events recorder / `services` builder used by the sibling `hypothesis.*` assertions)

**Interfaces:**
- Consumes: `event(taskId: string, type: string, payload: Record<string, unknown>): AgentEvent` (`backtest-support.ts:14`); `services.events.append(e: AgentEvent): Promise<void>`; the handler's top-level bindings `const { backtestRunId, hypothesisId, strategyProfileId, decision, reasons, cycleDepth } = parsed.data;` (`backtest-completed.handler.ts:57`).
- Produces: an `AgentEvent` with `type === 'backtest.result_ready'` and `payload === { decision, profileId, hypothesisId, backtestRunId }`, appended last for every decision. (Consumed by office PR2's `DownstreamBacktestWatcher`.)

- [ ] **Step 1: Write the failing test**

Add to `src/orchestrator/handlers/backtest-completed.handler.test.ts`, reusing whatever `services` / event-recorder factory the existing tests in this file already use (search the file for how it constructs `services` and reads appended events — do NOT invent a new harness). The new assertion, expressed against the recorded events list:

```ts
it('emits backtest.result_ready as the final event for a PASS decision', async () => {
  // Arrange: build the task + services exactly as the sibling PASS test does,
  // with payload { backtestRunId: 'bt-1', hypothesisId: 'hyp-1', strategyProfileId: 'prof-1',
  //   decision: 'PASS', reasons: ['ok'], cycleDepth: 0 } (match the existing builder).
  // Act:
  await backtestCompletedHandler(ctx); // same call shape the sibling tests use

  // Assert: hypothesis.passed still emitted (additive guarantee)
  const types = recordedEvents.map((e) => e.type);
  expect(types).toContain('hypothesis.passed');

  // Assert: backtest.result_ready is the LAST event, with the remapped payload
  const last = recordedEvents[recordedEvents.length - 1];
  expect(last.type).toBe('backtest.result_ready');
  expect(last.payload).toEqual({
    decision: 'PASS', profileId: 'prof-1', hypothesisId: 'hyp-1', backtestRunId: 'bt-1',
  });
});

it('emits backtest.result_ready for a FAIL decision too', async () => {
  // Same setup with decision: 'FAIL'.
  await backtestCompletedHandler(ctx);
  const last = recordedEvents[recordedEvents.length - 1];
  expect(last.type).toBe('backtest.result_ready');
  expect(last.payload).toMatchObject({ decision: 'FAIL', profileId: 'prof-1' });
});
```

Note: `profileId` in the asserted payload maps from the in-scope `strategyProfileId`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/orchestrator/handlers/backtest-completed.handler.test.ts`
Expected: FAIL — the new assertions fail because no `backtest.result_ready` event is appended (the last event is `hypothesis.passed` / `hypothesis.failed`).

- [ ] **Step 3: Add the trailing append in the handler**

In `src/orchestrator/handlers/backtest-completed.handler.ts`, after the `switch (decision) { … }` block closes and before the handler ends, add:

```ts
  await services.events.append(event(task.id, 'backtest.result_ready', {
    decision,
    profileId: strategyProfileId,
    hypothesisId,
    backtestRunId,
  }));
```

Use `task.id` as the first `event()` argument (matching every existing call in this handler). Do not touch the `switch` or any `hypothesis.*` append.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/orchestrator/handlers/backtest-completed.handler.test.ts`
Expected: PASS — both new tests green; all pre-existing tests in the file still green.

- [ ] **Step 5: Run the full suite + typecheck + strip-types guard**

Run: `npx vitest run && npm run typecheck`
Expected: full suite green (including `src/strip-types-no-param-properties.test.ts`); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/backtest-completed.handler.ts src/orchestrator/handlers/backtest-completed.handler.test.ts
git commit -m "feat(orchestrator): emit backtest.result_ready terminal event from backtestCompletedHandler"
```

---

## Self-review notes

- **Spec coverage:** implements spec §"Change 1 — LAB". The five `hypothesis.*` events stay (additive guarantee asserted). Payload `{decision, profileId, hypothesisId, backtestRunId}` matches the spec.
- **Race:** intentionally fires before the worker sets `status: 'completed'` — the office side absorbs it via bounded retry (spec §"Change 3"); nothing to do here.
- **No new endpoint / no schema migration** — events table is unchanged (new rows, existing columns).

## Done criteria

Full lab suite + typecheck green; one additive event type; SP-4 / read-API paths untouched. This PR is dormant until office PR2 consumes the event — safe to merge first.
