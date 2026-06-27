# Strategy-Critic Eval Harness — Design

**Date:** 2026-06-27
**Status:** Approved (brainstorming)

## Context

PR #88 shipped the pre-flight strategy critic with a pluggable mode (`single` = one combined
agent; `two_stage` = critic agent → refiner agent), default OFF. Its spec deferred the
"Comparison & future eval" to a separate slice: decide the default mode + per-role models by
data, not by guess. This slice builds that eval harness — mirroring the existing
analyst / researcher / builder / turn-interpreter harnesses — plus one prerequisite product
change: ground the refining agents in the platform's real data capabilities so their
improvements are *actionable* (buildable + backtestable), not data-blind.

Two real motivating cases drive the dataset (the user's actual strategies):
`pump-short` ("шорт после пампа от 10% за 20 минут") and `dump-long` ("лонг после дампа от 10%
за 20 минут").

## Decisions

- **Mirror the existing eval-harness conventions** (`src/experiments/strategy-analyst/*` as the
  primary template): `RunEvalInput` / `RunEvalDeps`, `runOnce` → deterministic score → optional
  judge, `aggregateRuns` / `rankAggregates`, judge agent under `src/mastra/agents/`, real model
  factory imported only under `--run`, dry-run paid-gate, offline-deterministic tests.
- **Candidate = `(mode, criticModel, refinerModel?)`.** `single` → one combined model;
  `two_stage` → a `(criticModel, refinerModel)` pair. CLI `--mode two_stage --critic-models a,b
  --refiner-models x,y` evaluates the **cross-product** of role models (so e.g. a `gpt-5.5`
  critic × `{gpt-5.5, grok-4.3}` refiner is one run each); `--mode single --models a,b`.
- **Deterministic scorer = improvement signals** on `improvedStrategyText` (offline, no LLM).
- **Judge = absolute per-candidate** (mirror analyst/researcher judges), opus default,
  best-effort, NEVER affects the deterministic verdict. Mode + role models are surfaced in the
  ranking so `single` vs `two_stage` (and cross-role pairs) compare directly.
- **Fixtures = the 2 real vague cases** above (RU), dataset-of-cases (candidates × cases ×
  repeat). Extensible; no invented strategies for now.
- **Platform-data grounding (prerequisite product change):** inject a shared
  `PLATFORM_DATA_CAPABILITIES` context into the agents that REWRITE — `strategy-refiner`
  (two_stage) and `strategy-critic-combined` (single) — so refinements reference only available
  signals. The pure-critique agent `strategy-critic` stays the user's verbatim prompt
  (critique-only, no data context) — preserving the PR #88 invariant. Still gated OFF by default
  (`STRATEGY_PREFLIGHT_CRITIQUE=false`).
- **Scope:** harness + scorer + judge + fixtures + dry-run + offline tests. The paid `--run`
  (actual model selection) is the user's manual step after merge (as with `analyst:eval`).

## Architecture

### 0. Platform-data grounding (Task 1 — product change, prerequisite)

A canonical capabilities description sourced from the real contract, NOT invented:
- `MarketDataKind = 'openInterest' | 'liquidations' | 'funding' | 'taker'`
  (`src/ports/research-run-lifecycle.ts`).
- `src/adapters/builder/builder-sdk-doc.ts` — the real `ctx.market` API (`openInterest.trend`,
  etc.); `takerBuy`/`takerSell` (→ taker delta / CVD); long/short liquidations.

Add a `PLATFORM_DATA_CAPABILITIES` constant (prose, concise — OHLCV; open interest + trend;
long/short liquidations; funding rate; taker buy/sell → delta/CVD). Inject it into the
INSTRUCTIONS of:
- `src/mastra/agents/strategy-refiner.agent.ts` (two_stage rewriter)
- `src/mastra/agents/strategy-critic-combined.agent.ts` (single — critiques AND rewrites)

Do NOT touch `src/mastra/agents/strategy-critic.agent.ts` (verbatim critique-only). The refiner /
combined are instructed: propose improvements grounded in these signals; do not invent
unavailable data sources; execution / risk-sizing stays runner-owned. Test: refiner + combined
INSTRUCTIONS contain the capabilities markers; critic does NOT.

### 1. Module layout (mirror strategy-analyst)

- `src/experiments/strategy-critic/types.ts` — `Candidate`, `CandidateResult`, `ScoreResult`,
  `CandidateError`, `JudgeVerdict`, `ModelAggregate`, `EvalRunResult`, `CriticEvalCase`.
- `src/experiments/strategy-critic/scoring.ts` — `scoreRefinement(refinement, case, { threshold })`.
- `src/experiments/strategy-critic/judge.ts` — `buildJudgePrompt`, `runJudge(agent, input)`.
- `src/experiments/strategy-critic/eval-harness.ts` — `runOnce`, `runEval`.
- `src/experiments/strategy-critic/aggregate.ts` — `aggregateRuns`, `rankAggregates`.
- `src/experiments/strategy-critic/fixtures.ts` — `CRITIC_EVAL_CASES` (the 2 real cases).
- `src/experiments/strategy-critic/real-critic-factory.ts` — `buildRealCriticFor`,
  `buildRealJudge` (dynamic-imported only under `--run`).
- `src/experiments/strategy-critic/__fixtures__/refinements.ts` — canned `StrategyRefinement`
  objects for offline scorer/aggregate tests.
- `src/mastra/agents/strategy-critic-judge.agent.ts` — judge agent factory + ID.
- `scripts/strategy-critic-eval.ts` — CLI; `package.json` `critic:eval` script.

### 2. Candidate model + CLI

```ts
type Candidate =
  | { mode: 'single'; label: string; combinedModel: string }
  | { mode: 'two_stage'; label: string; criticModel: string; refinerModel: string };
```
Label: `single:<combined>` / `two_stage:critic=<c>,refiner=<r>`. CLI builds candidates:
`--mode single --models a,b` → 2 single candidates; `--mode two_stage --critic-models a,b
--refiner-models x,y` → 4 two_stage candidates (cross-product). Aggregation is keyed by label.

### 3. runOnce / runEval flow

`RunEvalDeps`: `criticFor(candidate) => StrategyCriticPort`, `providerOf(modelId)`, `clock`,
`judge?`. `runOnce(candidate, case)`: `clock()` → `critic.refine({ kind:'manual_description',
content: case.text })` → `clock()` (latency) → `scoreRefinement(refinement, case, {threshold})`
→ optional `judge(refinement, case)` (best-effort, stderr on failure, never blocks). Returns
`CandidateResult { label, mode, criticModel, refinerModel?, caseId, latencyMs, verdict, score,
rawOutput, error, judge? }`. `runEval`: iterate candidates × cases × repeat (sequential, no
parallelism — rate limits). `EvalRunResult { perCandidate: CandidateResult[], aggregates:
ModelAggregate[], judgeEnabled, overallSuccess }` (`overallSuccess` = any run PASS).

### 4. Deterministic scorer (`scoring.ts`, offline)

Gates: `schemaValid` (`StrategyRefinementSchema.safeParse(refinement)`); `directionPreserved`
(the improved text keeps the case's stated direction — short stays short, long stays long);
`noRunnerOverreach` (the improved text does not prescribe leverage / base-order sizing / equity %
— that stays runner-owned, mirroring the analyst risk gate); `nonTrivialChange`
(`improvedStrategyText` materially differs from `case.text` — length + token-set delta over a
floor). Weighted checks: coverage of `case.expectedAspects` (each aspect is a keyword/regex group
grounded in available data — e.g. for `pump-short`: taker-flow / OI / funding / liquidation /
invalidation / timeframe). Verdict PASS iff all gates pass AND coverage score ≥ threshold
(default 0.6). `ScoreResult { gates, checks, score, threshold, verdict }`.

### 5. Judge (`judge.ts` + `src/mastra/agents/strategy-critic-judge.agent.ts`)

Opus-default agent. Prompt: given the original strategy text + the candidate's refinement, score
rubric dimensions 0..1 — did it strengthen the real weaknesses; did it add the missing nuances
grounded in available data; did it avoid inventing facts / unavailable data; is the strategy
still analyzable+buildable (no runner overreach). `JudgeVerdict { dimensions[], overallScore,
hallucinations[], missing[], notes }`. Best-effort, non-blocking.

### 6. Fixtures (`fixtures.ts` + `__fixtures__`)

`CriticEvalCase { id, text, lang, direction: 'long'|'short', expectedAspects: AspectGroup[] }`.
Two cases: `pump-short` ("шорт после пампа от 10% за 20 минут"), `dump-long` ("лонг после дампа
от 10% за 20 минут"). `expectedAspects` per case enumerate the data-grounded improvements the
refinement should address (taker-flow confirmation, OI trend, funding extreme, liquidation
cascade risk, explicit invalidation level, timeframe/holding window). `__fixtures__/refinements.ts`
provides canned `StrategyRefinement` objects (good / gate-fail / low-coverage / runner-overreach)
for the offline scorer + aggregate tests.

### 7. Aggregation / ranking (`aggregate.ts`)

`aggregateRuns` → per-candidate `ModelAggregate { label, mode, criticModel, refinerModel?, runs:
{ok,total}, passRate, det: {mean,std}, judge?: {mean,std}, latency: {mean} }` over cases × repeat.
`rankAggregates` sorts by judge-mean (when judge enabled) → passRate → det-mean. The ranking row
carries mode + role models, so `single` vs `two_stage` and cross-role pairs are directly
comparable.

### 8. real-critic-factory + CLI (dry-run paid-gate)

`buildRealCriticFor(baseEnv)(candidate)`: compose `MastraCompositionEnv` with
`STRATEGY_CRITIC_ADAPTER='mastra'`, `STRATEGY_CRITIC_MODE=candidate.mode`,
`STRATEGY_CRITIC_MODEL` (= combined or critic model), `STRATEGY_REFINER_MODEL`
(= refiner model for two_stage), all other adapters `fake`; `composeMastra` → build the matching
adapter via the same selection `buildStrategyCritic` uses. `buildRealJudge(baseEnv, judgeModelId)`
→ `createStrategyCriticJudgeAgent` + `runJudge`. CLI `scripts/strategy-critic-eval.ts` (npm
`critic:eval`): `--mode`, `--models` / `--critic-models` / `--refiner-models`, `--threshold`,
`--judge` + `--judge-model`, `--repeat`, `--run`. No `--run` → dry-run: print the planned paid
calls per candidate + `missingKeys`, construct nothing, import no real factory. `--run` →
dynamic-import the real factory, run, write artifacts under
`.artifacts/experiments/strategy-critic/<timestamp>/`, render a ranking table, exit 0 on
`overallSuccess` else 3.

## Testing

Offline-deterministic, no real adapters / API keys (mirrors the existing harness tests):
- `scoring.test.ts` — gates + coverage + verdict over the `__fixtures__` refinements.
- `eval-harness.test.ts` — fake `criticFor` (fixed / throwing / flaky), runOnce/runEval, error
  classification, judge best-effort (throwing judge → verdict unaffected), repeat aggregation.
- `aggregate.test.ts` — per-candidate aggregation + ranking order (single vs two_stage).
- agent test — refiner + combined INSTRUCTIONS include the capabilities markers; critic does not.
- judge construction test (mirror analyst judge construction test).
- CLI dry-run test if the existing harness has one (plan to mirror `planDryRun`).
Gate: `pnpm typecheck` + `pnpm test`.

## Out of scope (later)

- Round-trip-through-analyst scorer (feed `improvedStrategyText` → analyst → `scoreProfile`) —
  a future `--round-trip` flag.
- Pairwise (comparative) judge.
- Executing the paid `--run` and committing a chosen default mode/models — a manual follow-up
  after the user inspects the ranking.
- Dynamic sourcing of `PLATFORM_DATA_CAPABILITIES` from live ops-read discovery (a curated
  constant for now).
