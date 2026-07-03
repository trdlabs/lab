# Slice G4 — paper.monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a champion is admitted to paper (G2b), the lab watches the paper run via ops-read, decides by a trade-count-adaptive window policy when observation is complete, and auto-triggers `research.run_cycle {strategyProfileId, paperRunId}` (Cycle 2).

**Spec:** `docs/superpowers/specs/2026-07-03-paper-monitor-design.md` (APPROVED; user review blockers fixed).

**Architecture:** Self-rescheduling `paper.monitor` task (reserved enum value) using BullMQ delayed jobs via a new `delayMs` passthrough in `createAndEnqueueTask`. A pure `evaluatePaperWindow` policy function; a `PaperRunLocatorPort` seam (heuristic strategyName+startedAt adapter now, platform candidateId→runId link later); monitor state persisted as additive columns on `paper_submission` (migration 0017); `research.run_cycle` gains an optional `paperRunId` payload input loaded regardless of run status.

**Tech Stack:** TypeScript (node --experimental-strip-types), Drizzle + drizzle-kit (migration 0017), BullMQ delayed jobs, Vitest, `BotResultsReadPort` (ops-read DTOs re-exported).

## Global Constraints

- Reserved task type `'paper.monitor'` already in AGENT_TASK_TYPES — enum unchanged.
- `src/adapters/platform/paper-intake.port.ts` NOT modified.
- Window policy semantics EXACTLY per spec §3: watching / window_complete(normal) / window_complete(lowConfidence) / stalled; stalled → NO Cycle 2 trigger.
- Policy env validation fail-fast at composition: positive ints; `lowConfidenceThreshold <= minTrades`; `minDays <= maxDays`; `maxWaitDays >= 1`.
- Cycle 2 trigger payload `{strategyProfileId, paperRunId}`, source `'platform'`, dedupeKey `paper_window:${runId}` — exactly once per window.
- run_cycle's existing finished-filter behavior byte-identical when `paperRunId` absent.
- Monitor re-enqueue dedupeKey `paper.monitor:${experimentId}:${attempt}`; resume CLI uses `paper.monitor:${experimentId}:resume-${YYYYMMDDHHmm}`.
- Ledger seeding (`monitor_status='watching'`, `window_policy`, `observed_trades=0`, `strategy_name`) happens in `paperStartHandler` BEFORE enqueueing paper.monitor.
- Migration 0017 ADDITIVE only (ALTER TABLE paper_submission ADD COLUMNs). NO TS parameter properties.
- Gates per task: focused vitest; task-completing commit only after `npm run typecheck` clean + FULL `npm test` 0 failed (baseline on this branch: 2907 passed).

---

### Task 1: `delayMs` passthrough in `createAndEnqueueTask`

**Files:**
- Modify: `src/orchestrator/task-intake.ts` (TaskIntakeInput += `delayMs?: number`; `queue.enqueue(envelope, input.delayMs !== undefined ? { delayMs: input.delayMs } : undefined)`)
- Test: `src/orchestrator/task-intake.test.ts` (extend if exists, else create alongside)

**Interfaces:**
- Consumes: `TaskQueuePort.enqueue(envelope, opts?: { delayMs?: number })` (src/ports/task-queue.port.ts:6 — already supports it).
- Produces: `TaskIntakeInput.delayMs?: number` — Tasks 5/6/8 rely on this exact field name.

- [ ] **Step 1: Failing test** (fake queue records enqueue opts):

```ts
it('passes delayMs through to queue.enqueue opts', async () => {
  const calls: Array<{ envelope: QueueEnvelope; opts?: { delayMs?: number } }> = [];
  const queue = { enqueue: async (envelope, opts) => { calls.push({ envelope, opts }); }, process: () => {}, close: async () => {} };
  await createAndEnqueueTask(
    { taskType: 'paper.monitor', source: 'platform', payload: {}, delayMs: 5000 },
    { repo: new InMemoryResearchTaskRepository(), queue },
  );
  expect(calls[0]?.opts).toEqual({ delayMs: 5000 });
});

it('omits opts when delayMs is not set (existing behavior)', async () => {
  /* same fixture, no delayMs */ expect(calls[0]?.opts).toBeUndefined();
});
```

(Adapt fixture names to the existing test file's helpers if it exists; the in-memory task repo lives in src/adapters/repository/.)

- [ ] **Step 2: Run** `npx vitest run src/orchestrator/task-intake.test.ts` — FAIL (unknown property / opts undefined).
- [ ] **Step 3: Implement** — add the field and the conditional opts argument; doc-comment on the field: "BullMQ delayed job; in-memory adapter ignores it (test-time immediacy)".
- [ ] **Step 4:** Focused PASS → typecheck → FULL suite.
- [ ] **Step 5: Commit** `feat(orchestrator): delayMs passthrough in createAndEnqueueTask (BullMQ delayed jobs)`

---

### Task 2: `PaperWindowPolicy` + `evaluatePaperWindow` + env loading/validation

**Files:**
- Create: `src/domain/paper-window.ts`
- Modify: `src/config/env.ts` (five env vars, mirror existing optional-number patterns)
- Test: `src/domain/paper-window.test.ts`

**Interfaces:**
- Produces (Tasks 5/6 rely on):

```ts
export interface PaperWindowPolicy {
  minTrades: number;              // env PAPER_WINDOW_MIN_TRADES, default 30
  lowConfidenceThreshold: number; // env PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD, default 15
  minDays: number;                // env PAPER_WINDOW_MIN_DAYS, default 3
  maxDays: number;                // env PAPER_WINDOW_MAX_DAYS, default 30
  maxWaitDays: number;            // env PAPER_MONITOR_MAX_WAIT_DAYS, default 7
}
export type PaperWindowVerdict =
  | { state: 'watching' }
  | { state: 'window_complete'; lowConfidence: boolean }
  | { state: 'stalled' };
export function validatePaperWindowPolicy(p: PaperWindowPolicy): void; // throws with the violated invariant named
export function evaluatePaperWindow(policy: PaperWindowPolicy, input: { runStartedAtMs: number; nowMs: number; closedTrades: number }): PaperWindowVerdict;
```

- [ ] **Step 1: Failing tests** — table over the five §3 branches + boundaries:

```ts
const P = { minTrades: 30, lowConfidenceThreshold: 15, minDays: 3, maxDays: 30, maxWaitDays: 7 };
const day = 24 * 3600 * 1000;
it.each([
  ['before minDays even with enough trades', 2 * day, 100, { state: 'watching' }],
  ['enough trades at minDays boundary', 3 * day, 30, { state: 'window_complete', lowConfidence: false }],
  ['too few trades mid-window', 10 * day, 5, { state: 'watching' }],
  ['maxDays with lowConfidence band', 30 * day, 20, { state: 'window_complete', lowConfidence: true }],
  ['maxDays below lowConfidence threshold', 30 * day, 10, { state: 'stalled' }],
  ['just under maxDays stays watching', 30 * day - 1, 10, { state: 'watching' }],
])('%s', (_n, elapsed, trades, expected) => {
  expect(evaluatePaperWindow(P, { runStartedAtMs: 0, nowMs: elapsed, closedTrades: trades })).toEqual(expected);
});

it.each([
  [{ ...P, minTrades: 0 }, /positive/],
  [{ ...P, lowConfidenceThreshold: 31 }, /lowConfidenceThreshold/],
  [{ ...P, minDays: 31 }, /minDays/],
  [{ ...P, maxWaitDays: 0 }, /maxWaitDays/],
])('validate rejects bad policy %#', (p, re) => {
  expect(() => validatePaperWindowPolicy(p)).toThrow(re);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the ordered ladder exactly:

```ts
export function evaluatePaperWindow(policy: PaperWindowPolicy, input: { runStartedAtMs: number; nowMs: number; closedTrades: number }): PaperWindowVerdict {
  const elapsedDays = (input.nowMs - input.runStartedAtMs) / (24 * 3600 * 1000);
  if (elapsedDays < policy.minDays) return { state: 'watching' };
  if (input.closedTrades >= policy.minTrades) return { state: 'window_complete', lowConfidence: false };
  if (elapsedDays >= policy.maxDays) {
    return input.closedTrades >= policy.lowConfidenceThreshold
      ? { state: 'window_complete', lowConfidence: true }
      : { state: 'stalled' };
  }
  return { state: 'watching' };
}
```

env.ts: five vars parsed as numbers with the defaults above (mirror how existing numeric envs are read); composition will call `validatePaperWindowPolicy` (Task 5).

- [ ] **Step 4:** Focused PASS → typecheck → FULL suite. **Step 5: Commit** `feat(research): PaperWindowPolicy + evaluatePaperWindow (trade-count adaptive paper window, §2.5)`

---

### Task 3: Ledger monitor columns (migration 0017) + `updateMonitorState`

**Files:**
- Modify: `src/domain/paper-submission.ts`, `src/db/schema.ts` (paperSubmission table), `src/ports/paper-submission.repository.ts`, both repo adapters
- Create: migration via `npm run db:generate` → `migrations/0017_*.sql`
- Test: `src/adapters/repository/in-memory-paper-submission.repository.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
// domain PaperSubmission += (all optional):
strategyName?: string;
paperRunId?: string;
runStartedAtMs?: number;
monitorStatus?: 'watching' | 'window_complete' | 'stalled';
observedTrades?: number;
windowPolicy?: Record<string, unknown>;
lowConfidence?: boolean;

// port +=
updateMonitorState(experimentId: string, patch: Partial<Pick<PaperSubmission,
  'strategyName' | 'paperRunId' | 'runStartedAtMs' | 'monitorStatus' | 'observedTrades' | 'windowPolicy' | 'lowConfidence'>> & { updatedAt: string }): Promise<void>;
```

- [ ] **Step 1: Failing tests** — round-trip of the new fields through upsert+find; `updateMonitorState` patches only named fields (others untouched), throws or no-ops deterministically on unknown experimentId (pick: throw with experimentId in message — test pins it).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** — schema columns `strategy_name text`, `paper_run_id text`, `run_started_at_ms bigint` (drizzle `bigint('run_started_at_ms', { mode: 'number' })`), `monitor_status text`, `observed_trades integer`, `window_policy jsonb`, `low_confidence boolean`; drizzle updateMonitorState = `update().set(definedFieldsOnly).where(eq(experimentId))`; mapper `?? undefined` symmetry.
- [ ] **Step 4:** `npm run db:generate` → verify 0017 contains ONLY the seven ADD COLUMNs on paper_submission. Focused PASS → typecheck → FULL suite.
- [ ] **Step 5: Commit** `feat(research): paper_submission monitor state — additive 0017 + updateMonitorState`

---

### Task 4: `PaperRunLocatorPort` + heuristic adapter

**Files:**
- Create: `src/ports/paper-run-locator.port.ts`, `src/adapters/platform/heuristic-paper-run-locator.ts`
- Test: `src/adapters/platform/heuristic-paper-run-locator.test.ts`

**Interfaces:**
- Consumes: `BotResultsReadPort.listBotRuns({mode:'paper'})` → `BotRunRecord[]` (fields used: `runId`, `strategy.name`, `startedAtMs`).
- Produces:

```ts
export interface PaperRunLocatorPort {
  locate(args: { strategyName: string; submittedAtMs: number }): Promise<{ runId: string; startedAtMs: number } | null>;
}
export class HeuristicPaperRunLocator implements PaperRunLocatorPort {
  constructor(botResults: Pick<BotResultsReadPort, 'listBotRuns'>); // NO parameter properties — assign in body
}
```

- [ ] **Step 1: Failing tests** (fake listBotRuns): matches newest run with `strategy.name === strategyName && startedAtMs > submittedAtMs`; ignores earlier-started runs; ignores other names; null when nothing matches; two candidates → the newer one wins.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (filter → sort desc by startedAtMs → first; header doc-comment: "TEMPORARY heuristic join — replaced by the platform candidateId→runId link per handoff doc; seam isolated here by design").
- [ ] **Step 4:** Focused PASS → typecheck. **Step 5: Commit** `feat(research): PaperRunLocatorPort + heuristic strategyName/startedAt adapter (temporary seam)`

---

### Task 5: `paperStartHandler` — seed watching state + schedule monitor + `ensureMonitorScheduled`

**Files:**
- Modify: `src/orchestrator/handlers/paper-start.handler.ts`, `src/orchestrator/app-services.ts` (+`paperWindowPolicy: PaperWindowPolicy`, `paperMonitorPollMs: number`), `src/composition.ts` (build policy from env + `validatePaperWindowPolicy` fail-fast + `PAPER_MONITOR_POLL_MS` default 21600000)
- Test: `src/orchestrator/handlers/paper-start.handler.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 `delayMs`, Task 2 policy, Task 3 `updateMonitorState`/new fields.
- Produces: on `ok:true && admissionStatus === 'admitted'` the upsert row now ALSO carries `strategyName: args.identity.strategyName, monitorStatus: 'watching', observedTrades: 0, windowPolicy: {...services.paperWindowPolicy}`; then `createAndEnqueueTask({taskType:'paper.monitor', source: task.source, payload:{experimentId}, correlationId: task.correlationId, dedupeKey:\`paper.monitor:${experimentId}:0\`, delayMs: services.paperMonitorPollMs}, {repo, queue})`. Non-admitted `ok:true` (rejected/quarantined/superseded) → NO monitor. `ensureMonitorScheduled`: the existing already-submitted guard branch now — when `existing.submissionStatus === 'submitted'` and (`monitorStatus` undefined or `'watching'`) — seeds missing monitor fields via `updateMonitorState` and enqueues paper.monitor (attempt 0 dedupeKey → intake dedup makes re-runs safe), instead of returning after `paper.already_submitted`; terminal `monitorStatus` keeps the old exit.

- [ ] **Step 1: Failing tests** (extend existing fixture): admitted happy path → row has watching/policy/strategyName/observedTrades 0 AND paper.monitor queued with delayMs = services.paperMonitorPollMs; `admissionStatus:'rejected'` → no monitor task; retry-edge: seed submitted row WITHOUT monitorStatus → handler enqueues monitor + seeds fields, no duplicate submit (port not called); already-submitted with `monitorStatus:'window_complete'` → old behavior (already_submitted event, no enqueue).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (the seeding rides in the SAME upsert object for the fresh-submit path — extend the literal; ensureMonitorScheduled as a small local function used by the guard branch).
- [ ] **Step 4:** Focused PASS → typecheck → FULL suite. **Step 5: Commit** `feat(orchestrator): paper.start seeds watching state and schedules paper.monitor (incl. retry-edge ensureMonitorScheduled)`

---

### Task 6: `research.run_cycle` — optional `paperRunId` input

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts` (payload schema + bot-results block at ~line 171)
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (extend)

**Interfaces:**
- Produces: payload schema += `paperRunId: z.string().optional()`. Behavior: when present, AFTER the existing finished-runs gathering, load the paper run REGARDLESS of status: `const paperRun = (await services.botResults.listBotRuns({ mode: 'paper' })).find((r) => r.runId === payload.paperRunId)`; if found and not already in `botResults` → prepend `{run: paperRun, summary: await getRunSummary(id), trades: await getClosedTrades(id)}`; if not found → event `researcher.paper_run_missing {paperRunId}` and continue (fail-soft, mirrors the existing bot_results_unavailable catch). When absent — existing behavior byte-identical.

- [ ] **Step 1: Failing tests**: with paperRunId and a fake botResults exposing a `running` paper run (excluded by the finished filter) → researcher input's botResults contains that run's trades; with paperRunId pointing nowhere → `researcher.paper_run_missing` event + cycle completes; without paperRunId → botResults identical to before (pin with the existing test's expectations).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** inside the existing try-block (so ops-read failures keep the same fail-soft path).
- [ ] **Step 4:** Focused PASS → typecheck → FULL suite (run_cycle tests are numerous — all must stay green).
- [ ] **Step 5: Commit** `feat(research): run_cycle accepts paperRunId — loads the monitored paper run regardless of status`

---

### Task 7: `paperMonitorHandler` + registration

**Files:**
- Create: `src/orchestrator/handlers/paper-monitor.handler.ts`
- Modify: `src/orchestrator/app-services.ts` (+`paperRunLocator: PaperRunLocatorPort`), `src/composition.ts` (adapter over botResults; `router.register('paper.monitor', paperMonitorHandler)`)
- Test: `src/orchestrator/handlers/paper-monitor.handler.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4, 6. Payload schema `PaperMonitorPayloadSchema = z.object({ experimentId: z.string().min(1), attempt: z.number().int().nonnegative().optional() })` (exported).
- Produces events: `paper.run_located {experimentId, runId}`, `paper.window_complete {experimentId, runId, closedTrades, lowConfidence}`, `paper.window_stalled {experimentId, runId?, observedTrades?}`, `paper.run_not_found {experimentId, strategyName}`, `paper.monitor.already_done {experimentId, monitorStatus}`.

Handler flow (complete logic — implement exactly):

```ts
export const paperMonitorHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(PaperMonitorPayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid paper.monitor payload: ${JSON.stringify(parsed.issues)}`);
  const { experimentId } = parsed.data;
  const attempt = parsed.data.attempt ?? 0;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const sub = await services.paperSubmissions.findByExperimentId(experimentId);
  if (!sub || sub.submissionStatus !== 'submitted') throw new Error(`paper.monitor: no submitted paper_submission for experiment ${experimentId}`);
  if (sub.monitorStatus === 'window_complete' || sub.monitorStatus === 'stalled') {
    await services.events.append(event(task.id, 'paper.monitor.already_done', { experimentId, monitorStatus: sub.monitorStatus }));
    return;
  }
  if (!sub.strategyName) throw new Error(`paper.monitor: paper_submission ${experimentId} has no strategyName — re-run paper.start (post-G4 version)`);

  const policy = (sub.windowPolicy ?? services.paperWindowPolicy) as unknown as PaperWindowPolicy;
  const submittedAtMs = Date.parse(sub.createdAt);

  const reschedule = async (): Promise<void> => {
    await createAndEnqueueTask(
      { taskType: 'paper.monitor', source: task.source, payload: { experimentId, attempt: attempt + 1 },
        correlationId: task.correlationId, dedupeKey: `paper.monitor:${experimentId}:${attempt + 1}`,
        delayMs: services.paperMonitorPollMs },
      { repo: services.researchTasks, queue: services.taskQueue },
    );
  };

  let runId = sub.paperRunId;
  let runStartedAtMs = sub.runStartedAtMs;
  if (!runId) {
    const located = await services.paperRunLocator.locate({ strategyName: sub.strategyName, submittedAtMs });
    if (!located) {
      if (now - submittedAtMs > policy.maxWaitDays * 24 * 3600 * 1000) {
        await services.paperSubmissions.updateMonitorState(experimentId, { monitorStatus: 'stalled', updatedAt: nowIso });
        await services.events.append(event(task.id, 'paper.run_not_found', { experimentId, strategyName: sub.strategyName }));
        return;
      }
      await reschedule();
      return;
    }
    runId = located.runId;
    runStartedAtMs = located.startedAtMs;
    await services.paperSubmissions.updateMonitorState(experimentId, { paperRunId: runId, runStartedAtMs, updatedAt: nowIso });
    await services.events.append(event(task.id, 'paper.run_located', { experimentId, runId }));
  }

  const summary = await services.botResults.getRunSummary(runId);
  const verdict = evaluatePaperWindow(policy, { runStartedAtMs: runStartedAtMs ?? submittedAtMs, nowMs: now, closedTrades: summary.closedTrades });

  if (verdict.state === 'watching') {
    await services.paperSubmissions.updateMonitorState(experimentId, { observedTrades: summary.closedTrades, updatedAt: nowIso });
    await reschedule();
    return;
  }
  if (verdict.state === 'stalled') {
    await services.paperSubmissions.updateMonitorState(experimentId, { monitorStatus: 'stalled', observedTrades: summary.closedTrades, updatedAt: nowIso });
    await services.events.append(event(task.id, 'paper.window_stalled', { experimentId, runId, observedTrades: summary.closedTrades }));
    return;
  }
  await services.paperSubmissions.updateMonitorState(experimentId, {
    monitorStatus: 'window_complete', observedTrades: summary.closedTrades, lowConfidence: verdict.lowConfidence, updatedAt: nowIso,
  });
  await services.events.append(event(task.id, 'paper.window_complete', { experimentId, runId, closedTrades: summary.closedTrades, lowConfidence: verdict.lowConfidence }));
  await createAndEnqueueTask(
    { taskType: 'research.run_cycle', source: 'platform', payload: { strategyProfileId: sub.strategyProfileId, paperRunId: runId },
      correlationId: task.correlationId, dedupeKey: `paper_window:${runId}` },
    { repo: services.researchTasks, queue: services.taskQueue },
  );
};
```

(`event(...)` helper — sibling convention. `runStartedAtMs` window base per spec §9: located run's startedAtMs.)

- [ ] **Step 1: Failing tests** — the ten scenarios from spec §7.3 (run-not-yet→reschedule with attempt+1 dedupeKey+delayMs; located→ledger+event; watching→observed_trades+reschedule; window_complete→ledger+event+run_cycle enqueued with exact payload/dedupeKey/source exactly once, second monitor run → already_done; stalled at maxDays; maxWaitDays expiry → stalled+run_not_found; terminal row → already_done without any botResults call; invalid payload; missing strategyName → actionable error).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** + register + wire locator in composition.
- [ ] **Step 4:** Focused PASS → typecheck → FULL suite. **Step 5: Commit** `feat(orchestrator): paper.monitor — locate run, adaptive window, Cycle 2 auto-trigger`

---

### Task 8: resume CLI + integration test + env docs + handoff docs

**Files:**
- Create: `scripts/paper-monitor-resume.mts` (composeRuntime; scan `monitor_status='watching'` paper_submission rows — add `listWatching(): Promise<PaperSubmission[]>` to the repo port+adapters (tested in the repo test); for each: `createAndEnqueueTask({taskType:'paper.monitor', source:'platform', payload:{experimentId, attempt:0}, dedupeKey:\`paper.monitor:${experimentId}:resume-${yyyymmddhhmm}\`, delayMs: 0(immediate)}, ...)`; header documents the Redis-loss recovery purpose + manual tsc command like sibling scripts)
- Create: `src/orchestrator/handlers/paper-monitor.integration.test.ts` (submitted+watching ledger row + fake bot-results with a paper run carrying ≥minTrades closed trades and startedAtMs > minDays ago → run paperMonitorHandler → assert window_complete ledger + run_cycle task created with `{strategyProfileId, paperRunId}`)
- Modify: `.env.example` (block: PAPER_MONITOR_POLL_MS, PAPER_WINDOW_MIN_TRADES, PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD, PAPER_WINDOW_MIN_DAYS, PAPER_WINDOW_MAX_DAYS, PAPER_MONITOR_MAX_WAIT_DAYS with the spec defaults + one-line comments) and docker-compose.yml worker env passthrough for the same six vars
- Create: `docs/superpowers/specs/2026-07-03-platform-auto-start-handoff.md` + `docs/superpowers/specs/2026-07-03-platform-candidate-run-link-handoff.md` — each ~1 page per the convention of `2026-06-30-platform-close-reason-enum-handoff.md`: current gap (with the platform file:line facts from the spec §2), what lab needs (a: auto-start/host pickup after promotion; b: candidateId/bundleId on bot_run + `/ops/runs` field), how lab consumes it today (heuristic locator seam — swap-in point named), acceptance sketch.

- [ ] **Step 1:** repo `listWatching` failing test → implement. **Step 2:** integration test (may pass immediately — say so honestly). **Step 3:** CLI + manual tsc gate (`npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --allowImportingTsExtensions --skipLibCheck scripts/paper-monitor-resume.mts`). **Step 4:** env/docker/handoff docs. **Step 5:** FULL gates (`npm run typecheck` + `npm test` 0 failed). **Step 6: Commit** `feat(research): paper:monitor:resume CLI + integration test + env docs + platform handoff docs (auto-start, candidate→run link)`

---

## Self-review notes

- Spec coverage: §2→T4+T8(handoffs), §3→T2, §4→T1/T5/T7, §5→T3, §6→T6, §7 tests→embedded, §9 resume→T8.
- Verify-at-implement flagged: existing task-intake test file presence (T1); env.ts numeric-parse idiom (T2); BotRunRecord field names against the SDK dto (T4 — `strategy.name`, `startedAtMs`; if the record field differs, e.g. `strategyRef`, adapt and note); run_cycle payload schema location (T6 — same file).
- Type consistency: `PaperWindowVerdict` states used in T7 handler match T2's union; `updateMonitorState` patch fields match T3's Pick; dedupeKey formats consistent across T5/T7/T8.
