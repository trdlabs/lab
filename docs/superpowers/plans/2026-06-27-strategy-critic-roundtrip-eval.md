# Strategy-Critic Round-Trip Eval Implementation Plan

> **REQUIRED SUB-SKILL:** You MUST read and follow `superpowers:test-driven-development` for every task below. Each task is RED → GREEN → COMMIT. Do not write implementation before its failing test.

Spec (source of truth): `docs/superpowers/specs/2026-06-27-strategy-critic-roundtrip-eval-design.md`
Branch: `feat/strategy-critic-eval`

## Goal

Add a default-off, paid-gated **round-trip** stage to the strategy-critic eval harness: the refined
strategy text is fed to the **StrategyAnalyst** to produce a JSON `AnalystProfileOutput`, that profile
is scored deterministically (reusing the analyst experiment's `scoreProfile`) AND shown to the judge,
so model selection reflects the whole critic→analyst chain. Also restructure the single-mode
(`strategy-critic-combined`) agent prompt so `improvedStrategyText` is emitted in explicit labelled
sections (Entry / Exit & invalidation / Required data signals / Caveats) — fixing the cheap model's
empty-`exitConditions` / high-`unknowns` profiles.

## Architecture

- **Combined agent** (`src/mastra/agents/strategy-critic-combined.agent.ts`) gains a structure
  instruction; grounding (`PLATFORM_DATA_CAPABILITIES`) + runner-owned boundary preserved.
- **Judge** (`judge.ts` + `strategy-critic-judge.agent.ts`) optionally receives the resulting profile.
- **Harness** (`eval-harness.ts`) runs the analyst after `refine()` when `roundTrip`, fail-soft.
- **Aggregation** (`aggregate.ts`) adds a profile `Stats` and a `profileMean` ranking tiebreak.
- **Wiring** (`real-critic-factory.ts` + `scripts/strategy-critic-eval.ts` + `plan.ts`) reuses the
  analyst experiment's `buildRealAnalystFor` under `--run` only and adds `--round-trip` /
  `--analyst-model` CLI flags + dry-run accounting.

## Tech Stack

- TypeScript run via `node --experimental-strip-types` (types erased at runtime).
- Vitest (`pnpm vitest run <file>`), zod for schemas, Mastra `@mastra/core/agent` for agents.
- Reused, NOT reimplemented: `scoreProfile` (`src/experiments/strategy-analyst/scoring.ts`) and
  `buildRealAnalystFor` (`src/experiments/strategy-analyst/real-analyst-factory.ts`).

## Global Constraints

- **No TS parameter-properties.** `node --experimental-strip-types` runs the code; a
  `constructor(private x: T)` passes `tsc`/Vitest but throws at runtime. No new constructors here use
  them. Guard: `src/strip-types-no-param-properties.test.ts` (keep green).
- **Agents live under `src/mastra/**`.** Only files under `src/mastra/agents/**` construct `new Agent`.
  Guard: `src/mastra/mastra-import-boundary.guard.test.ts` (keep green) — do NOT import `composeMastra`
  or construct provider models from `src/experiments/**` except in the existing `real-*-factory.ts`
  modules that the CLI dynamically imports only under `--run`.
- **`.ts` import extensions** on every relative import (e.g. `'./judge.ts'`).
- **Test gate:** `pnpm typecheck` + `pnpm test` (full suite green) at the end.
- **`pnpm vitest run` strips types** — a RED is an unresolved-import / runtime / **assertion** failure,
  never a "type error". For the one type-only task (Task 2) the RED is observed via **`pnpm typecheck`**
  (a missing-property error), NOT via vitest; vitest stays green there because the literal builds at
  runtime regardless.
- **Round-trip default OFF + paid-gated.** The analyst is constructed / imported ONLY under `--run`.
  Dry-run accounts for analyst calls but constructs nothing.
- **Judge is best-effort** and NEVER affects the deterministic verdict (existing invariant preserved).
- **Analyst failure is fail-soft:** `profile` / `profileScore` become `null`, the judge still runs
  (without a profile), and the critique verdict is unaffected.
- **Reuse, do not reimplement:** the analyst `scoreProfile` and `buildRealAnalystFor` are imported
  as-is. The analyst's `ScoreResult` is imported under the alias **`AnalystScoreResult`** (the critic
  package already exports a *different-shaped* `ScoreResult`, so the alias is mandatory).
- **`two_stage` code is NOT touched** (kept as-is; only `single` is measured going forward).
- **The critique-only `strategy-critic` agent and the `strategy-refiner` agent are NOT changed** —
  only `strategy-critic-combined` gets the structured-prompt change.

---

## Task 1 — Combined-agent structured prompt

`src/mastra/agents/strategy-critic-combined.agent.ts`: instruct that `improvedStrategyText` MUST be
organised into four explicit labelled sections. Keep `PLATFORM_DATA_CAPABILITIES` + runner-owned
boundary. Do NOT touch `strategy-critic.agent.ts` or `strategy-refiner.agent.ts`.

### Step 1.1 — Failing test (new file)

Create `src/mastra/agents/strategy-critic-combined.agent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { STRATEGY_CRITIC_COMBINED_INSTRUCTIONS } from './strategy-critic-combined.agent.ts';

const STRUCTURE_MARKERS = ['Entry conditions', 'Exit & invalidation', 'Required data signals', 'Caveats'];

describe('strategy-critic-combined instructions', () => {
  it('organise improvedStrategyText into the four labelled sections', () => {
    for (const marker of STRUCTURE_MARKERS) {
      expect(STRATEGY_CRITIC_COMBINED_INSTRUCTIONS).toContain(marker);
    }
  });

  it('still grounds in platform data and keeps the runner-owned boundary', () => {
    expect(STRATEGY_CRITIC_COMBINED_INSTRUCTIONS).toContain('AVAILABLE PLATFORM DATA');
    expect(STRATEGY_CRITIC_COMBINED_INSTRUCTIONS).toContain('runner-owned');
  });

  it('does NOT add the structure markers to the critique-only or refiner agents', () => {
    const criticSrc = readFileSync(new URL('./strategy-critic.agent.ts', import.meta.url), 'utf8');
    const refinerSrc = readFileSync(new URL('./strategy-refiner.agent.ts', import.meta.url), 'utf8');
    for (const marker of STRUCTURE_MARKERS) {
      expect(criticSrc).not.toContain(marker);
      expect(refinerSrc).not.toContain(marker);
    }
  });
});
```

### Step 1.2 — Run, expect FAIL

```
pnpm vitest run src/mastra/agents/strategy-critic-combined.agent.test.ts
```
Expected: the first test FAILS (assertion) — `STRATEGY_CRITIC_COMBINED_INSTRUCTIONS` does not yet
contain `'Entry conditions'`. (The grounding test and the negative critique-only test already pass.)

### Step 1.3 — Minimal implementation

Edit `src/mastra/agents/strategy-critic-combined.agent.ts` — add ONE element to `BASE_INSTRUCTIONS`
(after the `improvedStrategyText` / `changeLog` line, before the runner-owned line):

```ts
const BASE_INSTRUCTIONS = [
  'You are a ruthless market opponent who, in a single pass, critiques a trading-strategy idea AND produces an',
  'improved version of it. First attack the idea: find 5 to 10 weak points (`vulnerabilities`), separate fact from',
  'interpretation (`selfDeception`), categorize risk into market / timing / news / liquidity / BTC-regime / exhaustion',
  '(`risks`), name at most 3 earliest break signs (`earlyBreakSigns`), and list at most 5 pre-entry checks (`preEntryChecks`).',
  'Give a terse verdict (`verdict`): main vulnerability, severity (low/medium/high), bad_idea vs bad_timing (or neither),',
  'and what would strengthen it. Then write `improvedStrategyText` in the SAME language as the input — addressing your',
  'own findings (regime filter, invalidation condition, liquidity / BTC caveats) — plus a short `changeLog`.',
  'Structure `improvedStrategyText` into four explicit labelled sections, each starting on its own line:',
  '"Entry conditions:", "Exit & invalidation:", "Required data signals:", and "Caveats:" — so a downstream analyst can extract entry and exit cleanly.',
  'Risk sizing, order execution, and fills stay runner-owned. Never invent facts; flag missing data explicitly.',
  'Ground every proposed improvement in the available platform signals below; do not reference data the platform cannot provide.',
].join(' ');
```

(Do NOT change `STRATEGY_CRITIC_COMBINED_INSTRUCTIONS`, the agent factory, or any other file.)

### Step 1.4 — Run, expect PASS

```
pnpm vitest run src/mastra/agents/strategy-critic-combined.agent.test.ts
```
Expected: all three tests PASS.

### Step 1.5 — Commit

```
git add src/mastra/agents/strategy-critic-combined.agent.ts src/mastra/agents/strategy-critic-combined.agent.test.ts
git commit -m "feat(critic-eval): structure combined-agent improvedStrategyText into labelled sections

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Types (round-trip data + analyst injection)

Carry the round-trip data on `CandidateResult`, the round-trip inputs on `RunEvalInput`, the analyst
injection on `RunEvalDeps`, and an optional profile `Stats` on `ModelAggregate`. This task is
**type-only**; its RED is a `pnpm typecheck` missing-property error.

Files: `src/experiments/strategy-critic/types.ts`, `src/experiments/strategy-critic/eval-harness.ts`
(interfaces + the two `runOnce` return literals), plus housekeeping in two existing test files so the
suite keeps compiling.

### Step 2.1 — Failing test (extend the existing shape test)

Append to `src/experiments/strategy-critic/types.test.ts`:

```ts
import type { CandidateResult, ModelAggregate, ScoreResult as CriticScoreResult } from './types.ts';
import type { ScoreResult as AnalystScoreResult } from '../strategy-analyst/types.ts';
import { GOOD_LONG_OI_PROFILE } from '../strategy-analyst/__fixtures__/profiles.ts';

describe('CandidateResult round-trip fields', () => {
  it('carries profile + profileScore (null when round-trip is off)', () => {
    const detScore: CriticScoreResult = {
      gates: { schemaValid: true, directionPreserved: true, noRunnerOverreach: true, nonTrivialChange: true },
      checks: [], score: 0.8, threshold: 0.6, verdict: 'PASS',
    };
    const off: CandidateResult = {
      label: 'single:m', mode: 'single', criticModel: 'm', refinerModel: null, caseId: 'pump-short',
      latencyMs: 100, verdict: 'PASS', score: detScore, rawOutput: null, error: null, judge: null,
      profile: null, profileScore: null,
    };
    expect(off.profile).toBeNull();
    expect(off.profileScore).toBeNull();

    const profileScore: AnalystScoreResult = {
      gates: { schemaValid: true, directionLong: true }, checks: [], score: 0.9, threshold: 0.8, verdict: 'PASS',
    };
    const on: CandidateResult = { ...off, profile: GOOD_LONG_OI_PROFILE, profileScore };
    expect(on.profile?.direction).toBe('long');
    expect(on.profileScore?.score).toBe(0.9);
  });

  it('ModelAggregate exposes an optional profile Stats', () => {
    const agg: Pick<ModelAggregate, 'profile'> = { profile: { mean: 0.9, median: 0.9, std: 0, min: 0.9, max: 0.9 } };
    expect(agg.profile?.mean).toBe(0.9);
  });
});
```

### Step 2.2 — Run, expect FAIL (via typecheck)

```
pnpm typecheck
```
Expected: TS errors — `Object literal may only specify known properties, and 'profile' does not exist
in type 'CandidateResult'` (and the `profileScore` / `ModelAggregate.profile` / `'../strategy-analyst/types.ts'`
references). NOTE: `pnpm vitest run src/experiments/strategy-critic/types.test.ts` would *pass* here
because types are stripped at runtime — typecheck is the RED gate for this type-only task.

### Step 2.3 — Minimal implementation

**`src/experiments/strategy-critic/types.ts`** — add the two cross-experiment type imports at the top
(after the existing imports):

```ts
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { ScoreResult as AnalystScoreResult } from '../strategy-analyst/types.ts';
```

Extend `CandidateResult` (add the two fields after `judge`):

```ts
export interface CandidateResult {
  label: string;
  mode: 'single' | 'two_stage';
  criticModel: string;
  refinerModel: string | null; // null for single
  caseId: string;
  latencyMs: number;
  verdict: 'PASS' | 'FAIL';
  score: ScoreResult | null;            // null only when refine() threw
  rawOutput: StrategyRefinement | null; // present only when refine() returned
  error: CandidateError | null;
  judge: JudgeVerdict | null;           // populated only when --judge ran
  profile: AnalystProfileOutput | null;   // round-trip analyst profile; null when off or on analyst failure
  profileScore: AnalystScoreResult | null; // deterministic scoreProfile() result; null when off or on analyst failure
}
```

Extend `ModelAggregate` (add after `judge`):

```ts
export interface ModelAggregate {
  label: string;
  mode: 'single' | 'two_stage';
  criticModel: string;
  refinerModel: string | null;
  runs: { total: number; ok: number; failed: number; failedByType: Record<string, number> };
  passRate: number;
  det: Stats | null;
  judge: Stats | null;
  profile?: Stats; // mean/std of profileScore.score across ok round-trip runs; absent when round-trip off
  latency: { mean: number; median: number };
}
```

**`src/experiments/strategy-critic/eval-harness.ts`** — add the analyst-port type import at the top:

```ts
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
```

Extend `RunEvalInput` and `RunEvalDeps`:

```ts
export interface RunEvalInput {
  candidates: Candidate[];
  cases: CriticEvalCase[];
  threshold: number;
  repeat?: number; // independent runs per (candidate, case); default 1, assumed >= 1
  roundTrip: boolean;   // when true, feed improvedStrategyText to the analyst
  analystModel: string; // analyst model id used when roundTrip (e.g. 'openrouter/x-ai/grok-4.3')
}

export interface RunEvalDeps {
  criticFor: (candidate: Candidate) => StrategyCriticPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  judge?: (refinement: StrategyRefinement, evalCase: CriticEvalCase) => Promise<JudgeVerdict>;
  analystFor?: (modelId: string) => StrategyAnalystPort; // only used when roundTrip
}
```

In `runOnce`, add `profile: null, profileScore: null` to BOTH return literals (the success return and
the `catch` return) so the harness keeps compiling — round-trip logic lands in Task 4:

```ts
    return { label: candidate.label, mode: candidate.mode, criticModel, refinerModel, caseId: evalCase.id, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null, judge, profile: null, profileScore: null };
```
```ts
    return { label: candidate.label, mode: candidate.mode, criticModel, refinerModel, caseId: evalCase.id, latencyMs, verdict: 'FAIL', score: null, rawOutput: null, error: classifyError(err), judge: null, profile: null, profileScore: null };
```

**Housekeeping so existing tests still compile:**

`src/experiments/strategy-critic/eval-harness.test.ts` — the two `RunEvalInput` literals now need the
required fields. Change:

```ts
const baseInput: RunEvalInput = { candidates: [CAND], cases: [CASE], threshold: 0.6, roundTrip: false, analystModel: 'fake' };
```
and the inline input in the "iterates candidates × cases × repeat" test:

```ts
      { candidates: [CAND], cases: [resolveCase('pump-short'), resolveCase('dump-long')], threshold: 0.6, repeat: 2, roundTrip: false, analystModel: 'fake' },
```

`src/experiments/strategy-critic/aggregate.test.ts` — the `run()` helper now needs the two new
`CandidateResult` fields. Change its return literal to include them:

```ts
function run(over: Partial<CandidateResult>): CandidateResult {
  return { label: 'l', mode: 'single', criticModel: 'm', refinerModel: null, caseId: 'pump-short', latencyMs: 100, verdict: 'PASS', score: score(0.8), rawOutput: null, error: null, judge: null, profile: null, profileScore: null, ...over };
}
```

### Step 2.4 — Run, expect PASS

```
pnpm typecheck
pnpm vitest run src/experiments/strategy-critic/types.test.ts src/experiments/strategy-critic/eval-harness.test.ts src/experiments/strategy-critic/aggregate.test.ts
```
Expected: `pnpm typecheck` clean; all three test files PASS.

### Step 2.5 — Commit

```
git add src/experiments/strategy-critic/types.ts src/experiments/strategy-critic/eval-harness.ts src/experiments/strategy-critic/types.test.ts src/experiments/strategy-critic/eval-harness.test.ts src/experiments/strategy-critic/aggregate.test.ts
git commit -m "feat(critic-eval): round-trip data on CandidateResult/RunEvalInput/RunEvalDeps + ModelAggregate.profile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Judge sees the profile

`src/experiments/strategy-critic/judge.ts`: `JudgeInput` gains `profile?: AnalystProfileOutput`;
`buildJudgePrompt` appends a `--- RESULTING ANALYST PROFILE (JSON) ---` block ONLY when `profile`
is present. `src/mastra/agents/strategy-critic-judge.agent.ts`: add the profile-completeness rubric.

### Step 3.1 — Failing test (extend two existing tests)

Append to `src/experiments/strategy-critic/judge.test.ts`:

```ts
import { GOOD_LONG_OI_PROFILE } from '../strategy-analyst/__fixtures__/profiles.ts';

describe('buildJudgePrompt — resulting profile block', () => {
  it('appends the profile block when a profile is present', () => {
    const prompt = buildJudgePrompt({ originalText: 'orig', refinement: GOOD_PUMP_SHORT_REFINEMENT, profile: GOOD_LONG_OI_PROFILE });
    expect(prompt).toContain('--- RESULTING ANALYST PROFILE (JSON) ---');
    expect(prompt).toContain(JSON.stringify(GOOD_LONG_OI_PROFILE, null, 2));
    expect(prompt).toContain('Return the structured judge verdict.');
  });

  it('omits the profile block when no profile is provided', () => {
    const prompt = buildJudgePrompt({ originalText: 'orig', refinement: GOOD_PUMP_SHORT_REFINEMENT });
    expect(prompt).not.toContain('RESULTING ANALYST PROFILE');
  });
});
```

Append to `src/mastra/agents/strategy-critic-judge.agent.test.ts`:

```ts
import { STRATEGY_CRITIC_JUDGE_INSTRUCTIONS } from './strategy-critic-judge.agent.ts';

describe('strategy-critic-judge instructions — profile completeness rubric', () => {
  it('instructs the judge to penalize empty exits when a profile is provided', () => {
    expect(STRATEGY_CRITIC_JUDGE_INSTRUCTIONS).toContain('penalize empty exits');
  });
});
```

### Step 3.2 — Run, expect FAIL

```
pnpm vitest run src/experiments/strategy-critic/judge.test.ts src/mastra/agents/strategy-critic-judge.agent.test.ts
```
Expected (assertion failures): `buildJudgePrompt` ignores the unknown `profile` field so the block is
absent → `toContain('--- RESULTING ANALYST PROFILE (JSON) ---')` FAILS; and
`STRATEGY_CRITIC_JUDGE_INSTRUCTIONS` lacks `'penalize empty exits'` → that test FAILS. (The "omits"
test already passes.)

### Step 3.3 — Minimal implementation

Rewrite `src/experiments/strategy-critic/judge.ts`:

```ts
// src/experiments/strategy-critic/judge.ts
import type { Agent } from '@mastra/core/agent';
import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';

export interface JudgeInput {
  originalText: string;
  refinement: StrategyRefinement;
  profile?: AnalystProfileOutput;
}

export function buildJudgePrompt(input: JudgeInput): string {
  const lines = [
    '--- ORIGINAL STRATEGY TEXT START ---',
    input.originalText,
    '--- ORIGINAL STRATEGY TEXT END ---',
    '',
    '--- CANDIDATE REFINEMENT (JSON) START ---',
    JSON.stringify(input.refinement, null, 2),
    '--- CANDIDATE REFINEMENT END ---',
    '',
  ];
  if (input.profile) {
    lines.push(
      '--- RESULTING ANALYST PROFILE (JSON) ---',
      JSON.stringify(input.profile, null, 2),
      '--- RESULTING ANALYST PROFILE END ---',
      '',
    );
  }
  lines.push('Return the structured judge verdict.');
  return lines.join('\n');
}

export async function runJudge(agent: Agent, input: JudgeInput): Promise<JudgeVerdict> {
  const result = await agent.generate(buildJudgePrompt(input), { structuredOutput: { schema: JudgeVerdictSchema } });
  return JudgeVerdictSchema.parse(result.object);
}
```

Edit `src/mastra/agents/strategy-critic-judge.agent.ts` — add ONE element to the instructions array
(before the closing `'Be strict and concise...'` line):

```ts
export const STRATEGY_CRITIC_JUDGE_INSTRUCTIONS = [
  'You are evaluating a candidate strategy REFINEMENT produced by another model, given the original vague strategy text.',
  'Score each rubric dimension from 0 to 1 with a short rationale:',
  'did it strengthen the REAL weaknesses of the idea;',
  'did it add the missing nuances grounded in AVAILABLE data (OHLCV; open interest + trend; long/short liquidations; funding rate; taker buy/sell -> delta/CVD);',
  'did it AVOID inventing facts or unavailable data sources;',
  'is the strategy still analyzable and buildable with NO runner overreach (no leverage / base-order sizing / equity %).',
  'If a resulting analyst profile is provided, also assess how completely it captures the strategy — entry conditions, exit & invalidation, required data signals — and penalize empty exits or many unknowns.',
  'List any invented or unavailable-data claims (`hallucinations`) and any weaknesses it failed to address (`missing`).',
  'Be strict and concise. Do not rewrite the strategy; only assess.',
].join(' ');
```

### Step 3.4 — Run, expect PASS

```
pnpm vitest run src/experiments/strategy-critic/judge.test.ts src/mastra/agents/strategy-critic-judge.agent.test.ts
```
Expected: all tests PASS.

### Step 3.5 — Commit

```
git add src/experiments/strategy-critic/judge.ts src/experiments/strategy-critic/judge.test.ts src/mastra/agents/strategy-critic-judge.agent.ts src/mastra/agents/strategy-critic-judge.agent.test.ts
git commit -m "feat(critic-eval): judge prompt + agent rubric factor in the resulting analyst profile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — eval-harness round-trip stage

`runOnce`: when `input.roundTrip`, after `refine()` call the injected analyst, score the profile with
the reused `scoreProfile`, pass the profile to the judge, and populate `CandidateResult.profile` /
`profileScore`. Fail-soft on analyst throw. Round-trip off → no analyst call.

### Step 4.1 — Failing test (extend the existing harness test)

Append to `src/experiments/strategy-critic/eval-harness.test.ts` (top-level imports first):

```ts
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import { GOOD_LONG_OI_PROFILE } from '../strategy-analyst/__fixtures__/profiles.ts';
```

then the new suite:

```ts
function fakeAnalyst(profile: AnalystProfileOutput, onCall?: (i: StrategyAnalystInput) => void): StrategyAnalystPort {
  return { adapter: 'fake', model: 'fake', async analyze(i: StrategyAnalystInput): Promise<AnalystProfileOutput> { onCall?.(i); return profile; } };
}
function throwingAnalyst(message: string): StrategyAnalystPort {
  return { adapter: 'fake', model: 'fake', async analyze(): Promise<AnalystProfileOutput> { throw new Error(message); } };
}

describe('runOnce — round-trip stage', () => {
  const rtInput: RunEvalInput = { candidates: [CAND], cases: [CASE], threshold: 0.6, roundTrip: true, analystModel: 'fake/analyst' };

  it('populates profile + profileScore and hands the profile to the judge', async () => {
    let analystInput: StrategyAnalystInput | undefined;
    let judgeProfile: AnalystProfileOutput | undefined;
    const d: RunEvalDeps = {
      criticFor: () => fakeCritic(GOOD_PUMP_SHORT_REFINEMENT),
      providerOf: (m) => ({ provider: 'fake', modelId: m }),
      clock: (() => { let t = 0; return () => (t += 100); })(),
      analystFor: () => fakeAnalyst(GOOD_LONG_OI_PROFILE, (i) => { analystInput = i; }),
      judge: async (_r, _c, p) => { judgeProfile = p; return { dimensions: [], overallScore: 0.9, hallucinations: [], missing: [], notes: 'ok' }; },
    };
    const r = await runOnce(CAND, CASE, rtInput, d);
    expect(analystInput).toEqual({ kind: 'manual_description', content: GOOD_PUMP_SHORT_REFINEMENT.improvedStrategyText });
    expect(r.profile).toEqual(GOOD_LONG_OI_PROFILE);
    expect(r.profileScore).not.toBeNull();
    expect(typeof r.profileScore!.score).toBe('number');
    expect(judgeProfile).toEqual(GOOD_LONG_OI_PROFILE);
    expect(r.verdict).toBe('PASS'); // critique verdict, unaffected
  });

  it('is fail-soft when the analyst throws: profile/profileScore null, critique verdict intact, judge still runs', async () => {
    let judgeProfile: AnalystProfileOutput | undefined = GOOD_LONG_OI_PROFILE;
    let judged = false;
    const d: RunEvalDeps = {
      criticFor: () => fakeCritic(GOOD_PUMP_SHORT_REFINEMENT),
      providerOf: (m) => ({ provider: 'fake', modelId: m }),
      clock: (() => { let t = 0; return () => (t += 100); })(),
      analystFor: () => throwingAnalyst('analyst boom'),
      judge: async (_r, _c, p) => { judged = true; judgeProfile = p; return { dimensions: [], overallScore: 0.9, hallucinations: [], missing: [], notes: 'ok' }; },
    };
    const r = await runOnce(CAND, CASE, rtInput, d);
    expect(r.profile).toBeNull();
    expect(r.profileScore).toBeNull();
    expect(r.verdict).toBe('PASS');
    expect(r.error).toBeNull(); // analyst failure is NOT a candidate error
    expect(judged).toBe(true);
    expect(judgeProfile).toBeUndefined(); // judge ran without a profile
  });

  it('does not call the analyst when round-trip is off', async () => {
    let called = false;
    const d: RunEvalDeps = {
      criticFor: () => fakeCritic(GOOD_PUMP_SHORT_REFINEMENT),
      providerOf: (m) => ({ provider: 'fake', modelId: m }),
      clock: (() => { let t = 0; return () => (t += 100); })(),
      analystFor: () => fakeAnalyst(GOOD_LONG_OI_PROFILE, () => { called = true; }),
    };
    const r = await runOnce(CAND, CASE, baseInput, d); // baseInput has roundTrip:false
    expect(called).toBe(false);
    expect(r.profile).toBeNull();
    expect(r.profileScore).toBeNull();
  });
});
```

### Step 4.2 — Run, expect FAIL

```
pnpm vitest run src/experiments/strategy-critic/eval-harness.test.ts
```
Expected (assertion failures): `runOnce` does not yet call the analyst → `analystInput` is `undefined`
and `r.profile` is `null` in the first test → `expect(r.profile).toEqual(GOOD_LONG_OI_PROFILE)` FAILS.
(Also the judge's 3rd arg is never supplied.)

### Step 4.3 — Minimal implementation

Edit `src/experiments/strategy-critic/eval-harness.ts`. Add imports at top:

```ts
import { scoreProfile } from '../strategy-analyst/scoring.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { ScoreResult as AnalystScoreResult } from '../strategy-analyst/types.ts';
```

Extend `RunEvalDeps.judge` to accept the optional profile (replace the `judge?` line):

```ts
  judge?: (refinement: StrategyRefinement, evalCase: CriticEvalCase, profile?: AnalystProfileOutput) => Promise<JudgeVerdict>;
```

Replace the body of `runOnce`'s success path (between `const score = scoreRefinement(...)` and the
success `return`) with the round-trip + judge wiring:

```ts
    const score = scoreRefinement(raw, evalCase, { threshold: input.threshold });

    let profile: AnalystProfileOutput | null = null;
    let profileScore: AnalystScoreResult | null = null;
    if (input.roundTrip && deps.analystFor) {
      try {
        const analyst = deps.analystFor(input.analystModel);
        profile = await analyst.analyze({ kind: 'manual_description', content: raw.improvedStrategyText });
        profileScore = scoreProfile(profile, { threshold: input.threshold });
      } catch (analystErr) {
        // Fail-soft: the analyst is downstream of the critique; its failure must NOT fail the candidate.
        process.stderr.write(`analyst failed for ${candidate.label}/${evalCase.id}: ${analystErr instanceof Error ? analystErr.message : String(analystErr)}\n`);
        profile = null;
        profileScore = null;
      }
    }

    let judge: JudgeVerdict | null = null;
    if (deps.judge) {
      try {
        judge = await deps.judge(raw, evalCase, profile ?? undefined);
      } catch (judgeErr) {
        // Judge is best-effort and NEVER affects the deterministic verdict.
        process.stderr.write(`judge failed for ${candidate.label}/${evalCase.id}: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}\n`);
        judge = null;
      }
    }

    return { label: candidate.label, mode: candidate.mode, criticModel, refinerModel, caseId: evalCase.id, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null, judge, profile, profileScore };
```

(The `catch (err)` return from Task 2 already carries `profile: null, profileScore: null` — leave it.)

### Step 4.4 — Run, expect PASS

```
pnpm vitest run src/experiments/strategy-critic/eval-harness.test.ts
```
Expected: all harness tests PASS (the original judge/critic/error tests still green; the three
round-trip tests now pass).

### Step 4.5 — Commit

```
git add src/experiments/strategy-critic/eval-harness.ts src/experiments/strategy-critic/eval-harness.test.ts
git commit -m "feat(critic-eval): runOnce round-trip stage (analyst -> profile -> scoreProfile -> judge), fail-soft

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Aggregate profile stats + ranking tiebreak

`aggregateRuns` computes a `profile: Stats` from `profileScore.score` across ok runs (only when
present). `rankAggregates` adds `profileMean` as a tiebreak (judge-mean → profileMean → passRate →
det-mean), applied only when any aggregate has profile data.

### Step 5.1 — Failing test (extend the existing aggregate test)

Append to `src/experiments/strategy-critic/aggregate.test.ts` (add the analyst `ScoreResult` import):

```ts
import type { ScoreResult as AnalystScoreResult } from '../strategy-analyst/types.ts';

function pscore(s: number): AnalystScoreResult {
  return { gates: { schemaValid: true, directionLong: true }, checks: [], score: s, threshold: 0.8, verdict: s >= 0.8 ? 'PASS' : 'FAIL' };
}

describe('aggregateRuns — profile stats', () => {
  it('computes profile Stats over runs that have a profileScore', () => {
    const agg = aggregateRuns([
      run({ profileScore: pscore(0.6) }),
      run({ profileScore: pscore(0.8) }),
      run({ profileScore: null }), // no profile -> excluded
    ]);
    expect(agg.profile).toBeDefined();
    expect(agg.profile!.mean).toBeCloseTo(0.7, 10);
    expect(agg.profile!.min).toBe(0.6);
    expect(agg.profile!.max).toBe(0.8);
  });

  it('leaves profile undefined when no run has a profileScore', () => {
    const agg = aggregateRuns([run({}), run({})]);
    expect(agg.profile).toBeUndefined();
  });
});

describe('rankAggregates — profileMean tiebreak', () => {
  it('breaks ties on profileMean when round-trip data is present', () => {
    const base = { mode: 'single' as const, criticModel: 'm', refinerModel: null, runs: { total: 1, ok: 1, failed: 0, failedByType: {} }, passRate: 1, det: { mean: 0.8, median: 0.8, std: 0, min: 0.8, max: 0.8 }, judge: null, latency: { mean: 100, median: 100 } };
    const lo: ModelAggregate = { ...base, label: 'single:lo', profile: { mean: 0.5, median: 0.5, std: 0, min: 0.5, max: 0.5 } };
    const hi: ModelAggregate = { ...base, label: 'single:hi', profile: { mean: 0.9, median: 0.9, std: 0, min: 0.9, max: 0.9 } };
    const ranked = rankAggregates([lo, hi], false);
    expect(ranked.map((a) => a.label)).toEqual(['single:hi', 'single:lo']);
  });
});
```

### Step 5.2 — Run, expect FAIL

```
pnpm vitest run src/experiments/strategy-critic/aggregate.test.ts
```
Expected (assertion failures): `aggregateRuns` does not emit `profile` → `expect(agg.profile).toBeDefined()`
FAILS; `rankAggregates` ignores profile means → with equal judge/passRate/det the order is unchanged
(input order `['single:lo','single:hi']`) → `toEqual(['single:hi','single:lo'])` FAILS.

### Step 5.3 — Minimal implementation

Edit `src/experiments/strategy-critic/aggregate.ts`.

In `aggregateRuns`, after the `judgeScores` line add the profile-score collection, and add the
`profile` field to the returned object:

```ts
  const detScores = runs.filter((r) => r.score != null).map((r) => r.score!.score);
  const judgeScores = runs.filter((r) => r.judge != null).map((r) => r.judge!.overallScore);
  const profileScores = runs.filter((r) => r.profileScore != null).map((r) => r.profileScore!.score);
  const latencies = runs.map((r) => r.latencyMs);
  const passCount = runs.filter((r) => r.verdict === 'PASS').length;

  return {
    label: first.label,
    mode: first.mode,
    criticModel: first.criticModel,
    refinerModel: first.refinerModel,
    runs: { total, ok: total - failed.length, failed: failed.length, failedByType },
    passRate: passCount / total,
    det: detScores.length > 0 ? stats(detScores) : null,
    judge: judgeScores.length > 0 ? stats(judgeScores) : null,
    profile: profileScores.length > 0 ? stats(profileScores) : undefined,
    latency: { mean: mean(latencies), median: median(latencies) },
  };
```

Replace `rankAggregates`:

```ts
/**
 * Rank candidates: judge-mean desc (only when judge ran) -> profileMean desc (only when round-trip
 * data present) -> PASS-rate desc -> det-mean desc. Candidates without a given mean sort last on
 * that key. Pure; returns a new array.
 */
export function rankAggregates(aggs: ModelAggregate[], judgeEnabled: boolean): ModelAggregate[] {
  const hasProfile = aggs.some((a) => a.profile != null);
  const j = (a: ModelAggregate): number => a.judge?.mean ?? -1;
  const p = (a: ModelAggregate): number => a.profile?.mean ?? -1;
  const d = (a: ModelAggregate): number => a.det?.mean ?? -1;
  return [...aggs].sort((a, b) => {
    if (judgeEnabled) {
      const dj = j(b) - j(a);
      if (dj !== 0) return dj;
    }
    if (hasProfile) {
      const dpf = p(b) - p(a);
      if (dpf !== 0) return dpf;
    }
    const dp = b.passRate - a.passRate;
    if (dp !== 0) return dp;
    return d(b) - d(a);
  });
}
```

### Step 5.4 — Run, expect PASS

```
pnpm vitest run src/experiments/strategy-critic/aggregate.test.ts
```
Expected: all aggregate tests PASS (the original judge-mean ranking test still green — no profile data,
`hasProfile` false, behaviour unchanged).

### Step 5.5 — Commit

```
git add src/experiments/strategy-critic/aggregate.ts src/experiments/strategy-critic/aggregate.test.ts
git commit -m "feat(critic-eval): aggregate profile Stats + profileMean ranking tiebreak

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — real-factory wiring + CLI flags + dry-run accounting

Reuse `buildRealAnalystFor` (dynamic import under `--run` only) for `analystFor`; forward the profile
from `buildRealJudge`; add `--round-trip` / `--analyst-model` to the CLI; account for analyst calls in
the dry-run plan and surface the analyst provider key in `missingKeys`; render a `profileMean` column.

### Step 6.1 — Failing test (extend the existing dry-run test)

Append to `src/experiments/strategy-critic/plan.test.ts`:

```ts
describe('planDryRun — round-trip', () => {
  it('counts analyst calls and reports the analyst provider key as missing, constructing nothing', () => {
    const candidates = buildCandidates({ mode: 'single', models: ['openai/gpt-x'] });
    const plan = planDryRun({
      candidates,
      cases: ['pump-short', 'dump-long'],
      judge: false,
      env: { OPENAI_API_KEY: 'present' }, // no OPENROUTER key present
      repeat: 2,
      roundTrip: true,
      analystModel: 'openrouter/x-ai/grok-4.3',
    });
    // 1 candidate × 2 cases × 2 repeat = 4 analyst calls
    expect(plan.analystCalls).toBe(4);
    expect(plan.missingKeys).toContain('OPENROUTER_API_KEY');
    expect(plan.missingKeys).not.toContain('OPENAI_API_KEY'); // present
  });

  it('reports zero analyst calls when round-trip is off', () => {
    const candidates = buildCandidates({ mode: 'single', models: ['anthropic/claude-x'] });
    const plan = planDryRun({ candidates, cases: ['pump-short'], judge: false, env: { ANTHROPIC_API_KEY: 'present' }, repeat: 1 });
    expect(plan.analystCalls).toBe(0);
  });
});
```

### Step 6.2 — Run, expect FAIL

```
pnpm vitest run src/experiments/strategy-critic/plan.test.ts
```
Expected (assertion/runtime failure): `planDryRun` returns no `analystCalls` field → `plan.analystCalls`
is `undefined` → `expect(plan.analystCalls).toBe(4)` FAILS; and the analyst key is not added to
`missingKeys` → `toContain('OPENROUTER_API_KEY')` FAILS.

### Step 6.3 — Minimal implementation

**`src/experiments/strategy-critic/plan.ts`** — extend `DryRunPlan` and `PlanInput`, and compute
`analystCalls` + the analyst key:

```ts
export interface DryRunPlan {
  repeat: number;
  caseCount: number;
  perCandidate: DryRunCandidatePlan[];
  refineCalls: number;
  judgeCalls: number;
  analystCalls: number; // candidates × cases × repeat when roundTrip, else 0
  totalPaidCalls: number;
  missingKeys: string[];
}

export interface PlanInput {
  candidates: Candidate[];
  cases: string[]; // case ids
  judge: boolean;
  judgeModel?: string;
  env: Record<string, string | undefined>;
  repeat?: number;
  roundTrip?: boolean;
  analystModel?: string;
}
```

Inside `planDryRun`, after computing `judgeCalls`, add analyst accounting and fold the analyst model
into the missing-key sweep:

```ts
  const refineCalls = perCandidate.reduce((s, p) => s + p.callsPerRun, 0) * caseCount * repeat;
  const judgeCalls = (input.judge ? input.candidates.length : 0) * caseCount * repeat;
  const analystCalls = input.roundTrip ? input.candidates.length * caseCount * repeat : 0;

  const allModels = new Set<string>();
  for (const p of perCandidate) for (const m of p.models) allModels.add(m);
  if (input.judge && input.judgeModel) allModels.add(input.judgeModel);
  if (input.roundTrip && input.analystModel) allModels.add(input.analystModel);

  const missing = new Set<string>();
  for (const m of allModels) {
    const { provider } = parseRoleModel(modelEnv, m);
    if (!isProvider(provider)) continue;
    const key = KEY_BY_PROVIDER[provider];
    if (!input.env[key]) missing.add(key);
  }

  return { repeat, caseCount, perCandidate, refineCalls, judgeCalls, analystCalls, totalPaidCalls: refineCalls + judgeCalls + analystCalls, missingKeys: [...missing] };
```

**`src/experiments/strategy-critic/real-critic-factory.ts`** — forward the profile through the judge
closure (replace the `buildRealJudge` return). Add the analyst-profile type import at the top:

```ts
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
```

and update the returned closure signature + call:

```ts
export function buildRealJudge(
  baseEnv: ModelProviderEnv,
  judgeModelId: string,
): (refinement: StrategyRefinement, evalCase: CriticEvalCase, profile?: AnalystProfileOutput) => Promise<JudgeVerdict> {
  const resolved = resolveLanguageModel(baseEnv, judgeModelId);
  const agent = createStrategyCriticJudgeAgent(resolved.model);
  return (refinement: StrategyRefinement, evalCase: CriticEvalCase, profile?: AnalystProfileOutput) =>
    runJudge(agent, { originalText: evalCase.text, refinement, profile });
}
```

**`scripts/strategy-critic-eval.ts`** — add the two flags to `parseArgs`:

```ts
      repeat: { type: 'string', default: '1' },
      'round-trip': { type: 'boolean', default: false },
      'analyst-model': { type: 'string', default: 'openrouter/x-ai/grok-4.3' },
```

and thread them through `parseCli`'s return:

```ts
  return { candidates, cases, run: values.run!, threshold, judge: values.judge!, judgeModel: values['judge-model'], repeat, roundTrip: values['round-trip']!, analystModel: values['analyst-model']! };
```

In the DRY RUN branch, pass `roundTrip` / `analystModel` to `planDryRun` and surface the new fields:

```ts
  if (!args.run) {
    const plan = planDryRun({ candidates: args.candidates, cases: args.cases, judge: args.judge, judgeModel: args.judgeModel, env: process.env, repeat: args.repeat, roundTrip: args.roundTrip, analystModel: args.analystModel });
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run', threshold: args.threshold, judge: args.judge, repeat: args.repeat, cases: args.cases,
      roundTrip: args.roundTrip, analystModel: args.analystModel,
      plannedPaidCalls: plan.totalPaidCalls, refineCalls: plan.refineCalls, judgeCalls: plan.judgeCalls, analystCalls: plan.analystCalls,
      candidates: plan.perCandidate, missingKeys: plan.missingKeys,
      note: 'DRY RUN — no real models constructed, nothing sent. Re-run with --run to make paid calls.',
    }, null, 2)}\n`);
    return 0;
  }
```

In the REAL RUN branch, dynamically import `buildRealAnalystFor` only when round-trip is on (paid-gate
intact), pass `roundTrip` / `analystModel` into the `runEval` input, and wire `analystFor`:

```ts
  const env = modelEnv();
  const { buildRealCriticFor, buildRealJudge } = await import('../src/experiments/strategy-critic/real-critic-factory.ts');

  let judge: Awaited<ReturnType<typeof buildRealJudge>> | undefined;
  if (args.judge && args.judgeModel) judge = buildRealJudge(env, args.judgeModel);

  let analystFor: ((modelId: string) => import('../src/ports/strategy-analyst.port.ts').StrategyAnalystPort) | undefined;
  if (args.roundTrip) {
    const { buildRealAnalystFor } = await import('../src/experiments/strategy-analyst/real-analyst-factory.ts');
    analystFor = buildRealAnalystFor(env);
  }

  const result = await runEval(
    { candidates: args.candidates, cases: args.cases.map((id) => resolveCase(id)), threshold: args.threshold, repeat: args.repeat, roundTrip: args.roundTrip, analystModel: args.analystModel },
    {
      criticFor: buildRealCriticFor(env),
      providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
      clock: () => Date.now(),
      judge,
      analystFor,
    },
  );
```

Add a `profileMean` column to the ranking render (only meaningful under round-trip; `null` otherwise):

```ts
  const ranking = rankAggregates(result.aggregates, result.judgeEnabled).map((a) => ({
    label: a.label,
    mode: a.mode,
    criticModel: a.criticModel,
    refinerModel: a.refinerModel,
    runs: `${a.runs.ok}/${a.runs.total}`,
    passRate: r3(a.passRate),
    detMean: a.det ? r3(a.det.mean) : null,
    detStd: a.det ? r3(a.det.std) : null,
    judgeMean: a.judge ? r3(a.judge.mean) : null,
    judgeStd: a.judge ? r3(a.judge.std) : null,
    profileMean: a.profile ? r3(a.profile.mean) : null,
    latencyMeanMs: Math.round(a.latency.mean),
  }));
```

(`CandidateResult.profile` / `profileScore` are already serialised by `writeRunArtifacts` since they
are plain `CandidateResult` fields — no artifacts change needed. Optionally add `profileMean` to the
manifest aggregate line for parity.) In `src/experiments/strategy-critic/artifacts.ts`, extend the
manifest `perCandidate` aggregate to include it:

```ts
      aggregate: { passRate: a.passRate, detMean: a.det?.mean ?? null, judgeMean: a.judge?.mean ?? null, profileMean: a.profile?.mean ?? null },
```

### Step 6.4 — Run, expect PASS

```
pnpm vitest run src/experiments/strategy-critic/plan.test.ts
pnpm typecheck
```
Expected: plan tests PASS; typecheck clean (CLI + real-factory wiring type-checks; the
`buildRealAnalystFor` / `buildRealJudge` real-run paths are exercised by typecheck — they mirror the
existing untested `real-*-factory.ts` pattern and are paid-gated behind `--run`).

### Step 6.5 — Commit

```
git add src/experiments/strategy-critic/plan.ts src/experiments/strategy-critic/plan.test.ts src/experiments/strategy-critic/real-critic-factory.ts src/experiments/strategy-critic/artifacts.ts scripts/strategy-critic-eval.ts
git commit -m "feat(critic-eval): --round-trip / --analyst-model CLI wiring + dry-run analyst accounting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final gate

```
pnpm typecheck
pnpm test
```
Expected: typecheck clean; full suite green (including the strip-types and mastra-import-boundary
guards). A paid measured run (`--run --round-trip --analyst-model openrouter/x-ai/grok-4.3 --mode single`)
and the resulting default-config decision are out of scope (manual, after merge).

---

## Self-Review (writing-plans)

**Spec coverage** — every spec section maps to a task:
- §1 Flags + CLI → Task 6 (parseCli `--round-trip` / `--analyst-model`, dry-run output).
- §2 runOnce round-trip stage + fail-soft + `analystFor` injection → Task 4 (+ types in Task 2).
- §3 Judge sees the profile (`buildJudgePrompt` block + judge-agent rubric) → Task 3.
- §4 Aggregation / ranking (`profile?: Stats`, `profileMean` tiebreak, render column) → Task 5 (Stats
  + ranking) and Task 6 (render column / manifest).
- §5 Analyst wiring (`buildRealAnalystFor` reuse, `planDryRun` analystCalls + missingKeys) → Task 6.
- §6 Combined-agent prompt structure → Task 1.
- Testing bullets → covered by Tasks 1–6 tests; `scoreProfile` reuse is exercised inside Task 4's
  round-trip test (profileScore populated by the real `scoreProfile`). Gate → Final gate.
- Out-of-scope items (paid run, `two_stage` removal, backtest variant, auto-select) → not implemented.

**Placeholder scan** — no "similar to Task N", no `...`, no TODO; every step carries complete code.

**Type-consistency** (identical names everywhere):
- `roundTrip` — RunEvalInput field, PlanInput field, parseCli return, runOnce read, CLI `values['round-trip']`. ✓
- `analystModel` — RunEvalInput field, PlanInput field, parseCli return, runOnce read (`input.analystModel`), CLI `values['analyst-model']`. ✓
- `analystFor` — RunEvalDeps field, runOnce read (`deps.analystFor`), CLI wiring. ✓
- `profile` — CandidateResult field, ModelAggregate optional field, JudgeInput field, aggregateRuns/rank reads, render. ✓
- `profileScore` — CandidateResult field, runOnce local + return, aggregateRuns read. ✓
- `scoreProfile` — imported from `../strategy-analyst/scoring.ts` (value import), called once in runOnce. ✓
- `buildRealAnalystFor` — imported from `../src/experiments/strategy-analyst/real-analyst-factory.ts` under `--run`. ✓
- Analyst `ScoreResult` alias — imported as **`AnalystScoreResult`** from `../strategy-analyst/types.ts`
  consistently in `types.ts`, `eval-harness.ts`, `aggregate.test.ts`, and `types.test.ts` (the critic
  package's own `ScoreResult` is a different shape, so the alias is mandatory and never bare-imported). ✓
