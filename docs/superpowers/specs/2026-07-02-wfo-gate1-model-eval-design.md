# Slice C — WFO Gate1 decision-agent model-eval harness (single-frontier baseline)

**Date:** 2026-07-02
**Status:** design, pending spec review
**Predecessors:** Slice A (strategy-baseline lane, #120/#121) + Slice B (WFO decision contour, #122/#123). Roadmap: `2026-06-30-backtest-research-orchestrator-roadmap.md` §5 (token-economy), the decision-agent model-eval step.
**Mirrors:** the existing offline eval harnesses (`src/experiments/{turn-interpreter,strategy-critic,strategy-analyst}/` + `scripts/*-eval.ts`) — same layout, `--run` paid-gate, artifact/manifest conventions.

---

## 1. Goal

Prove the **offline model-eval contour** for the WFO **Gate1DecisionAgent** ("worth improving?") and get a **quality baseline** for a single frontier model, on a labeled dataset built from **recorded** runs (not hand-authored business-cases). This slice establishes the reusable eval skeleton + the **labeled-dataset-with-frozen-provenance** mechanism the other two WFO agents (SweepDesigner, ResultInterpreter) and the later cheap-model cascade will reuse.

**Explicitly a baseline-proving slice.** Now: one frontier candidate (e.g. `openrouter/openai/gpt-5.5`) evaluated → does it clear the threshold on the labeled dataset? **Deferred to a later slice:** cheap models × confidence-threshold × escalation-rate/cost-saving (the cascade), an LLM-as-judge, and the other two agents.

## 2. Scope

**In:**
- **Dataset builder** — extract Gate1 eval cases from recorded sources (local Postgres baseline experiments; mock-platform run exports; VPS snapshot export). A Gate1 case = the exact `Gate1Input` a real WFO run would feed the agent, reconstructed from persisted state.
- **Labeling pipeline** — a deterministic **oracle** labels the unambiguous cases; a **teacher** (frontier model) labels the ambiguous ones; labels are **frozen** into a snapshot artifact with provenance (`labelSource`, `teacherModel`, `rationale`, `createdAt`, `snapshotId`). A repeat eval never silently regenerates labels — relabeling is an explicit, separate step.
- **Eval harness** — run the candidate model(s) over the frozen-labeled cases; deterministic scoring only (schema-gate + exact decision-match + lightweight reason check); aggregate; markdown report + manifest; `--run` paid-gate; offline unit tests on minimal synthetic fixtures.
- **Single-frontier recommendation** — the report states whether the frontier baseline **passes/fails** the threshold, split by `labelSource` (oracle vs teacher) so teacher-circularity is visible. The models × repeat × cases cross-product stays in the skeleton for the future cascade.

**Out (deferred / roadmap):**
- LLM-as-judge (no `--judge`, no judge agent) — reason is checked lightweight (non-empty / no obvious contradiction) only.
- SweepDesigner and ResultInterpreter evals (separate later slices, reusing this skeleton).
- Cheap-model cascade, confidence-threshold, escalation-rate + cost/$ ranking, "cheapest-passing" recommendation.
- Hand-authored inline business-case datasets (anti-goal — the golden dataset comes from recorded sources; in-repo `.ts` fixtures are minimal synthetic loader/oracle test data ONLY).

## 3. What a Gate1 case is

`Gate1Input` (from `src/ports/wfo-agents.port.ts`) = `{ profile: StrategyProfile; baselineMetrics: BacktestMetricBlock; entryAffecting: string[]; hasEntrySignalEvidence: boolean }`. The eval reconstructs each field the SAME way `runWalkForwardOptimization` does, so a case is a faithful replay of a real Gate1 call:
- `profile` — the recorded `strategy_profile`.
- `baselineMetrics` — the **train-window** metrics of the recorded baseline experiment (the `train` member's `strategy_backtest_run.metrics` when the split is valid; sanity metrics when `mode:'none'`) — mirroring the Slice-B fix (#123).
- `entryAffecting` — `classifyEntryAffectingParams(profile.parameters)`.
- `hasEntrySignalEvidence` — derived deterministically: `baselineMetrics.totalTrades > 0`, else the recorded entry-signal flag when the source captured one (a decision-records-based enrichment; absent today → `false`).

The **golden output** is the `Gate1Output.decision` (one of `improve | allow_exploratory_sweep | stop_not_worth | stop_insufficient_evidence`).

> **Dataset-diversity limitation (known):** an `allow_exploratory_sweep` case requires a `0-trade` baseline WITH `hasEntrySignalEvidence === true`. Until the extractor captures the decision-records entry-signal evidence, extracted `0-trade` cases default to `evidence=false` → the oracle labels them `stop_insufficient_evidence`, so real `allow_exploratory_sweep` cases will be under-represented in the recorded dataset. Synthetic `fixtures.ts` covers this branch for unit tests; a rich real sample of it awaits the evidence enrichment (or a VPS dataset where long_oi trades). This is honest data-reality, not a scoring gap.

## 4. Architecture

Standard harness skeleton (`src/experiments/wfo-gate1/` + `scripts/wfo-gate1-eval.ts`) plus two Slice-C-specific stages upstream of the eval: **case extraction** and **labeling+freeze**.

```
recorded sources (local DB / mock-platform / VPS snapshot)
  → CaseExtractor → Gate1 cases (Gate1Input each, deterministic reconstruction)
  → Labeler:  oracle (obvious) + teacher/frontier (ambiguous)
  → FrozenDataset snapshot {caseId → {input, label, labelSource, teacherModel?, rationale?, createdAt}, snapshotId}
  → runEval(candidate models × repeat × cases) → scoreCase (schema + exact-decision + reason-lite)
  → aggregate (accuracy/passRate, split by labelSource) → markdown report + manifest
```

### 4.1 Case extraction — `case-source.ts`
- A `CaseSource` port with implementations: `DbCaseSource` (reads baseline experiments + profiles from Postgres, reconstructs `Gate1Input` per the §3 rules), and a `SnapshotCaseSource` (reads a VPS/mock export file). Returns `RawCase[] = { id, input: Gate1Input, meta: { experimentId, sourceRef } }`.
- **In-repo only** a tiny `fixtures.ts` with a handful of synthetic `RawCase`s to unit-test the extractor/oracle/scorer offline. The real golden dataset is external.

### 4.2 Oracle — `oracle.ts` (deterministic labeler)
- Labels the structurally-unambiguous cases with high confidence, encoding the settled Gate1 rules:
  - `totalTrades === 0` and **no** entry-affecting tunable → `stop_insufficient_evidence`.
  - `totalTrades === 0` and entry-affecting tunable present **and** `hasEntrySignalEvidence` → `allow_exploratory_sweep`.
  - `totalTrades === 0` and entry-affecting tunable present **but** no evidence → `stop_insufficient_evidence`.
- Returns `{ label, confidence: 'obvious' } | { needsTeacher: true }`. The genuinely subjective call — a baseline WITH trades that is `improve` vs `stop_not_worth` (is it already good enough?) — is marked `needsTeacher` (the oracle does not guess it).

### 4.3 Teacher labeler — `teacher.ts`
- For `needsTeacher` cases, calls a **frontier** model (the teacher, configurable, distinct-by-default from the eval candidate to avoid self-agreement) to produce `{ label, rationale }`. Records `labelSource:'teacher'`, `teacherModel`.
- Paid — runs only under an explicit `--label` step, never during a plain eval.

### 4.4 Frozen dataset — `dataset.ts`
- `FrozenCase = { id, input: Gate1Input, label: Gate1Decision, labelSource: 'oracle'|'teacher', teacherModel?: string, rationale?: string, createdAt: string }`.
- `FrozenDataset = { snapshotId, createdAt, gitSha, sourceRef, cases: FrozenCase[] }`, persisted as a snapshot artifact (`.artifacts/experiments/wfo-gate1/datasets/<snapshotId>.json`), with a stable `snapshotId` (content hash of cases+labels).
- The eval consumes a **pinned** `snapshotId`; it NEVER re-labels. `--label` (separate command) builds/refreshes a snapshot and prints its id; `--snapshot <id>` selects it for eval. A curated snapshot MAY later be committed under `docs/fixtures/` if a stable public golden set is wanted.

### 4.5 Eval harness — `eval-harness.ts` + `scoring.ts`
- `runEval({ models, repeat, dataset, threshold }, deps: { gate1For(modelId), providerOf, clock })` loops `models → repeat → cases`, calls `gate1.decide(case.input)` (catch → schema-miss), `scoreCase`, `scoreRun`.
- `scoreCase` (deterministic, NO LLM): (1) `Gate1OutputSchema.safeParse` — schema gate (fail → 0); (2) exact match of `decision` vs the frozen `label` — the primary metric; (3) lightweight `reason` check — non-empty and not an obvious contradiction (e.g. a `stop_*` decision whose reason literally asserts the strategy should be swept) → a small penalty, never the primary signal.
- `scoreRun` → mean accuracy + `passRate` vs `DEFAULT_THRESHOLD` → PASS/FAIL. **Aggregates split accuracy by `labelSource`** (oracle-accuracy = the genuine signal; teacher-accuracy flagged as potentially circular when candidate == teacher).

### 4.6 Aggregate + report — `aggregate.ts` + `report.ts`
- `aggregateRuns`/`rankAggregates` (mean/std), `recommendEnv` reporting **frontier baseline PASS/FAIL** vs the incumbent `WFO_GATE1_MODEL` (not a cheapest-passing pick this slice).
- `planDryRun` (paid-call math `models × repeat × caseCount` + `missingKeys` per provider), `writeRunArtifacts` (JSON + manifest `{timestamp, gitSha, harnessVersion, contractVersion, snapshotId, mode}`), `renderReport` (markdown table: model, accuracy overall / oracle / teacher, passRate, meanLatency, PASS/FAIL).

### 4.7 CLI — `scripts/wfo-gate1-eval.ts`
- `HARNESS_VERSION='wfo-gate1-eval-v1'`, `CONTRACT_VERSION='wfo-gate1-v0'`.
- Subcommands/flags: `--label` (build/refresh a frozen snapshot — paid teacher calls + DB/snapshot read; prints `snapshotId`); `--snapshot <id>` (select the frozen dataset for eval); `--run` (the sole paid-eval trigger; dry-run default prints `plannedPaidCalls`/`classifyCalls`/`missingKeys`); `--models`, `--repeat`, `--threshold`, `--teacher-model`.
- Under `--run`/`--label` it dynamically imports `real-gate1-factory.ts`.

### 4.8 real-gate1-factory.ts — the only `composeMastra` importer
- `buildRealGate1For(env, modelId)` — sets every adapter to `'fake'` except the Gate1 agent under test (wires `src/adapters/wfo/mastra-gate1.ts` + `src/mastra/agents/gate1-decision.agent.ts`). `buildRealTeacher(env, teacherModel)` — the frontier labeler (reuses the same Gate1 agent factory, different model). No judge factory this slice.

## 5. Data flow (two commands)

1. `wfo-gate1-eval --label --teacher-model <frontier> [--source db|snapshot ...]` → extract cases → oracle-label obvious + teacher-label ambiguous → freeze → prints `snapshotId`.
2. `wfo-gate1-eval --run --snapshot <id> --models <frontier> --repeat N` → load frozen dataset → run candidate(s) → deterministic score → report + manifest.

## 6. Error handling
- Candidate returns schema-invalid output → case scores 0 (schema gate), classified `schema_miss` in the aggregate (not a crash).
- No frozen snapshot / unknown `snapshotId` → fail-fast with a clear message (eval never auto-labels).
- Missing provider key → surfaced in the dry-run `missingKeys` before any paid call.
- A recorded source yielding zero cases → fail-fast (empty dataset is a setup error, not a pass).

## 7. Testing
- **Offline, deterministic, no paid calls:** unit tests on the synthetic `fixtures.ts`:
  - `oracle` labels each structural branch correctly + marks the has-trades case `needsTeacher`.
  - `scoreCase`: schema-miss → 0; exact decision-match → full; wrong decision → 0; reason-contradiction → penalty.
  - `runEval` with a **fake** `gate1For(modelId)` returning canned outputs (incl. a schema-miss) + injected `clock` → correct accuracy/passRate/labelSource-split aggregation.
  - dataset freeze/round-trip: freeze → load by `snapshotId` → identical cases+labels; a second freeze of unchanged input yields the same `snapshotId` (content-addressed); the loader NEVER mutates labels.
- **Gates:** `pnpm typecheck` clean; full suite green. No paid call in any test.

## 8. Roadmap / deferred
- **Next slice (cascade):** cheap candidate models × confidence-threshold × escalation-rate + cost/$ saving; "cheapest-passing" recommendation; the frontier becomes the escalation target.
- LLM-as-judge for reason quality (a `wfo-gate1-judge.agent.ts` in `src/mastra/agents/`).
- SweepDesigner + ResultInterpreter eval harnesses (reuse this skeleton; SweepDesigner scoring layers `validateSweepGrid` + a judge for grid quality).
- Committing a curated public golden snapshot under `docs/fixtures/` once the recorded dataset is rich enough (VPS ≥30-day data).
