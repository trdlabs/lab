# Strengthen Analyst Eval (generic completeness scorer + short fixture) — Design

**Date:** 2026-06-27
**Status:** Approved (brainstorming)
**Branch:** `feat/analyst-eval-strengthen` (from main)

## Context

We need a confident analyst-model choice (the profile-quality lever). A first paid `analyst:eval` run on the
single `long-oi` fixture ranked **gpt-5.5 (det 0.975) > opus-4.8 (0.925) > grok-4.3 (0.825, passes) >
gemini-3.1-pro (0.758, FAIL)**. But the evidence is thin and partly confounded:

- The deterministic `scoreProfile` (`src/experiments/strategy-analyst/scoring.ts`) is **bespoke to the
  long-oi fixture**: a hard `directionLong` gate PLUS entry buckets (dump/drop/crash/bounce/reversal)
  and an exit ladder (TP1 3.5% / TP2 5% / SL 12% / time 180) tuned to that one strategy. It validly
  scores ONLY long-oi.
- The round-trip eval (PR #89) reused `scoreProfile` for arbitrary strategies, so its `profileMean`
  for the short `pump-short` case is meaningless (fails `directionLong`, content buckets all miss) —
  a real measurement bug. This also invalidated the earlier "analyst is the bottleneck (~0.5)"
  reading.
- Only one fixture (long, detailed), repeat=1.

This slice strengthens the evidence: a **generic, direction-aware structural-completeness scorer**
usable across any strategy/direction, a **detailed short-strategy fixture**, both eval harnesses
rewired to the generic scorer, then a clean paid run (long + short, repeat=3) to decide.

## Decisions

- **New generic scorer** `scoreCompleteness(profile, { expectedDirection, threshold })` —
  direction-aware structural completeness; works on any strategy. Used in the round-trip and as the
  cross-fixture deterministic signal in `analyst:eval`.
- **Keep the bespoke `scoreProfile`** as a long-oi deep-correctness check (module + tests retained;
  surfaced as a secondary long-oi-only diagnostic in `analyst:eval`).
- **New detailed short-source fixture** (`short-pump`) authored to long-oi depth, with notes + rubric
  for the judge.
- The paid decision run (long-oi + short-pump, repeat=3, 4 models) and the analyst-default switch are
  out of scope here (the experiment + decision follow the slice).

## Architecture (all in trading-lab; eval experiment only — production onboarding untouched)

### 1. `scoreCompleteness` (new module, e.g. `src/experiments/strategy-analyst/completeness.ts`)

`scoreCompleteness(raw: unknown, opts: { expectedDirection: 'long'|'short'|'spot'|'unknown'; threshold?: number }): ScoreResult`
- Gates: `schemaValid` (`AnalystProfileOutputSchema.safeParse`); `directionMatches`
  (`profile.direction === expectedDirection`).
- Weighted structural checks (direction/strategy-agnostic):
  - `has_market_features` — `requiredMarketFeatures` non-empty.
  - `has_entry` — `entryConditions` non-empty.
  - `has_exit` — `exitConditions` non-empty.
  - `unknowns_bounded` — `unknowns.length` ≤ a cap (constant, e.g. 4).
  - `no_fabrication` — reuse the FAB patterns (extract the FAB_PATTERNS + `FAB_PARAM_NAME` +
    `scoreRiskNoFabrication` logic from `scoring.ts` into a shared util both scorers import — DRY, no
    duplication).
- Verdict PASS iff gates pass AND weighted score ≥ threshold (default reuse `DEFAULT_THRESHOLD`).
- Returns the existing `ScoreResult` shape (`src/experiments/strategy-analyst/types.ts`).

### 2. `FixtureRef` + short fixture

- `FixtureRef` (`types.ts`) gains `direction: 'long' | 'short'`. `long-oi` → `'long'`.
- New `short-pump` fixture in `FIXTURES`: `sourcePath` `docs/fixtures/strategies/short-pump-strategy-source.md`,
  `notesPath` `...-research-notes.md`, `rubricPath` `...-rubric.md`, `direction: 'short'`. Author the
  three docs to long-oi depth (a detailed short-after-pump strategy with entry/exit/invalidation +
  available-data grounding; the rubric mirrors long-oi's rubric structure for the judge).

### 3. `analyst:eval` rewire (`src/experiments/strategy-analyst/eval-harness.ts` + script)

- The deterministic ranking signal switches from `scoreProfile` to
  `scoreCompleteness(raw, { expectedDirection: fixture.direction, threshold })` so long + short are
  comparable on one metric.
- The bespoke `scoreProfile` result is retained as a **secondary diagnostic** computed only when the
  fixture is long-oi (or, simplest: only for `direction === 'long'`), surfaced in the per-model
  artifact / ranking as an extra field (not the primary sort key). `scoreProfile` + its tests are NOT
  deleted.
- `runOnce` threads `fixture.direction` into the scorer. The script already supports `--repeat`.

### 4. round-trip rewire (`src/experiments/strategy-critic/eval-harness.ts`)

- Replace the `scoreProfile(profile, { threshold })` call with
  `scoreCompleteness(profile, { expectedDirection: evalCase.direction, threshold })` (the
  `CriticEvalCase` already carries `direction`). Fixes the pump-short confound — `profileScore` is now
  valid across directions. `profileScore` stays the analyst `ScoreResult` type.

### 5. Decision run (out of scope — manual, after merge)

`npm run analyst:eval -- --fixture long-oi` and `--fixture short-pump`, repeat=3, models
grok-4.3 / gemini-3.1-pro / gpt-5.5 / opus-4.8, judge opus-4.8 → robust det(completeness)+judge
ranking across both directions → choose the analyst default. Plus a round-trip cross-check (now
valid). Then a small follow-up wires the chosen `STRATEGY_ANALYST_MODEL` default.

## Testing (offline-deterministic)

- `scoreCompleteness`: gates (schema invalid → fail; direction mismatch → fail) + each structural
  check (empty entry/exit/features → miss; unknowns over cap → miss; fabrication → no_fabrication
  fail) on BOTH a long and a short canned profile; PASS on a complete matching-direction profile.
- shared FAB util: the extraction is behavior-preserving — `scoreProfile`'s existing
  risk_no_fabrication tests stay green.
- fixtures: `short-pump` loads (files exist) + fingerprint; `FixtureRef.direction` present.
- `analyst:eval`: deterministic signal uses `scoreCompleteness` keyed on `fixture.direction`; the
  long-oi `scoreProfile` secondary diagnostic still appears; both fixtures resolvable.
- round-trip: `pump-short` (short) no longer fails on `directionLong`; `profileScore` reflects
  structural completeness keyed on the case direction.
- Gate: `pnpm typecheck` + `pnpm test` (full suite green, incl. the FAB-extraction regression).

## Out of scope

- Executing the paid decision run + switching the default `STRATEGY_ANALYST_MODEL` (follow-up).
- Deleting or parametrizing `scoreProfile` per-fixture (kept as the long-oi deep check).
- Any production onboarding/analyst behavior change (this is eval-experiment only).
- More fixtures beyond `short-pump` (start with one short fixture).
