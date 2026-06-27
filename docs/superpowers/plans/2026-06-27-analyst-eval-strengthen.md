# Strengthen Analyst Eval Implementation Plan

REQUIRED SUB-SKILL: `superpowers:test-driven-development` — every task is RED → GREEN → commit. A
test-only / type-only step's RED is observed via `pnpm typecheck`; a behavioral step's RED is observed
via `pnpm vitest run` (which strips types, so RED is an unresolved-import / runtime / assertion failure,
NEVER a "type error").

**Spec (source of truth):** `docs/superpowers/specs/2026-06-27-analyst-eval-strengthen-design.md`
**Branch:** `feat/analyst-eval-strengthen` (from `main`)

## Goal

Replace the single bespoke long-oi `scoreProfile` as the cross-fixture deterministic signal with a
generic, direction-aware **`scoreCompleteness`** scorer; add a detailed **`short-pump`** fixture
(source + research-notes + rubric) so the analyst-model decision run can cover both directions; rewire
both eval harnesses (`analyst:eval` and the critic round-trip) to the generic scorer. `scoreProfile`
and all its tests are RETAINED — it becomes a long-oi-only secondary diagnostic. This is an
eval-experiment-only change: no production onboarding / analyst behavior changes.

## Architecture

- `src/experiments/strategy-analyst/fabrication.ts` (NEW) — shared FAB detection
  (`FAB_PATTERNS`, `FAB_PARAM_NAME`, `detectFabrication`) extracted verbatim from `scoring.ts`.
- `src/experiments/strategy-analyst/completeness.ts` (NEW) — `scoreCompleteness(raw, { expectedDirection, threshold? })`.
- `src/experiments/strategy-analyst/scoring.ts` — keeps `scoreProfile`; its `scoreRiskNoFabrication`
  now delegates to `detectFabrication`. Behavior identical.
- `src/experiments/strategy-analyst/types.ts` — `ScoreResult.gates` widened to carry an optional
  `directionMatches`; `FixtureRef` gains `direction`; `CandidateResult` gains `secondaryScore`.
- `src/experiments/strategy-analyst/fixtures.ts` — `long-oi` tagged `direction:'long'`; new `short-pump`.
- `docs/fixtures/strategies/short-pump-strategy-{source,research-notes,rubric}.md` (NEW).
- `src/experiments/strategy-analyst/eval-harness.ts` + `scripts/strategy-analyst-eval.ts` — primary
  signal becomes `scoreCompleteness` keyed on `fixture.direction`; `scoreProfile` retained as the
  long-oi-only `secondaryScore`.
- `src/experiments/strategy-critic/eval-harness.ts` — round-trip `profileScore` switches from
  `scoreProfile` to `scoreCompleteness` keyed on `evalCase.direction`.

## Tech Stack

- TypeScript run under `node --experimental-strip-types` (no transpile step).
- Vitest for tests; Zod for schema gates (`AnalystProfileOutputSchema`).
- `.ts` import extensions everywhere; ESM.

## Global Constraints

- **No TS parameter-properties.** `node --experimental-strip-types` strips types only; a
  `constructor(private x: T)` compiles under `tsc`/Vitest but throws at runtime. None of these tasks
  add classes, but the guard `src/strip-types-no-param-properties.test.ts` must stay green. Use plain
  fields / module functions.
- **`.ts` import specifiers.** Every relative import keeps the `.ts` extension
  (e.g. `import { detectFabrication } from './fabrication.ts';`).
- **Test gate (every task):** `pnpm typecheck` clean AND `pnpm test` (full suite) green before commit.
- **Eval-experiment only.** No production onboarding / analyst / orchestrator behavior change. All new
  code lives under `src/experiments/strategy-analyst/**` + `src/experiments/strategy-critic/**` +
  `docs/fixtures/strategies/**`. The analyst harness import guard
  (`src/experiments/strategy-analyst/imports.guard.test.ts`) scans every non-test `.ts` in the analyst
  dir for `compose-mastra` and a FORBIDDEN list (`repository|queue|platform|builder|orchestrator|db|drizzle|hypothesis|backtest|mock-platform`).
  `fabrication.ts` and `completeness.ts` import ONLY `../../domain/strategy-profile.ts`, `./types.ts`,
  `./scoring.ts`, `./fabrication.ts` — all allowed. Run this guard in Task 1 and Task 2.
- **FAB extraction is behavior-preserving.** Task 1 moves the FAB regexes + the param-name regex + the
  detection loop; it changes imports and the body of `scoreRiskNoFabrication`, but the function's
  output (id, weight `RISK_WEIGHT=0.15`, `bucketsHit`, `contribution`, and the `matched` label order)
  is byte-identical. `scoring.ts`'s existing `risk_no_fabrication` tests in `scoring.test.ts` MUST stay
  green (re-run them in Task 1). `detectFabrication`'s regexes are non-global (`/i`, not `/g`), so the
  shared module-level constants carry no `lastIndex` state between the two scorers.
- **`scoreProfile` is RETAINED, not deleted.** Its module, its export, and all of `scoring.test.ts`
  remain. It is only re-sourced for its FAB internals (Task 1) and demoted to a secondary diagnostic
  (Task 4).
- **`scripts/` is NOT covered by `pnpm typecheck`** (tsc only checks tsconfig-included `src/`). The
  one-line script edit in Task 4 must be eyeballed; verify it at runtime with the dry-run
  (`npm run analyst:eval -- --fixture short-pump --models a/b`, default dry-run, no paid calls).

### Type-consistency contract (identical spelling everywhere)

- Shared FAB util function name: **`detectFabrication`** (signature `detectFabrication(p: AnalystProfileOutput): string[]`).
- Generic scorer: **`scoreCompleteness(raw: unknown, opts: { expectedDirection: Direction; threshold?: number }): ScoreResult`**,
  where `Direction = (typeof DIRECTIONS)[number]` from `src/domain/strategy-profile.ts`
  (`'long' | 'short' | 'both' | 'unknown'`). NOTE: the spec prose wrote `'spot'`; the real enum has no
  `'spot'` and has `'both'` — use the real `Direction` type. `FixtureRef.direction` (`'long' | 'short'`)
  and `CriticEvalCase.direction` (`'long' | 'short'`) are both assignable to `Direction`.
- Direction gate field name on the completeness `ScoreResult`: **`directionMatches`**.
- Fixture-ref field name: **`FixtureRef.direction`**.
- Unknowns cap constant: **`UNKNOWNS_CAP`** (named export in `completeness.ts`, value `4`).
- Analyst secondary diagnostic field on `CandidateResult`: **`secondaryScore`** (the bespoke long-oi
  `scoreProfile` result; `null` unless `direction === 'long'`).
- The critic round-trip keeps its existing alias `import type { ScoreResult as AnalystScoreResult }`;
  `scoreCompleteness` returns the analyst `ScoreResult`, so `profileScore: AnalystScoreResult | null`
  is unchanged.

---

## Task 1: Shared FAB util (`fabrication.ts`) — behavior-preserving extraction

Extract `FAB_PATTERNS`, `FAB_PARAM_NAME`, and the fabrication-detection loop out of `scoring.ts` into a
new shared module that both `scoreProfile` (now) and `scoreCompleteness` (Task 2) import. Pure refactor.

### Step 1.1 — Write the failing test

- [ ] Create `src/experiments/strategy-analyst/fabrication.test.ts`:

```ts
// src/experiments/strategy-analyst/fabrication.test.ts
import { describe, it, expect } from 'vitest';
import { detectFabrication, FAB_PATTERNS, FAB_PARAM_NAME } from './fabrication.ts';
import {
  GOOD_LONG_OI_PROFILE, FABRICATED_RISK_PROFILE, DCA_HINT_RISK_PROFILE,
} from './__fixtures__/profiles.ts';

describe('detectFabrication', () => {
  it('clean risk summary -> no fabrication labels', () => {
    expect(detectFabrication(GOOD_LONG_OI_PROFILE)).toEqual([]);
  });

  it('fabricated leverage + base size -> labels present, in pattern order', () => {
    const labels = detectFabrication(FABRICATED_RISK_PROFILE);
    expect(labels).toContain('leverage_x');
    expect(labels).toContain('base_size_usd');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('DCA size hints (1.2x/1.5x) are NOT fabrication', () => {
    expect(detectFabrication(DCA_HINT_RISK_PROFILE)).toEqual([]);
  });

  it('a sizing parameter with a value appends param_sizing last', () => {
    const profile = {
      ...GOOD_LONG_OI_PROFILE,
      parameters: [{ name: 'leverage', value: 5, unit: 'x', description: 'lev', tunable: true }],
    };
    const labels = detectFabrication(profile);
    expect(labels[labels.length - 1]).toBe('param_sizing');
  });

  it('exposes the raw FAB constants for reuse', () => {
    expect(FAB_PATTERNS.length).toBeGreaterThan(0);
    expect(FAB_PARAM_NAME.test('leverage')).toBe(true);
  });
});
```

### Step 1.2 — Run, expect RED

- [ ] `pnpm vitest run src/experiments/strategy-analyst/fabrication.test.ts`
- [ ] Expected RED: `Failed to resolve import "./fabrication.ts"` (module does not exist yet).

### Step 1.3 — Minimal implementation

- [ ] Create `src/experiments/strategy-analyst/fabrication.ts`:

```ts
// src/experiments/strategy-analyst/fabrication.ts
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';

// Fabrication patterns for the negative check. Leverage requires >=2x OR the explicit word,
// so DCA size hints (1.2x/1.5x) are NOT flagged.
export const FAB_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'leverage_x', re: /(?<![.\d])\b(?:[2-9]|\d{2,})(?:\.\d+)?\s*[x×]\b/i },
  { label: 'leverage_word', re: /leverage\s*[:=]?\s*\d/i },
  { label: 'leverage_ru', re: /плеч\w*\s*[:=]?\s*\d/i },
  { label: 'base_size_usd', re: /\$\s*\d|\b\d+\s*(?:usd|usdt|dollars?)\b|base[ _]?order\s*[:=]?\s*\d/i },
  { label: 'equity_fraction', re: /\b\d+(?:\.\d+)?\s*%\s*(?:of\s+)?(?:equity|account|balance|capital|portfolio|deposit|депозит)/i },
];

export const FAB_PARAM_NAME = /leverage|плеч|margin|марж|base.?order|position.?siz|order.?siz|notional/i;

/** Pure: returns the fabrication labels for a profile (pattern order, then `param_sizing` if any
 *  sizing-named parameter carries a value). Empty array == clean. Non-global regexes => stateless. */
export function detectFabrication(p: AnalystProfileOutput): string[] {
  const matched: string[] = [];
  const riskText = (p.riskManagementSummary ?? '').toString();
  for (const { label, re } of FAB_PATTERNS) if (re.test(riskText)) matched.push(label);
  const paramFab = p.parameters.some((param) => param.value != null && FAB_PARAM_NAME.test(param.name));
  if (paramFab) matched.push('param_sizing');
  return matched;
}
```

- [ ] Edit `src/experiments/strategy-analyst/scoring.ts` — exactly these changes (behavior-preserving):
  1. Add to the import block at the top: `import { detectFabrication } from './fabrication.ts';`
  2. DELETE the `const FAB_PATTERNS: Array<{ label: string; re: RegExp }> = [ ... ];` block (and its
     two `// Fabrication patterns ...` comment lines).
  3. DELETE the `const FAB_PARAM_NAME = /.../i;` line.
  4. Replace the body of `scoreRiskNoFabrication` so it delegates to `detectFabrication`; KEEP
     `RISK_WEIGHT` and the `CheckResult` shape identical:

```ts
function scoreRiskNoFabrication(p: AnalystProfileOutput): CheckResult {
  const matched = detectFabrication(p);
  const clean = matched.length === 0;
  return {
    id: 'risk_no_fabrication',
    weight: RISK_WEIGHT,
    bucketsHit: clean ? 1 : 0,
    bucketCount: 1,
    contribution: clean ? RISK_WEIGHT : 0,
    matched,
  };
}
```

  (Leave `DEFAULT_THRESHOLD`, `RISK_WEIGHT`, `POSITIVE_CHECKS`, `matchBuckets`, `joinFields`, and
  `scoreProfile` untouched.)

### Step 1.4 — Run, expect PASS (incl. the regression)

- [ ] `pnpm vitest run src/experiments/strategy-analyst/fabrication.test.ts` → GREEN.
- [ ] Regression: `pnpm vitest run src/experiments/strategy-analyst/scoring.test.ts` → GREEN
      (the `scoreProfile — negative risk check (5)` block: clean → full credit + `matched [] `,
      fabricated → 0 credit, DCA hints → full credit — all unchanged).
- [ ] `pnpm vitest run src/experiments/strategy-analyst/imports.guard.test.ts` → GREEN
      (`fabrication.ts` imports nothing forbidden, no `compose-mastra`).
- [ ] `pnpm typecheck` clean; `pnpm test` green.

### Step 1.5 — Commit

- [ ] `git commit -am "refactor(analyst-eval): extract shared FAB detection (detectFabrication) from scoring.ts (behavior-preserving)"`

---

## Task 2: `scoreCompleteness` (`completeness.ts`) + short canned profile

New generic, direction-aware structural-completeness scorer. Returns the analyst `ScoreResult`.

### Step 2.1 — Write the failing test

- [ ] Add a complete short canned profile to `src/experiments/strategy-analyst/__fixtures__/profiles.ts`
      (append at the end):

```ts
/** A strong short-after-pump profile that should PASS scoreCompleteness for expectedDirection 'short'. */
export const GOOD_SHORT_PUMP_PROFILE: AnalystProfileOutput = {
  direction: 'short',
  coreIdea: 'Short-only mean-reversion: after a vertical pump, enter short on confirmed exhaustion backed by stalling open interest and a liquidation cascade near the high.',
  summary: 'Rule-based FSM on 1m candles. Detects a sharp pump, watches for exhaustion, enters short when price rolls over, open interest stalls/declines and liquidations confirm the blow-off.',
  requiredMarketFeatures: ['ohlcv', 'open interest', 'liquidations', 'funding'],
  entryConditions: [
    'Pump of >=10% detected over the lookback window',
    'Rollover/rejection from the local high confirmed by red candles',
    'Open interest stalling or rolling over',
    'Liquidation cascade present near the high',
  ],
  exitConditions: [
    'TP1 at -3.5% (partial 50%)',
    'TP2 at -5% (full exit)',
    'Hard stop at +12%',
    'Time exit after 180 minutes',
  ],
  timeframes: ['1m'],
  indicators: [],
  parameters: [
    { name: 'pump.minRisePct', value: 10, unit: '%', description: 'Minimum rise to trigger', tunable: true },
    { name: 'tpLadder.tp1Pct', value: 3.5, unit: '%', description: 'First take profit', tunable: true },
  ],
  watchLifecycleSummary: 'IDLE -> WATCHING -> IN_POSITION -> COOLDOWN.',
  positionManagementSummary: 'DCA up to two adds on further spikes; move stop to breakeven after TP1.',
  riskManagementSummary: 'Risk sizing, leverage and fills are owned by the runner/platform; the strategy only emits a sizing hint for DCA.',
  runnerOwnedAuthorities: ['position sizing', 'leverage', 'fills', 'execution'],
  confidence: 0.8,
  unknowns: [
    'Exact position sizing and leverage are not specified',
    'Fees/commissions are not specified',
    'Target exchange/venue is not specified',
    'Instrument universe (which symbols) is not specified',
  ],
  evidence: ['"шорт после пампа"', '"первый тейк на -3.5%"'],
};
```

- [ ] Create `src/experiments/strategy-analyst/completeness.test.ts`:

```ts
// src/experiments/strategy-analyst/completeness.test.ts
import { describe, it, expect } from 'vitest';
import { scoreCompleteness, UNKNOWNS_CAP } from './completeness.ts';
import type { ScoreResult } from './types.ts';
import { GOOD_LONG_OI_PROFILE, GOOD_SHORT_PUMP_PROFILE } from './__fixtures__/profiles.ts';

function checkById(r: ScoreResult, id: string) {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} not found`);
  return c;
}

describe('scoreCompleteness — gates', () => {
  it('schema-invalid raw: schemaValid false, score 0, FAIL', () => {
    const r = scoreCompleteness({ not: 'a profile' }, { expectedDirection: 'long' });
    expect(r.gates.schemaValid).toBe(false);
    expect(r.gates.directionMatches).toBe(false);
    expect(r.score).toBe(0);
    expect(r.checks).toEqual([]);
    expect(r.verdict).toBe('FAIL');
  });

  it('direction mismatch: directionMatches false, verdict FAIL even with high score', () => {
    const r = scoreCompleteness(GOOD_LONG_OI_PROFILE, { expectedDirection: 'short' });
    expect(r.gates.schemaValid).toBe(true);
    expect(r.gates.directionMatches).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('FAIL');
  });
});

describe('scoreCompleteness — complete matching-direction profiles PASS', () => {
  it('long profile, expectedDirection long -> PASS, score ~1', () => {
    const r = scoreCompleteness(GOOD_LONG_OI_PROFILE, { expectedDirection: 'long' });
    expect(r.gates).toEqual({ schemaValid: true, directionMatches: true });
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('PASS');
  });

  it('short profile, expectedDirection short -> PASS, score ~1', () => {
    const r = scoreCompleteness(GOOD_SHORT_PUMP_PROFILE, { expectedDirection: 'short' });
    expect(r.gates).toEqual({ schemaValid: true, directionMatches: true });
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('PASS');
  });
});

describe('scoreCompleteness — structural checks miss', () => {
  it('empty entryConditions -> has_entry misses', () => {
    const r = scoreCompleteness({ ...GOOD_SHORT_PUMP_PROFILE, entryConditions: [] }, { expectedDirection: 'short' });
    expect(checkById(r, 'has_entry').contribution).toBe(0);
  });

  it('empty exitConditions -> has_exit misses', () => {
    const r = scoreCompleteness({ ...GOOD_LONG_OI_PROFILE, exitConditions: [] }, { expectedDirection: 'long' });
    expect(checkById(r, 'has_exit').contribution).toBe(0);
  });

  it('empty requiredMarketFeatures -> has_market_features misses', () => {
    const r = scoreCompleteness({ ...GOOD_LONG_OI_PROFILE, requiredMarketFeatures: [] }, { expectedDirection: 'long' });
    expect(checkById(r, 'has_market_features').contribution).toBe(0);
  });

  it('unknowns over cap -> unknowns_bounded misses', () => {
    const tooMany = Array.from({ length: UNKNOWNS_CAP + 1 }, (_, i) => `unknown ${i}`);
    const r = scoreCompleteness({ ...GOOD_SHORT_PUMP_PROFILE, unknowns: tooMany }, { expectedDirection: 'short' });
    expect(checkById(r, 'unknowns_bounded').contribution).toBe(0);
  });

  it('fabricated risk text -> no_fabrication misses with labels (long and short)', () => {
    const fabLong = scoreCompleteness(
      { ...GOOD_LONG_OI_PROFILE, riskManagementSummary: 'Use 10x leverage with a base order size of $100 per entry.' },
      { expectedDirection: 'long' },
    );
    const cLong = checkById(fabLong, 'no_fabrication');
    expect(cLong.contribution).toBe(0);
    expect(cLong.matched.length).toBeGreaterThan(0);

    const fabShort = scoreCompleteness(
      { ...GOOD_SHORT_PUMP_PROFILE, riskManagementSummary: 'Use 10x leverage with a base order size of $100 per entry.' },
      { expectedDirection: 'short' },
    );
    expect(checkById(fabShort, 'no_fabrication').contribution).toBe(0);
  });
});

describe('scoreCompleteness — threshold', () => {
  it('default threshold is DEFAULT_THRESHOLD (0.8)', () => {
    expect(scoreCompleteness(GOOD_LONG_OI_PROFILE, { expectedDirection: 'long' }).threshold).toBe(0.8);
  });
  it('respects an explicit threshold', () => {
    const r = scoreCompleteness(GOOD_SHORT_PUMP_PROFILE, { expectedDirection: 'short', threshold: 0.5 });
    expect(r.threshold).toBe(0.5);
  });
});
```

### Step 2.2 — Run, expect RED

- [ ] `pnpm vitest run src/experiments/strategy-analyst/completeness.test.ts`
- [ ] Expected RED: `Failed to resolve import "./completeness.ts"` (module does not exist yet).

### Step 2.3 — Minimal implementation

- [ ] Widen the gate type in `src/experiments/strategy-analyst/types.ts` — `ScoreResult.gates` keeps
      `schemaValid` + the existing `directionLong` (now optional) and adds an optional `directionMatches`
      so both scorers share the `ScoreResult` shape:

```ts
export interface ScoreResult {
  gates: { schemaValid: boolean; directionLong?: boolean; directionMatches?: boolean };
  checks: CheckResult[];
  score: number; // 0..1
  threshold: number;
  verdict: 'PASS' | 'FAIL';
}
```

  (This is a widening: `scoreProfile` still builds `{ schemaValid, directionLong }` at runtime, so its
  `expect(r.gates).toEqual({ schemaValid, directionLong })` deep-equality assertions stay green —
  `directionMatches` is simply absent on those objects.)

- [ ] Create `src/experiments/strategy-analyst/completeness.ts`:

```ts
// src/experiments/strategy-analyst/completeness.ts
import { AnalystProfileOutputSchema, type AnalystProfileOutput, type Direction } from '../../domain/strategy-profile.ts';
import type { CheckResult, ScoreResult } from './types.ts';
import { DEFAULT_THRESHOLD } from './scoring.ts';
import { detectFabrication } from './fabrication.ts';

/** Max number of declared unknowns before the structural check considers the profile under-committed. */
export const UNKNOWNS_CAP = 4;

/** Direction-aware structural-completeness scorer. Strategy-agnostic: works for any direction. */
export function scoreCompleteness(
  raw: unknown,
  opts: { expectedDirection: Direction; threshold?: number },
): ScoreResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const parsed = AnalystProfileOutputSchema.safeParse(raw);

  if (!parsed.success) {
    return { gates: { schemaValid: false, directionMatches: false }, checks: [], score: 0, threshold, verdict: 'FAIL' };
  }

  const profile = parsed.data;
  const gates = { schemaValid: true, directionMatches: profile.direction === opts.expectedDirection };

  const checks: CheckResult[] = [];
  const push = (id: string, weight: number, ok: boolean, matched: string[] = []): void => {
    checks.push({ id, weight, bucketsHit: ok ? 1 : 0, bucketCount: 1, contribution: ok ? weight : 0, matched });
  };

  // Five equally-weighted structural checks; a fully-complete profile scores 1.0.
  push('has_market_features', 0.2, profile.requiredMarketFeatures.length > 0);
  push('has_entry', 0.2, profile.entryConditions.length > 0);
  push('has_exit', 0.2, profile.exitConditions.length > 0);
  push('unknowns_bounded', 0.2, profile.unknowns.length <= UNKNOWNS_CAP);
  const fab = detectFabrication(profile);
  push('no_fabrication', 0.2, fab.length === 0, fab);

  const score = checks.reduce((sum, c) => sum + c.contribution, 0);
  const verdict = gates.schemaValid && gates.directionMatches && score >= threshold ? 'PASS' : 'FAIL';
  return { gates, checks, score, threshold, verdict };
}
```

### Step 2.4 — Run, expect PASS

- [ ] `pnpm vitest run src/experiments/strategy-analyst/completeness.test.ts` → GREEN.
- [ ] Regression: `pnpm vitest run src/experiments/strategy-analyst/scoring.test.ts` → GREEN
      (gate widening did not break the `toEqual({ schemaValid, directionLong })` assertions).
- [ ] `pnpm vitest run src/experiments/strategy-analyst/imports.guard.test.ts` → GREEN.
- [ ] `pnpm typecheck` clean; `pnpm test` green.

### Step 2.5 — Commit

- [ ] `git commit -am "feat(analyst-eval): generic direction-aware scoreCompleteness + short canned profile"`

---

## Task 3: `FixtureRef.direction` + `short-pump` fixture (3 docs)

Tag fixtures with direction and register a detailed short-after-pump fixture so the decision run covers
both directions.

### Step 3.1 — Write the failing test

- [ ] Extend `src/experiments/strategy-analyst/fixtures.test.ts` — add to the `resolveFixture` describe:

```ts
  it('tags long-oi as a long-direction fixture', () => {
    expect(resolveFixture('long-oi').direction).toBe('long');
  });

  it('resolves the short-pump fixture to its source/notes/rubric paths + short direction', () => {
    const ref = resolveFixture('short-pump');
    expect(ref.id).toBe('short-pump');
    expect(ref.sourcePath).toBe('docs/fixtures/strategies/short-pump-strategy-source.md');
    expect(ref.notesPath).toBe('docs/fixtures/strategies/short-pump-strategy-research-notes.md');
    expect(ref.rubricPath).toBe('docs/fixtures/strategies/short-pump-strategy-rubric.md');
    expect(ref.direction).toBe('short');
  });

  it('FIXTURES registers both fixtures', () => {
    expect(Object.keys(FIXTURES)).toEqual(expect.arrayContaining(['long-oi', 'short-pump']));
  });
```

  Also add a real-file existence + fingerprint assertion (proves the authored docs load) — append a new
  describe block at the end of the file:

```ts
import { readFileSync } from 'node:fs';

describe('short-pump fixture files exist and fingerprint', () => {
  it('source/notes/rubric files are readable and the source fingerprints', () => {
    const ref = resolveFixture('short-pump');
    const source = readFileSync(ref.sourcePath, 'utf8');
    expect(source.length).toBeGreaterThan(200);
    expect(readFileSync(ref.notesPath, 'utf8').length).toBeGreaterThan(1000);
    expect(readFileSync(ref.rubricPath, 'utf8').length).toBeGreaterThan(200);
    expect(fingerprintSource(source)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
```

### Step 3.2 — Run, expect RED

- [ ] `pnpm vitest run src/experiments/strategy-analyst/fixtures.test.ts`
- [ ] Expected RED: `resolveFixture('short-pump')` throws `unknown fixture "short-pump"` (runtime) —
      the registry has no `short-pump` and the docs do not exist.

### Step 3.3 — Minimal implementation

- [ ] Edit `src/experiments/strategy-analyst/types.ts` — add `direction` to `FixtureRef`:

```ts
export interface FixtureRef {
  id: string;
  sourcePath: string;
  notesPath: string;
  rubricPath: string;
  direction: 'long' | 'short';
}
```

- [ ] Edit `src/experiments/strategy-analyst/fixtures.ts` — tag `long-oi` and register `short-pump`:

```ts
export const FIXTURES: Record<string, FixtureRef> = {
  'long-oi': {
    id: 'long-oi',
    sourcePath: `${DIR}/long-oi-strategy-source.md`,
    notesPath: `${DIR}/long-oi-strategy-research-notes.md`,
    rubricPath: `${DIR}/long-oi-strategy-rubric.md`,
    direction: 'long',
  },
  'short-pump': {
    id: 'short-pump',
    sourcePath: `${DIR}/short-pump-strategy-source.md`,
    notesPath: `${DIR}/short-pump-strategy-research-notes.md`,
    rubricPath: `${DIR}/short-pump-strategy-rubric.md`,
    direction: 'short',
  },
};
```

- [ ] Author `docs/fixtures/strategies/short-pump-strategy-source.md` (RU first-person, mirrors the
      long-oi source's voice and length):

```md
Торгую только в short на крипто-фьючерсах.

Идея такая: если за последние примерно 20 минут цена выросла на 10% или больше (вертикальный памп), я не вхожу сразу, а беру инструмент на наблюдение и жду признаков истощения и разворота от локального максимума.

Вход делаю только после подтверждения: цена начинает откатываться, например появляются две красные свечи или резкий rollover, open interest перестаёт расти или начинает снижаться, и перед этим был каскад ликвидаций у хая (вынос шортов на пампе).

После входа первый тейк на −3.5% — там фиксирую половину позиции. После TP1 стоп переношу в безубыток. Остаток держу до −5%.

Жёсткий стоп ставлю примерно на +12% (выше входа). Если за 180 минут позиция не дошла ни до тейка, ни до стопа, закрываю по времени.

Если после входа цена ещё растёт примерно на 3% от последней цены входа, но потом снова появляется подтверждение разворота вниз, могу усредниться. Всего максимум две доливки. Плечо, размер позиции и комиссии — это не моё, это решает раннер/платформа.
```

- [ ] Author `docs/fixtures/strategies/short-pump-strategy-research-notes.md` (mirrors the long-oi
      research-notes section structure, adapted to short-after-pump):

```md
# Research notes: `short_pump` (Short after Pump)

> **Назначение.** Вспомогательные research-заметки (reverse-engineering гипотетической стратегии
> `short_pump` — зеркала `long_oi` по противоположному направлению), а **не** primary input для
> StrategyAnalyst. Primary input — короткое пользовательское описание в `short-pump-strategy-source.md`;
> эти заметки нужны для сверки того, что StrategyAnalyst извлечёт, и как справочник по логике.
>
> **Статус.** Research-only. Это не StrategyProfile и не результат запуска StrategyAnalyst.
>
> **Направление.** short-only, mean-reversion после капитуляционного **пампа** (а не дампа).

---

## 1. Краткое summary

`short_pump` — это **short-only** rule-based стратегия для крипто-перпетуалов на минутном таймфрейме.
Идея: после резкого вертикального роста цены (pump) дождаться **истощения** движения, подтверждённого
остановкой/разворотом open interest и каскадом ликвидаций у максимума, и войти в шорт «на откате от
эйфории». Внутри позиции — лестница тейк-профитов (TP1/TP2), перевод стопа в безубыток после TP1,
DCA-усреднения на дальнейших выносах вверх, жёсткий стоп и выход по времени.

Логика — детерминированный конечный автомат (FSM) без технических индикаторов: сигналы строятся только
из OHLCV, open interest (OI), ликвидаций и (опционально) funding.

---

## 2. Направление (direction)

- **Только short.** Решение о входе всегда `{ kind: 'enter', side: 'short' }`. Лонг-ветки нет.
- Стратегия рассчитана на **mean-reversion после капитуляционного пампа**, а не на трендследование вверх.

---

## 3. Core idea (ядро гипотезы)

1. Найти на окне последних минут **резкий памп** (rise) — цена выросла и **держится наверху** (не успела
   откатиться).
2. Перейти в режим наблюдения (watch) на ограниченное время.
3. Войти в шорт, когда одновременно: цена начала откатываться от локального максимума, **OI перестал
   расти / снижается** (леверидж-лонги начинают выходить), и присутствуют **ликвидации** у хая
   (вынос шортов на пампе — признак локальной эйфории / blow-off).
4. Управлять позицией: частичный TP1 → безубыток → TP2/стоп/время, при дальнейшем выносе вверх — усреднять (DCA).

---

## 4. Используемые рыночные признаки (market features)

| Признак | Что используется |
|---|---|
| Закрытые свечи 1m (OHLCV) | `open/high/low/close/ts` последних N свечей, строго до текущего бара (point-in-time, без заглядывания вперёд) |
| Open Interest | `oiTotalUsd` — суммарный OI; окно из последних 3 минутных значений и текущее значение |
| Liquidations | объём ликвидаций текущей минуты у максимума (short-ликвидации на пампе) |
| Funding (опц.) | повышенный/положительный funding как контекст перегретости лонгов |
| Технические индикаторы | **не используются** — стратегия чисто rule-based |

Производная метрика: `liqRatioPct = liqUsd / oiTotalUsd * 100`.

**Деградация данных.** Если лента OHLCV-only или есть gap в OI/ликвидациях — модуль **не входит** и не
подставляет нули: вход требует полного OI-окна и текущих ликвидаций. Carry-forward запрещён.

---

## 5. Жизненный цикл / FSM (watch lifecycle)

Фазы: `IDLE → WATCHING → IN_POSITION → COOLDOWN → IDLE`.

- **IDLE** — ждём pump-сигнал; на каждом закрытии бара проверяем окно последних свечей детектором пампа.
- **WATCHING** — памп найден, наблюдаем за разворотом вниз до таймаута; обновляем локальный максимум.
- **IN_POSITION** — позиция открыта; работает логика TP/SL/BE/DCA.
- **COOLDOWN** — пауза после таймаута watch или после закрытия позиции.

`watch.maxMinutes = 40` мин, `watch.cooldownMinutes = 20` мин.

---

## 6. Сигнал входа: pump-детект (entry trigger)

Детектор на окне последних `pump.lookbackMin = 20` закрытых свечей. Режим по умолчанию `low_to_high`
(зеркало `high_to_low`):

1. Найти минимум `low` в окне; от его индекса вперёд найти максимум `high`.
2. `pumpPctLowHigh` = рост от минимума к максимуму, должен быть **≥ `pump.minRisePct` = 10%**.
3. `pumpPctLowToClose` = рост от минимума к текущему `close`, должен быть **≥ 6%** — цена всё ещё наверху,
   **не откатилась** к минимуму (фильтр «удержания пампа»).
4. Свеча-максимум закрылась в верхней части своего диапазона (фильтр «не сильный разворотный бар вниз»).
5. Если откат от максимума к текущему close уже **> 3.5%** → сигнал **отклоняется** (разворот уже отыгран).

Сигнал переносит в watch: `signalPrice`, `triggerPct`, `highest/lowest` (+ их ts), откат от хая.

---

## 7. Confirmation logic — подтверждение входа

На каждом баре фазы WATCHING (требуются OI-окно из 3 значений и текущие ликвидации) вычисляется
`evaluateEntry`. Вход разрешается, когда **выполнены ВСЕ** условия (иначе — причина отказа):

1. Цена откатывается: `redCandles ≥ 2` **или** быстрый одно-баровый импульс вниз `≤ −2.5%`
   (иначе `price_not_falling_2m`).
2. `oiRolloverPct ≤ entryMaxOiGrowthPct` — OI перестал расти / снижается (иначе `oi_still_growing`).
3. `pullbackPct ≥ minPullbackPctFromHigh (0.6%)` — есть откат от максимума (иначе `pullback_too_small`).
4. Если `liqFilter.requireLiquidation = true`: `liqUsd > 0` и `liqRatioPct ≥ 0.02%`
   (иначе `no_liquidations` / `liq_ratio_too_small`).

При успехе эмитится `enter short`; хост открывает позицию по `open(t+1)`.

---

## 8. DCA / averaging logic

Доливка армится при росте цены ещё на ~3% от последнего входа (`dca.risePcts = [3, 3]`) и `dcaCount < dca.maxAdds (2)`,
затем переподтверждение разворота вниз (откат + остановка OI + красные свечи). При успехе `dcaCount += 1`,
эмитится `add_to_position` с `sizingHint` (множители `1.2`, `1.5` — только подсказка размера). Максимум **2** усреднения.

---

## 9. TP / SL / BE / exit logic

`onPositionBar` выбирает ровно одно действие в порядке приоритета:

1. Полные выходы: TP2 (`price ≤ entry * (1 − tp2Pct/100)`, `tp2Pct = 5%`); hard stop
   (`price ≥ entry * (1 + hardStopPct/100)`, `hardStopPct = 12%`); time exit (`maxHoldMin = 180` мин).
2. Отложенный перевод в безубыток (BE) на баре после TP1 (`update_protection { stop: entryPrice }`).
3. TP1: при первом `price ≤ entry * (1 − tp1Pct/100)`, `tp1Pct = 3.5%` → частичный выход 50% + взвод BE.
4. DCA (см. раздел 8).
5. Иначе — `idle`.

Сводка выходов: TP1 = −3.5% (частичный 50%, далее BE), TP2 = −5% (полный), hard stop = +12%,
time exit = 180 мин, trailing **отсутствует**.

---

## 10. Position / risk / execution boundaries

- **Сторона:** только short. Один инструмент = одна позиция.
- **Размер позиции / плечо / комиссии:** стратегия **не задаёт** — host-owned; модуль отдаёт только
  `sizingHint` для DCA (`1.2`, `1.5`).
- **Лимит доливок:** `dca.maxAdds = 2`.

---

## 11. Важные параметры (DEFAULT_PARAMS, зеркало long_oi)

| Параметр | Дефолт | Смысл |
|---|---|---|
| `pump.lookbackMin` | 20 (мин) | окно поиска пампа |
| `pump.minRisePct` | 10 (%) | мин. рост для сигнала |
| `watch.maxMinutes` | 40 (мин) | таймаут наблюдения |
| `watch.cooldownMinutes` | 20 (мин) | пауза |
| `entry.minPullbackPctFromHigh` | 0.6 (%) | мин. откат от хая |
| `entry.requireRedPriceCandles` | 2 | требуемых красных свечей |
| `liqFilter.minLiqOiRatioPct` | 0.02 (%) | мин. отношение liq к OI |
| `dca.maxAdds` | 2 | макс. доливок |
| `dca.risePcts` | [3, 3] (%) | рост от входа для арминга |
| `dca.sizeMultipliers` | [1.2, 1.5] | sizingHint доливок (подсказка) |
| `tpLadder.tp1Pct` | 3.5 (%) | порог TP1 |
| `tpLadder.tp2Pct` | 5 (%) | порог TP2 |
| `hardStopPct` | 12 (%) | жёсткий стоп |
| `maxHoldMin` | 180 (мин) | выход по времени |

---

## 12. Разделение ответственности

- **Стратегия:** детект пампа, watch/cooldown, FSM-переходы, условия входа/доливки/выхода, намерение
  `update_protection` (BE = цена входа), `sizingHint` для DCA. Чистая детерминированная функция (без I/O).
- **Runner / platform:** point-in-time контекст, исполнение одного решения на бар, открытие по `open(t+1)`,
  фактический размер/плечо/комиссии/проскальзывание, accept/clamp hint-полей, warmup-гейтинг.
- **Exchange / execution:** сбор рыночных данных (свечи, OI, ликвидации, funding), маршрутизация ордеров.

---

## 13. Известные неопределённости / что НЕ выводится

1. Точное окно агрегации ликвидаций и происхождение OI/funding-данных — на стороне market-aggregator/хоста.
2. Размер позиции / equity-модель — host-owned; множители DCA `1.2/1.5` — только `sizingHint`.
3. Trailing-стоп не предполагается.
4. Режим `open_to_close` существует, но дефолт — `low_to_high`.
5. Конкретный набор инструментов (universe), биржа и комиссии — не специфицированы.

---

## 14. Подсказка для StrategyAnalyst

- Направление: short-only; класс: rule-based mean-reversion на капитуляционном пампе с OI/liq-подтверждением,
  лестницей TP, BE и DCA.
- Не включать host-owned / default-off элементы; при неоднозначности предпочитать формулировки из
  uncertainties, а не доопределять пороги «от себя».
```

- [ ] Author `docs/fixtures/strategies/short-pump-strategy-rubric.md` (mirrors the long-oi rubric):

```md
# Rubric: short_pump StrategyProfile evaluation

Score the candidate StrategyProfile against these dimensions (each 0–1). Use the source
description and the research notes as ground truth. Penalize invented specifics.

## Dimensions

1. **Direction** — Net bias is short-only. No long branch invented.
2. **Core idea** — Mean-reversion after a sharp pump; enter short on a confirmed rollover backed by OI stalling/declining + a liquidation cascade. Not trend-following.
3. **Market features** — Names the real data needs: OHLCV (1m candles), open interest (OI), liquidations (funding optional). No technical indicators claimed (the strategy is rule-based).
4. **Entry trigger** — Pump detection (~10% rise) → watch → confirmed rollover (price falling / red candles), OI stalling/declining, liquidations present near the high.
5. **Exit ladder** — TP1 (−3.5%, partial), TP2 (−5%, full), hard stop (+12%), time exit (180m). Move stop to breakeven after TP1.
6. **Position management** — DCA averaging (max two adds on further spikes up); breakeven after TP1.
7. **Boundary discipline** — Treats position sizing, leverage, fills, fees, exchange, and instrument universe as runner/platform-owned. Does NOT invent exact leverage or base order size. DCA size multipliers are hints only.
8. **Unknowns honesty** — Flags missing sizing/leverage, fees, exchange, and instrument universe (or equivalents) rather than fabricating them.

## Hallucination flags (list any present)

- Invented leverage (e.g. "10x") or base order size (e.g. "$100").
- Invented fees, commissions, exchange, or specific instrument list.
- Claimed technical indicators or a trailing stop (the strategy uses neither).
- A long entry branch (the strategy is short-only).

## Missing-from-profile (list rubric items the profile omitted)

Note any of dimensions 1–8 the profile fails to cover.
```

### Step 3.4 — Run, expect PASS

- [ ] `pnpm vitest run src/experiments/strategy-analyst/fixtures.test.ts` → GREEN.
- [ ] `pnpm typecheck` clean; `pnpm test` green.

### Step 3.5 — Commit

- [ ] `git commit -am "feat(analyst-eval): FixtureRef.direction + detailed short-pump fixture (source/notes/rubric)"`

---

## Task 4: `analyst:eval` rewire — completeness primary, scoreProfile secondary

Switch the deterministic ranking signal to `scoreCompleteness` keyed on `fixture.direction`; keep
`scoreProfile` as a long-oi-only `secondaryScore` diagnostic. Do NOT delete `scoreProfile` or its tests.

### Step 4.1 — Write the failing test

- [ ] Edit `src/experiments/strategy-analyst/eval-harness.test.ts`:
  - Add `direction: 'long'` to the shared `baseInput` literal:

```ts
const baseInput = {
  models: ['anthropic/claude-x', 'openai/gpt-x'],
  fixtureId: 'long-oi',
  fixtureText: 'long only strategy text',
  fixtureFingerprint: 'sha256:abc',
  threshold: 0.8,
  direction: 'long' as const,
};
```

  - Import the short profile: extend the existing fixtures import to
    `import { GOOD_LONG_OI_PROFILE, GOOD_SHORT_PUMP_PROFILE } from './__fixtures__/profiles.ts';`
  - Add a new describe block:

```ts
describe('runEval — completeness primary signal + scoreProfile secondary', () => {
  it('long fixture: score is direction-aware completeness AND secondaryScore is the bespoke scoreProfile', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] }, deps({ 'x/y': fakeAnalyst(GOOD_LONG_OI_PROFILE) }));
    const r = result.perModel[0]!;
    // primary deterministic verdict comes from scoreCompleteness keyed on direction 'long'
    expect(r.score!.gates.directionMatches).toBe(true);
    expect(r.verdict).toBe('PASS');
    // bespoke long-oi diagnostic retained as a secondary field (uses the directionLong gate)
    expect(r.secondaryScore).not.toBeNull();
    expect(r.secondaryScore!.gates.directionLong).toBe(true);
  });

  it('short fixture: completeness keyed on short PASSes; secondaryScore is null (not long-oi)', async () => {
    const result = await runEval(
      { ...baseInput, models: ['x/y'], fixtureId: 'short-pump', direction: 'short' as const },
      deps({ 'x/y': fakeAnalyst(GOOD_SHORT_PUMP_PROFILE) }),
    );
    const r = result.perModel[0]!;
    expect(r.score!.gates.directionMatches).toBe(true);
    expect(r.verdict).toBe('PASS');
    expect(r.secondaryScore).toBeNull();
  });

  it('a throwing model still records secondaryScore null', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] }, deps({ 'x/y': throwingAnalyst('boom') }));
    expect(result.perModel[0]!.secondaryScore).toBeNull();
  });
});
```

### Step 4.2 — Run, expect RED

- [ ] `pnpm vitest run src/experiments/strategy-analyst/eval-harness.test.ts`
- [ ] Expected RED: assertion failures — `r.score!.gates.directionMatches` is `undefined` and
      `r.secondaryScore` is undefined (the harness still runs `scoreProfile` as the primary and has no
      `secondaryScore` field). (Runtime/assertion failure, not a type error.)

### Step 4.3 — Minimal implementation

- [ ] Edit `src/experiments/strategy-analyst/types.ts` — add `secondaryScore` to `CandidateResult`:

```ts
export interface CandidateResult {
  model: string;
  provider: string;
  modelId: string;
  latencyMs: number;
  verdict: 'PASS' | 'FAIL';
  score: ScoreResult | null;        // primary deterministic signal — scoreCompleteness (null only when analyze() threw)
  secondaryScore: ScoreResult | null; // bespoke long-oi scoreProfile diagnostic; null unless direction === 'long'
  rawOutput: AnalystProfileOutput | null;
  error: CandidateError | null;
  judge: JudgeVerdict | null;
}
```

- [ ] Edit `src/experiments/strategy-analyst/eval-harness.ts`:
  1. Extend the domain import: `import type { AnalystProfileOutput, Direction } from '../../domain/strategy-profile.ts';`
  2. Add the new scorer import (keep the existing `scoreProfile` import):
     `import { scoreCompleteness } from './completeness.ts';`
  3. Add `direction` to `RunEvalInput`:

```ts
export interface RunEvalInput {
  models: string[];
  fixtureId: string;
  fixtureText: string;
  fixtureFingerprint: string;
  threshold: number;
  direction: Direction;
  repeat?: number; // independent runs per model; default 1, assumed >= 1
}
```

  4. In `runOnce`, replace the scoring line and add the secondary, then thread it into both returns:

```ts
    const score = scoreCompleteness(raw, { expectedDirection: input.direction, threshold: input.threshold });
    const secondaryScore = input.direction === 'long' ? scoreProfile(raw, { threshold: input.threshold }) : null;
```

   - success return: add `secondaryScore` (place it next to `score`):
     `return { model, provider, modelId, latencyMs, verdict: score.verdict, score, secondaryScore, rawOutput: raw, error: null, judge };`
   - catch return: add `secondaryScore: null`:
     `return { model, provider, modelId, latencyMs, verdict: 'FAIL', score: null, secondaryScore: null, rawOutput: null, error: classifyError(err), judge: null };`
  5. Update the `runOnce` doc comment to
     `/** One independent run for a model: analyze() -> scoreCompleteness() (+ scoreProfile secondary for long) -> (optional) judge(). Never throws. */`

- [ ] Edit `scripts/strategy-analyst-eval.ts` — thread `fixture.direction` into the `runEval` input
      (the only change; `fixture` is now a `FixtureRef` carrying `direction`):

```ts
  const result = await runEval(
    { models: args.models, fixtureId: fixture.id, fixtureText, fixtureFingerprint: fingerprintSource(fixtureText), threshold: args.threshold, repeat: args.repeat, direction: fixture.direction },
    {
      analystFor: buildRealAnalystFor(env),
      providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
      clock: () => Date.now(),
      judge,
    },
  );
```

  (`secondaryScore` rides into the per-run artifact automatically — `writeRunArtifacts` JSON-serializes
  the whole `CandidateResult` minus `judge`. No `artifacts.ts` / `aggregate.ts` change: the `det` stat
  still reads `score.score`, which is now the completeness score.)

### Step 4.4 — Run, expect PASS

- [ ] `pnpm vitest run src/experiments/strategy-analyst/eval-harness.test.ts` → GREEN (new + existing:
      the long-oi `GOOD_LONG_OI_PROFILE` scores completeness 1.0 → PASS; repeat/std/aggregate tests
      unaffected since the completeness score is deterministic).
- [ ] `pnpm vitest run src/experiments/strategy-analyst/imports.guard.test.ts` → GREEN.
- [ ] `pnpm typecheck` clean; `pnpm test` green.
- [ ] Runtime smoke (scripts/ is not tsc-covered): `npm run analyst:eval -- --fixture short-pump --models a/b`
      prints a dry-run plan (no `--run` ⇒ no paid calls) without throwing; repeat with `--fixture long-oi`.

### Step 4.5 — Commit

- [ ] `git commit -am "feat(analyst-eval): scoreCompleteness as the cross-fixture primary signal; scoreProfile retained as long-oi secondary diagnostic"`

---

## Task 5: round-trip rewire (critic eval-harness)

Replace the bespoke `scoreProfile` round-trip scorer with `scoreCompleteness` keyed on
`evalCase.direction`, fixing the `pump-short` confound. `profileScore` keeps the `AnalystScoreResult`
alias type.

### Step 5.1 — Write the failing test

- [ ] Edit `src/experiments/strategy-critic/eval-harness.test.ts`:
  - Import the short profile alongside the long one:
    `import { GOOD_LONG_OI_PROFILE, GOOD_SHORT_PUMP_PROFILE } from '../strategy-analyst/__fixtures__/profiles.ts';`
  - In the `runOnce — round-trip stage` describe, change the first test to feed a direction-matching
    short profile and assert direction-awareness:

```ts
  it('populates profile + profileScore (completeness keyed on the case direction) and hands the profile to the judge', async () => {
    let analystInput: StrategyAnalystInput | undefined;
    let judgeProfile: AnalystProfileOutput | undefined;
    const d: RunEvalDeps = {
      criticFor: () => fakeCritic(GOOD_PUMP_SHORT_REFINEMENT),
      providerOf: (m) => ({ provider: 'fake', modelId: m }),
      clock: (() => { let t = 0; return () => (t += 100); })(),
      analystFor: () => fakeAnalyst(GOOD_SHORT_PUMP_PROFILE, (i) => { analystInput = i; }),
      judge: async (_r, _c, p) => { judgeProfile = p; return { dimensions: [], overallScore: 0.9, hallucinations: [], missing: [], notes: 'ok' }; },
    };
    const r = await runOnce(CAND, CASE, rtInput, d); // CASE = pump-short (direction 'short')
    expect(analystInput).toEqual({ kind: 'manual_description', content: GOOD_PUMP_SHORT_REFINEMENT.improvedStrategyText });
    expect(r.profile).toEqual(GOOD_SHORT_PUMP_PROFILE);
    expect(r.profileScore).not.toBeNull();
    // pump-short (short) no longer fails on a long-only gate: a matching short profile is direction-valid
    expect(r.profileScore!.gates.directionMatches).toBe(true);
    expect(r.profileScore!.verdict).toBe('PASS');
    expect(judgeProfile).toEqual(GOOD_SHORT_PUMP_PROFILE);
    expect(r.verdict).toBe('PASS'); // critique verdict, unaffected
  });

  it('a long profile against the short case is direction-mismatched (the confound is now visible, not silently bucket-missed)', async () => {
    const d: RunEvalDeps = {
      criticFor: () => fakeCritic(GOOD_PUMP_SHORT_REFINEMENT),
      providerOf: (m) => ({ provider: 'fake', modelId: m }),
      clock: (() => { let t = 0; return () => (t += 100); })(),
      analystFor: () => fakeAnalyst(GOOD_LONG_OI_PROFILE),
    };
    const r = await runOnce(CAND, CASE, rtInput, d);
    expect(r.profileScore).not.toBeNull();
    expect(r.profileScore!.gates.directionMatches).toBe(false);
  });
```

  (The fail-soft and "round-trip off" tests are unchanged — they assert `profileScore` null on analyst
  failure / when off, which still holds.)

### Step 5.2 — Run, expect RED

- [ ] `pnpm vitest run src/experiments/strategy-critic/eval-harness.test.ts`
- [ ] Expected RED: `r.profileScore!.gates.directionMatches` is `undefined` — the harness still calls
      `scoreProfile` (which sets `directionLong`, not `directionMatches`), and feeding the new
      `GOOD_SHORT_PUMP_PROFILE` to `scoreProfile` gates on `directionLong:false`. (Runtime/assertion.)

### Step 5.3 — Minimal implementation

- [ ] Edit `src/experiments/strategy-critic/eval-harness.ts`:
  1. Replace the import line
     `import { scoreProfile } from '../strategy-analyst/scoring.ts';`
     with
     `import { scoreCompleteness } from '../strategy-analyst/completeness.ts';`
  2. Replace the round-trip scoring call:

```ts
        profileScore = scoreCompleteness(profile, { expectedDirection: evalCase.direction, threshold: input.threshold });
```

  (`profileScore` stays typed `AnalystScoreResult | null`; the alias import
  `import type { ScoreResult as AnalystScoreResult } from '../strategy-analyst/types.ts';` is unchanged —
  `scoreCompleteness` returns the analyst `ScoreResult`. The critic `aggregate.ts` `profile` Stats still
  reads `profileScore.score`, a number, so it is unaffected.)

- [ ] Edit `src/experiments/strategy-critic/types.ts` — update the trailing comment on
      `CandidateResult.profileScore` from `// deterministic scoreProfile() result; ...` to
      `// deterministic scoreCompleteness() result (keyed on the case direction); null when off or on analyst failure`.

### Step 5.4 — Run, expect PASS

- [ ] `pnpm vitest run src/experiments/strategy-critic/eval-harness.test.ts` → GREEN.
- [ ] `pnpm vitest run src/experiments/strategy-critic/` → GREEN (aggregate/fixtures/scoring/types/plan).
- [ ] `pnpm typecheck` clean; `pnpm test` (full suite) green.

### Step 5.5 — Commit

- [ ] `git commit -am "feat(critic-eval): round-trip profileScore via direction-aware scoreCompleteness (fixes pump-short directionLong confound)"`

---

## Self-Review

### Spec coverage (every spec requirement → task)

- New generic `scoreCompleteness(profile, { expectedDirection, threshold })`, gates `schemaValid` +
  `directionMatches`, weighted structural checks (`has_market_features`/`has_entry`/`has_exit`/
  `unknowns_bounded`/`no_fabrication`), verdict PASS iff gates + score ≥ threshold, returns existing
  `ScoreResult` shape, default threshold reuses `DEFAULT_THRESHOLD` → **Task 2**.
- Shared FAB util (DRY extraction of `FAB_PATTERNS` + `FAB_PARAM_NAME` + detection logic), used by both
  scorers, behavior-preserving → **Task 1** (consumed in Task 2).
- `FixtureRef.direction`; `long-oi` → `'long'`; `short-pump` registered with 3 doc paths +
  `direction:'short'`; author source + research-notes + rubric to long-oi depth → **Task 3**.
- `analyst:eval` rewire: deterministic signal = `scoreCompleteness` keyed on `fixture.direction`;
  `scoreProfile` retained as a secondary diagnostic computed only for `direction==='long'`, surfaced as
  an extra field (not the primary sort), threaded `fixture.direction` via `runOnce`/`RunEvalInput`/script
  → **Task 4**.
- round-trip rewire: critic `scoreProfile(profile,{threshold})` → `scoreCompleteness(profile,{expectedDirection: evalCase.direction, threshold})`; `profileScore` stays the analyst `ScoreResult` → **Task 5**.
- Testing requirements: completeness gates + each structural check on a long AND a short profile + PASS
  on a complete matching-direction profile (Task 2); behavior-preserving FAB regression (Task 1 + re-run
  in Task 2); short-pump loads + fingerprint + `FixtureRef.direction` present (Task 3); analyst:eval
  det signal is completeness keyed on direction + long-oi `secondaryScore` appears + both fixtures
  resolvable (Task 4); round-trip pump-short no longer fails on `directionLong` + profileScore reflects
  completeness keyed on case direction (Task 5); gate `pnpm typecheck` + `pnpm test` every task.
- Out of scope (NOT in any task, correctly): the paid decision run, the `STRATEGY_ANALYST_MODEL`
  default switch, deleting/parametrizing `scoreProfile`, extra fixtures beyond `short-pump`, any
  production behavior change.

**Unmapped spec requirements: none.**

### Placeholder scan

No `TODO`, no "similar to Task N", no "(author here)" — every code block and every fixture document is
complete and pasteable.

### Type-consistency scan (identical spelling, cross-task)

- `scoreCompleteness` — Task 2 def; Task 4 import+call; Task 5 import+call. Signature
  `(raw: unknown, opts: { expectedDirection: Direction; threshold?: number }): ScoreResult` everywhere.
- `expectedDirection` — Task 2 (opts), Task 4 (`expectedDirection: input.direction`), Task 5
  (`expectedDirection: evalCase.direction`). Identical key.
- `directionMatches` — Task 2 (gate field + tests), Task 4 (`r.score!.gates.directionMatches`), Task 5
  (`r.profileScore!.gates.directionMatches`). `ScoreResult.gates` widened in Task 2 to carry it
  (optional) alongside the retained optional `directionLong`.
- `FixtureRef.direction` — Task 3 (type + both fixtures + tests), Task 4 (`direction: fixture.direction`
  in the script). Values `'long' | 'short'`, assignable to `Direction`.
- `detectFabrication` — Task 1 (def + tests + scoring.ts call site), Task 2 (completeness.ts call site).
  One name, signature `(p: AnalystProfileOutput): string[]`.
- `UNKNOWNS_CAP` — Task 2 named export (value 4), referenced in completeness.ts and completeness.test.ts.
- `secondaryScore` — Task 4 (`CandidateResult` field + harness returns + tests). `ScoreResult | null`.
- `Direction` imported from `../../domain/strategy-profile.ts` in completeness.ts (Task 2) and
  eval-harness.ts (Task 4). Real enum is `'long'|'short'|'both'|'unknown'` — the spec's `'spot'` is a
  prose typo, deliberately not used.
- Critic alias `ScoreResult as AnalystScoreResult` unchanged (Task 5); `scoreCompleteness` returns the
  analyst `ScoreResult`, so `profileScore: AnalystScoreResult | null` stays valid.

All consistent; no inline fixes required.
