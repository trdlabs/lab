# Slice G3 — Strategy Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge proxy-passed hypotheses of a research cycle into a `strategy_revision` (standalone strategy bundle via a deterministic composition harness), accept it ONLY through a strategy-lane comparison against the current accepted revision on the same run-context, stack round N+1 on the accepted revision, and feed proxy verdicts back onto `HypothesisProposal`.

**Spec:** `docs/superpowers/specs/2026-07-03-strategy-revisions-design.md` (APPROVED; user dialogue decisions + 4 review fixes).

**Architecture:** New `strategy_revision` table (bootstrap v1 from the G1 baseline). A pure pipeline — score → conflict-detect → `composeRevisionBundle` (namespace-isolated harness mirroring the engine's OverlayComposer semantics) — feeds a new `revision.build` task (triggered when all of a cycle's hypothesis tasks are terminal), which validates the candidate via a `StrategyRevisionRunExecutor` port (today: G1 strategy-lane submit/poll) against the accepted revision's comparable run, with greedy degradation (max 2 retries). Researcher's `activeOverlayRules` switches to the accepted revision's merged rule set.

**Tech Stack:** TypeScript (strip-types), Drizzle (migrations 0018+), BullMQ, Vitest, `@trading-backtester/sdk` (submitStrategyResearchRun lane).

## Global Constraints

- Terminology invariant (spec §3): overlay-lane results are **proxy** signals — the words "proven"/"active" for an individual hypothesis are forbidden in code/events/docs. The ONLY proof = accepted `strategy_revision` after strategy-lane combo validation.
- Score order EXACTLY (spec §4): verdict rank desc → netPnl delta desc → maxDrawdown improvement desc → createdAt desc → hypothesisId asc.
- Greedy degradation: max 2 retries (≤3 candidate combo runs + ≤1 comparison-baseline run per cycle). Every dropped hypothesis explainable: `merge_conflict_dropped` | `combo_fail_dropped` | `unsupported_module_shape` in `strategy_revision.dropped` + events.
- Same-run-context guarantee (spec §3): candidate is NEVER compared against metrics from a different datasetScope/paramsHash; if the accepted revision lacks a comparable run, run it first via the executor.
- Composition harness: modules isolated in own namespaces (no shared scope), fixed deterministic order, semantics mirror engine OverlayComposer (`pass|annotate|patch|veto`, veto terminal); deterministic output (same input → byte-identical bundle → same bundleHash).
- No LLM in the merge/acceptance core path. Migrations ADDITIVE only (`npm run db:generate`; next number 0018). NO TS parameter properties.
- New enum value `revision.build` appended to AGENT_TASK_TYPES (append-only). `paper-intake.port.ts` untouched.
- Gates per task: focused vitest; before each task-completing commit `npm run typecheck` clean + FULL `npm test` 0 failed (baseline on this branch: 2969 passed).

---

### Task 1: `strategy_revision` entity (domain + schema + migration 0018 + repos)

**Files:**
- Create: `src/domain/strategy-revision.ts`, `src/ports/strategy-revision.repository.ts`, `src/adapters/repository/drizzle-strategy-revision.repository.ts`, `src/adapters/repository/in-memory-strategy-revision.repository.ts`
- Modify: `src/db/schema.ts` (new pgTable after `paperSubmission`)
- Create: migration via `npm run db:generate` → `migrations/0018_*.sql`
- Test: `src/adapters/repository/in-memory-strategy-revision.repository.test.ts`

**Interfaces (Produces — later tasks rely on exact names):**

```ts
// src/domain/strategy-revision.ts
export type RevisionStatus = 'candidate' | 'accepted' | 'rejected';
export type DroppedReason = 'merge_conflict_dropped' | 'combo_fail_dropped' | 'unsupported_module_shape';
export interface DroppedHypothesis { hypothesisId: string; reason: DroppedReason; detail: string; }
export interface StrategyRevision {
  id: string;
  strategyProfileId: string;
  version: number;                        // monotonic per profile; UNIQUE(profileId, version)
  baseRevisionId?: string;                // null => v1 bootstrap from G1 baseline
  hypothesisIds: string[];
  dropped?: DroppedHypothesis[];
  mergedRuleSet: Record<string, unknown>; // { order: hypothesisId[], rules: RuleAction[] }
  bundleArtifactRef?: ArtifactRef;        // composed revision STRATEGY bundle
  bundleHash?: string;
  comboBacktestRunId?: string;            // strategy-lane StrategyBacktestRun id (validation run)
  status: RevisionStatus;
  metrics?: Record<string, unknown>;      // BacktestMetricBlock of the accepted run
  verdictReason?: string;
  createdAt: string; updatedAt: string;
}
// src/ports/strategy-revision.repository.ts
export interface StrategyRevisionRepository {
  create(r: StrategyRevision): Promise<void>;
  findById(id: string): Promise<StrategyRevision | null>;
  findLatestAccepted(strategyProfileId: string): Promise<StrategyRevision | null>; // max version with status accepted
  updateStatus(id: string, patch: Partial<Pick<StrategyRevision,
    'status' | 'comboBacktestRunId' | 'metrics' | 'verdictReason' | 'dropped' | 'hypothesisIds' | 'mergedRuleSet' | 'bundleArtifactRef' | 'bundleHash' | 'updatedAt'>>): Promise<void>;
  listByProfile(strategyProfileId: string): Promise<StrategyRevision[]>; // version asc
}
```

pgTable: text/int/jsonb mirroring the domain (idiom = `paperSubmission` table; jsonb `$type<>` for dropped/mergedRuleSet/bundleArtifactRef/metrics), `uniqueIndex('strategy_revision_profile_version_uq').on(strategyProfileId, version)`, index on (strategyProfileId, status).

- [ ] **Step 1: Failing tests** — round-trip; `findLatestAccepted` picks max accepted version among mixed statuses; `updateStatus` patches defined fields only (explicit `!== undefined` guards, NOT spread — mirror `drizzle-paper-submission.repository.ts::updateMonitorState`); unknown id → throw naming the id; unique (profile, version) enforced in-memory (second create with same pair → throw).
- [ ] **Step 2: RED** `npx vitest run src/adapters/repository/in-memory-strategy-revision.repository.test.ts`.
- [ ] **Step 3: Implement** all four files + schema. **Step 4:** `npm run db:generate` → 0018 contains ONLY the CREATE TABLE + 2 indexes. **Step 5:** focused PASS → typecheck → FULL suite. **Step 6: Commit** `feat(research): strategy_revision entity — additive 0018, repos with latest-accepted lookup`

---

### Task 2: HypothesisProposal proxy statuses + proxyMetrics + updateStatus

**Files:**
- Modify: `src/domain/hypothesis.ts` (HypothesisStatus union + optional field), `src/ports/hypothesis-proposal.repository.ts`, both adapters, `src/db/schema.ts` (hypothesis_proposal += `proxy_metrics jsonb`), `src/orchestrator/handlers/backtest-completed.handler.ts`
- Create: migration 0019 (single ADD COLUMN)
- Test: hypothesis repo tests + backtest-completed handler tests (extend)

**Interfaces:**
- Consumes: `HypothesisStatus = 'validated' | 'rejected'` today (src/domain/hypothesis.ts:52); status column is plain `text` (schema.ts:97 — widening VALUES needs NO DDL; only the new jsonb column does).
- Produces:

```ts
export type HypothesisStatus = 'validated' | 'rejected'
  | 'proxy_passed' | 'proxy_failed' | 'proxy_paper_candidate'
  | 'merged' | 'dropped_merge_conflict' | 'dropped_combo_fail' | 'dropped_unsupported_shape';
export interface HypothesisProxyMetrics {
  decision: 'PASS' | 'FAIL' | 'MODIFY' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';
  deltaNetPnlUsd: number; deltaMaxDrawdownPct: number; backtestRunId: string;
}
// HypothesisProposal += proxyMetrics?: HypothesisProxyMetrics;
// repo += updateStatus(id: string, status: HypothesisStatus, proxyMetrics?: HypothesisProxyMetrics): Promise<void>; // throws on unknown id
```

- `backtestCompletedHandler`: after its existing switch, when `hypothesisId` present → `services.hypotheses.updateStatus(hypothesisId, mapDecisionToProxyStatus(decision), { decision, deltaNetPnlUsd, deltaMaxDrawdownPct, backtestRunId })`. Mapping: PASS→proxy_passed, PAPER_CANDIDATE→proxy_paper_candidate, FAIL|MODIFY|INCONCLUSIVE→proxy_failed. Deltas: the handler currently receives only `decision/reasons` — extend `BacktestCompletedPayloadSchema` with OPTIONAL `deltaNetPnlUsd: z.number().optional(), deltaMaxDrawdownPct: z.number().optional()` and thread them from where the payload is built (find the enqueue site: `finalizeBacktestCompletion` in `src/orchestrator/handlers/backtest-support.ts` computes the Evaluation from ComparisonSummary — add `variant.netPnlUsd - baseline.netPnlUsd` and `variant.maxDrawdownPct - baseline.maxDrawdownPct` to the enqueued payload). Missing deltas → proxyMetrics written with 0s and a `proxy_deltas_missing` event (fail-soft, older in-flight tasks).
- Status write is fail-soft (try/catch + event `hypothesis.status_update_failed`) — verdict bookkeeping must not fail the task.

- [ ] **Step 1: RED tests** (repo: updateStatus round-trip incl. proxyMetrics + unknown-id throw; handler: each decision → expected status+metrics on the proposal; missing hypothesis row → event, no throw). **Step 2-4:** implement, migration 0019 (ONLY `ALTER TABLE hypothesis_proposal ADD COLUMN proxy_metrics jsonb;`), gates. **Step 5: Commit** `feat(research): hypothesis proxy statuses + proxyMetrics feedback from backtest.completed`

---

### Task 3: Score module (pure)

**Files:**
- Create: `src/research/hypothesis-score.ts` + test

**Produces:**

```ts
export interface ScoredHypothesis { proposal: HypothesisProposal; }
export const VERDICT_RANK: Record<string, number> = { PAPER_CANDIDATE: 2, PASS: 1 }; // others never eligible
export function compareHypotheses(a: HypothesisProposal, b: HypothesisProposal): number;
// lexicographic: VERDICT_RANK[proxyMetrics.decision] desc → proxyMetrics.deltaNetPnlUsd desc
// → (-proxyMetrics.deltaMaxDrawdownPct) desc (improvement = smaller delta) → createdAt desc → id asc.
// Missing createdAt on either side → skip that tier (spec §4). Missing proxyMetrics → treated as rank 0 (sorts last).
export function sortEligible(proposals: HypothesisProposal[]): HypothesisProposal[];
// filters status ∈ {proxy_passed, proxy_paper_candidate} then sorts by compareHypotheses
```

- [ ] TDD: table tests for every tier + both tie-breaks + eligibility filter (validated/proxy_failed excluded). Gates. **Commit** `feat(research): deterministic hypothesis score (verdict→pnl→drawdown→createdAt→id)`

---

### Task 4: Conflict detector (pure)

**Files:**
- Create: `src/research/rule-conflict.ts` + test

**Produces:**

```ts
export interface RuleConflict { winnerId: string; loserId: string; key: string; detail: string; }
export function detectConflicts(ordered: HypothesisProposal[]): { kept: HypothesisProposal[]; conflicts: RuleConflict[] };
// Walk in score order (winner = earlier). Conflict = same ruleAction.appliesTo AND two rules with the
// same (action, param key) but different values, OR contradictory action pair on the same appliesTo:
// CONTRADICTORY_PAIRS = [['skip_entry','allow_entry'], ['tighten_stop','widen_stop']].
// Loser (later in order) is dropped ENTIRELY (whole hypothesis), with detail naming key+values.
```

- [ ] TDD: same-param different-value → later dropped; contradictory pair → later dropped; disjoint params/actions coexist; multiple losers vs one winner; determinism (same input → same output). Gates. **Commit** `feat(research): deterministic rule-conflict detector (score-order winner)`

---

### Task 5: Composition harness — `composeRevisionBundle` (pure codegen)

**Files:**
- Create: `src/research/compose-revision-bundle.ts` + test
- Investigation artifact: append findings to the module's header doc-comment.

**Interfaces:**
- Consumes: `AssembledStrategyBundle` (base bundle: `source`, `manifest`, `bundleHash`, `bytes`), overlay module sources from hypothesis build artifacts (module_bundle artifacts persisted by hypothesisBuildHandler — locate via the build's artifact; the handler stores `{source, manifest, bundleHash}` wrappers), `assembleStrategyBundle` for output assembly.
- Produces:

```ts
export interface OverlayModuleInput { hypothesisId: string; source: string; }  // the overlay module's entry source
export interface ComposeResult {
  output: StrategyBuilderOutput;            // { source, manifestMeta } — feed to assembleStrategyBundle
  included: string[];                        // hypothesisIds actually composed
  unsupported: { hypothesisId: string; detail: string }[]; // shape-fallback drops
  mergedRuleSet: Record<string, unknown>;    // { order, rules } for the revision row + researcher context
}
export function composeRevisionBundle(args: {
  baseSource: string; baseManifestMeta: StrategyManifestMeta;
  overlays: OverlayModuleInput[];            // ALREADY score-ordered, conflicts removed
  ruleActions: Record<string, RuleAction>;   // hypothesisId → ruleAction (for mergedRuleSet)
  revisionVersion: number;
}): ComposeResult;
```

**MANDATORY investigation step (before coding the harness):** overlay modules come in two documented shapes (src/adapters/builder/builder-sdk-doc.ts): Style B functional `export const overlay = function apply(ctx){...} → {kind:'pass'|'veto'|'patch'|'annotate'}` and Style A data-only `export const overlay = {appliesTo, rules:[{when: <free text>, action, params}]}`. Free-text `when` is NOT machine-evaluable in lab. Check how the backtester engine treats Style A (trading-backtester OverlayComposer / module host — one focused read). Decision rule fixed by this plan:
- Style B → composed natively by the harness.
- Style A → **NOT composed**: returned in `unsupported` with detail `data-driven overlay (free-text when) cannot be deterministically composed lab-side` → the caller drops the hypothesis as `unsupported_module_shape` (ledger + event). If the investigation finds the engine has a deterministic Style-A interpreter that lab can mirror exactly, note it in the header as a follow-up — do NOT implement it in this slice.

**Harness codegen (deterministic template):**

```ts
// Generated source layout (packaging concatenation ONLY inside this fixed template):
// 1. Base strategy factory captured in its own namespace:
//    const __base = (() => { <baseSource with `export default` rewritten to a local return> })();
// 2. Each overlay module isolated: const __ov_<i> = (() => { <overlaySource with `export const overlay` rewritten to return> })();
// 3. Fixed composer mirroring engine semantics (pass/annotate/patch/veto, veto terminal, patch replaces decision):
//    export default function createStrategyModule() {
//      const base = __base();  // or __base if already an instance — follow the actual factory contract
//      return { onBarClose(ctx) {
//        let decision = base.onBarClose(ctx);
//        for (const ov of [__ov_0, ...]) {
//          const out = ov(ctx, decision);            // functional overlays receive ctx (+ current decision)
//          if (!out || out.kind === 'pass') continue;
//          if (out.kind === 'annotate') { /* attach tags/notes to decision.rationale */ continue; }
//          if (out.kind === 'patch') { decision = { ...decision, ...out.patch }; continue; }
//          if (out.kind === 'veto') { decision = { kind: 'idle', rationale: out.reasonCode }; break; }
//        }
//        return decision;
//      } };
//    }
```

Verify the exact base factory/hook contract against `src/adapters/builder/fixtures/short-after-pump.strategy-source.ts` (default-export factory returning `{onBarClose(ctx)}` → decisions `{kind:'idle'|'enter',...}`) and the overlay `apply(ctx)` signature against builder-sdk-doc.ts — reconcile the two ctx surfaces honestly (overlays receive the same ctx the harness got; the current decision is passed as a second argument — document that this extends the documented single-arg signature and gate on `ov.length >= 1` only). manifestMeta: derive from baseManifestMeta with `id: \`${baseManifestMeta.id}-rev${revisionVersion}\``, same hooks/params/capabilities (+ union of overlay capabilities), summary mentioning composed hypothesis ids.

- [ ] **RED tests:** determinism (two calls → identical source string; after assembleStrategyBundle — identical bundleHash); namespace isolation (two overlays with same-named internal consts compose without collision — build real bundle via assembleStrategyBundle and execute the compiled module against a stub ctx: base enter + overlay veto → idle; base enter + patch → patched; annotate → decision unchanged plus rationale note; two overlays: first veto → second never invoked (spy)); Style-A input → `unsupported` (not thrown); manifestMeta id carries `-rev${version}`.
- [ ] Implement → gates. **Commit** `feat(research): composeRevisionBundle — namespace-isolated deterministic overlay composition harness`

---

### Task 6: `StrategyRevisionRunExecutor` port + strategy-lane implementation

**Files:**
- Create: `src/ports/strategy-revision-run-executor.ts`, `src/research/backtester-revision-run-executor.ts` + test
- Modify: `src/domain/strategy-backtest-run.ts` (StrategyRunKind union += `'revision_combo'`), `src/db/schema.ts` runKind `$type` widening (no DDL — text column), `src/ports/strategy-backtest-run.repository.ts` += `findByBundleAndParams(strategyBundleId: string, paramsHash: string, bundleHash: string): Promise<StrategyBacktestRun | null>` (+ both adapters; the unique index (strategyBundleId, paramsHash, bundleHash) already exists — schema.ts:192-218)

**Produces:**

```ts
export interface RevisionRunRequest {
  revisionId: string; label: 'candidate' | 'comparison_baseline';
  strategyBundle: AssembledStrategyBundle; strategyProfileId: string;
  run: PlatformRunConfig; metrics: string[]; correlationId: string;
}
export interface RevisionRunResult { status: 'completed' | 'pending' | 'rejected'; runId: string; platformRunId: string; metrics?: BacktestMetricBlock; totalTrades?: number; }
export interface StrategyRevisionRunExecutor { execute(req: RevisionRunRequest): Promise<RevisionRunResult>; }
```

Implementation mirrors `BacktesterStrategyExperimentRunExecutor` (src/research/backtester-strategy-experiment-run-executor.ts): same submit (`platform.submitStrategyResearchRun`) / poll / persist flow, `runKind: 'revision_combo'`, `paramsHash = computeStrategyParamsHash({bundleHash, platformRun: req.run, params: {}})`, resumeToken over `{v:1, revisionId, label, paramsHash, bundleHash}`. **Reuse-first:** if extracting a shared submit/poll core from the experiment executor is a ≤30-line refactor, do it (one shared helper, both executors thin); if it demands touching the experiment executor's behavior, duplicate deliberately with a header note and leave a `follow-up: extract shared core` comment. **Dedup:** before submitting, `findByBundleAndParams(...)` — an existing completed row with metrics → return it (this is what makes the §3 same-run-context comparison cheap and idempotent).

- [ ] RED tests with fake platform (submit/poll happy path persists row with runKind revision_combo; dedup returns existing completed run WITHOUT resubmitting; rejected propagates). Gates. **Commit** `feat(research): StrategyRevisionRunExecutor — strategy-lane combo runs with by-key dedup`

---

### Task 7: Revision comparator (pure ladder)

**Files:**
- Create: `src/validation/revision-evaluator.ts` + test

**Produces:**

```ts
export const REVISION_EVALUATOR_VERSION = 'revision-combo-v1';
export interface RevisionComparisonInput { accepted: BacktestMetricBlock; candidate: BacktestMetricBlock; minTrades: number; }
export type RevisionVerdict = { decision: 'ACCEPT'; reasons: string[] } | { decision: 'REJECT'; reasons: string[] };
export function evaluateRevision(input: RevisionComparisonInput): RevisionVerdict;
// ladder (evaluateBacktest conventions, src/validation/evaluator.ts):
// candidate.totalTrades < minTrades → REJECT 'insufficient_sample'
// (candidate.netPnlUsd - accepted.netPnlUsd) <= 0 → REJECT 'no_improvement_over_accepted'
// (candidate.maxDrawdownPct - accepted.maxDrawdownPct) > 2.0 → REJECT 'drawdown_regression'
// candidate.topTradeContributionPct >= 50 → REJECT 'fragile_pnl'
// else ACCEPT with reasons ['pnl_improved', ...]
```

- [ ] TDD table over the ladder + boundaries. Gates. **Commit** `feat(research): evaluateRevision — deterministic accepted-vs-candidate ladder`

---

### Task 8: Bootstrap revision v1

**Files:**
- Modify: `src/research/experiment-service.ts` (`runStrategyBaselineValidation` finalize: after verdict persisted, create revision v1 if none accepted for the profile), deps += `revisions?: StrategyRevisionRepository`
- Modify: `src/composition.ts` (wire repo into ExperimentService + AppServices)
- Test: `src/research/experiment-service.strategy.test.ts` (extend)

Behavior (spec §1): if `findLatestAccepted(profileId)` is null → `create({version: 1, status: 'accepted', baseRevisionId: undefined, hypothesisIds: [], mergedRuleSet: {order: [], rules: []}, bundleArtifactRef: input.bundleArtifactRef, bundleHash: input.strategyBundle.bundleHash, comboBacktestRunId: <holdout member's strategyBacktestRunId, fallback sanity>, metrics: <that run's metrics>})`. Idempotent: existing accepted → no-op; UNIQUE(profile,version) is the backstop. Fail-soft (event `revision.bootstrap_failed`, baseline verdict unaffected). Deps optional → absent repo = no-op (keeps old tests green).

- [ ] RED (baseline completes → v1 accepted row with baseline artifacts; second run → still one v1; repo absent → no throw). Gates. **Commit** `feat(research): bootstrap strategy_revision v1 from completed G1 baseline`

---

### Task 9: `revision.build` handler + cycle-completion trigger

**Files:**
- Modify: `src/domain/schemas.ts` (AGENT_TASK_TYPES append `'revision.build'`), `src/ports/research-task.repository.ts` += `listByCorrelationAndTypes(correlationId: string, taskTypes: AgentTaskType[]): Promise<ResearchTask[]>` (+ both adapters), `src/orchestrator/handlers/backtest-completed.handler.ts` (trigger), `src/orchestrator/app-services.ts`, `src/composition.ts` (register + wire `revisionRunExecutor`, `revisions`)
- Create: `src/orchestrator/handlers/revision-build.handler.ts` + test

**Trigger (in backtestCompletedHandler, after status feedback):** load `listByCorrelationAndTypes(task.correlationId, ['hypothesis.build','backtest.completed'])`; if every task except the current one is in a terminal status (`completed|failed|rejected`) → `createAndEnqueueTask({taskType:'revision.build', source: task.source, payload: {strategyProfileId, correlationId: task.correlationId}, correlationId: task.correlationId, dedupeKey: \`revision.build:${task.correlationId}\`}, ...)`. Concurrent last-finishers both enqueue → dedupeKey absorbs. Fail-soft try/catch (trigger must not fail the task).

**Handler flow (payload `{strategyProfileId, correlationId}`):**
1. Ensure accepted revision exists: `findLatestAccepted` → null? → backfill branch: latest completed `strategy_baseline_validation` experiment for the profile (repo `listByType` exists) with `bundleArtifactRef` → bootstrap v1 (same shape as Task 8); still none → event `revision.skipped {reason:'no_baseline'}`, return.
2. Collect eligible: `listByStrategyProfile(profileId)` → `sortEligible` (Task 3) → cap at `REVISION_BATCH_MAX` (env, default 5, parsePositiveInt) → empty → `revision.skipped {reason:'no_eligible_hypotheses'}`, return.
3. `detectConflicts` (Task 4) → conflict losers: `hypotheses.updateStatus(id, 'dropped_merge_conflict')` + collect into `dropped`.
4. Load overlay module sources for the kept set (from the hypothesis build's `module_bundle` artifacts — the hypothesisBuildHandler persists `{source, manifest, bundleHash}` wrappers; VERIFY at implement how to locate the artifact ref per hypothesis: if no direct link exists on the proposal, extend `hypothesisBuildHandler` to `updateStatus`-attach the built artifact ref into proxyMetrics or a new optional field `buildArtifactRef` — smallest additive change, document the choice).
5. Base = accepted revision's bundle: `reconstructStrategyBundle(artifacts, accepted.bundleArtifactRef)`.
6. `composeRevisionBundle` → `unsupported` → `updateStatus(id,'dropped_unsupported_shape')` + dropped[]; empty `included` → `revision.skipped {reason:'nothing_composable'}`.
7. `assembleStrategyBundle(output)` → `validateBundle` → `artifacts.put(bytes)` (content_hash === bundleHash assert, G2b idiom) + wrapper artifact → create revision row `status:'candidate'`, version = latestAccepted.version + 1, baseRevisionId = accepted.id.
8. **Same-run-context comparison baseline:** runConfig from `services.defaultPlatformRun` (datasetScope/period/seed) — `paramsHash` computed; accepted revision's comparable run = `findByBundleAndParams(accepted-bundle manifest id, paramsHash, accepted.bundleHash)`; missing/incomplete → `executor.execute({label:'comparison_baseline', strategyBundle: <reconstructed accepted bundle>, ...})`; still not completed → revision `rejected` reason `comparison_baseline_unavailable` (INCONCLUSIVE-style, no greedy).
9. Candidate run: `executor.execute({label:'candidate', ...})` → `evaluateRevision({accepted: baselineRun.metrics, candidate: run.metrics, minTrades: 20})`.
10. ACCEPT → revision `accepted` (+metrics, comboBacktestRunId) + `updateStatus(hypothesisId,'merged')` for included + event `revision.accepted`; REJECT → greedy: drop worst (last in score order) → `updateStatus(id,'dropped_combo_fail')` → re-compose/re-assemble/re-run (max 2 retries; runs budget guard); exhausted/empty → revision `rejected` + event `revision.rejected` with all reasons.
11. Events throughout: `revision.candidate_built {revisionId, version, included, dropped}`, `revision.hypothesis_dropped {hypothesisId, reason, detail}` per drop, `revision.accepted|rejected|skipped`.

- [ ] RED tests (fake executor/repos, real in-memory ports; scenarios: happy accept; conflict drop; unsupported-shape drop; greedy 1-retry accept; greedy exhausted reject; comparison-baseline run performed when missing and skipped when present; no-eligible skip; bootstrap-backfill branch; trigger — last terminal backtest.completed enqueues exactly once, dedupe on concurrent). Gates. **Commit** `feat(orchestrator): revision.build — batch merge, same-context comparison, greedy degradation`

---

### Task 10: activeOverlayRules from accepted revision + integration + handoff doc

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts:288-294` (replace the validated-proposals source), researcher input docs/comments
- Create: `src/orchestrator/handlers/revision-flow.integration.test.ts`
- Create: `docs/superpowers/specs/2026-07-03-backtester-overlay-on-submitted-baseline-handoff.md` (third handoff: native overlay-on-submitted-baseline + multi-overlay bundles; cite the facts from the G3 spec §0 and the backtester findings — RunSubmitRequest single moduleBundle, worker overlay path empty strategyBundles, TRUSTED_REGISTRY short_after_pump only; lab bridge = StrategyRevisionRunExecutor seam)
- Modify: `.env.example` (`REVISION_BATCH_MAX=5` with comment)

**activeOverlayRules replacement:**

```ts
let activeOverlayRules: ActiveOverlayRuleSummary[] = [];
try {
  const accepted = await services.revisions.findLatestAccepted(profile.id);
  const rules = (accepted?.mergedRuleSet?.rules ?? []) as RuleAction[];
  activeOverlayRules = rules.map((ruleAction) => ({ thesis: 'accepted revision rule', ruleAction, status: 'accepted_revision' }));
} catch { activeOverlayRules = []; }
```

(Adapt `ActiveOverlayRuleSummary` shape minimally if `status`/`thesis` are typed literals — check src/ports/researcher.port.ts and widen the summary type additively; thesis: carry the source hypothesis thesis inside mergedRuleSet entries if cheaply available — store `{order, rules, theses?}` in Task 5's mergedRuleSet to keep this honest.) Regression test: schema-validated proposals are NO LONGER fed (pin: fixture with a validated-but-unmerged proposal → activeOverlayRules empty when no accepted revision beyond v1; v1 bootstrap has empty rules → empty list).

**Integration test:** in-memory composition: seed profile + accepted v1 (bootstrap shape) + two proxy_passed hypotheses with functional overlay module artifacts → run revisionBuildHandler with fake executor returning improving metrics → assert v2 accepted, hypotheses merged, events, activeOverlayRules (via the handler's new source) reflect v2 rules.

- [ ] RED → implement → gates (FULL suite; run_cycle tests must stay green). **Commit** `feat(research): activeOverlayRules from accepted revision + revision-flow integration + backtester handoff doc`

---

## Self-review notes

- Spec coverage: §1→T1+T8, §2→T4+T5, §3→T6+T7+T9(8-9), §4→T3+T9(10), §5→T9, §6→T2+T10, §7 handoff→T10.
- Verify-at-implement flagged: base factory/hook contract + overlay apply signature reconciliation (T5); hypothesis→build-artifact linkage (T9.4 — smallest additive change allowed); ActiveOverlayRuleSummary shape (T10); shared submit/poll extraction judgment (T6).
- Type consistency: RevisionRunRequest/Result names match between T6 and T9; DroppedReason values match T1/T2 statuses (`dropped_unsupported_shape` status ↔ `unsupported_module_shape` dropped-reason — intentionally distinct namespaces: proposal status vs revision.dropped reason; both documented).
- Budget: ≤3 candidate runs + ≤1 comparison run per cycle (T9.8-10) — matches spec §3/§4.
