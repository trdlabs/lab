# Slice G1 — WFO Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock WFO (bundle reconstruction from a persisted `ArtifactRef` instead of a non-deterministic LLM rebuild), register `strategy.baseline` / `strategy.wfo` as orchestrated task types with an onboard→baseline→WFO chat autochain, and wire the correlationId-keyed token-budget kill-switch into the WFO round loop.

**Spec:** `docs/superpowers/specs/2026-07-02-wfo-orchestration-design.md` (APPROVED).

**Architecture:** The baseline lane persists its assembled bundle's `ArtifactRef` (jsonb) on the `research_experiment` row; the WFO path reconstructs the exact bundle from that ref (hash-verified). Two new worker handlers wrap the existing `ExperimentService` lanes; the chat guard chains ordinary onboarding to `strategy.baseline`, keeping the `research.run_cycle` chain for explicit research goals. `ExperimentService.runWalkForwardOptimization` gains a budget gate reading `tokenUsage.get(correlationId)` before GATE1 and before each sweep round.

**Tech Stack:** TypeScript (node --experimental-strip-types), Drizzle ORM + drizzle-kit migrations, BullMQ task queue, Vitest.

## Global Constraints

- NO TS parameter properties (`constructor(private x)`) — breaks strip-types at runtime (AST guard test enforces).
- Migrations are ADDITIVE only; generate via `npm run db:generate` (drizzle-kit; next number 0015).
- `tsc --noEmit` (`npm run typecheck`) does NOT cover `scripts/` — typecheck touched scripts manually with the command in their headers.
- `withinTokenBudget(cumulativeTokens, budgetTokens)` (src/orchestrator/token-budget.ts) and `services.researchTaskTokenBudget` (env `RESEARCH_TASK_TOKEN_BUDGET`) are the existing budget primitives — reuse, do not duplicate.
- The baseline lane (`runStrategyBaselineValidation`) and hypothesis lane (`runNewStrategyValidation`) behavior must not change except for the additive `bundleArtifactRef` persist.
- Full gates before finishing: `npm run typecheck` clean + `npm test` 0 failed.
- Code/comments/commits in English.

---

### Task 1: `bundleArtifactRef` on ResearchExperiment (domain + db schema + repos + migration)

**Files:**
- Modify: `src/domain/research-experiment.ts` (add field to `ResearchExperiment`)
- Modify: `src/db/schema.ts:303` (`researchExperiment` pgTable — add jsonb column)
- Modify: `src/adapters/repository/drizzle-research-experiment.repository.ts` (insert + row map)
- Modify: `src/adapters/repository/in-memory-research-experiment.repository.ts` (only if it copies fields explicitly; if it stores the object whole, test only)
- Create: migration via `npm run db:generate` → `migrations/0015_*.sql`
- Test: `src/adapters/repository/in-memory-research-experiment.repository.test.ts`

**Interfaces:**
- Consumes: `ArtifactRef` from `src/domain/types.ts:29` (`{artifact_id, uri, content_hash, kind, size_bytes, mime_type, created_at, producer, metadata}`).
- Produces: `ResearchExperiment.bundleArtifactRef?: ArtifactRef` — Tasks 3/5/7 rely on this exact name.

- [ ] **Step 1: Failing test** — in the in-memory repo test add:

```ts
it('round-trips bundleArtifactRef through create/findById', async () => {
  const repo = new InMemoryResearchExperimentRepository();
  const ref = {
    artifact_id: 'art-1', uri: 'file:///tmp/a.json', content_hash: 'sha256:aa',
    kind: 'strategy_bundle', size_bytes: 10, mime_type: 'application/json',
    created_at: '2026-07-03T00:00:00.000Z', producer: 'test', metadata: {},
  };
  await repo.createExperiment({ ...baseExperiment(), id: 'exp-ref', experimentKey: 'k-ref', bundleArtifactRef: ref });
  const got = await repo.findById('exp-ref');
  expect(got?.bundleArtifactRef).toEqual(ref);
});
```

(reuse the file's existing experiment-factory helper; name may differ — mirror sibling tests.)

- [ ] **Step 2: Run** `npx vitest run src/adapters/repository/in-memory-research-experiment.repository.test.ts` — expect FAIL (type error: unknown property).
- [ ] **Step 3: Implement** — domain:

```ts
// src/domain/research-experiment.ts — inside ResearchExperiment, after bundleHash?:
bundleArtifactRef?: ArtifactRef;
// + at top: import type { ArtifactRef } from './types.ts';
```

db schema (after `bundleHash` column):

```ts
bundleArtifactRef: jsonb('bundle_artifact_ref').$type<ArtifactRef>(),
```

Drizzle repo: add `bundleArtifactRef: e.bundleArtifactRef ?? null`-style mapping to the insert values and `bundleArtifactRef: row.bundleArtifactRef ?? undefined` to the row→domain map (mirror how `holdoutBoundary` jsonb is mapped in the same file).

- [ ] **Step 4: Generate migration** — `npm run db:generate`; verify the new `migrations/0015_*.sql` contains ONLY `ALTER TABLE "research_experiment" ADD COLUMN "bundle_artifact_ref" jsonb;`.
- [ ] **Step 5: Run tests** — same vitest command, expect PASS; then `npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(research): persist strategy bundle ArtifactRef on research_experiment (additive 0015)`

---

### Task 2: `reconstructStrategyBundle` helper

**Files:**
- Create: `src/research/reconstruct-strategy-bundle.ts`
- Test: `src/research/reconstruct-strategy-bundle.test.ts`

**Interfaces:**
- Consumes: `ArtifactStorePort` (`get(ref: ArtifactRef): Promise<Buffer>`), `assembleStrategyBundle` from `src/domain/strategy-bundle.ts`, persisted artifact JSON shape `{source, manifest, bundleHash}` (exactly what `run-strategy-baseline.mts` puts today).
- Produces: `reconstructStrategyBundle(artifacts: ArtifactStorePort, ref: ArtifactRef): Promise<AssembledStrategyBundle>` — Tasks 5/7 call this exact signature.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryArtifactStore } from '../adapters/artifact/in-memory-artifact-store.ts';
import { assembleStrategyBundle } from '../domain/strategy-bundle.ts';
import { reconstructStrategyBundle } from './reconstruct-strategy-bundle.ts';

// Build a real bundle once via assembleStrategyBundle from a minimal valid builder output
// (copy the fixture used in experiment-service.strategy.test.ts for its strategyBundle).

describe('reconstructStrategyBundle', () => {
  it('reconstructs a bundle byte-identical in hash to the persisted one', async () => {
    const store = new InMemoryArtifactStore();
    const bundle = await makeTestStrategyBundle(); // local helper reusing the fixture
    const ref = await store.put(
      JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
      { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
    );
    const got = await reconstructStrategyBundle(store, ref);
    expect(got.bundleHash).toBe(bundle.bundleHash);
  });

  it('fails fast when the stored hash does not match the reassembled bundle', async () => {
    const store = new InMemoryArtifactStore();
    const bundle = await makeTestStrategyBundle();
    const ref = await store.put(
      JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: 'sha256:corrupted' }),
      { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
    );
    await expect(reconstructStrategyBundle(store, ref)).rejects.toThrow(/hash mismatch/i);
  });

  it('fails with an actionable error on malformed artifact JSON', async () => {
    const store = new InMemoryArtifactStore();
    const ref = await store.put('not json', { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' });
    await expect(reconstructStrategyBundle(store, ref)).rejects.toThrow(/strategy_bundle artifact/i);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/research/reconstruct-strategy-bundle.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement**

```ts
import type { ArtifactRef } from '../domain/types.ts';
import type { ArtifactStorePort } from '../ports/artifact-store.port.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../domain/strategy-bundle.ts';

/**
 * Rebuild the exact AssembledStrategyBundle a baseline experiment validated from its persisted
 * strategy_bundle artifact. NO LLM rebuild — determinism is the whole point (WFO must optimize
 * the same bundle the baseline validated). Fails fast if the reassembled hash drifts from the
 * persisted one (corruption / format drift).
 */
export async function reconstructStrategyBundle(
  artifacts: ArtifactStorePort, ref: ArtifactRef,
): Promise<AssembledStrategyBundle> {
  const raw = (await artifacts.get(ref)).toString('utf8');
  let parsed: { source?: unknown; manifest?: unknown; bundleHash?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (err) {
    throw new Error(`strategy_bundle artifact ${ref.artifact_id} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.source === undefined || parsed.manifest === undefined || typeof parsed.bundleHash !== 'string') {
    throw new Error(`strategy_bundle artifact ${ref.artifact_id} is missing source/manifest/bundleHash`);
  }
  const bundle = await assembleStrategyBundle({ source: parsed.source, manifest: parsed.manifest } as never);
  if (bundle.bundleHash !== parsed.bundleHash) {
    throw new Error(
      `strategy_bundle artifact ${ref.artifact_id} hash mismatch: reassembled ${bundle.bundleHash} != persisted ${parsed.bundleHash}`,
    );
  }
  return bundle;
}
```

NOTE for implementer: check `assembleStrategyBundle`'s real input type (it takes the builder output shape in `run-strategy-baseline.mts` step 2) and type `parsed` accordingly instead of `as never` — the cast above is a sketch, the final code must typecheck strictly.

- [ ] **Step 4: Run tests** — PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(research): reconstructStrategyBundle — hash-verified bundle rebuild from ArtifactRef`

---

### Task 3: ExperimentService — persist ref, `correlationId`+`agentOpts` on RunWfoInput, budget gate

**Files:**
- Modify: `src/research/experiment-service.ts`
- Test: `src/research/experiment-service.wfo.test.ts` (budget gate), `src/research/experiment-service.strategy.test.ts` (ref persist)

**Interfaces:**
- Consumes: `withinTokenBudget` (src/orchestrator/token-budget.ts), `TokenUsageRepository` (src/ports/token-usage.repository.ts), `AgentCallOpts` (src/ports/agent-call-opts.ts), Task 1's `bundleArtifactRef`.
- Produces (Tasks 4/5/7 rely on these exact shapes):
  - `RunStrategyBaselineValidationInput` += `bundleArtifactRef?: ArtifactRef` (persisted onto the created experiment row).
  - `RunWfoInput` += `correlationId: string` (required) and `agentOpts?: AgentCallOpts`.
  - `ExperimentServiceDeps` += `tokenUsage?: Pick<TokenUsageRepository, 'get'>` and `researchTaskTokenBudget?: number`.
  - New terminalReason string: `'budget_exhausted'`.

- [ ] **Step 1: Failing tests** (extend the existing wfo test file's fake-deps builder):

```ts
it('persists bundleArtifactRef on the baseline experiment row', async () => {
  const ref = testArtifactRef(); // same literal shape as Task 1's test
  const { experimentId } = await service.runStrategyBaselineValidation({ ...baselineInput(), bundleArtifactRef: ref });
  expect((await experiments.findById(experimentId))?.bundleArtifactRef).toEqual(ref);
});

it('stops with budget_exhausted before GATE1 when the correlation budget is spent', async () => {
  const service = makeService({ tokenUsage: { get: async () => 1_000_000 }, researchTaskTokenBudget: 500_000 });
  const { verdict, terminalReason } = await service.runWalkForwardOptimization({ ...wfoInput(), correlationId: 'corr-1' });
  expect(verdict).toBe('INCONCLUSIVE');
  expect(terminalReason).toBe('budget_exhausted');
  expect(gate1.calls).toHaveLength(0); // GATE1 never invoked
});

it('stops the round loop between rounds when the budget runs out mid-experiment', async () => {
  let cumulative = 0;
  const service = makeService({
    tokenUsage: { get: async () => cumulative }, researchTaskTokenBudget: 100,
    // fake sweepDesigner bumps `cumulative` past 100 via its onUsage-equivalent side effect
  });
  // round 1 runs; before round 2's sweepDesigner call the gate trips
  const out = await service.runWalkForwardOptimization({ ...wfoInput(), correlationId: 'corr-2' });
  expect(out.terminalReason).toBe('budget_exhausted');
  expect(sweepDesigner.calls).toHaveLength(1);
});

it('forwards agentOpts to gate1/sweepDesigner/resultInterpreter calls', async () => {
  const seen: string[] = [];
  const agentOpts = { onUsage: async () => { seen.push('usage'); } };
  await service.runWalkForwardOptimization({ ...wfoInput(), correlationId: 'corr-3', agentOpts });
  // fake agents call opts?.onUsage?.(...) once each when opts present
  expect(seen.length).toBeGreaterThanOrEqual(2);
});
```

Adapt helper names (`makeService`, `wfoInput`, fake agents with `.calls`) to the file's existing fixtures — it already builds fake gate1/sweepDesigner/resultInterpreter; extend the fakes to record calls and invoke `opts?.onUsage`.

- [ ] **Step 2: Run** `npx vitest run src/research/experiment-service.wfo.test.ts src/research/experiment-service.strategy.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `experiment-service.ts`:
  1. `RunStrategyBaselineValidationInput` += `bundleArtifactRef?: ArtifactRef`; in `runStrategyBaselineValidation`'s `createExperiment(...)` object add `...(input.bundleArtifactRef !== undefined ? { bundleArtifactRef: input.bundleArtifactRef } : {})`.
  2. `RunWfoInput` += `correlationId: string; agentOpts?: AgentCallOpts;`.
  3. `ExperimentServiceDeps` += `tokenUsage?: Pick<TokenUsageRepository, 'get'>; researchTaskTokenBudget?: number;`.
  4. Private helper:

```ts
private async budgetExhausted(correlationId: string): Promise<boolean> {
  if (!this.d.tokenUsage || this.d.researchTaskTokenBudget === undefined) return false;
  const cumulative = await this.d.tokenUsage.get(correlationId);
  return !withinTokenBudget(cumulative, this.d.researchTaskTokenBudget);
}
```

  5. In `runWalkForwardOptimization`: (a) BEFORE the `gate1.decide` call (line ~435): if `await this.budgetExhausted(input.correlationId)` → finalize the experiment exactly like the existing GATE1-stop path but with `verdict: 'INCONCLUSIVE'`, `terminalReason: 'budget_exhausted'` (reuse the existing finalize/update+addEvaluation+event code path — do NOT invent a second finalize). (b) At the TOP of each round iteration (before `sweepDesigner.design`, line ~455), same check → break out of the loop with `terminalReason: 'budget_exhausted'`; if the previous round's interpretation was `select`, the existing post-loop holdout run still executes (backtest, not LLM). (c) Pass `input.agentOpts` as the `opts` argument to all three agent calls: `this.d.gate1.decide(x, input.agentOpts)`, `this.d.sweepDesigner.design(x, input.agentOpts)`, `this.d.resultInterpreter.interpret(x, input.agentOpts)`.
- [ ] **Step 4: Run tests** — PASS; run the FULL suite `npm test` (this file is load-bearing; the wfo/strategy/holdout tests must all stay green with `correlationId` added to their inputs — update existing test fixtures to pass `correlationId: 'test-corr'`).
- [ ] **Step 5: Commit** — `feat(research): WFO budget kill-switch (correlationId-keyed) + bundleArtifactRef persist + agentOpts passthrough`

---

### Task 4: `strategy.baseline` + `strategy.wfo` task types; `strategyBaselineHandler`

**Files:**
- Modify: `src/domain/schemas.ts:3` (AGENT_TASK_TYPES)
- Create: `src/orchestrator/handlers/strategy-baseline.handler.ts`
- Modify: `src/composition.ts` (router.register ×1; ExperimentService deps get `tokenUsage: services-to-be.tokenUsage`-equivalent + `researchTaskTokenBudget: env.RESEARCH_TASK_TOKEN_BUDGET` — wire the two new optional deps)
- Test: `src/orchestrator/handlers/strategy-baseline.handler.test.ts`

**Interfaces:**
- Consumes: `runStrategyBaselineValidation` (Task 3 shape), `createAndEnqueueTask` (src/orchestrator/task-intake.ts — same call shape as chain-runner.ts:50), `getAuthoringDoc('strategy')` from `@trading-backtester/sdk/builder`, `assembleStrategyBundle`, `RESEARCH_RUN_METRICS`.
- Produces:
  - `AGENT_TASK_TYPES` += `'strategy.baseline', 'strategy.wfo'` (append; do not reorder; note: legacy reserved `'sweep.run'` stays untouched).
  - `StrategyBaselinePayloadSchema = z.object({ strategyProfileId: z.string().min(1), sourceTaskId: z.string().optional() })` (exported — mirrors `HypothesisBuildPayloadSchema` convention).
  - Handler enqueues `strategy.wfo` with payload `{ baselineExperimentId }`, `correlationId: task.correlationId`, `dedupeKey: \`strategy.wfo:${experimentId}\``.
  - Events: `strategy.baseline.started` / `strategy.baseline.completed` (payload `{ strategyProfileId, experimentId, verdict, bundleHash }`).

- [ ] **Step 1: Failing test** — fake `AppServices` subset (mirror `hypothesis-build.handler.test.ts` fixture style):

```ts
it('builds, persists ref, runs baseline validation, enqueues strategy.wfo with the task correlationId', async () => {
  const { services, queued, artifacts, experimentCalls } = makeFakeServices();
  await strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1' }), services);
  expect(experimentCalls[0].bundleArtifactRef).toBeDefined();          // ref passed through
  expect(artifacts.puts[0].meta.kind).toBe('strategy_bundle');
  expect(queued[0]).toMatchObject({
    taskType: 'strategy.wfo',
    payload: { baselineExperimentId: experimentCalls[0].returnedExperimentId },
    correlationId: taskOf({}).correlationId,
    dedupeKey: expect.stringMatching(/^strategy\.wfo:/),
  });
});

it('does not enqueue strategy.wfo when the baseline lane throws', async () => {
  const { services, queued } = makeFakeServices({ baselineThrows: true });
  await expect(strategyBaselineHandler(taskOf({ strategyProfileId: 'prof-1' }), services)).rejects.toThrow();
  expect(queued).toHaveLength(0);
});

it('rejects an invalid payload', async () => {
  await expect(strategyBaselineHandler(taskOf({}), services)).rejects.toThrow(/invalid strategy.baseline payload/);
});
```

- [ ] **Step 2: Run** — FAIL (module not found).
- [ ] **Step 3: Implement** `strategy-baseline.handler.ts`:

```ts
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { assembleStrategyBundle } from '../../domain/strategy-bundle.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import { getAuthoringDoc } from '@trading-backtester/sdk/builder';
import { createAndEnqueueTask } from '../task-intake.ts';

export const StrategyBaselinePayloadSchema = z.object({
  strategyProfileId: z.string().min(1),
  sourceTaskId: z.string().optional(),
});

export const strategyBaselineHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(StrategyBaselinePayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid strategy.baseline payload: ${JSON.stringify(parsed.issues)}`);
  const { strategyProfileId } = parsed.data;

  const profile = await services.strategyProfiles.findById(strategyProfileId);
  if (!profile) throw new Error(`strategy_profile ${strategyProfileId} not found`);

  await services.events.append(event(task.id, 'strategy.baseline.started', { strategyProfileId }));

  const out = await services.strategyBuilder.build({
    spec: { description: `baseline validation for profile ${profile.id}` },
    authoringDoc: getAuthoringDoc('strategy'),
    profile,
  });
  const bundle = await assembleStrategyBundle(out);
  const bundleArtifactRef = await services.artifacts.put(
    JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'strategy-baseline-handler' },
  );

  const run = services.defaultPlatformRun;
  const { experimentId, verdict } = await services.experimentService.runStrategyBaselineValidation({
    strategyProfileId: profile.id,
    strategyBundle: bundle,
    bundleArtifactRef,
    datasetScope: { datasetId: run.datasetId, symbols: run.symbols, timeframe: run.timeframe, period: run.period },
    runConfig: { datasetId: run.datasetId, symbols: run.symbols, timeframe: run.timeframe, seed: run.seed },
    metrics: RESEARCH_RUN_METRICS,
    taskId: task.id,
  });

  await createAndEnqueueTask(
    {
      taskType: 'strategy.wfo',
      source: task.source,
      payload: { baselineExperimentId: experimentId },
      correlationId: task.correlationId,
      dedupeKey: `strategy.wfo:${experimentId}`,
    },
    { repo: services.researchTasks, queue: services.queue },
  );

  await services.events.append(event(task.id, 'strategy.baseline.completed', {
    strategyProfileId, experimentId, verdict, bundleHash: bundle.bundleHash,
  }));
};
```

NOTE for implementer: `event(...)` — reuse the same local event-constructor helper pattern the sibling handlers use (see `backtest-completed.handler.ts`); check whether `AppServices` exposes `queue`/`researchTasks` under these names (chain-runner uses a separate deps object — if `AppServices` lacks them, mirror how `researchRunCycleHandler` enqueues `hypothesis.build` and use that exact mechanism instead of `createAndEnqueueTask`).
Then: `schemas.ts` — append `'strategy.baseline', 'strategy.wfo'` to `AGENT_TASK_TYPES`; `composition.ts` — `router.register('strategy.baseline', strategyBaselineHandler);` and pass `tokenUsage` + `researchTaskTokenBudget: env.RESEARCH_TASK_TOKEN_BUDGET` into the `ExperimentService` deps object.

- [ ] **Step 4: Run tests** — handler test PASS; `npm test` (ingress schema tests may assert the task-type enum — update snapshots/fixtures if they enumerate types).
- [ ] **Step 5: Commit** — `feat(orchestrator): strategy.baseline task type — build → persist ref → baseline validation → enqueue strategy.wfo`

---

### Task 5: `strategyWfoHandler` (reconstruction path)

**Files:**
- Create: `src/orchestrator/handlers/strategy-wfo.handler.ts`
- Modify: `src/composition.ts` (router.register)
- Test: `src/orchestrator/handlers/strategy-wfo.handler.test.ts`

**Interfaces:**
- Consumes: `reconstructStrategyBundle` (Task 2), `RunWfoInput` with `correlationId`+`agentOpts` (Task 3), `makeOnUsage(task, services)` (src/orchestrator/make-on-usage.ts).
- Produces: payload schema `StrategyWfoPayloadSchema = z.object({ baselineExperimentId: z.string().min(1) })`; events `strategy.wfo.started` / `strategy.wfo.completed` (`{ baselineExperimentId, experimentId, verdict, terminalReason }`).

- [ ] **Step 1: Failing tests**

```ts
it('reconstructs the baseline bundle from bundleArtifactRef and runs WFO with task.correlationId', async () => {
  const { services, wfoCalls } = makeFakeServices({ baselineExperiment: withRef() });
  await strategyWfoHandler(taskOf({ baselineExperimentId: 'exp-base' }), services);
  expect(wfoCalls[0].correlationId).toBe(taskOf({}).correlationId);
  expect(wfoCalls[0].strategyBundle.bundleHash).toBe(persistedBundleHash);
  expect(wfoCalls[0].agentOpts?.onUsage).toBeTypeOf('function');   // makeOnUsage wired
});

it('fails with an actionable error when the baseline experiment has no bundleArtifactRef', async () => {
  const { services } = makeFakeServices({ baselineExperiment: withoutRef() });
  await expect(strategyWfoHandler(taskOf({ baselineExperimentId: 'exp-base' }), services))
    .rejects.toThrow(/re-run baseline|bundleArtifactRef/i);
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**

```ts
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import { reconstructStrategyBundle } from '../../research/reconstruct-strategy-bundle.ts';
import { makeOnUsage } from '../make-on-usage.ts';

export const StrategyWfoPayloadSchema = z.object({ baselineExperimentId: z.string().min(1) });

export const strategyWfoHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(StrategyWfoPayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid strategy.wfo payload: ${JSON.stringify(parsed.issues)}`);
  const { baselineExperimentId } = parsed.data;

  const baseline = await services.experiments.findById(baselineExperimentId);
  if (!baseline) throw new Error(`research_experiment ${baselineExperimentId} not found`);
  if (!baseline.bundleArtifactRef) {
    throw new Error(
      `baseline experiment ${baselineExperimentId} has no bundleArtifactRef — re-run the baseline `
      + '(strategy.baseline) to persist the bundle; WFO never rebuilds via the LLM builder.',
    );
  }
  const profile = await services.strategyProfiles.findById(baseline.strategyProfileId);
  if (!profile) throw new Error(`strategy_profile ${baseline.strategyProfileId} not found`);

  await services.events.append(event(task.id, 'strategy.wfo.started', { baselineExperimentId }));

  const strategyBundle = await reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef);
  const scope = baseline.datasetScope;
  const { experimentId, verdict, terminalReason } = await services.experimentService.runWalkForwardOptimization({
    baselineExperimentId,
    strategyBundle,
    profile,
    strategyProfileId: baseline.strategyProfileId,
    datasetScope: scope,
    runConfig: { datasetId: scope.datasetId, symbols: scope.symbols, timeframe: scope.timeframe, seed: services.defaultPlatformRun.seed },
    metrics: RESEARCH_RUN_METRICS,
    taskId: task.id,
    correlationId: task.correlationId,
    agentOpts: makeOnUsage(task, services),
  });

  await services.events.append(event(task.id, 'strategy.wfo.completed', {
    baselineExperimentId, experimentId, verdict, terminalReason,
  }));
};
```

(`event(...)`: same sibling-handler helper convention as Task 4.) Register: `router.register('strategy.wfo', strategyWfoHandler);`.

- [ ] **Step 4: Run tests** — PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(orchestrator): strategy.wfo task type — hash-verified bundle reconstruction, correlationId budget key, onUsage accrual`

---

### Task 6: Chat autochain — ChainSpec union + chain-selection rule + chain-runner payload

**Files:**
- Modify: `src/chat/guard.ts:33` (ChainSpec), `src/chat/guard.ts:58` (buildOnboardDecision)
- Modify: `src/orchestrator/chain-runner.ts` (dedupeKey; payload is `{strategyProfileId}` for both types — already generic)
- Test: `src/chat/guard.test.ts`, `src/orchestrator/chain-runner.test.ts`

**Interfaces:**
- Consumes: Task 4's `'strategy.baseline'` task type.
- Produces: `ChainSpec.nextTaskType: 'research.run_cycle' | 'strategy.baseline'`. Chain rule: ordinary onboarding (`withResearch === false`) → chain `strategy.baseline`; explicit research goal (`withResearch === true`) → chain `research.run_cycle` (unchanged).

- [ ] **Step 1: Failing tests**

```ts
// guard.test.ts
it('ordinary strategy onboarding chains strategy.baseline after confirm', async () => {
  const d = await planChatAction(turnOf({ subject: 'strategy', goal: undefined, strategyText: 'buy dips' }), args);
  expect(d).toMatchObject({ kind: 'propose_task', taskType: 'strategy.onboard', chain: { nextTaskType: 'strategy.baseline' } });
});
it('explicit research goal still chains research.run_cycle', async () => {
  const d = await planChatAction(turnOf({ subject: 'strategy', goal: 'research', strategyText: 'buy dips' }), args);
  expect(d).toMatchObject({ chain: { nextTaskType: 'research.run_cycle' } });
});

// chain-runner.test.ts
it('advances a strategy.baseline plan with a type-scoped dedupeKey and {strategyProfileId} payload', async () => {
  const plan = planOf({ nextTaskType: 'strategy.baseline' });
  await advanceChatPlan(completedOnboardTask(), depsWith(plan));
  expect(created[0]).toMatchObject({
    taskType: 'strategy.baseline',
    payload: { strategyProfileId: 'prof-1' },
    dedupeKey: `chat_plan:${plan.id}:strategy.baseline`,
  });
});
```

- [ ] **Step 2: Run** — FAIL (guard: chain undefined for ordinary onboarding; chain-runner: dedupeKey hardcodes research.run_cycle).
- [ ] **Step 3: Implement** — guard.ts:

```ts
export interface ChainSpec {
  nextTaskType: 'research.run_cycle' | 'strategy.baseline';
  resolveProfileByFingerprint: string;
}
// buildOnboardDecision: replace the conditional chain with an always-chain:
const chain: ChainSpec = {
  nextTaskType: withResearch ? 'research.run_cycle' : 'strategy.baseline',
  resolveProfileByFingerprint: sourceFingerprint(kind, text),
};
```

chain-runner.ts: `const dedupeKey = \`chat_plan:${plan.id}:${plan.nextTaskType}\`;` (payload `{ strategyProfileId: profile.id }` already fits both task types; update the doc-comment "single MVP continuation" wording).

- [ ] **Step 4: Run tests** — the two files PASS, then `npm test` (chat-handler tests asserting `chain === undefined` for ordinary onboarding will now see a chain — update those expectations: plannedNextStep now present for ordinary onboarding).
- [ ] **Step 5: Commit** — `feat(chat): onboard autochain — ordinary onboarding chains strategy.baseline; research goal keeps research.run_cycle`

---

### Task 7: CLI scripts — ref-based reconstruction

**Files:**
- Modify: `scripts/run-strategy-baseline.mts` (pass ref)
- Modify: `scripts/run-strategy-wfo.mts` (drop rebuild + pre-flight; reconstruct; drop BUILDER_ADAPTER/MODEL_PROVIDER requirements; add correlationId)

**Interfaces:**
- Consumes: Tasks 1–3 (`bundleArtifactRef`, `reconstructStrategyBundle`, `RunWfoInput.correlationId`).

- [ ] **Step 1: baseline script** — capture and pass the ref:

```ts
const bundleArtifactRef = await services.artifacts.put(/* unchanged args */);
// runStrategyBaselineValidation input += bundleArtifactRef
```

- [ ] **Step 2: wfo script** — delete: the `strategyBuilder.build` block (step 3), the pre-flight hash guard (step 3b), the `artifacts.put` audit anchor (step 4 — the ref already exists on the baseline row), and the `BUILDER_ADAPTER`/`MODEL_PROVIDER`/key env-validation blocks (WFO agents still need `WFO_*_ADAPTER=mastra` + provider key — KEEP those and keep MODEL_PROVIDER validation ONLY if the three WFO mastra adapters read it; check composition and keep the minimal set). Replace with:

```ts
if (!baseline.bundleArtifactRef) {
  throw new Error(
    `baseline experiment ${baselineExperimentId} has no bundleArtifactRef — re-run `
    + 'scripts/run-strategy-baseline.mts (post-G1 version) to persist the bundle ref.',
  );
}
const strategyBundle = await reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef);
```

and pass `correlationId: taskId` (the script's generated `run-strategy-wfo-${randomUUID()}` doubles as the budget key) into `runWalkForwardOptimization`. Rewrite the header: KNOWN LIMITATION block → short "reconstructs the exact baseline bundle from research_experiment.bundle_artifact_ref".

- [ ] **Step 3: Manual typecheck** (scripts are outside tsconfig):

```bash
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --allowImportingTsExtensions --skipLibCheck scripts/run-strategy-baseline.mts scripts/run-strategy-wfo.mts
```

Expected: clean.
- [ ] **Step 4: Commit** — `feat(scripts): WFO script reconstructs the persisted baseline bundle (self-block removed)`

---

### Task 8: Env docs + full gates

**Files:**
- Modify: `.env.example` (+ the docker demo overlay if it enumerates worker env — check `docker/` compose files for `RESEARCH_TASK_TOKEN_BUDGET` absence)

- [ ] **Step 1:** Add to `.env.example` next to the other research vars:

```bash
# Cumulative LLM token budget per research chain (correlationId-keyed). Gates: between
# research cycles AND between WFO sweep rounds. Unset = unlimited.
RESEARCH_TASK_TOKEN_BUDGET=
```

- [ ] **Step 2: Full gates** — `npm run typecheck` clean; `npm test` 0 failed.
- [ ] **Step 3: Commit** — `chore(env): document RESEARCH_TASK_TOKEN_BUDGET (.env.example)`

---

## Self-review notes

- Spec coverage: §2→Tasks 1/2/3/7, §3→Tasks 4/5/6, §4→Tasks 3/5/8, §5→Task 7, §6 test list→embedded per task (integration onboard→baseline→wfo chain rides on Task 6's chain-runner test + Task 4/5 handler tests; if a full-chain in-memory integration test is cheap after Task 6, add it there mirroring `new-strategy-holdout.integration.test.ts`).
- Known verify-at-implement points (flagged inline): `assembleStrategyBundle` input typing (Task 2), enqueue mechanism available on `AppServices` (Task 4), which env vars the WFO mastra adapters truly need (Task 7). Each is a one-file check for the implementing agent.
- `'sweep.run'`/`'paper.start'` legacy reserved task types intentionally untouched (YAGNI; removal is not this slice).
