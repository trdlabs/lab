# TurnInterpreter eval harness — Design

**Status:** Approved (brainstorm 2026-06-22)
**Repo:** trading-lab (TypeScript, `node --experimental-strip-types`, Vitest, Mastra)

## Goal

Measure the **live quality of the `TurnInterpreter`** — the conversational operator's one-LLM-call step that turns a chat message into a typed interpretation (subject / goal / strategyText / constraints / references / confidence). The interpreter currently shares the intent-classifier's model config (`INTENT_CLASSIFIER_*`, no own env) and its live extraction quality is unmeasured. This slice builds an **offline-deterministic eval harness** mirroring the existing `intent-classifier` and `strategy-analyst` harnesses, sweeps a small model set, and outputs a recommendation on whether the TurnInterpreter should get its own model env.

## Decisions (from the 2026-06-22 brainstorm)

1. **Model scope — sweep + env recommendation.** Run a small model set (incumbent `INTENT_CLASSIFIER_MODEL` baseline + 1–2 stronger candidates) against a labelled interpretation dataset. One output is a printed recommendation: give the TurnInterpreter its own `TURN_INTERPRETER_MODEL` env, or keep sharing `INTENT_CLASSIFIER_*`. The eval does NOT change composition — env decoupling, if recommended, is a separate follow-up.
2. **Scoring — weighted structured extraction.** The headline score is a weighted sum over the structured fields (subject + goal + constraints + strategyText-present + references), because the structured extraction (not the easy `subject` enum) is what discriminates models. Deterministic: enums exact, free strings normalized-exact, strategyText scored by presence, plus a no-fabrication penalty.
3. **Judge — opt-in, default off** (mirrors both sibling harnesses). The deterministic score stays the headline; the judge only assesses soft quality the scorer can't.

## Background (the thing under eval — verified from code)

- Output type `TurnInterpretationSchema` (`src/chat/turn-interpretation.ts:6`): `subject` (required enum `strategy|bot|results|task|hypothesis|unknown`), `goal?` (enum `analyze|research|show_results|show_similar`), `strategyText?`, `constraints{market?,symbol?,timeframe?,direction?('long'|'short'|'both')}` (`.strict()`), `references: string[]`, `confidence: number 0..1`.
- Port `TurnInterpreterPort` (`src/ports/turn-interpreter.port.ts:6`): `{ adapter, model, interpret(message): Promise<unknown> }` — returns RAW provider output (untrusted). The single trust boundary is `normalizeTurnOutput` (null-strip) → `TurnInterpretationSchema.parse`, applied in prod at `src/chat/chat-handler.ts:139`.
- Mastra adapter `MastraTurnInterpreter` (`src/adapters/intent/mastra-turn-interpreter.ts:15`); agent `createTurnInterpreterAgent` (`src/mastra/agents/turn-interpreter.agent.ts`); deterministic `FakeTurnInterpreter` (`src/adapters/intent/fake-turn-interpreter.ts`) for tests.
- **Env:** no `TURN_INTERPRETER_*` exists; the runtime resolves the agent's model from `INTENT_CLASSIFIER_MODEL` (`compose-mastra.ts:76`, `composition.ts:94`). Vars: `INTENT_CLASSIFIER_ADAPTER | INTENT_CLASSIFIER_MODEL | INTENT_CLASSIFIER_MIN_CONFIDENCE`.

## Architecture — mirror the `intent-classifier` harness

New package `src/experiments/turn-interpreter/` + CLI `scripts/turn-interpreter-eval.ts` + npm script `"turn-interpreter:eval"`. Same skeleton as the two existing harnesses:

- **`types.ts`** — `EvalCase` / `EvalCaseExpect`, `CaseResult` / `ScoreResult`, `CandidateResult` / `Stats` / `ModelAggregate`, `EvalRunResult`, `ManifestMeta`, `JudgeVerdictSchema` (Zod).
- **`fixtures.ts`** — Zod-validated dataset loader + sha256 `fingerprintCases` + a `DATASETS` registry; data file `src/experiments/turn-interpreter/__fixtures__/turn-interpretations-v1.json`.
- **`scoring.ts`** — pure, **never throws**; re-validates the candidate's RAW output through the exact production trust boundary (`normalizeTurnOutput` then `TurnInterpretationSchema.safeParse`); returns a 0..1 `score` + `verdict: PASS|FAIL`.
- **`eval-harness.ts`** — DI orchestrator: `RunEvalInput { models, datasetId, cases, datasetFingerprint, threshold, repeat? }`, `RunEvalDeps { interpreterFor, providerOf, clock, judge? }`. **Imports NO composeMastra / model code.** Model-major, sequential; per-model failure isolation (a model that can't build FAILs alone; a throwing message = schema-invalid miss).
- **`aggregate.ts`** — `aggregateRuns` + `rankAggregates` (extraction-score → pass-rate → latency tiebreak; judge-mean first when judge enabled).
- **`real-turn-interpreter-factory.ts`** — the ONLY module importing composeMastra / constructing real provider models; dynamically `import()`-ed ONLY under `--run`. Exposes `buildRealInterpreterFor(env)` + `buildRealJudge(...)`. Builds the `mastra` adapter via the shared `turn-interpreter` agent with the model resolved from the swept `modelId` (baseline = `INTENT_CLASSIFIER_MODEL`).
- **`src/mastra/agents/turn-interpreter-judge.agent.ts`** — the judge agent (invariant: judge agents live in `src/mastra`, never in `experiments/`).

Composition is untouched; the harness never mutates the operator runtime.

## Dataset — `turn-interpretations-v1.json`

Cases `{ id, lang: 'ru'|'en', message, expect }`, bilingual RU+EN (mirrors `chat-intents-v1`). **Authored in this slice (~30 cases), user-reviewed.** `expect` (`EvalCaseExpect`) declares only the relevant fields — secondary fields are checked only when declared:

```ts
interface EvalCaseExpect {
  subject: Subject;                 // primary, required
  goal?: TurnGoal | 'none';         // 'none' = expected absent
  hasStrategyText?: boolean;        // presence, not content
  constraints?: {                   // each checked only when present
    market?: string; symbol?: string; timeframe?: string;
    direction?: 'long'|'short'|'both';
  };
  absentConstraints?: Array<'market'|'symbol'|'timeframe'|'direction'>; // must NOT be fabricated
  references?: string[];            // set match when declared
}
```

Coverage matrix: each `subject` × `goal`; constraint variety (market/symbol/timeframe/direction in different combinations, both languages); strategyText cases (full strategy descriptions); references cases ("тот бэктест" / "последняя гипотеза"); edge cases (`subject:unknown`, no constraints, ambiguous message); and **anti-fabrication** cases (a message with no symbol → `absentConstraints: ['symbol']`, the model must not invent one). The dataset is fingerprinted (sha256) and the fingerprint is recorded in the run manifest.

## Scoring — `scoring.ts` (weighted structured extraction)

`scoreCase(raw: unknown, evalCase: EvalCase, latencyMs: number): CaseResult`:

1. `normalizeTurnOutput(raw)` (null-strip) then `TurnInterpretationSchema.safeParse`. On failure → schema-invalid miss: `score = 0`, `schemaValid = false`, and a `bestEffortSubject(raw)` surfaces a visible (not null) value in the report.
2. Per-field component scores (0..1), computed only for fields the case **declares**, then combined as a weighted sum with weights **normalized over the declared fields** (so a sparse case still scores 0..1). Default weights (constants in the file, tunable):
   - `subject` exact-enum — 0.20
   - `goal` exact (including `'none'` ⇒ output has no goal) — 0.15
   - `constraints.direction` exact-enum — 0.10
   - `constraints.market` / `symbol` / `timeframe` — normalized-exact (lowercase, trim, canonicalize separators), 0.30 split across the declared ones
   - `hasStrategyText` — presence matches expectation (boolean) — 0.15
   - `references` — set equality (normalized) when declared — 0.10
3. **No-fabrication penalty:** for each field listed in `absentConstraints`, if the parsed output filled it → subtract a `FABRICATION_PENALTY` (constant, e.g. 0.25 each) from the case score (floored at 0). This is the extraction-faithfulness signal (mirrors the analyst harness's `scoreRiskNoFabrication`).
4. `caseScore = clamp(weightedSum − fabricationPenalty, 0, 1)`.

`scoreRun(cases, { threshold }): ScoreResult` → `{ schemaValidRate, subjectAccuracy, fieldAccuracies{goal,direction,market,symbol,timeframe,strategyText,references}, fabricationRate, score (mean caseScore), threshold, verdict: PASS|FAIL, cases[] }`. `DEFAULT_THRESHOLD = 0.75`.

## Model sweep + env recommendation

- `--models` takes a list; baseline = the incumbent (`INTENT_CLASSIFIER_MODEL`) plus 1–2 stronger candidates. Paid-call volume = **models × repeat × caseCount**, printed in the dry-run plan.
- `rankAggregates` ranks by extraction `score` → pass-rate → latency.
- The `report.md` synthesis prints an **env recommendation** (text only, no code change): incumbent score, best-model score, and Δ. Decision rule (documented constant `ENV_RECOMMEND_MARGIN = 0.05`): if the best non-incumbent both **clears the PASS threshold** AND beats the incumbent by `≥ ENV_RECOMMEND_MARGIN` on `score` → recommend "give the TurnInterpreter its own `TURN_INTERPRETER_MODEL=<best>`"; else → "keep sharing `INTENT_CLASSIFIER_*`". The recommendation is advisory output for a follow-up decision.

## CLI / gates

`scripts/turn-interpreter-eval.ts` — flags `--dataset --models(required) --run --threshold --judge --judge-model --repeat`. **DRY RUN is the default:** `planDryRun` prints `plannedPaidCalls`, `classifyCalls` (= models×repeat×caseCount), and `missingKeys` — builds NOTHING, imports NO composeMastra. `--run` is the SOLE paid trigger; only then is `real-turn-interpreter-factory.ts` dynamically imported. Artifacts → `.artifacts/experiments/turn-interpreter/<dataset>/<timestamp>/` (JSON manifest + per-run JSON always; `report.md` human-readable). Exit code 3 when no run PASSes. npm: `"turn-interpreter:eval": "node --experimental-strip-types --env-file-if-exists=.env scripts/turn-interpreter-eval.ts"`.

## Judge — opt-in, default off

`src/mastra/agents/turn-interpreter-judge.agent.ts` (agent id `turn-interpreter-judge`). Assesses soft quality the deterministic scorer cannot: constraint faithfulness and how well `strategyText` captures the message's strategy intent. `JudgeVerdict { dimensions[{name,score,rationale}], overallScore, hallucinations[], missingFromExpected[], notes }`, written to a SEPARATE file; the deterministic score stays the headline. Runs only with `--judge --judge-model`; `buildRealJudge` is dynamically imported under `--run`. When enabled, `rankAggregates` uses judge-mean as the first sort key.

## Testing (offline, deterministic — no paid calls in CI)

- `scoring.test.ts` — exact / normalized-exact / strategyText-presence / references-set / no-fabrication-penalty / schema-invalid-miss; weighted-sum normalization over sparse `expect`.
- `eval-harness.test.ts` — DI orchestrator with a fake interpreter (canned raw outputs) + a fake judge; model-major sequencing; per-model failure isolation; manifest fingerprint recorded.
- `fixtures.test.ts` — dataset loads + validates; fingerprint is stable.
- Mirror the intent-classifier tests' structure. No network, no model construction in any test.

## Invariants / constraints

- **Trust boundary parity:** the scorer re-validates through the EXACT prod path (`normalizeTurnOutput` + `TurnInterpretationSchema`) — no parallel/looser schema.
- **No paid calls without `--run`;** the real factory is the only composeMastra importer, dynamically loaded under `--run` only.
- **Composition untouched;** the eval never mutates the operator runtime or env wiring (env decoupling is a separate follow-up if recommended).
- **Judge agents live in `src/mastra/`** (never under `experiments/`).
- **strip-types:** no TS parameter properties in new `src/` or `scripts/` code (AST guard).

## Out of scope

- Actually introducing `TURN_INTERPRETER_*` env / decoupling composition (a follow-up gated on the eval's recommendation).
- Tuning the TurnInterpreter prompt; an independent/large labelled corpus (this is a curated golden set, same caveat as the other harnesses).
- Scoring `confidence` calibration (recorded, not scored in v1).
