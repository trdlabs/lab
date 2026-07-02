# WFO Gate1 Model-Eval Harness (Slice C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An offline model-eval harness for the WFO `Gate1DecisionAgent` that scores a candidate model against a frozen, provenance-labeled dataset built from recorded runs — a single-frontier baseline (pass/fail a threshold).

**Architecture:** Mirrors the existing TurnInterpreter eval harness (`src/experiments/turn-interpreter/` + `scripts/turn-interpreter-eval.ts`): a pure library `src/experiments/wfo-gate1/` + a thin CLI. Adds two Slice-C stages upstream of the eval — case extraction from recorded repos and oracle/teacher labeling frozen into a content-addressed snapshot.

**Tech Stack:** TypeScript on `node --experimental-strip-types`, Vitest, zod, Drizzle (Postgres, read-only here), Mastra agents. Gates: `pnpm typecheck` + `pnpm test`.

## Global Constraints

- **Mirror the TurnInterpreter harness** (`src/experiments/turn-interpreter/*`, `scripts/turn-interpreter-eval.ts`) for every shared piece — same file roles, `parseArgs` (node:util), artifact layout `.artifacts/experiments/wfo-gate1/`, exit codes (dry-run 0; run `overallSuccess?0:3`; top-level catch 1).
- **Dry-run is the default; `--run` is the SOLE paid-eval trigger; `--label` is the SOLE paid-labeling trigger.** Neither dry-run loads `composeMastra`.
- **`real-gate1-factory.ts` is the ONLY module that imports `composeMastra`**, dynamically imported under `--run`/`--label`.
- **`snapshotId` is content-addressed over the CANONICAL volatile-free per-case projection** `{ id, input, label, labelSource, teacherModel, rationale }` via `stableStringify` (from `src/orchestrator/handlers/backtest-support.ts`), EXCLUDING `createdAt`/`gitSha`/timestamps. Re-freeze of identical content → same id. Eval NEVER re-labels.
- **Deterministic scoring only** (NO judge this slice): `Gate1OutputSchema.safeParse` gate + exact `decision` match vs frozen label + lightweight reason check (non-empty / no obvious contradiction). Report is single-frontier PASS/FAIL, split by `labelSource`; `teacher-circular` flagged when candidate id == snapshot `teacherModel`.
- **`node --experimental-strip-types` — NO TypeScript parameter properties** (declare fields, assign in constructor body). An AST guard test enforces this.
- Reuse existing symbols: `Gate1Input`/`Gate1DecisionPort` (`src/ports/wfo-agents.port.ts`), `Gate1OutputSchema`/`Gate1Output`/`classifyEntryAffectingParams` (`src/domain/wfo.ts`), `BacktestMetricBlock` (`src/ports/platform-gateway.port.ts`), `StrategyProfile` + `profile.profile.parameters: StrategyParameter[]` (`src/domain/strategy-profile.ts`), `stableStringify`, `parseRoleModel`/`MODEL_PROVIDERS`/`ModelProviderEnv`/`resolveLanguageModel` (`src/adapters/llm/model-provider.ts`).
- Every task: `pnpm typecheck` clean; run the FULL suite as a BLOCKING foreground `pnpm test` (Bash `timeout: 600000`, NOT background/Monitor) before the task-completing commit.

---

## File Structure

**Modify (Task 1 only):**
- `src/ports/research-experiment.repository.ts` — add `listByType`.
- `src/adapters/repository/drizzle-research-experiment.repository.ts` + `src/adapters/repository/in-memory-research-experiment.repository.ts` — implement `listByType`.

**Create — `src/experiments/wfo-gate1/`:**
- `types.ts` — the cross-cutting shapes only: `Gate1Decision`, `LabelSource`, `RawCase`, `OracleLabel`, `FrozenCase`, `FrozenDataset` (+ `RawCaseSchema`). Result types live with their producer: `CaseScore`/`RunScore` in `scoring.ts`; `CandidateResult`/`ModelAggregate`/`EvalRunResult`/`ManifestMeta` in `eval-harness.ts`.
- `oracle.ts` — `labelObvious(input): OracleLabel`.
- `case-source.ts` — `CaseSource` interface, `reconstructGate1Input(...)`, `DbCaseSource`, `SnapshotCaseSource`.
- `fixtures.ts` — a small SYNTHETIC `RawCase[]` (`SYNTHETIC_CASES`) for offline tests only.
- `teacher.ts` — `TeacherLabeler` type + `labelAmbiguous(...)` orchestration.
- `dataset.ts` — `computeSnapshotId`, `freezeDataset`, `writeSnapshot`, `loadSnapshot`.
- `scoring.ts` — `DEFAULT_THRESHOLD`, `scoreCase`, `scoreRun`.
- `eval-harness.ts` — `RunEvalInput`, `RunEvalDeps`, `runEval`.
- `aggregate.ts` — `rankAggregates`, `recommendEnv`.
- `report.ts` — `CliArgs`, `parseArgs`, `planDryRun`, `writeRunArtifacts`, `renderReport`, `writeReport`, `compactTimestamp`, `KEY_BY_PROVIDER`.
- `real-gate1-factory.ts` — `buildRealGate1For`, `buildRealTeacher`.
- Tests: `oracle.test.ts`, `case-source.test.ts`, `dataset.test.ts`, `scoring.test.ts`, `eval-harness.test.ts`, `report.test.ts`.

**Create:** `scripts/wfo-gate1-eval.ts`.

---

## Task 1: `listByType` on ResearchExperimentRepository

**Files:**
- Modify: `src/ports/research-experiment.repository.ts`
- Modify: `src/adapters/repository/in-memory-research-experiment.repository.ts`
- Modify: `src/adapters/repository/drizzle-research-experiment.repository.ts`
- Test: `src/adapters/repository/in-memory-research-experiment.repository.test.ts`

**Interfaces:**
- Produces: `listByType(type: ExperimentType, opts?: { limit?: number }): Promise<ResearchExperiment[]>` — returns experiments of that `experiment_type`, `createdAt ASC, id ASC`. The DbCaseSource (Task 3) enumerates `'strategy_baseline_validation'` experiments through this.

- [ ] **Step 1: Failing test** — in the in-memory repo test:

```ts
it('listByType returns experiments of the given type, createdAt/id ordered', async () => {
  const repo = new InMemoryResearchExperimentRepository();
  await repo.createExperiment(makeExperiment({ id: 'e2', experimentType: 'strategy_baseline_validation' }));
  await repo.createExperiment(makeExperiment({ id: 'e1', experimentType: 'strategy_baseline_validation' }));
  await repo.createExperiment(makeExperiment({ id: 'e3', experimentType: 'walk_forward_optimization' }));
  const rows = await repo.listByType('strategy_baseline_validation');
  expect(rows.map((r) => r.id).sort()).toEqual(['e1', 'e2']);
  expect(rows.every((r) => r.experimentType === 'strategy_baseline_validation')).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/adapters/repository/in-memory-research-experiment.repository.test.ts -t "listByType"` → FAIL (method missing).

- [ ] **Step 3: Port** — add to the `ResearchExperimentRepository` interface: `listByType(type: ExperimentType, opts?: { limit?: number }): Promise<ResearchExperiment[]>;` (import `ExperimentType` if not already).

- [ ] **Step 4: In-memory** — implement: filter the stored experiments by `experimentType === type`, sort by `createdAt` then `id`, `slice(0, opts?.limit ?? Infinity)`, return clones.

- [ ] **Step 5: Drizzle** — implement mirroring the existing `find*` mappers: `select().from(researchExperiment).where(eq(researchExperiment.experimentType, type)).orderBy(asc(createdAt), asc(id))` (+ `.limit(opts.limit)` when set), map each row via the existing `expToDomain`.

- [ ] **Step 6: Run — expect PASS** — same `-t` → PASS.

- [ ] **Step 7: Typecheck + full suite** — `pnpm typecheck && <foreground pnpm test timeout:600000>` → green.

- [ ] **Step 8: Commit**

```bash
git add src/ports/research-experiment.repository.ts src/adapters/repository/in-memory-research-experiment.repository.ts src/adapters/repository/drizzle-research-experiment.repository.ts src/adapters/repository/in-memory-research-experiment.repository.test.ts
git commit -m "feat(research): listByType on ResearchExperimentRepository"
```

---

## Task 2: types + deterministic oracle

**Files:**
- Create: `src/experiments/wfo-gate1/types.ts`
- Create: `src/experiments/wfo-gate1/oracle.ts`
- Test: `src/experiments/wfo-gate1/oracle.test.ts`

**Interfaces:**
- Consumes: `Gate1Input` (`src/ports/wfo-agents.port.ts`), `classifyEntryAffectingParams` (`src/domain/wfo.ts`).
- Produces:
```ts
// types.ts
export type Gate1Decision = 'improve' | 'allow_exploratory_sweep' | 'stop_not_worth' | 'stop_insufficient_evidence';
export type LabelSource = 'oracle' | 'teacher';
export interface RawCase { id: string; input: Gate1Input; meta: { experimentId: string; sourceRef: string } }
export type OracleLabel = { label: Gate1Decision; confidence: 'obvious' } | { needsTeacher: true };
export interface FrozenCase { id: string; input: Gate1Input; label: Gate1Decision; labelSource: LabelSource; teacherModel?: string; rationale?: string; createdAt: string }
export interface FrozenDataset { snapshotId: string; createdAt: string; gitSha: string; sourceRef: string; cases: FrozenCase[] }
// (CaseScore/RunScore/CandidateResult/ModelAggregate/EvalRunResult/ManifestMeta added in later tasks — see their Produces blocks)
// oracle.ts
export function labelObvious(input: Gate1Input): OracleLabel;
```

**Oracle rules (spec §4.2):** with `entryAffecting = classifyEntryAffectingParams(input.profile.profile.parameters).entryAffecting` (note the double `.profile`):
- `input.baselineMetrics.totalTrades === 0` and `entryAffecting.length === 0` → `{ label: 'stop_insufficient_evidence', confidence: 'obvious' }`.
- `totalTrades === 0` and `entryAffecting.length > 0` and `input.hasEntrySignalEvidence === true` → `{ label: 'allow_exploratory_sweep', confidence: 'obvious' }`.
- `totalTrades === 0` and `entryAffecting.length > 0` and `hasEntrySignalEvidence === false` → `{ label: 'stop_insufficient_evidence', confidence: 'obvious' }`.
- `totalTrades > 0` → `{ needsTeacher: true }` (improve-vs-stop_not_worth is subjective).

- [ ] **Step 1: Failing test** (`oracle.test.ts`):

```ts
import { labelObvious } from './oracle.ts';
const mkInput = (o: Partial<Gate1Input> & { totalTrades: number; params: { name: string; tunable: boolean }[]; evidence?: boolean }): Gate1Input => ({
  profile: { profile: { parameters: o.params } } as any,
  baselineMetrics: { totalTrades: o.totalTrades, netPnlUsd:0, netPnlPct:0, winRate:0, profitFactor:1, maxDrawdownPct:0, expectancyUsd:0, sharpe:0, topTradeContributionPct:0 } as any,
  entryAffecting: [], hasEntrySignalEvidence: o.evidence ?? false,
});
it('labels the structural 0-trade branches', () => {
  expect(labelObvious(mkInput({ totalTrades:0, params:[{name:'hardStopPct',tunable:true}] }))).toEqual({ label:'stop_insufficient_evidence', confidence:'obvious' });
  expect(labelObvious(mkInput({ totalTrades:0, params:[{name:'dump.minDropPct',tunable:true}], evidence:true }))).toEqual({ label:'allow_exploratory_sweep', confidence:'obvious' });
  expect(labelObvious(mkInput({ totalTrades:0, params:[{name:'dump.minDropPct',tunable:true}], evidence:false }))).toEqual({ label:'stop_insufficient_evidence', confidence:'obvious' });
});
it('defers has-trades cases to the teacher', () => {
  expect(labelObvious(mkInput({ totalTrades:5, params:[{name:'dump.minDropPct',tunable:true}] }))).toEqual({ needsTeacher: true });
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/experiments/wfo-gate1/oracle.test.ts` → FAIL.
- [ ] **Step 3: Implement** `types.ts` (the shapes above) + `oracle.ts` (`labelObvious` per the rules; recompute `entryAffecting` from the profile — do NOT trust `input.entryAffecting`, since a case may carry a stale array). Note the classifier reads `input.profile.profile.parameters`.
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Typecheck** — `pnpm typecheck` → clean.
- [ ] **Step 6: Commit**

```bash
git add src/experiments/wfo-gate1/types.ts src/experiments/wfo-gate1/oracle.ts src/experiments/wfo-gate1/oracle.test.ts
git commit -m "feat(wfo-gate1-eval): types + deterministic oracle labeler"
```

---

## Task 3: case extraction (DbCaseSource + SnapshotCaseSource + synthetic fixtures)

**Files:**
- Create: `src/experiments/wfo-gate1/case-source.ts`
- Create: `src/experiments/wfo-gate1/fixtures.ts`
- Test: `src/experiments/wfo-gate1/case-source.test.ts`

**Interfaces:**
- Consumes: Task 1 `listByType`; `ResearchExperimentRepository` (`listByType`, `listMembers`), `StrategyBacktestRunRepository` (`findById`), `StrategyProfileRepository` (`findById`), `ExperimentRunMember` (`role`/`strategyBacktestRunId`), `StrategyBacktestRun.metrics: BacktestMetricBlock | null`, `StrategyProfile`.
- Produces:
```ts
export interface CaseSource { load(): Promise<RawCase[]> }
export interface DbCaseSourceDeps { experiments: ResearchExperimentRepository; strategyBacktests: StrategyBacktestRunRepository; strategyProfiles: StrategyProfileRepository }
export function reconstructGate1Input(args: { profile: StrategyProfile; baselineMetrics: BacktestMetricBlock }): Gate1Input;
export class DbCaseSource implements CaseSource { constructor(deps: DbCaseSourceDeps); load(): Promise<RawCase[]> }
export class SnapshotCaseSource implements CaseSource { constructor(filePath: string); load(): Promise<RawCase[]> }
export const SYNTHETIC_CASES: RawCase[];   // exported from fixtures.ts (re-export here optional)
```

**`reconstructGate1Input`** (mirrors `runWalkForwardOptimization` §3): `entryAffecting = classifyEntryAffectingParams(profile.profile.parameters).entryAffecting`; `hasEntrySignalEvidence = baselineMetrics.totalTrades > 0` (the recorded-evidence enrichment is future — default the 0-trade case to `false`); return `{ profile, baselineMetrics, entryAffecting, hasEntrySignalEvidence }`.

**`DbCaseSource.load`**: `experiments.listByType('strategy_baseline_validation')`; for each experiment → `listMembers` → pick the `train` member (`m.role === 'train'`) when present else the `sanity` member (mirrors the Slice-B #123 fix: train-window metrics when a split exists, sanity when `mode:'none'`); skip experiments whose chosen member has no `strategyBacktestRunId`; `strategyBacktests.findById(member.strategyBacktestRunId)` → skip if `!run?.metrics`; `strategyProfiles.findById(exp.strategyProfileId)` → skip if null; `reconstructGate1Input({ profile, baselineMetrics: run.metrics })`; `RawCase = { id: 'case-' + exp.id, input, meta: { experimentId: exp.id, sourceRef: 'db' } }`. Log (console.warn) each skipped experiment with the reason (no silent drop).

**`SnapshotCaseSource.load`**: `readFileSync(filePath)` → `JSON.parse` → zod-validate an array of `RawCase` (define a `RawCaseSchema` in `types.ts` or here) → return.

**`fixtures.ts`**: `export const SYNTHETIC_CASES: RawCase[]` — ~4 hand-built cases covering: 0-trade+exit-only, 0-trade+entry+evidence, 0-trade+entry+no-evidence, has-trades. FOR UNIT TESTS ONLY (comment says so). Not the golden dataset.

- [ ] **Step 1: Failing test** (`case-source.test.ts`) — build in-memory repos, seed a baseline experiment with a `train` member linked to a strategy_backtest_run with metrics + a profile; assert `DbCaseSource.load()` reconstructs one `RawCase` with the train metrics and the entryAffecting derived from the profile; assert an experiment whose train member lacks metrics is skipped (not thrown). Also test `reconstructGate1Input` directly (evidence=false when 0 trades).

```ts
it('DbCaseSource reconstructs a Gate1 case from a baseline experiment train member', async () => {
  // seed InMemoryResearchExperimentRepository + InMemoryStrategyBacktestRunRepository + InMemoryStrategyProfileRepository
  // exp(type=strategy_baseline_validation) + train member(strategyBacktestRunId=r1) + run r1 metrics{totalTrades:5,...} + profile with parameters
  const cases = await new DbCaseSource({ experiments, strategyBacktests, strategyProfiles }).load();
  expect(cases).toHaveLength(1);
  expect(cases[0]!.input.baselineMetrics.totalTrades).toBe(5);
  expect(cases[0]!.meta.experimentId).toBe('exp-1');
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/experiments/wfo-gate1/case-source.test.ts` → FAIL.
- [ ] **Step 3: Implement** `fixtures.ts` + `case-source.ts` per the interfaces.
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Typecheck + full suite** — `pnpm typecheck && <foreground pnpm test>` → green.
- [ ] **Step 6: Commit**

```bash
git add src/experiments/wfo-gate1/case-source.ts src/experiments/wfo-gate1/fixtures.ts src/experiments/wfo-gate1/case-source.test.ts
git commit -m "feat(wfo-gate1-eval): case extraction from recorded baseline experiments"
```

---

## Task 4: frozen dataset (content-addressed snapshotId)

**Files:**
- Create: `src/experiments/wfo-gate1/dataset.ts`
- Test: `src/experiments/wfo-gate1/dataset.test.ts`

**Interfaces:**
- Consumes: `stableStringify` (`src/orchestrator/handlers/backtest-support.ts`), `FrozenCase`/`FrozenDataset` (types.ts).
- Produces:
```ts
export function computeSnapshotId(cases: FrozenCase[]): string;   // sha256 over canonical volatile-free projection
export function freezeDataset(cases: FrozenCase[], meta: { gitSha: string; sourceRef: string; now: string }): FrozenDataset;
export function writeSnapshot(baseDir: string, dataset: FrozenDataset): string;   // returns file path
export function loadSnapshot(baseDir: string, snapshotId: string): FrozenDataset;  // throws if missing
```

**`computeSnapshotId`**: `createHash('sha256').update(stableStringify(cases.map((c) => ({ id: c.id, input: c.input, label: c.label, labelSource: c.labelSource, teacherModel: c.teacherModel, rationale: c.rationale })))).digest('hex')` — NO `createdAt`. **`freezeDataset`** sets `snapshotId = computeSnapshotId(cases)`, `createdAt: meta.now`, `gitSha`, `sourceRef`. **`writeSnapshot`** writes `${baseDir}/${dataset.snapshotId}.json` (mkdir -p baseDir). **`loadSnapshot`** reads `${baseDir}/${snapshotId}.json`, `JSON.parse`, returns as `FrozenDataset` (throw a clear Error if the file is absent).

- [ ] **Step 1: Failing test** (`dataset.test.ts`):

```ts
const cases = (created: string): FrozenCase[] => [
  { id:'c1', input: {} as any, label:'improve', labelSource:'teacher', teacherModel:'gpt-5.5', rationale:'r', createdAt: created },
];
it('snapshotId ignores volatile createdAt — same content → same id', () => {
  expect(computeSnapshotId(cases('2026-01-01'))).toBe(computeSnapshotId(cases('2026-09-09')));
});
it('snapshotId changes when a label changes', () => {
  const a = cases('t'); const b = [{ ...a[0]!, label:'stop_not_worth' as const }];
  expect(computeSnapshotId(a)).not.toBe(computeSnapshotId(b));
});
it('freeze → write → load round-trips and never mutates labels', () => {
  const dir = mkdtempSync(join(tmpdir(),'wfo-ds-'));
  const ds = freezeDataset(cases('t'), { gitSha:'abc', sourceRef:'db', now:'t' });
  const p = writeSnapshot(dir, ds);
  const loaded = loadSnapshot(dir, ds.snapshotId);
  expect(loaded.cases[0]!.label).toBe('improve');
  expect(loaded.snapshotId).toBe(ds.snapshotId);
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/experiments/wfo-gate1/dataset.test.ts` → FAIL.
- [ ] **Step 3: Implement** `dataset.ts`.
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Typecheck** — clean.
- [ ] **Step 6: Commit**

```bash
git add src/experiments/wfo-gate1/dataset.ts src/experiments/wfo-gate1/dataset.test.ts
git commit -m "feat(wfo-gate1-eval): content-addressed frozen dataset snapshots"
```

---

## Task 5: teacher labeler + freeze pipeline

**Files:**
- Create: `src/experiments/wfo-gate1/teacher.ts`
- Test: `src/experiments/wfo-gate1/teacher.test.ts`

**Interfaces:**
- Consumes: `labelObvious` (Task 2), `freezeDataset` (Task 4), `Gate1DecisionPort` (a teacher is a `Gate1DecisionPort` producing a decision + reason).
- Produces:
```ts
export type TeacherLabeler = (input: Gate1Input) => Promise<{ label: Gate1Decision; rationale: string }>;
export async function buildFrozenCases(rawCases: RawCase[], deps: { teacher: TeacherLabeler; teacherModel: string; now: () => string }): Promise<FrozenCase[]>;
```

**`buildFrozenCases`**: for each `RawCase`, `labelObvious(c.input)` → if `'obvious'` → `FrozenCase{ label, labelSource:'oracle', createdAt: now() }`; else (`needsTeacher`) → `const { label, rationale } = await deps.teacher(c.input)` → `FrozenCase{ label, labelSource:'teacher', teacherModel: deps.teacherModel, rationale, createdAt: now() }`. Preserves `id`/`input`. (The actual frontier `TeacherLabeler` is wired in the real factory, Task 10 — here it's an injected dep so this module stays pure/testable.)

- [ ] **Step 1: Failing test** (`teacher.test.ts`) — a fake `TeacherLabeler` returning a canned `{label:'improve',rationale:'r'}`; feed `SYNTHETIC_CASES`; assert the 0-trade cases get `labelSource:'oracle'` with the oracle's decision, and the has-trades case gets `labelSource:'teacher'`, `teacherModel`, and the fake's label/rationale. Assert the teacher is NOT called for obvious cases (spy count).

- [ ] **Step 2: Run — expect FAIL** — → FAIL.
- [ ] **Step 3: Implement** `teacher.ts`.
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Typecheck** — clean.
- [ ] **Step 6: Commit**

```bash
git add src/experiments/wfo-gate1/teacher.ts src/experiments/wfo-gate1/teacher.test.ts
git commit -m "feat(wfo-gate1-eval): oracle+teacher labeling into frozen cases"
```

---

## Task 6: deterministic scoring

**Files:**
- Create: `src/experiments/wfo-gate1/scoring.ts`
- Test: `src/experiments/wfo-gate1/scoring.test.ts`

**Interfaces:**
- Consumes: `Gate1OutputSchema` (`src/domain/wfo.ts`), `FrozenCase` (types.ts).
- Produces:
```ts
export const DEFAULT_THRESHOLD = 0.9;
export const REASON_PENALTY = 0.1;
export interface CaseScore { id: string; schemaValid: boolean; decisionMatch: boolean; reasonOk: boolean; labelSource: LabelSource; score: number; latencyMs: number }
export interface RunScore { schemaValidRate: number; accuracy: number; oracleAccuracy: number; teacherAccuracy: number; reasonOkRate: number; meanScore: number; passRate: number; threshold: number; verdict: 'PASS'|'FAIL'; cases: CaseScore[] }
export function scoreCase(raw: unknown, c: FrozenCase, latencyMs: number): CaseScore;
export function scoreRun(cases: CaseScore[], opts?: { threshold?: number }): RunScore;
```

**`scoreCase`**: `const parsed = Gate1OutputSchema.safeParse(raw)`; if `!parsed.success` → `{ schemaValid:false, decisionMatch:false, reasonOk:false, score:0, ... }`. Else `decisionMatch = parsed.data.decision === c.label`; `reasonOk = reasonNonContradictory(parsed.data)` (non-empty AND not a stop-decision whose reason contains an explicit sweep/improve assertion — a tiny keyword check; keep conservative). `score = decisionMatch ? (reasonOk ? 1 : 1 - REASON_PENALTY) : 0`. **`scoreRun`**: `accuracy` = mean `decisionMatch`; `oracleAccuracy`/`teacherAccuracy` = mean `decisionMatch` over cases with that `labelSource` (0 if none); `meanScore` = mean `score`; `passRate` = `meanScore >= threshold ? 1 : 0`; `verdict` PASS/FAIL vs `threshold` (default `DEFAULT_THRESHOLD`).

- [ ] **Step 1: Failing test** (`scoring.test.ts`): schema-miss (`raw = {}`) → score 0 schemaValid false; exact decision-match → score 1; wrong decision → 0; a `stop_insufficient_evidence` output whose reason literally says "should sweep" → `reasonOk:false`, score `1 - REASON_PENALTY` when the decision still matches. `scoreRun` split: 2 oracle cases (1 right) + 1 teacher case (right) → `oracleAccuracy:0.5`, `teacherAccuracy:1`.

- [ ] **Step 2: Run — expect FAIL** — → FAIL.
- [ ] **Step 3: Implement** `scoring.ts`.
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Typecheck** — clean.
- [ ] **Step 6: Commit**

```bash
git add src/experiments/wfo-gate1/scoring.ts src/experiments/wfo-gate1/scoring.test.ts
git commit -m "feat(wfo-gate1-eval): deterministic scoring (schema + decision-match + reason-lite)"
```

---

## Task 7: eval-harness (runEval)

**Files:**
- Create: `src/experiments/wfo-gate1/eval-harness.ts`
- Test: `src/experiments/wfo-gate1/eval-harness.test.ts`

**Interfaces:**
- Consumes: `Gate1DecisionPort` (`src/ports/wfo-agents.port.ts`), `scoreCase`/`scoreRun` (Task 6), `FrozenDataset` (types.ts).
- Produces:
```ts
export interface RunEvalInput { models: string[]; dataset: FrozenDataset; threshold: number; repeat?: number }
export interface RunEvalDeps { gate1For: (modelId: string) => Gate1DecisionPort; providerOf: (modelId: string) => { provider: string; modelId: string }; clock: () => number }
export interface CandidateResult { modelId: string; provider: string; ok: boolean; error?: string; result?: RunScore }
export interface ModelAggregate { modelId: string; provider: string; runs: number; meanScore: number; accuracy: number; oracleAccuracy: number; teacherAccuracy: number; passRate: number; meanLatencyMs: number }
export interface ManifestMeta { snapshotId: string; models: string[]; repeat: number; threshold: number; caseCount: number; teacherModel: string | null; teacherCircular: boolean; harnessVersion: string; gitSha: string }
export interface EvalRunResult { manifest: ManifestMeta; candidates: CandidateResult[]; aggregates: ModelAggregate[] }
export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult>;
```

**`runEval`** (mirror TI `eval-harness.ts` structure): for each `modelId` → `try { const gate1 = deps.gate1For(modelId) } catch (e) → push { ok:false, error }`; inner `repeat × dataset.cases`: `const t0 = deps.clock(); let raw; try { raw = await gate1.decide(c.input) } catch { raw = { __throw:true } }; const latency = deps.clock() - t0; scoreCase(raw, c, latency)`; `scoreRun(caseScores, { threshold })`; build `CandidateResult`. Aggregate per model: `meanScore`/`accuracy`/`oracle`/`teacher`/`meanLatencyMs` across repeats, `passRate = result.verdict==='PASS'?1:0` averaged. `teacherModel` = the snapshot's teacher model (first `FrozenCase.teacherModel` present, else null); `teacherCircular = models.includes(teacherModel)`.

- [ ] **Step 1: Failing test** (`eval-harness.test.ts`) — copy the TI offline stub pattern: a `fakeGate1(modelId): Gate1DecisionPort` returning a canned `{ decision:'improve', reason:'r' }`; a frozen dataset (build via `freezeDataset` over `SYNTHETIC_CASES`-derived FrozenCases, or hand-build 3 FrozenCases with known labels); `runEval({ models:['m1','m2'], dataset, threshold:0.9, repeat:1 }, { gate1For: fakeGate1, providerOf: m=>({provider:'fake',modelId:m}), clock: ()=>0 })`. Assert: a model whose decisions all match → `aggregate.accuracy===1`; a `gate1For` that throws for one model → that `candidate.ok===false` isolated; a fake returning a schema-invalid object → `result.schemaValidRate===0`. Assert `teacherCircular===true` when `models` includes the dataset's teacherModel.

- [ ] **Step 2: Run — expect FAIL** — → FAIL.
- [ ] **Step 3: Implement** `eval-harness.ts`.
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Typecheck** — clean.
- [ ] **Step 6: Commit**

```bash
git add src/experiments/wfo-gate1/eval-harness.ts src/experiments/wfo-gate1/eval-harness.test.ts
git commit -m "feat(wfo-gate1-eval): runEval (models×repeat×cases, labelSource-split)"
```

---

## Task 8: aggregate + recommendEnv

**Files:**
- Create: `src/experiments/wfo-gate1/aggregate.ts`
- Test: `src/experiments/wfo-gate1/aggregate.test.ts`

**Interfaces:**
- Consumes: `ModelAggregate` (Task 7).
- Produces:
```ts
export function rankAggregates(aggregates: ModelAggregate[]): ModelAggregate[];   // meanScore desc, then accuracy desc
export interface FrontierVerdict { incumbentModelId: string; bestModelId: string | null; bestScore: number; threshold: number; passes: boolean; reason: string }
export function frontierVerdict(ranked: ModelAggregate[], opts: { incumbentModelId: string; threshold: number }): FrontierVerdict;
```

**`frontierVerdict`** (single-frontier, NOT cheapest-passing): `best = ranked[0]`; `passes = !!best && best.meanScore >= threshold`; `reason` describes pass/fail vs threshold and whether the best model is the incumbent `WFO_GATE1_MODEL`.

- [ ] **Step 1: Failing test** (`aggregate.test.ts`): `rankAggregates` orders by meanScore desc; `frontierVerdict` returns `passes:true` when best.meanScore≥threshold, `passes:false` otherwise; empty input → `passes:false, bestModelId:null`.
- [ ] **Step 2: Run — expect FAIL** — → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Typecheck** — clean.
- [ ] **Step 6: Commit**

```bash
git add src/experiments/wfo-gate1/aggregate.ts src/experiments/wfo-gate1/aggregate.test.ts
git commit -m "feat(wfo-gate1-eval): aggregate ranking + single-frontier verdict"
```

---

## Task 9: report (plan + artifacts + markdown)

**Files:**
- Create: `src/experiments/wfo-gate1/report.ts`
- Test: `src/experiments/wfo-gate1/report.test.ts`

**Interfaces:**
- Consumes: `EvalRunResult`/`ManifestMeta` (Task 7), `FrontierVerdict` (Task 8), `parseRoleModel`/`MODEL_PROVIDERS`/`ModelProviderEnv` (`src/adapters/llm/model-provider.ts`).
- Produces (mirror TI `report.ts`):
```ts
export const KEY_BY_PROVIDER: Record<ModelProvider, string> = { anthropic:'ANTHROPIC_API_KEY', openai:'OPENAI_API_KEY', openrouter:'OPENROUTER_API_KEY' };
export interface CliArgs { models: string[]; snapshot: string | undefined; run: boolean; label: boolean; threshold: number; repeat: number; teacherModel: string | undefined; source: string | undefined }
export function parseArgs(argv: string[]): CliArgs;   // node:util parseArgs; --run requires --snapshot; --label requires --teacher-model
export interface DryRunPlan { mode: 'dry-run'; plannedPaidCalls: number; classifyCalls: number; caseCount: number; models: string[]; missingKeys: string[] }
export function planDryRun(args: CliArgs, env: ModelProviderEnv, caseCount: number): DryRunPlan;
export function renderReport(run: EvalRunResult, verdict: FrontierVerdict): string;   // markdown; ⚠ teacher-circular banner when run.manifest.teacherCircular
export function writeRunArtifacts(outDir: string, result: EvalRunResult): string[];   // per-candidate JSON + manifest.json
export function writeReport(outDir: string, result: EvalRunResult, verdict: FrontierVerdict): string;
export function compactTimestamp(date: Date): string;
```

**`planDryRun`**: `classifyCalls = models.length * repeat * caseCount`; `plannedPaidCalls = classifyCalls`; `missingKeys` = for each model, `parseRoleModel(env, model).provider` → `KEY_BY_PROVIDER[provider]` if the env key is absent (dedupe). **`renderReport`**: a markdown table (model | provider | accuracy | oracleAcc | teacherAcc | passRate | meanLatency | PASS/FAIL) + a headline PASS/FAIL for the frontier verdict; when `run.manifest.teacherCircular`, prepend a `> ⚠ **teacher-circular**: candidate == teacher (<model>); teacher-labeled accuracy is not independent.` banner. `writeRunArtifacts` mirrors TI (per-candidate JSON + `manifest.json`).

- [ ] **Step 1: Failing test** (`report.test.ts`): `planDryRun` math (`models×repeat×caseCount`) + `missingKeys` (a model on a provider whose key is absent → its env key listed); `renderReport` contains a PASS/FAIL headline and, when `manifest.teacherCircular`, the `⚠ teacher-circular` banner; `parseArgs` rejects `--run` without `--snapshot`.
- [ ] **Step 2: Run — expect FAIL** — → FAIL.
- [ ] **Step 3: Implement** (mirror TI `report.ts` structure; `writeRunArtifacts`/`writeReport` use `fs`).
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Typecheck** — clean.
- [ ] **Step 6: Commit**

```bash
git add src/experiments/wfo-gate1/report.ts src/experiments/wfo-gate1/report.test.ts
git commit -m "feat(wfo-gate1-eval): dry-run plan + artifacts + markdown report (teacher-circular banner)"
```

---

## Task 10: real-gate1-factory (the only composeMastra importer)

**Files:**
- Create: `src/experiments/wfo-gate1/real-gate1-factory.ts`

**Interfaces:**
- Consumes: `composeMastra`/`MastraCompositionEnv` (`src/mastra/compose-mastra.ts`), `ModelProviderEnv`, the Gate1 Mastra adapter (`src/adapters/wfo/mastra-gate1.ts`) + agent (`src/mastra/agents/gate1-decision.agent.ts`).
- Produces:
```ts
export function buildRealGate1For(baseEnv: ModelProviderEnv): (modelId: string) => Gate1DecisionPort;
export function buildRealTeacher(baseEnv: ModelProviderEnv, teacherModelId: string): TeacherLabeler;
```

**`buildRealGate1For`**: copy `real-turn-interpreter-factory.ts::buildRealInterpreterFor` EXACTLY, changing only: set `WFO_GATE1_ADAPTER:'mastra'` + `WFO_GATE1_MODEL:modelId` and every OTHER role (turn-interpreter, analyst, researcher, critic, builder, strategy-critic, strategy-refiner, sweep-designer, result-interpreter) to `'fake'`; `const runtime = composeMastra(env)`; pull the Gate1 agent entry — **verify the exact key** `runtime.agents.<gate1 key>` by reading how `src/composition.ts::buildGate1` reads it (it uses `rt.agents.gate1` or similar — match that identifier); `return new MastraGate1(entry.agent, entry.label)`. **`buildRealTeacher`**: a `TeacherLabeler` = a closure that builds a real Gate1 agent at `teacherModelId` (reuse `buildRealGate1For(baseEnv)(teacherModelId)`) and calls `.decide(input)` → maps to `{ label: out.decision, rationale: out.reason }`.

- [ ] **Step 1: Verify the agent key** — read `src/composition.ts` `buildGate1` + `src/mastra/compose-mastra.ts` to confirm the exact `runtime.agents.<key>` name and the `MastraGate1` constructor signature.
- [ ] **Step 2: Implement** `real-gate1-factory.ts`.
- [ ] **Step 3: Typecheck** — `pnpm typecheck` clean (no unit test — it's the composeMastra edge, exercised only under `--run`; typecheck is the gate). Run the FULL suite to confirm no regression.
- [ ] **Step 4: Commit**

```bash
git add src/experiments/wfo-gate1/real-gate1-factory.ts
git commit -m "feat(wfo-gate1-eval): real Gate1 + teacher factory (only composeMastra importer)"
```

---

## Task 11: CLI `scripts/wfo-gate1-eval.ts`

**Files:**
- Create: `scripts/wfo-gate1-eval.ts`

**Interfaces:**
- Consumes: everything above. Mirror `scripts/turn-interpreter-eval.ts` structure.

**Behaviour:**
- `HARNESS_VERSION='wfo-gate1-eval-v1'`, `CONTRACT_VERSION='wfo-gate1-v0'`, `gitSha()` (execSync try/catch), `modelEnv()` (reads MODEL_PROVIDER + 3 keys).
- `parseArgs(process.argv.slice(2))`.
- **`--label` branch (paid):** dynamic `await import('.../real-gate1-factory.ts')`; build the case source (from `--source` — `composeRuntime()` for `db` (default), or `SnapshotCaseSource(path)`); `source.load()`; `buildFrozenCases(rawCases, { teacher: buildRealTeacher(env, args.teacherModel), teacherModel: args.teacherModel, now: ()=>new Date().toISOString() })`; `freezeDataset(...)`; `writeSnapshot('.artifacts/experiments/wfo-gate1/datasets', ds)`; print the `snapshotId`. (For `db`, use `composeRuntime()` + `finally { queue.close(); pool.end() }`.)
- **`--run` branch (paid eval):** requires `--snapshot`; `loadSnapshot(baseDir, args.snapshot)`; dynamic import `buildRealGate1For`; `runEval({ models, dataset, threshold, repeat }, { gate1For: buildRealGate1For(env), providerOf: m=>{const r=parseRoleModel(env,m);return {provider:r.provider,modelId:r.modelId}}, clock: ()=>Date.now() })`; thread `HARNESS_VERSION`/`gitSha()` into the manifest; `rankAggregates` → `frontierVerdict({ incumbentModelId: process.env.WFO_GATE1_MODEL ?? '', threshold })`; `writeRunArtifacts` + `writeReport` under `.artifacts/experiments/wfo-gate1/${args.snapshot}/${compactTimestamp(now)}`; exit `overallSuccess?0:3` (overallSuccess = some aggregate passRate>0).
- **Dry-run (default, neither --run nor --label, OR --run without keys):** `planDryRun` → print JSON → return 0.
- Top-level `main().then(process.exit).catch(err=>{console.error(err);process.exit(1)})`.

- [ ] **Step 1: Write the script** — mirror `scripts/turn-interpreter-eval.ts`; add the `--label` branch. Do NOT execute (needs DB + keys — a later live step).
- [ ] **Step 2: Standalone typecheck** — `npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --allowImportingTsExtensions --skipLibCheck scripts/wfo-gate1-eval.ts` → clean.
- [ ] **Step 3: Full gate** — `pnpm typecheck && <foreground pnpm test>` → green.
- [ ] **Step 4: Commit**

```bash
git add scripts/wfo-gate1-eval.ts
git commit -m "feat(wfo-gate1-eval): CLI (--label / --run --snapshot / dry-run default)"
```

---

## Post-plan verification (whole-branch)

- [ ] `pnpm typecheck` clean; `pnpm test` full suite green.
- [ ] Grep guard: `grep -rn "composeMastra" src/experiments/wfo-gate1` shows ONLY `real-gate1-factory.ts`.
- [ ] Grep guard: no `--judge` / judge-agent references (deferred).
- [ ] Opus whole-branch review before PR (per prior slices).
- [ ] Live paid run deferred to the user (needs DB with recorded baseline experiments + a frontier key): `--label --teacher-model <frontier>` → `snapshotId`, then `--run --snapshot <id> --models <frontier>`. On this box the recorded dataset is thin (live runs were mostly INCONCLUSIVE) — a rich dataset awaits VPS data. Record any run in a runbook note.

## Deferred (not in this plan)

- LLM-as-judge (`--judge`, `wfo-gate1-judge.agent.ts`).
- SweepDesigner + ResultInterpreter eval harnesses (reuse this skeleton).
- Cheap-model cascade: cheap candidates × confidence-threshold × escalation-rate + cost/$ ranking; "cheapest-passing" recommendation.
- Capturing decision-records entry-signal evidence in the extractor (to surface real `allow_exploratory_sweep` cases).
- Committing a curated public golden snapshot under `docs/fixtures/`.
