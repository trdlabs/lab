# Slice G2b — Paper-Bridge Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-submit a WFO champion (bundle bytes + champion params + experiment evidence) to the platform paper intake when a `walk_forward_optimization` experiment ends with verdict `PAPER_CANDIDATE`, recording the outcome in a lab-side `paper_submission` ledger.

**Spec:** `docs/superpowers/specs/2026-07-03-paper-bridge-orchestration-design.md` (APPROVED, user review applied).

**Architecture:** `strategyWfoHandler` enqueues a retryable `paper.start` task (`{experimentId, baselineExperimentId}`, reserved task type — no enum change). Its handler consumes the merged PR #127 `PaperIntakePort` (injected via `AppServices.paperIntake`, kill-switch = missing `LAB_PAPER_INTAKE_URL`), materializes the champion's canonical bundle bytes into the content-addressed artifact store, maps experiment/member/run rows into `SubmitProvenCandidateArgs` via a pure `buildChampionSubmission`, and decomposes the intake result into submitted/rejected/failed/retry paths against a new `paper_submission` table (experiment_id UNIQUE, upsert semantics).

**Tech Stack:** TypeScript (node --experimental-strip-types), Drizzle + drizzle-kit (migration 0016), BullMQ, Vitest, `@trading-platform/sdk@0.9.1` intake types (native identity fields).

## Global Constraints

- Do NOT modify `src/adapters/platform/paper-intake.port.ts` or `scripts/submit-paper-candidate.mts` (PR #127, owned by the parallel session) — consume only.
- NO TS parameter properties (strip-types runtime; AST guard test enforces).
- Migration 0016 ADDITIVE only, generated via `npm run db:generate`.
- Run ids in evidence are PLATFORM ids: `StrategyBacktestRun.platformRunId`, never lab DB ids.
- `identity.side` must be `'long' | 'short'` only (platform projects nothing else); profile `direction` outside that → fail-fast, not coercion.
- Canonical bytes invariant: `artifacts.put(Buffer.from(bundle.bytes), ...)` must yield `ref.content_hash === bundle.bundleHash` — assert it, fail-fast on mismatch.
- Result decomposition (spec §2.4): `ok:true` → ledger submitted/rejected + events; `ok:false` `internal_error` or transport throw → handler throws (retry); `ok:false` validation_error/not_found/conflict/unsupported_query → terminal ledger `failed` + `error` jsonb + event, task completes.
- Kill-switch: `services.paperIntake.enabled === false` → `paper.intake_skipped` event, NO ledger row, task completes.
- idempotencyKey = `wfo-champion:${experimentId}` (stable across retries).
- Gates per task: focused vitest; before each task-completing commit `npm run typecheck` clean + FULL `npm test` 0 failed (baseline on this branch: 2864 passed).
- Code/comments/commits in English (repo docs may be Russian; new code comments English).

---

### Task 1: `paper_submission` ledger (domain + schema + migration 0016 + repos)

**Files:**
- Create: `src/domain/paper-submission.ts`
- Create: `src/ports/paper-submission.repository.ts`
- Create: `src/adapters/repository/drizzle-paper-submission.repository.ts`
- Create: `src/adapters/repository/in-memory-paper-submission.repository.ts`
- Modify: `src/db/schema.ts` (new pgTable after `researchExperiment` block)
- Create: migration via `npm run db:generate` → `migrations/0016_*.sql`
- Test: `src/adapters/repository/in-memory-paper-submission.repository.test.ts`

**Interfaces:**
- Produces (Tasks 3/5 rely on exact names):

```ts
// src/domain/paper-submission.ts
export type PaperSubmissionStatus = 'submitted' | 'rejected' | 'failed';
export interface PaperSubmission {
  id: string;
  experimentId: string;             // UNIQUE — one champion submission per WFO experiment
  strategyProfileId: string;
  submissionStatus: PaperSubmissionStatus;
  candidateId?: string;             // platform OpaqueId (ok:true only)
  admissionStatus?: string;         // admitted | rejected | quarantined | superseded (ok:true only)
  admissionReasonCode?: string;
  error?: Record<string, unknown>;  // {category, code, message} on terminal failed
  idempotencyKey: string;           // UNIQUE
  bundleHash: string;
  params?: Record<string, unknown>; // champion params
  createdAt: string;
  updatedAt: string;
}

// src/ports/paper-submission.repository.ts
export interface PaperSubmissionRepository {
  upsertByExperimentId(s: PaperSubmission): Promise<void>; // insert or replace-by-experimentId (id/createdAt preserved on update)
  findByExperimentId(experimentId: string): Promise<PaperSubmission | null>;
}
```

- [ ] **Step 1: Failing test** (`in-memory-paper-submission.repository.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryPaperSubmissionRepository } from './in-memory-paper-submission.repository.ts';
import type { PaperSubmission } from '../../domain/paper-submission.ts';

const row = (over: Partial<PaperSubmission> = {}): PaperSubmission => ({
  id: 'ps-1', experimentId: 'exp-1', strategyProfileId: 'prof-1',
  submissionStatus: 'submitted', candidateId: 'cand-1', admissionStatus: 'admitted',
  idempotencyKey: 'wfo-champion:exp-1', bundleHash: 'sha256:aa',
  params: { dumpPct: 8 }, createdAt: '2026-07-03T00:00:00.000Z', updatedAt: '2026-07-03T00:00:00.000Z',
  ...over,
});

describe('InMemoryPaperSubmissionRepository', () => {
  it('round-trips a submission by experimentId', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    await repo.upsertByExperimentId(row());
    expect(await repo.findByExperimentId('exp-1')).toEqual(row());
  });

  it('upsert replaces the existing row for the same experimentId (id/createdAt preserved)', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    await repo.upsertByExperimentId(row({ submissionStatus: 'failed', error: { category: 'validation_error' }, candidateId: undefined, admissionStatus: undefined }));
    await repo.upsertByExperimentId(row({ id: 'ps-2', createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z' }));
    const got = await repo.findByExperimentId('exp-1');
    expect(got?.submissionStatus).toBe('submitted');
    expect(got?.id).toBe('ps-1');                                // original id preserved
    expect(got?.createdAt).toBe('2026-07-03T00:00:00.000Z');     // original createdAt preserved
    expect(got?.updatedAt).toBe('2026-07-04T00:00:00.000Z');
    expect(got?.error).toBeUndefined();                          // replaced, not merged
  });

  it('returns null for unknown experimentId', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    expect(await repo.findByExperimentId('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/adapters/repository/in-memory-paper-submission.repository.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement.** Domain + port per Interfaces block verbatim. In-memory: `Map<experimentId, PaperSubmission>`; on upsert, if existing → `{...incoming, id: existing.id, createdAt: existing.createdAt}` (replace, not merge). Drizzle table in `src/db/schema.ts` (mirror `researchExperiment` idiom):

```ts
export const paperSubmission = pgTable('paper_submission', {
  id: text('id').primaryKey(),
  experimentId: text('experiment_id').notNull(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  submissionStatus: text('submission_status').notNull().$type<PaperSubmissionStatus>(),
  candidateId: text('candidate_id'),
  admissionStatus: text('admission_status'),
  admissionReasonCode: text('admission_reason_code'),
  error: jsonb('error').$type<Record<string, unknown>>(),
  idempotencyKey: text('idempotency_key').notNull(),
  bundleHash: text('bundle_hash').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  experimentUq: uniqueIndex('paper_submission_experiment_uq').on(t.experimentId),
  idempotencyUq: uniqueIndex('paper_submission_idempotency_uq').on(t.idempotencyKey),
}));
```

Drizzle repo: `upsertByExperimentId` = `insert().values(...).onConflictDoUpdate({ target: paperSubmission.experimentId, set: {…all mutable fields, updatedAt} })` — mirror an existing onConflict usage if present, else standard drizzle API; map row↔domain with `?? undefined` for nullables (holdoutBoundary idiom).

- [ ] **Step 4:** `npm run db:generate` → verify `migrations/0016_*.sql` contains ONLY `CREATE TABLE "paper_submission"` + its two unique indexes.
- [ ] **Step 5:** Focused tests PASS → `npm run typecheck` → FULL `npm test`.
- [ ] **Step 6: Commit** `feat(research): paper_submission ledger — additive 0016, upsert-by-experiment repos`

---

### Task 2: `buildChampionSubmission` pure mapper

**Files:**
- Create: `src/research/champion-evidence.ts`
- Test: `src/research/champion-evidence.test.ts`

**Interfaces:**
- Consumes: `SubmitProvenCandidateArgs` from `../adapters/platform/paper-intake.port.ts` (#127 — import type only); `ResearchExperiment`, `ExperimentRunMember` (src/domain/research-experiment.ts); `StrategyBacktestRun` (src/domain/strategy-backtest-run.ts — `platformRunId`, `metrics`); `StrategyProfile` (src/domain/strategy-profile.ts — `name`, `direction`).
- Produces (Task 3 relies on):

```ts
export interface ChampionSubmissionInput {
  wfoExperiment: ResearchExperiment;        // type walk_forward_optimization, verdict PAPER_CANDIDATE
  wfoMembers: ExperimentRunMember[];        // must contain role 'holdout' with oos true
  baselineExperiment: ResearchExperiment;
  baselineMembers: ExperimentRunMember[];   // must contain role 'holdout'
  profile: StrategyProfile;
  baselineRun: StrategyBacktestRun;         // looked up by caller from baseline holdout member's strategyBacktestRunId
  variantRun: StrategyBacktestRun;          // looked up from WFO holdout member's strategyBacktestRunId
  correlationId: string;
}
export function buildChampionSubmission(input: ChampionSubmissionInput): SubmitProvenCandidateArgs;
```

- [ ] **Step 1: Failing tests** (fixtures: hand-built experiments/members/runs/profile — reuse shapes from `src/research/experiment-service.wfo.test.ts` fixtures):

```ts
it('maps a champion into SubmitProvenCandidateArgs with PLATFORM run ids', () => {
  const args = buildChampionSubmission(fixture());
  expect(args.evidence.baselineRunId).toBe('plat-run-base');   // platformRunId, NOT lab id
  expect(args.evidence.variantRunId).toBe('plat-run-var');
  expect(args.bundle.bundleHash).toBe(fixture().wfoExperiment.bundleHash);
  expect(args.identity).toEqual({ strategyName: 'long_oi', side: 'long', params: { dumpPct: 8 } });
  expect(args.evidence.window).toEqual({ fromMs: Date.parse('2026-06-12T00:00:00.000Z'), toMs: Date.parse('2026-06-19T00:00:00.000Z') });
  expect(args.evidence.symbols).toEqual(['ESPORTSUSDT']);
  expect(args.idempotencyKey).toBe(`wfo-champion:${fixture().wfoExperiment.id}`);
  expect(args.workflowId).toBe(fixture().wfoExperiment.id);
});

it.each([
  ['wfo holdout member missing', (f) => ({ ...f, wfoMembers: f.wfoMembers.filter((m) => m.role !== 'holdout') }), /wfo holdout member/i],
  ['baseline holdout member missing', (f) => ({ ...f, baselineMembers: [] }), /baseline holdout member/i],
  ['variant run metrics missing', (f) => ({ ...f, variantRun: { ...f.variantRun, metrics: null } }), /variant run metrics/i],
  ['unsupported direction', (f) => ({ ...f, profile: { ...f.profile, direction: 'both' } }), /long\|short/i],
])('fails fast: %s', (_n, mutate, re) => {
  expect(() => buildChampionSubmission(mutate(fixture()))).toThrow(re);
});
```

(Adjust the `direction` fixture value to a REAL member of the `DIRECTIONS` enum in src/domain/strategy-profile.ts that is neither 'long' nor 'short' — read the enum first; if the enum is only long|short, replace that case with a cast-forced value and note it.)

- [ ] **Step 2: Run** — FAIL (module not found).
- [ ] **Step 3: Implement:**

```ts
export function buildChampionSubmission(input: ChampionSubmissionInput): SubmitProvenCandidateArgs {
  const { wfoExperiment, baselineExperiment, profile, baselineRun, variantRun } = input;
  const wfoHoldout = input.wfoMembers.find((m) => m.role === 'holdout' && m.oos === true);
  if (!wfoHoldout) throw new Error(`experiment ${wfoExperiment.id}: wfo holdout member (oos) not found`);
  const baseHoldout = input.baselineMembers.find((m) => m.role === 'holdout');
  if (!baseHoldout) throw new Error(`experiment ${baselineExperiment.id}: baseline holdout member not found`);
  if (!variantRun.metrics) throw new Error(`run ${variantRun.id}: variant run metrics missing (not completed?)`);
  if (profile.direction !== 'long' && profile.direction !== 'short') {
    throw new Error(`profile ${profile.id}: direction '${profile.direction}' cannot be papered — platform accepts long|short only`);
  }
  if (!wfoExperiment.bundleHash) throw new Error(`experiment ${wfoExperiment.id}: bundleHash missing`);
  const scope = wfoExperiment.datasetScope;
  return {
    bundle: { bundleHash: wfoExperiment.bundleHash },
    identity: {
      strategyName: profile.name,
      side: profile.direction,
      ...(wfoHoldout.params ? { params: wfoHoldout.params } : {}),
    },
    evidence: {
      baselineRunId: baselineRun.platformRunId,
      variantRunId: variantRun.platformRunId,
      datasetRef: scope.datasetId,
      window: { fromMs: Date.parse(scope.period.from), toMs: Date.parse(scope.period.to) },
      symbols: scope.symbols,
      timeframe: scope.timeframe,
      metricsSnapshot: { ...variantRun.metrics, ...(wfoHoldout.resultSummary ? { resultSummary: wfoHoldout.resultSummary } : {}) },
      improvementSummary: wfoExperiment.verdictReason ?? 'wfo champion',
    },
    idempotencyKey: `wfo-champion:${wfoExperiment.id}`,
    workflowId: wfoExperiment.id,
    correlationId: input.correlationId,
  };
}
```

(Check `BacktestMetricBlock`'s shape for the spread into `metricsSnapshot: Record<string, unknown>` — if it's not a plain record, wrap as `{ metrics: variantRun.metrics }` instead; keep the test asserting the actual chosen shape.)

- [ ] **Step 4:** Tests PASS → typecheck.
- [ ] **Step 5: Commit** `feat(research): buildChampionSubmission — pure experiment→intake evidence mapper (platform run ids)`

---

### Task 3: `paperStartHandler` + `AppServices.paperIntake` + registration

**Files:**
- Create: `src/orchestrator/handlers/paper-start.handler.ts`
- Modify: `src/orchestrator/app-services.ts` (add `paperIntake: PaperIntakePort;` + `paperSubmissions: PaperSubmissionRepository;` imports/fields)
- Modify: `src/composition.ts` (services: `paperIntake: selectPaperIntake(process.env)`, `paperSubmissions: new DrizzlePaperSubmissionRepository(db)`; `router.register('paper.start', paperStartHandler)`)
- Test: `src/orchestrator/handlers/paper-start.handler.test.ts`

**Interfaces:**
- Consumes: Task 1 repo, Task 2 mapper, `PaperIntakePort` (#127: `{enabled, submitProvenCandidate}`), `reconstructStrategyBundle` (G1), `WorkflowHandler` (`../workflow-router.ts`).
- Produces: `PaperStartPayloadSchema = z.object({ experimentId: z.string().min(1), baselineExperimentId: z.string().min(1) })` (exported). Events: `paper.intake_skipped` / `paper.already_submitted` / `paper.candidate_submitted` / `paper.candidate_rejected` / `paper.submission_failed`.

- [ ] **Step 1: Failing tests** (mirror `strategy-wfo.handler.test.ts` fixture style — real in-memory ports, fake `paperIntake`):

```ts
// helper: makeServices() with in-memory artifact store pre-seeded with the baseline's
// bundleArtifactRef wrapper artifact (reuse the real-bundle fixture approach from
// strategy-wfo.handler.test.ts — FakeStrategyBuilder → assembleStrategyBundle → artifacts.put),
// experiments repo seeded with wfo(PAPER_CANDIDATE)+baseline experiments, members, run rows.

it('skips when intake disabled: event, no submit, no ledger row', async () => {
  const { services, intakeCalls, events } = make({ enabled: false });
  await paperStartHandler(taskOf(), services);
  expect(intakeCalls).toHaveLength(0);
  expect(events.map((e) => e.type)).toContain('paper.intake_skipped');
  expect(await services.paperSubmissions.findByExperimentId('exp-wfo')).toBeNull();
});

it('happy path: bytes in CAS (content_hash === bundleHash), ledger submitted, event with candidateId', async () => {
  const { services, artifacts, bundleHash } = make({ result: { ok: true, candidateId: 'cand-1', admissionStatus: 'admitted', admissionReasonCode: null, idempotentReplay: false } });
  await paperStartHandler(taskOf(), services);
  expect(artifacts.putHashes).toContain(bundleHash);   // raw bytes landed content-addressed
  const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
  expect(row).toMatchObject({ submissionStatus: 'submitted', candidateId: 'cand-1', admissionStatus: 'admitted', idempotencyKey: 'wfo-champion:exp-wfo' });
});

it('already submitted: no port call, paper.already_submitted event', async () => { /* seed ledger submitted row first */ });

it('bundleHash mismatch wfo↔baseline → actionable error', async () => { /* mutate baseline.bundleHash */ });

it('ok:true + admissionStatus rejected → ledger rejected + paper.candidate_rejected, no throw', async () => { /* result admissionStatus:'rejected' */ });

it('ok:false internal_error → throws (retry), no ledger row', async () => {
  const { services } = make({ result: { ok: false, error: { category: 'internal_error', code: 'x', message: 'boom' } } });
  await expect(paperStartHandler(taskOf(), services)).rejects.toThrow(/internal_error|boom/);
  expect(await services.paperSubmissions.findByExperimentId('exp-wfo')).toBeNull();
});

it('ok:false validation_error → ledger failed + error jsonb + paper.submission_failed, no throw', async () => { /* category validation_error */ });

it('retry after failed row → port called again, row upserted to submitted', async () => { /* seed failed row, result ok:true */ });
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (straight-line, mirrors spec §2 numbered flow):

```ts
export const paperStartHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(PaperStartPayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid paper.start payload: ${JSON.stringify(parsed.issues)}`);
  const { experimentId, baselineExperimentId } = parsed.data;

  const wfo = await services.experiments.findById(experimentId);
  if (!wfo) throw new Error(`research_experiment ${experimentId} not found`);
  if (wfo.experimentType !== 'walk_forward_optimization' || wfo.verdict !== 'PAPER_CANDIDATE') {
    throw new Error(`experiment ${experimentId} is not a PAPER_CANDIDATE wfo experiment (type=${wfo.experimentType}, verdict=${wfo.verdict})`);
  }
  const baseline = await services.experiments.findById(baselineExperimentId);
  if (!baseline) throw new Error(`baseline experiment ${baselineExperimentId} not found`);
  if (wfo.bundleHash !== baseline.bundleHash) {
    throw new Error(`bundleHash mismatch: wfo ${wfo.bundleHash} != baseline ${baseline.bundleHash} — champion must be the baseline-validated bundle`);
  }

  if (!services.paperIntake.enabled) {
    await services.events.append(event(task.id, 'paper.intake_skipped', { experimentId, reason: 'intake_disabled' }));
    return;
  }
  const existing = await services.paperSubmissions.findByExperimentId(experimentId);
  if (existing?.submissionStatus === 'submitted') {
    await services.events.append(event(task.id, 'paper.already_submitted', { experimentId, candidateId: existing.candidateId ?? null }));
    return;
  }

  if (!baseline.bundleArtifactRef) throw new Error(`baseline experiment ${baselineExperimentId} has no bundleArtifactRef — re-run strategy.baseline`);
  const bundle = await reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef);
  const bytesRef = await services.artifacts.put(Buffer.from(bundle.bytes), {
    kind: 'strategy_bundle_bytes', mime_type: 'application/javascript', producer: 'paper-start-handler',
  });
  if (bytesRef.content_hash !== bundle.bundleHash) {
    throw new Error(`artifact store content_hash ${bytesRef.content_hash} != bundleHash ${bundle.bundleHash} — CAS naming drift`);
  }

  const profile = await services.strategyProfiles.findById(wfo.strategyProfileId);
  if (!profile) throw new Error(`strategy_profile ${wfo.strategyProfileId} not found`);
  const [wfoMembers, baselineMembers] = await Promise.all([
    services.experiments.listMembers(experimentId), services.experiments.listMembers(baselineExperimentId),
  ]);
  const wfoHoldout = wfoMembers.find((m) => m.role === 'holdout' && m.oos === true);
  const baseHoldout = baselineMembers.find((m) => m.role === 'holdout');
  if (!wfoHoldout?.strategyBacktestRunId || !baseHoldout?.strategyBacktestRunId) {
    throw new Error(`holdout member run ids missing (wfo=${wfoHoldout?.strategyBacktestRunId}, baseline=${baseHoldout?.strategyBacktestRunId})`);
  }
  const [variantRun, baselineRun] = await Promise.all([
    services.strategyBacktests.findById(wfoHoldout.strategyBacktestRunId),
    services.strategyBacktests.findById(baseHoldout.strategyBacktestRunId),
  ]);
  if (!variantRun || !baselineRun) throw new Error('holdout StrategyBacktestRun rows missing');

  const args = buildChampionSubmission({
    wfoExperiment: wfo, wfoMembers, baselineExperiment: baseline, baselineMembers,
    profile, baselineRun, variantRun, correlationId: task.correlationId,
  });
  const res = await services.paperIntake.submitProvenCandidate(args);
  const now = new Date().toISOString();

  if (res.ok) {
    const rejected = res.admissionStatus === 'rejected';
    await services.paperSubmissions.upsertByExperimentId({
      id: randomUUID(), experimentId, strategyProfileId: wfo.strategyProfileId,
      submissionStatus: rejected ? 'rejected' : 'submitted',
      candidateId: res.candidateId, admissionStatus: res.admissionStatus,
      admissionReasonCode: res.admissionReasonCode ?? undefined,
      idempotencyKey: args.idempotencyKey, bundleHash: bundle.bundleHash,
      ...(wfoHoldout.params ? { params: wfoHoldout.params } : {}),
      createdAt: now, updatedAt: now,
    });
    await services.events.append(event(task.id, 'paper.candidate_submitted', {
      experimentId, candidateId: res.candidateId, admissionStatus: res.admissionStatus, idempotentReplay: res.idempotentReplay,
    }));
    if (rejected) await services.events.append(event(task.id, 'paper.candidate_rejected', { experimentId, candidateId: res.candidateId, reasonCode: res.admissionReasonCode }));
    return;
  }
  if (res.error.category === 'internal_error') {
    throw new Error(`paper intake internal_error: ${res.error.code} ${res.error.message}`);
  }
  await services.paperSubmissions.upsertByExperimentId({
    id: randomUUID(), experimentId, strategyProfileId: wfo.strategyProfileId,
    submissionStatus: 'failed', error: { category: res.error.category, code: res.error.code, message: res.error.message },
    idempotencyKey: args.idempotencyKey, bundleHash: bundle.bundleHash,
    ...(wfoHoldout.params ? { params: wfoHoldout.params } : {}),
    createdAt: now, updatedAt: now,
  });
  await services.events.append(event(task.id, 'paper.submission_failed', { experimentId, category: res.error.category, code: res.error.code }));
};
```

(`event(...)` helper — copy the sibling convention from `strategy-wfo.handler.ts`. NOTE: `selectPaperIntake`'s DISABLED port also returns `ok:false validation_error paper_intake_disabled` from submit — the handler's `enabled` check makes that unreachable; keep checking `enabled` first, per spec.) Wire `app-services.ts` + `composition.ts` (register `paper.start` next to `strategy.wfo`; construct `DrizzlePaperSubmissionRepository(db)` and `selectPaperIntake(process.env)`).

- [ ] **Step 4:** Focused tests PASS → typecheck → FULL `npm test`.
- [ ] **Step 5: Commit** `feat(orchestrator): paper.start handler — champion bytes to CAS, evidence submit, ledger + events`

---

### Task 4: `strategyWfoHandler` enqueues `paper.start` on PAPER_CANDIDATE

**Files:**
- Modify: `src/orchestrator/handlers/strategy-wfo.handler.ts`
- Test: `src/orchestrator/handlers/strategy-wfo.handler.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's `PaperStartPayloadSchema` shape `{experimentId, baselineExperimentId}`; `createAndEnqueueTask({...}, {repo: services.researchTasks, queue: services.taskQueue})` (same mechanism the file's sibling `strategy-baseline.handler.ts` uses).

- [ ] **Step 1: Failing tests** (extend existing fixture — it already spies runWalkForwardOptimization):

```ts
it('enqueues paper.start with baselineExperimentId when verdict is PAPER_CANDIDATE', async () => {
  const { services, queued } = make({ wfoResult: { experimentId: 'exp-wfo', verdict: 'PAPER_CANDIDATE', terminalReason: 'paper_candidate' } });
  await strategyWfoHandler(taskOf({ baselineExperimentId: 'exp-base' }), services);
  expect(queued).toContainEqual(expect.objectContaining({
    taskType: 'paper.start',
    payload: { experimentId: 'exp-wfo', baselineExperimentId: 'exp-base' },
    correlationId: taskOf({}).correlationId,
    dedupeKey: 'paper.start:exp-wfo',
  }));
});

it('does not enqueue paper.start for non-PAPER_CANDIDATE verdicts', async () => {
  const { services, queued } = make({ wfoResult: { experimentId: 'exp-wfo', verdict: 'INCONCLUSIVE', terminalReason: 'budget_exhausted' } });
  await strategyWfoHandler(taskOf({ baselineExperimentId: 'exp-base' }), services);
  expect(queued.filter((t) => t.taskType === 'paper.start')).toHaveLength(0);
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — in `strategyWfoHandler` after the `strategy.wfo.completed` event append:

```ts
if (verdict === 'PAPER_CANDIDATE') {
  await createAndEnqueueTask(
    {
      taskType: 'paper.start',
      source: task.source,
      payload: { experimentId, baselineExperimentId },
      correlationId: task.correlationId,
      dedupeKey: `paper.start:${experimentId}`,
    },
    { repo: services.researchTasks, queue: services.taskQueue },
  );
}
```

- [ ] **Step 4:** Focused tests PASS → typecheck → FULL `npm test`.
- [ ] **Step 5: Commit** `feat(orchestrator): strategy.wfo auto-chains paper.start on PAPER_CANDIDATE`

---

### Task 5: Integration test + env docs + full gates

**Files:**
- Create: `src/orchestrator/handlers/paper-bridge.integration.test.ts`
- Modify: `.env.example` (document `LAB_PAPER_INTAKE_URL` / `LAB_PAPER_INTAKE_TOKEN` if absent — check first; PR #127 may not have documented them)
- Modify: `docker-compose.yml` — passthrough `LAB_PAPER_INTAKE_URL: ${LAB_PAPER_INTAKE_URL:-}` / `LAB_PAPER_INTAKE_TOKEN: ${LAB_PAPER_INTAKE_TOKEN:-}` in the worker service env block (same two blocks that got RESEARCH_TASK_TOKEN_BUDGET in G1; worker is the submitter — ingress passthrough optional, add to both for symmetry).

- [ ] **Step 1: Integration test** — on in-memory infrastructure (mirror `new-strategy-holdout.integration.test.ts` composition style): seed profile + baseline experiment (completed, with `bundleArtifactRef` pointing at a real wrapper artifact in the in-memory store) + WFO experiment (PAPER_CANDIDATE) + members + run rows → run `paperStartHandler` with a fake `paperIntake` capturing args → assert: captured `SubmitProvenCandidateArgs.evidence.baselineRunId/variantRunId` are the PLATFORM ids from the seeded run rows; bytes artifact with `content_hash === bundleHash` exists; ledger row `submitted`; events sequence contains `paper.candidate_submitted`.
- [ ] **Step 2:** `.env.example` block (only if missing):

```bash
# Platform paper-intake (feature 036/066). Unset URL = paper bridge disabled (kill-switch):
# PAPER_CANDIDATE verdicts emit paper.intake_skipped instead of submitting.
LAB_PAPER_INTAKE_URL=
LAB_PAPER_INTAKE_TOKEN=
```

- [ ] **Step 3: Full gates** — `npm run typecheck` clean; FULL `npm test` 0 failed.
- [ ] **Step 4: Commit** `feat(research): paper-bridge integration test + LAB_PAPER_INTAKE env docs/passthrough`

---

## Self-review notes

- Spec coverage: §2→Tasks 3/4, §3→Task 2, §4→Task 3 (bytes+assert), §5→Task 1, §6 test list→embedded per task (§6.5 integration = Task 5).
- Verify-at-implement points flagged inline: `DIRECTIONS` enum members (Task 2), `BacktestMetricBlock` spreadability into `metricsSnapshot` (Task 2), drizzle `onConflictDoUpdate` idiom availability (Task 1), whether #127 already documented env vars (Task 5).
- Constraint echoes: paper-intake.port.ts untouched (no task modifies it); enum untouched (`paper.start` already reserved); ledger has NO 'skipped' status by design.
