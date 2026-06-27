# Strategy-Critic Eval Harness Implementation Plan

**For agentic workers:** This plan is executed task-by-task. You MUST use the `superpowers:executing-plans` skill (REQUIRED SUB-SKILL) to run it, and `superpowers:test-driven-development` for every task — write the failing test FIRST, watch it fail for the expected reason, then write the minimal implementation. Do not batch tasks; commit after each one.

**Spec (source of truth):** `docs/superpowers/specs/2026-06-27-strategy-critic-eval-harness-design.md`

## Goal

Build an offline-deterministic eval harness that compares the pre-flight strategy critic (PR #88) across candidates — `single` (one combined agent) vs `two_stage` (critic→refiner), and cross-product role models — so the default mode + per-role models are chosen by data, not guess. Plus one prerequisite product change: ground the *rewriting* agents (`strategy-refiner`, `strategy-critic-combined`) in the platform's real data capabilities so their refinements are buildable/backtestable. The paid `--run` is the user's manual post-merge step; this slice ships harness + scorer + judge + fixtures + dry-run + offline tests. Default OFF (`STRATEGY_PREFLIGHT_CRITIQUE=false`) is unchanged — this slice does NOT enable the feature.

## Architecture

Mirror `src/experiments/strategy-analyst/*` end-to-end into a new `src/experiments/strategy-critic/*` namespace:
- `types.ts` (`Candidate`, `CriticEvalCase`, `AspectGroup`, `ScoreResult`, `CandidateResult`, `CandidateError`, `JudgeVerdict`+`JudgeVerdictSchema`, `ModelAggregate`, `EvalRunResult`)
- `scoring.ts` (`scoreRefinement`), `judge.ts` (`buildJudgePrompt`/`runJudge`), `eval-harness.ts` (`runOnce`/`runEval`), `aggregate.ts` (`aggregateRuns`/`rankAggregates`), `fixtures.ts` (`CRITIC_EVAL_CASES`), `candidates.ts` (`buildCandidates`), `plan.ts` (`planDryRun`), `real-critic-factory.ts` (`buildRealCriticFor`/`buildRealJudge`), `artifacts.ts`, `__fixtures__/refinements.ts`.
- `src/mastra/agents/strategy-critic-judge.agent.ts` (judge agent + id) and `src/mastra/agents/platform-data-capabilities.ts` (shared `PLATFORM_DATA_CAPABILITIES`).
- `scripts/strategy-critic-eval.ts` + `package.json` `critic:eval`.

The harness consumes the existing `StrategyCriticPort.refine(input, opts?)` seam (`src/ports/strategy-critic.port.ts`); the real factory mirrors `buildStrategyCritic`'s adapter selection (`composeMastra` → `TwoStageStrategyCritic` / `SingleStageStrategyCritic`).

## Tech Stack

- TypeScript run via `node --experimental-strip-types` (no build step); Vitest for tests; Zod for schemas; Mastra agents (`@mastra/core/agent`).
- LLM providers via `src/adapters/llm/model-provider.ts` (`resolveLanguageModel`, `parseRoleModel`, `ProviderModel`).

## Global Constraints

- `node --experimental-strip-types` → NO TypeScript parameter-properties; use explicit field declarations + assignment in the constructor body (guard `src/strip-types-no-param-properties.test.ts`).
- All Mastra agents live under `src/mastra/**` (guard `src/mastra/mastra-import-boundary.guard.test.ts`); the judge agent + capabilities module go there.
- Every relative import carries the `.ts` extension.
- Test gate for every task: `pnpm typecheck` + `pnpm test` (`pnpm vitest run` strips types and does NOT typecheck — a RED step must fail at runtime/assertion or as an unresolved import, never as a "type error").
- The eval harness is OFFLINE-deterministic in tests: fake adapters only, no API keys, no `composeMastra`, no real-factory import in any `*.test.ts`.
- `real-critic-factory.ts` is imported ONLY under `--run` (dynamic `import()`); the dry-run path constructs nothing and imports no real factory.
- The judge is best-effort and NEVER affects the deterministic verdict (a throwing judge leaves `verdict` and `score` untouched, `judge: null`).
- The `strategy-critic` agent (`src/mastra/agents/strategy-critic.agent.ts`) stays VERBATIM (critique-only) — it is NOT touched; grounding goes only into `strategy-refiner` + `strategy-critic-combined`.
- Default OFF unchanged: `STRATEGY_PREFLIGHT_CRITIQUE` defaults false; this slice neither flips it nor changes `buildStrategyCritic`.

---

### Task 1 — Platform-data grounding (product change, prerequisite)

Add a shared `PLATFORM_DATA_CAPABILITIES` constant (grounded in `MarketDataKind = 'openInterest' | 'liquidations' | 'funding' | 'taker'` from `src/ports/research-run-lifecycle.ts:24` and the real `ctx.market` API in `src/adapters/builder/builder-sdk-doc.ts` — `openInterest.trend`, `liquidationsLong/Short`, funding, taker buy/sell → delta/CVD) and inject it into the INSTRUCTIONS of the two REWRITING agents. Do NOT touch `strategy-critic.agent.ts`.

**Files**
- Create: `src/mastra/agents/platform-data-capabilities.ts`
- Modify: `src/mastra/agents/strategy-refiner.agent.ts`, `src/mastra/agents/strategy-critic-combined.agent.ts`
- Test: `src/mastra/agents/platform-data-capabilities.test.ts`

**Interfaces**
- Produces: `export const PLATFORM_DATA_CAPABILITIES: string`; `export const STRATEGY_REFINER_INSTRUCTIONS: string`; `export const STRATEGY_CRITIC_COMBINED_INSTRUCTIONS: string` (existing factories + IDs unchanged).
- Consumes (negative assertion): the unmodified `src/mastra/agents/strategy-critic.agent.ts` source via `node:fs`.

Steps:

- [ ] **RED — write the failing test** `src/mastra/agents/platform-data-capabilities.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { PLATFORM_DATA_CAPABILITIES } from './platform-data-capabilities.ts';
  import { STRATEGY_REFINER_INSTRUCTIONS } from './strategy-refiner.agent.ts';
  import { STRATEGY_CRITIC_COMBINED_INSTRUCTIONS } from './strategy-critic-combined.agent.ts';

  const MARKERS = ['open interest', 'funding', 'taker', 'liquidation'];

  describe('platform-data grounding', () => {
    it('the capabilities constant names every available signal', () => {
      const text = PLATFORM_DATA_CAPABILITIES.toLowerCase();
      for (const m of MARKERS) expect(text).toContain(m);
    });

    it('refiner + combined INSTRUCTIONS embed the capabilities markers', () => {
      for (const instr of [STRATEGY_REFINER_INSTRUCTIONS, STRATEGY_CRITIC_COMBINED_INSTRUCTIONS]) {
        const text = instr.toLowerCase();
        for (const m of MARKERS) expect(text).toContain(m);
      }
    });

    it('the pure-critique agent is NOT grounded (no capabilities markers, no import)', () => {
      const path = fileURLToPath(new URL('./strategy-critic.agent.ts', import.meta.url));
      const src = readFileSync(path, 'utf8');
      expect(src).not.toContain('platform-data-capabilities');
      const lower = src.toLowerCase();
      for (const m of ['open interest', 'funding rate', 'taker buy']) expect(lower).not.toContain(m);
    });
  });
  ```
- [ ] **Run RED — expect FAIL:** `pnpm vitest run src/mastra/agents/platform-data-capabilities.test.ts` → fails to load with `Failed to load url ./platform-data-capabilities.ts` (module does not exist yet).
- [ ] **GREEN — create** `src/mastra/agents/platform-data-capabilities.ts`:
  ```ts
  // src/mastra/agents/platform-data-capabilities.ts
  // Canonical, curated description of the platform's REAL research data — sourced from
  // MarketDataKind ('openInterest' | 'liquidations' | 'funding' | 'taker',
  // src/ports/research-run-lifecycle.ts) and the ctx.market API in
  // src/adapters/builder/builder-sdk-doc.ts. NOT invented. Injected into the rewriting agents.
  export const PLATFORM_DATA_CAPABILITIES = [
    'AVAILABLE PLATFORM DATA — ground every improvement in these signals ONLY; do not invent unavailable data sources:',
    '- OHLCV candles (open/high/low/close/volume) per bar.',
    '- Open interest with trend (open interest rising / falling / flat).',
    '- Long and short liquidations (liquidation volume per side; cascade risk).',
    '- Funding rate (a funding extreme signals crowded positioning).',
    '- Taker buy/sell volume (taker delta / CVD — aggressive-flow confirmation).',
    'Execution, fills, leverage and risk-sizing stay runner-owned — never prescribe them.',
  ].join('\n');
  ```
- [ ] **GREEN — wire** `src/mastra/agents/strategy-refiner.agent.ts` (export the grounded INSTRUCTIONS, keep id + factory):
  ```ts
  import { Agent } from '@mastra/core/agent';
  import type { ProviderModel } from '../../adapters/llm/model-provider.ts';
  import { PLATFORM_DATA_CAPABILITIES } from './platform-data-capabilities.ts';

  export const STRATEGY_REFINER_AGENT_ID = 'strategy-refiner';

  const BASE_INSTRUCTIONS = [
    'You are a trading-strategy refiner. You are given an original strategy description and a critic\'s findings.',
    'Rewrite the strategy DESCRIPTION so it addresses the findings — add the missing regime filter, an explicit',
    'invalidation condition, and the liquidity / BTC-dependence caveats the critic raised.',
    'Write `improvedStrategyText` in the SAME language as the input. Keep risk sizing, order execution, and fills',
    'OUT of scope — those are owned by the runner/platform; do not propose live execution.',
    'Also emit a short `changeLog` listing each change you made. Do not invent facts; if the critic flagged missing',
    'data, reflect that as an explicit caveat rather than a fabricated value.',
    'Ground every proposed improvement in the available platform signals below; do not reference data the platform cannot provide.',
  ].join(' ');

  export const STRATEGY_REFINER_INSTRUCTIONS = `${BASE_INSTRUCTIONS}\n\n${PLATFORM_DATA_CAPABILITIES}`;

  export function createStrategyRefinerAgent(model: ProviderModel): Agent {
    return new Agent({ id: STRATEGY_REFINER_AGENT_ID, name: 'Strategy Refiner', instructions: STRATEGY_REFINER_INSTRUCTIONS, model });
  }
  ```
- [ ] **GREEN — wire** `src/mastra/agents/strategy-critic-combined.agent.ts`:
  ```ts
  import { Agent } from '@mastra/core/agent';
  import type { ProviderModel } from '../../adapters/llm/model-provider.ts';
  import { PLATFORM_DATA_CAPABILITIES } from './platform-data-capabilities.ts';

  export const STRATEGY_CRITIC_COMBINED_AGENT_ID = 'strategy-critic-combined';

  const BASE_INSTRUCTIONS = [
    'You are a ruthless market opponent who, in a single pass, critiques a trading-strategy idea AND produces an',
    'improved version of it. First attack the idea: find 5 to 10 weak points (`vulnerabilities`), separate fact from',
    'interpretation (`selfDeception`), categorize risk into market / timing / news / liquidity / BTC-regime / exhaustion',
    '(`risks`), name at most 3 earliest break signs (`earlyBreakSigns`), and list at most 5 pre-entry checks (`preEntryChecks`).',
    'Give a terse verdict (`verdict`): main vulnerability, severity (low/medium/high), bad_idea vs bad_timing (or neither),',
    'and what would strengthen it. Then write `improvedStrategyText` in the SAME language as the input — addressing your',
    'own findings (regime filter, invalidation condition, liquidity / BTC caveats) — plus a short `changeLog`.',
    'Risk sizing, order execution, and fills stay runner-owned. Never invent facts; flag missing data explicitly.',
    'Ground every proposed improvement in the available platform signals below; do not reference data the platform cannot provide.',
  ].join(' ');

  export const STRATEGY_CRITIC_COMBINED_INSTRUCTIONS = `${BASE_INSTRUCTIONS}\n\n${PLATFORM_DATA_CAPABILITIES}`;

  export function createStrategyCriticCombinedAgent(model: ProviderModel): Agent {
    return new Agent({ id: STRATEGY_CRITIC_COMBINED_AGENT_ID, name: 'Strategy Critic (combined)', instructions: STRATEGY_CRITIC_COMBINED_INSTRUCTIONS, model });
  }
  ```
- [ ] **Run GREEN — expect PASS:** `pnpm vitest run src/mastra/agents/platform-data-capabilities.test.ts` and `pnpm vitest run src/mastra/agents/strategy-critic.agent.test.ts` (the existing construction test still passes; critic untouched).
- [ ] **Typecheck:** `pnpm typecheck`.
- [ ] **Commit:** `git add -A && git commit -m "feat(strategy-critic): ground refiner + combined agents in real platform data capabilities"`

---

### Task 2 — types

The shared type surface for the harness.

**Files**
- Create: `src/experiments/strategy-critic/types.ts`
- Test: `src/experiments/strategy-critic/types.test.ts`

**Interfaces**
- Produces: `Direction`, `AspectGroup`, `CriticEvalCase`, `Candidate` (discriminated union), `CheckResult`, `ScoreResult`, `CandidateError`/`CandidateErrorType`, `JudgeVerdict`+`JudgeVerdictSchema`, `Stats`, `CandidateResult`, `ModelAggregate`, `EvalRunResult`, `EvalMode`, `ManifestMeta`.
- Consumes: `StrategyRefinement` from `src/domain/strategy-critic.ts`.

Steps:

- [ ] **RED — write** `src/experiments/strategy-critic/types.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';

  const VALID: JudgeVerdict = {
    dimensions: [{ name: 'strengthens-weaknesses', score: 0.8, rationale: 'addressed crowding' }],
    overallScore: 0.75,
    hallucinations: [],
    missing: ['no explicit invalidation'],
    notes: 'solid',
  };

  describe('JudgeVerdictSchema', () => {
    it('round-trips a valid verdict', () => {
      expect(JudgeVerdictSchema.parse(VALID)).toEqual(VALID);
    });
    it('rejects an out-of-range overallScore', () => {
      expect(JudgeVerdictSchema.safeParse({ ...VALID, overallScore: 1.5 }).success).toBe(false);
    });
    it('rejects a missing required field', () => {
      const { notes, ...withoutNotes } = VALID;
      expect(JudgeVerdictSchema.safeParse(withoutNotes).success).toBe(false);
    });
  });
  ```
- [ ] **Run RED — expect FAIL:** `pnpm vitest run src/experiments/strategy-critic/types.test.ts` → `Failed to load url ./types.ts` (module does not exist yet).
- [ ] **GREEN — create** `src/experiments/strategy-critic/types.ts`:
  ```ts
  // src/experiments/strategy-critic/types.ts
  import { z } from 'zod';
  import type { StrategyRefinement } from '../../domain/strategy-critic.ts';

  export type Direction = 'long' | 'short';
  export type EvalMode = 'dry-run' | 'run';

  /** A data-grounded expected improvement. Satisfied when ANY of `any` (regex sources) matches (case-insensitive). */
  export interface AspectGroup {
    label: string;
    weight: number;
    any: string[];
  }

  export interface CriticEvalCase {
    id: string;
    text: string;
    lang: 'ru' | 'en';
    direction: Direction;
    expectedAspects: AspectGroup[];
  }

  export type Candidate =
    | { mode: 'single'; label: string; combinedModel: string }
    | { mode: 'two_stage'; label: string; criticModel: string; refinerModel: string };

  export interface CheckResult {
    id: string;
    weight: number;
    hit: boolean;
    matched: string[];
  }

  export interface ScoreResult {
    gates: { schemaValid: boolean; directionPreserved: boolean; noRunnerOverreach: boolean; nonTrivialChange: boolean };
    checks: CheckResult[];
    score: number; // 0..1 weighted aspect coverage
    threshold: number;
    verdict: 'PASS' | 'FAIL';
  }

  export type CandidateErrorType = 'schema' | 'provider' | 'adapter' | 'timeout' | 'unknown';
  export interface CandidateError {
    type: CandidateErrorType;
    message: string;
  }

  export const JudgeVerdictSchema = z.object({
    dimensions: z.array(z.object({ name: z.string(), score: z.number().min(0).max(1), rationale: z.string() })),
    overallScore: z.number().min(0).max(1),
    hallucinations: z.array(z.string()),
    missing: z.array(z.string()),
    notes: z.string(),
  });
  export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

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
  }

  export interface Stats {
    mean: number;
    median: number;
    std: number; // population std; n === 1 -> 0
    min: number;
    max: number;
  }

  export interface ModelAggregate {
    label: string;
    mode: 'single' | 'two_stage';
    criticModel: string;
    refinerModel: string | null;
    runs: { total: number; ok: number; failed: number; failedByType: Record<string, number> };
    passRate: number;
    det: Stats | null;
    judge: Stats | null;
    latency: { mean: number; median: number };
  }

  export interface EvalRunResult {
    threshold: number;
    repeat: number;
    judgeEnabled: boolean;
    candidates: Candidate[];
    cases: string[]; // case ids
    perCandidate: CandidateResult[]; // flat: every run, candidate-major then case then run index
    aggregates: ModelAggregate[];    // one per candidate (keyed by label)
    overallSuccess: boolean;         // >=1 run (any candidate) with verdict PASS
  }

  export interface ManifestMeta {
    timestamp: string;
    gitSha: string;
    harnessVersion: string;
    contractVersion: string;
    mode: EvalMode;
  }
  ```
- [ ] **Run GREEN — expect PASS:** `pnpm vitest run src/experiments/strategy-critic/types.test.ts`.
- [ ] **Typecheck:** `pnpm typecheck`.
- [ ] **Commit:** `git add -A && git commit -m "feat(strategy-critic): eval-harness type surface (Candidate, ScoreResult, JudgeVerdict, ...)"`

---

### Task 3 — fixtures

The 2 real cases + canned `StrategyRefinement` objects for offline scorer/aggregate tests.

**Files**
- Create: `src/experiments/strategy-critic/fixtures.ts`, `src/experiments/strategy-critic/__fixtures__/refinements.ts`
- Test: `src/experiments/strategy-critic/fixtures.test.ts`

**Interfaces**
- Produces: `CRITIC_EVAL_CASES: Record<string, CriticEvalCase>`, `resolveCase(id): CriticEvalCase`; canned refinements `GOOD_PUMP_SHORT_REFINEMENT`, `WRONG_DIRECTION_REFINEMENT`, `LOW_COVERAGE_REFINEMENT`, `RUNNER_OVERREACH_REFINEMENT` (all typed `StrategyRefinement`).
- Consumes: `AspectGroup`/`CriticEvalCase` (types.ts), `StrategyRefinement`/`StrategyRefinementSchema` (domain).

Steps:

- [ ] **RED — write** `src/experiments/strategy-critic/fixtures.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { CRITIC_EVAL_CASES, resolveCase } from './fixtures.ts';
  import { StrategyRefinementSchema } from '../../domain/strategy-critic.ts';
  import {
    GOOD_PUMP_SHORT_REFINEMENT,
    WRONG_DIRECTION_REFINEMENT,
    LOW_COVERAGE_REFINEMENT,
    RUNNER_OVERREACH_REFINEMENT,
  } from './__fixtures__/refinements.ts';

  describe('CRITIC_EVAL_CASES', () => {
    it('has the two real cases with the right direction + RU lang', () => {
      expect(resolveCase('pump-short')).toMatchObject({ direction: 'short', lang: 'ru', text: 'шорт после пампа от 10% за 20 минут' });
      expect(resolveCase('dump-long')).toMatchObject({ direction: 'long', lang: 'ru', text: 'лонг после дампа от 10% за 20 минут' });
    });
    it('every case enumerates weighted, non-empty expected aspects', () => {
      for (const c of Object.values(CRITIC_EVAL_CASES)) {
        expect(c.expectedAspects.length).toBeGreaterThanOrEqual(6);
        for (const a of c.expectedAspects) {
          expect(a.weight).toBeGreaterThan(0);
          expect(a.any.length).toBeGreaterThan(0);
        }
      }
    });
    it('resolveCase throws on an unknown id', () => {
      expect(() => resolveCase('nope')).toThrow(/unknown critic eval case/);
    });
  });

  describe('canned refinements', () => {
    it('all four are StrategyRefinementSchema-valid (intended failures are gate/coverage, not schema)', () => {
      for (const r of [GOOD_PUMP_SHORT_REFINEMENT, WRONG_DIRECTION_REFINEMENT, LOW_COVERAGE_REFINEMENT, RUNNER_OVERREACH_REFINEMENT]) {
        expect(StrategyRefinementSchema.safeParse(r).success).toBe(true);
      }
    });
    it('carries its intended-failure marker in improvedStrategyText', () => {
      expect(WRONG_DIRECTION_REFINEMENT.improvedStrategyText.toLowerCase()).toContain('лонг'); // flipped away from short
      expect(WRONG_DIRECTION_REFINEMENT.improvedStrategyText.toLowerCase()).not.toContain('шорт');
      expect(RUNNER_OVERREACH_REFINEMENT.improvedStrategyText.toLowerCase()).toMatch(/плеч|10x|\$\s*\d/);
      expect(LOW_COVERAGE_REFINEMENT.improvedStrategyText.toLowerCase()).toContain('taker');
    });
  });
  ```
- [ ] **Run RED — expect FAIL:** `pnpm vitest run src/experiments/strategy-critic/fixtures.test.ts` → `Failed to load url ./fixtures.ts`.
- [ ] **GREEN — create** `src/experiments/strategy-critic/fixtures.ts`:
  ```ts
  // src/experiments/strategy-critic/fixtures.ts
  import type { AspectGroup, CriticEvalCase } from './types.ts';

  // Data-grounded expected-improvement groups (keyword/regex; RU + EN synonyms).
  const TAKER_FLOW: AspectGroup = { label: 'taker-flow', weight: 1, any: ['taker', 'тейкер', '\\bcvd\\b', 'delta', 'дельт', 'агресс'] };
  const OI_TREND: AspectGroup = { label: 'oi-trend', weight: 1, any: ['\\boi\\b', 'open[ _]?interest', 'открыт\\w*\\s+интерес', 'интерес'] };
  const FUNDING: AspectGroup = { label: 'funding', weight: 1, any: ['funding', 'фандинг', 'финансир'] };
  const LIQUIDATION: AspectGroup = { label: 'liquidation', weight: 1, any: ['liquidation', '\\bliq\\b', 'ликвидац', 'каскад'] };
  const INVALIDATION: AspectGroup = { label: 'invalidation', weight: 1, any: ['invalidat', 'инвалидац', '\\bstop\\b', 'стоп', 'уровень\\s+отмен', 'отмен\\w*\\s+сетап'] };
  const TIMEFRAME: AspectGroup = { label: 'timeframe', weight: 1, any: ['timeframe', 'таймфрейм', 'holding', 'удержан', 'свеч', 'минут', '\\bm5\\b', '\\bm15\\b', 'окно'] };

  const ASPECTS: AspectGroup[] = [TAKER_FLOW, OI_TREND, FUNDING, LIQUIDATION, INVALIDATION, TIMEFRAME];

  export const CRITIC_EVAL_CASES: Record<string, CriticEvalCase> = {
    'pump-short': {
      id: 'pump-short',
      text: 'шорт после пампа от 10% за 20 минут',
      lang: 'ru',
      direction: 'short',
      expectedAspects: ASPECTS,
    },
    'dump-long': {
      id: 'dump-long',
      text: 'лонг после дампа от 10% за 20 минут',
      lang: 'ru',
      direction: 'long',
      expectedAspects: ASPECTS,
    },
  };

  export function resolveCase(id: string): CriticEvalCase {
    const c = CRITIC_EVAL_CASES[id];
    if (!c) throw new Error(`unknown critic eval case "${id}" (known: ${Object.keys(CRITIC_EVAL_CASES).join(', ')})`);
    return c;
  }
  ```
- [ ] **GREEN — create** `src/experiments/strategy-critic/__fixtures__/refinements.ts`:
  ```ts
  // src/experiments/strategy-critic/__fixtures__/refinements.ts
  import type { StrategyRefinement } from '../../../domain/strategy-critic.ts';

  // All four are paired with the `pump-short` case (direction = 'short').
  const BASE_CRITIQUE = {
    vulnerabilities: ['Vague entry trigger', 'No confirmation signal', 'No invalidation level'],
    selfDeception: [],
    risks: { market: 'n/a', timing: 'n/a', news: 'n/a', liquidity: 'n/a', btcRegime: 'n/a', exhaustion: 'n/a' },
    earlyBreakSigns: [],
    preEntryChecks: [],
    verdict: { mainVulnerability: 'no confirmation', severity: 'medium' as const, badIdeaOrBadTiming: 'bad_timing' as const, whatWouldStrengthen: 'add flow confirmation' },
  };

  /** GOOD: short preserved, no overreach, covers every aspect -> PASS. */
  export const GOOD_PUMP_SHORT_REFINEMENT: StrategyRefinement = {
    ...BASE_CRITIQUE,
    improvedStrategyText:
      'Шорт после пампа от 10% за 20 минут на таймфрейме M5. Подтверждаем разворот по taker delta (CVD слабеет, ' +
      'агрессивные покупки иссякают) и по динамике open interest (перегретый long). Фандинг на экстремуме усиливает сигнал. ' +
      'Учитываем риск каскада long-ликвидаций. Уровень инвалидации сетапа — новый максимум выше пика пампа, стоп за ним. ' +
      'Окно удержания ограничено несколькими барами M5.',
    changeLog: ['added taker/CVD confirmation', 'added OI trend filter', 'added funding extreme', 'added liquidation cascade caveat', 'added invalidation level', 'added timeframe/holding window'],
  };

  /** GATE FAIL — direction flipped to long (no short marker) -> directionPreserved=false. */
  export const WRONG_DIRECTION_REFINEMENT: StrategyRefinement = {
    ...BASE_CRITIQUE,
    improvedStrategyText:
      'Вместо контр-тренда рекомендую вход в лонг (buy) после разворота вверх на таймфрейме M5. ' +
      'Подтверждение по taker delta и CVD, динамика open interest, фандинг, риск ликвидаций, уровень инвалидации (стоп), окно удержания.',
    changeLog: ['flipped to long'],
  };

  /** LOW COVERAGE — short preserved, no overreach, but only taker-flow is addressed -> coverage < threshold. */
  export const LOW_COVERAGE_REFINEMENT: StrategyRefinement = {
    ...BASE_CRITIQUE,
    improvedStrategyText:
      'Шорт после резкого роста на 10 процентов, добавим подтверждение входа по taker delta и cvd как единственный фильтр агрессивного потока.',
    changeLog: ['added taker confirmation only'],
  };

  /** RUNNER OVERREACH — covers aspects + short preserved, but prescribes leverage / base size -> noRunnerOverreach=false. */
  export const RUNNER_OVERREACH_REFINEMENT: StrategyRefinement = {
    ...BASE_CRITIQUE,
    improvedStrategyText:
      'Шорт после пампа от 10% за 20 минут на M5. Подтверждение по taker delta/CVD, open interest, фандинг, ликвидации, ' +
      'уровень инвалидации (стоп), окно удержания. Вход с плечом 10x, базовый ордер $100, риск 2% от депозита.',
    changeLog: ['added confirmations', 'added sizing (overreach)'],
  };
  ```
- [ ] **Run GREEN — expect PASS:** `pnpm vitest run src/experiments/strategy-critic/fixtures.test.ts`.
- [ ] **Typecheck:** `pnpm typecheck`.
- [ ] **Commit:** `git add -A && git commit -m "feat(strategy-critic): eval fixtures (2 real RU cases + canned refinements)"`

---

### Task 4 — scoring

Deterministic, offline scorer over `improvedStrategyText`.

**Files**
- Create: `src/experiments/strategy-critic/scoring.ts`
- Test: `src/experiments/strategy-critic/scoring.test.ts`

**Interfaces**
- Produces: `DEFAULT_THRESHOLD = 0.6`; `scoreRefinement(refinement: StrategyRefinement, evalCase: CriticEvalCase, opts?: { threshold?: number }): ScoreResult`.
- Consumes: `StrategyRefinement`/`StrategyRefinementSchema` (domain), `CriticEvalCase`/`CheckResult`/`ScoreResult` (types.ts), the canned refinements + `resolveCase` (fixtures).

Steps:

- [ ] **RED — write** `src/experiments/strategy-critic/scoring.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { scoreRefinement, DEFAULT_THRESHOLD } from './scoring.ts';
  import { resolveCase } from './fixtures.ts';
  import {
    GOOD_PUMP_SHORT_REFINEMENT,
    WRONG_DIRECTION_REFINEMENT,
    LOW_COVERAGE_REFINEMENT,
    RUNNER_OVERREACH_REFINEMENT,
  } from './__fixtures__/refinements.ts';

  const CASE = resolveCase('pump-short');

  describe('scoreRefinement', () => {
    it('defaults the threshold to 0.6', () => {
      expect(DEFAULT_THRESHOLD).toBe(0.6);
      expect(scoreRefinement(GOOD_PUMP_SHORT_REFINEMENT, CASE).threshold).toBe(0.6);
    });
    it('PASSes a good refinement (all gates + full coverage)', () => {
      const r = scoreRefinement(GOOD_PUMP_SHORT_REFINEMENT, CASE);
      expect(r.gates).toEqual({ schemaValid: true, directionPreserved: true, noRunnerOverreach: true, nonTrivialChange: true });
      expect(r.score).toBeGreaterThanOrEqual(0.6);
      expect(r.verdict).toBe('PASS');
    });
    it('FAILs when direction is not preserved', () => {
      const r = scoreRefinement(WRONG_DIRECTION_REFINEMENT, CASE);
      expect(r.gates.directionPreserved).toBe(false);
      expect(r.verdict).toBe('FAIL');
    });
    it('FAILs on runner overreach (leverage / base size)', () => {
      const r = scoreRefinement(RUNNER_OVERREACH_REFINEMENT, CASE);
      expect(r.gates.noRunnerOverreach).toBe(false);
      expect(r.verdict).toBe('FAIL');
    });
    it('FAILs on low aspect coverage even when all gates pass', () => {
      const r = scoreRefinement(LOW_COVERAGE_REFINEMENT, CASE);
      expect(r.gates.directionPreserved).toBe(true);
      expect(r.gates.noRunnerOverreach).toBe(true);
      expect(r.gates.nonTrivialChange).toBe(true);
      expect(r.score).toBeLessThan(0.6);
      expect(r.verdict).toBe('FAIL');
    });
  });
  ```
- [ ] **Run RED — expect FAIL:** `pnpm vitest run src/experiments/strategy-critic/scoring.test.ts` → `Failed to load url ./scoring.ts`.
- [ ] **GREEN — create** `src/experiments/strategy-critic/scoring.ts`:
  ```ts
  // src/experiments/strategy-critic/scoring.ts
  import { StrategyRefinementSchema, type StrategyRefinement } from '../../domain/strategy-critic.ts';
  import type { CheckResult, CriticEvalCase, Direction, ScoreResult } from './types.ts';

  export const DEFAULT_THRESHOLD = 0.6;

  // Runner-owned authorities the refinement must NOT prescribe (mirrors the analyst risk gate).
  // Leverage requires >=2x OR the explicit word, so DCA size hints (1.2x/1.5x) are NOT flagged.
  const FAB_PATTERNS: RegExp[] = [
    /(?<![.\d])\b(?:[2-9]|\d{2,})(?:\.\d+)?\s*[x×]\b/i, // leverage >= 2x
    /leverage\s*[:=]?\s*\d/i,
    /плеч\w*\s*[:=]?\s*\d/i,
    /\$\s*\d|\b\d+\s*(?:usd|usdt|dollars?)\b|base[ _]?order\s*[:=]?\s*\d/i,
    /\b\d+(?:\.\d+)?\s*%\s*(?:of\s+)?(?:equity|account|balance|capital|portfolio|deposit|депозит)/i,
  ];

  const DIRECTION_MARKERS: Record<Direction, RegExp> = {
    long: /\b(long|лонг|buy)\b/i,
    short: /\b(short|шорт|sell)\b/i,
  };

  function tokenize(text: string): Set<string> {
    return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3));
  }

  /** Materially different from the case text: length grew >=20% AND >=5 new tokens. */
  function nonTrivialChange(improved: string, original: string): boolean {
    if (improved.trim().length < original.trim().length * 1.2) return false;
    const before = tokenize(original);
    const added = [...tokenize(improved)].filter((t) => !before.has(t));
    return added.length >= 5;
  }

  export function scoreRefinement(
    refinement: StrategyRefinement,
    evalCase: CriticEvalCase,
    opts?: { threshold?: number },
  ): ScoreResult {
    const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
    const improved = refinement.improvedStrategyText;

    const schemaValid = StrategyRefinementSchema.safeParse(refinement).success;
    const directionPreserved = DIRECTION_MARKERS[evalCase.direction].test(improved);
    const noRunnerOverreach = !FAB_PATTERNS.some((re) => re.test(improved));
    const nonTrivial = nonTrivialChange(improved, evalCase.text);
    const gates = { schemaValid, directionPreserved, noRunnerOverreach, nonTrivialChange: nonTrivial };

    const haystack = [improved, ...(refinement.changeLog ?? [])].join(' • ').toLowerCase();
    const checks: CheckResult[] = evalCase.expectedAspects.map((aspect) => {
      const matched = aspect.any.filter((src) => new RegExp(src, 'i').test(haystack));
      return { id: aspect.label, weight: aspect.weight, hit: matched.length > 0, matched };
    });

    const totalWeight = evalCase.expectedAspects.reduce((s, a) => s + a.weight, 0);
    const hitWeight = checks.reduce((s, c) => s + (c.hit ? c.weight : 0), 0);
    const score = totalWeight > 0 ? hitWeight / totalWeight : 0;

    const gatesPass = schemaValid && directionPreserved && noRunnerOverreach && nonTrivial;
    const verdict = gatesPass && score >= threshold ? 'PASS' : 'FAIL';
    return { gates, checks, score, threshold, verdict };
  }
  ```
- [ ] **Run GREEN — expect PASS:** `pnpm vitest run src/experiments/strategy-critic/scoring.test.ts`.
- [ ] **Typecheck:** `pnpm typecheck`.
- [ ] **Commit:** `git add -A && git commit -m "feat(strategy-critic): deterministic offline scorer (gates + weighted aspect coverage)"`

---

### Task 5 — judge

Best-effort opus judge agent + prompt builder.

**Files**
- Create: `src/experiments/strategy-critic/judge.ts`, `src/mastra/agents/strategy-critic-judge.agent.ts`
- Test: `src/experiments/strategy-critic/judge.test.ts`, `src/mastra/agents/strategy-critic-judge.agent.test.ts`

**Interfaces**
- Produces: `JudgeInput { originalText: string; refinement: StrategyRefinement }`, `buildJudgePrompt(input): string`, `runJudge(agent, input): Promise<JudgeVerdict>`; `STRATEGY_CRITIC_JUDGE_AGENT_ID = 'strategy-critic-judge'`, `STRATEGY_CRITIC_JUDGE_INSTRUCTIONS`, `createStrategyCriticJudgeAgent(model: ProviderModel): Agent`.
- Consumes: `JudgeVerdictSchema`/`JudgeVerdict` (types.ts), `StrategyRefinement` (domain), `Agent` (`@mastra/core/agent`), `ProviderModel` + `resolveLanguageModel` (model-provider).

Steps:

- [ ] **RED — write** `src/mastra/agents/strategy-critic-judge.agent.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { resolveLanguageModel } from '../../adapters/llm/model-provider.ts';
  import { createStrategyCriticJudgeAgent, STRATEGY_CRITIC_JUDGE_AGENT_ID } from './strategy-critic-judge.agent.ts';

  const { model } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-opus-4-6');

  describe('strategy-critic-judge agent (construction)', () => {
    it('builds the judge agent with its id + name', () => {
      expect(STRATEGY_CRITIC_JUDGE_AGENT_ID).toBe('strategy-critic-judge');
      expect(createStrategyCriticJudgeAgent(model).name).toBe('Strategy Critic Judge');
    });
  });
  ```
- [ ] **RED — write** `src/experiments/strategy-critic/judge.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { buildJudgePrompt } from './judge.ts';
  import { GOOD_PUMP_SHORT_REFINEMENT } from './__fixtures__/refinements.ts';

  describe('buildJudgePrompt', () => {
    it('embeds the original text and the candidate refinement JSON', () => {
      const prompt = buildJudgePrompt({ originalText: 'шорт после пампа от 10% за 20 минут', refinement: GOOD_PUMP_SHORT_REFINEMENT });
      expect(prompt).toContain('шорт после пампа от 10% за 20 минут');
      expect(prompt).toContain(GOOD_PUMP_SHORT_REFINEMENT.improvedStrategyText);
      expect(prompt).toContain('Return the structured judge verdict.');
    });
  });
  ```
- [ ] **Run RED — expect FAIL:** `pnpm vitest run src/mastra/agents/strategy-critic-judge.agent.test.ts src/experiments/strategy-critic/judge.test.ts` → `Failed to load url ./strategy-critic-judge.agent.ts` / `./judge.ts`.
- [ ] **GREEN — create** `src/mastra/agents/strategy-critic-judge.agent.ts`:
  ```ts
  // src/mastra/agents/strategy-critic-judge.agent.ts
  import { Agent } from '@mastra/core/agent';
  import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

  export const STRATEGY_CRITIC_JUDGE_AGENT_ID = 'strategy-critic-judge';

  export const STRATEGY_CRITIC_JUDGE_INSTRUCTIONS = [
    'You are evaluating a candidate strategy REFINEMENT produced by another model, given the original vague strategy text.',
    'Score each rubric dimension from 0 to 1 with a short rationale:',
    'did it strengthen the REAL weaknesses of the idea;',
    'did it add the missing nuances grounded in AVAILABLE data (OHLCV; open interest + trend; long/short liquidations; funding rate; taker buy/sell -> delta/CVD);',
    'did it AVOID inventing facts or unavailable data sources;',
    'is the strategy still analyzable and buildable with NO runner overreach (no leverage / base-order sizing / equity %).',
    'List any invented or unavailable-data claims (`hallucinations`) and any weaknesses it failed to address (`missing`).',
    'Be strict and concise. Do not rewrite the strategy; only assess.',
  ].join(' ');

  export function createStrategyCriticJudgeAgent(model: ProviderModel): Agent {
    return new Agent({ id: STRATEGY_CRITIC_JUDGE_AGENT_ID, name: 'Strategy Critic Judge', instructions: STRATEGY_CRITIC_JUDGE_INSTRUCTIONS, model });
  }
  ```
- [ ] **GREEN — create** `src/experiments/strategy-critic/judge.ts`:
  ```ts
  // src/experiments/strategy-critic/judge.ts
  import type { Agent } from '@mastra/core/agent';
  import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
  import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';

  export interface JudgeInput {
    originalText: string;
    refinement: StrategyRefinement;
  }

  export function buildJudgePrompt(input: JudgeInput): string {
    return [
      '--- ORIGINAL STRATEGY TEXT START ---',
      input.originalText,
      '--- ORIGINAL STRATEGY TEXT END ---',
      '',
      '--- CANDIDATE REFINEMENT (JSON) START ---',
      JSON.stringify(input.refinement, null, 2),
      '--- CANDIDATE REFINEMENT END ---',
      '',
      'Return the structured judge verdict.',
    ].join('\n');
  }

  export async function runJudge(agent: Agent, input: JudgeInput): Promise<JudgeVerdict> {
    const result = await agent.generate(buildJudgePrompt(input), { structuredOutput: { schema: JudgeVerdictSchema } });
    return JudgeVerdictSchema.parse(result.object);
  }
  ```
- [ ] **Run GREEN — expect PASS:** `pnpm vitest run src/mastra/agents/strategy-critic-judge.agent.test.ts src/experiments/strategy-critic/judge.test.ts`.
- [ ] **Typecheck:** `pnpm typecheck`.
- [ ] **Commit:** `git add -A && git commit -m "feat(strategy-critic): best-effort judge agent + prompt/runner"`

---

### Task 6 — eval-harness

`runOnce` + `runEval` over candidates × cases × repeat.

**Files**
- Create: `src/experiments/strategy-critic/eval-harness.ts`
- Test: `src/experiments/strategy-critic/eval-harness.test.ts`

**Interfaces**
- Produces:
  - `RunEvalInput { candidates: Candidate[]; cases: CriticEvalCase[]; threshold: number; repeat?: number }`
  - `RunEvalDeps { criticFor: (candidate: Candidate) => StrategyCriticPort; providerOf: (modelId: string) => { provider: string; modelId: string }; clock: () => number; judge?: (refinement: StrategyRefinement, evalCase: CriticEvalCase) => Promise<JudgeVerdict> }`
  - `classifyError(err: unknown): CandidateError`
  - `runOnce(candidate: Candidate, evalCase: CriticEvalCase, input: RunEvalInput, deps: RunEvalDeps): Promise<CandidateResult>`
  - `runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult>`
- Consumes: `StrategyCriticPort` (port), `StrategyRefinement` (domain), `scoreRefinement` (scoring), `aggregateRuns` (aggregate — created in Task 7), types.

> NOTE: Task 7 creates `aggregate.ts`. To keep this task's RED/GREEN self-contained, define a **temporary local `aggregateRuns`** stub at the bottom of `eval-harness.ts` now and DELETE it in Task 7 when the real module lands (the import switch is part of Task 7). The stub returns a minimally-correct `ModelAggregate` so the harness tests pass.

Steps:

- [ ] **RED — write** `src/experiments/strategy-critic/eval-harness.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { runEval, runOnce } from './eval-harness.ts';
  import type { RunEvalDeps, RunEvalInput } from './eval-harness.ts';
  import type { StrategyCriticPort } from '../../ports/strategy-critic.port.ts';
  import type { StrategyCriticInput, StrategyRefinement } from '../../domain/strategy-critic.ts';
  import type { Candidate, CriticEvalCase, JudgeVerdict } from './types.ts';
  import { resolveCase } from './fixtures.ts';
  import { GOOD_PUMP_SHORT_REFINEMENT } from './__fixtures__/refinements.ts';

  const CAND: Candidate = { mode: 'two_stage', label: 'two_stage:critic=c,refiner=r', criticModel: 'c', refinerModel: 'r' };
  const CASE: CriticEvalCase = resolveCase('pump-short');

  function fakeCritic(out: StrategyRefinement): StrategyCriticPort {
    return { adapter: 'fake', mode: 'two_stage', model: 'c', async refine(_i: StrategyCriticInput): Promise<StrategyRefinement> { return out; } };
  }
  function throwingCritic(message: string): StrategyCriticPort {
    return { adapter: 'fake', mode: 'two_stage', model: 'c', async refine(): Promise<StrategyRefinement> { throw new Error(message); } };
  }
  function flakyCritic(failTimes: number, out: StrategyRefinement): StrategyCriticPort {
    let n = 0;
    return { adapter: 'fake', mode: 'two_stage', model: 'c', async refine(): Promise<StrategyRefinement> { n += 1; if (n <= failTimes) throw new Error('schema validation failed'); return out; } };
  }

  const baseInput: RunEvalInput = { candidates: [CAND], cases: [CASE], threshold: 0.6 };

  function deps(critic: StrategyCriticPort, judge?: (r: StrategyRefinement, c: CriticEvalCase) => Promise<JudgeVerdict>): RunEvalDeps {
    let tick = 0;
    return {
      criticFor: () => critic,
      providerOf: (m: string) => ({ provider: 'fake', modelId: m }),
      clock: () => (tick += 100),
      judge,
    };
  }

  describe('runOnce / runEval', () => {
    it('passes the case text as manual_description and scores PASS for a good refinement', async () => {
      let seen: StrategyCriticInput | undefined;
      const capturing: StrategyCriticPort = { adapter: 'fake', mode: 'two_stage', model: 'c', async refine(i) { seen = i; return GOOD_PUMP_SHORT_REFINEMENT; } };
      const r = await runOnce(CAND, CASE, baseInput, deps(capturing));
      expect(seen).toEqual({ kind: 'manual_description', content: CASE.text, title: CASE.id });
      expect(r.verdict).toBe('PASS');
      expect(r.label).toBe(CAND.label);
      expect(r.criticModel).toBe('c');
      expect(r.refinerModel).toBe('r');
      expect(r.caseId).toBe('pump-short');
    });

    it('isolates a throwing critic: FAIL + classified error, score null', async () => {
      const result = await runEval(baseInput, deps(throwingCritic('schema validation failed')));
      const only = result.perCandidate[0]!;
      expect(only.verdict).toBe('FAIL');
      expect(only.score).toBeNull();
      expect(only.rawOutput).toBeNull();
      expect(only.error).toEqual({ type: 'schema', message: 'schema validation failed' });
      expect(result.overallSuccess).toBe(false);
    });

    it('classifies a timeout error', async () => {
      const result = await runEval(baseInput, deps(throwingCritic('request timed out after 30s')));
      expect(result.perCandidate[0]!.error!.type).toBe('timeout');
    });

    it('runs an injected judge but never lets it change the verdict', async () => {
      const verdict: JudgeVerdict = { dimensions: [], overallScore: 0.9, hallucinations: [], missing: [], notes: 'ok' };
      const result = await runEval(baseInput, deps(fakeCritic(GOOD_PUMP_SHORT_REFINEMENT), async () => verdict));
      expect(result.judgeEnabled).toBe(true);
      expect(result.perCandidate[0]!.judge).toEqual(verdict);
      expect(result.perCandidate[0]!.verdict).toBe('PASS');
    });

    it('a throwing judge leaves the candidate PASS with judge null (best-effort)', async () => {
      const result = await runEval(baseInput, deps(fakeCritic(GOOD_PUMP_SHORT_REFINEMENT), async () => { throw new Error('judge boom'); }));
      expect(result.perCandidate[0]!.verdict).toBe('PASS');
      expect(result.perCandidate[0]!.judge).toBeNull();
    });

    it('iterates candidates × cases × repeat sequentially', async () => {
      const result = await runEval(
        { candidates: [CAND], cases: [resolveCase('pump-short'), resolveCase('dump-long')], threshold: 0.6, repeat: 2 },
        deps(flakyCritic(1, GOOD_PUMP_SHORT_REFINEMENT)),
      );
      expect(result.repeat).toBe(2);
      expect(result.perCandidate).toHaveLength(4); // 1 candidate × 2 cases × 2 repeats
      expect(result.cases).toEqual(['pump-short', 'dump-long']);
      expect(result.aggregates).toHaveLength(1);
    });
  });
  ```
- [ ] **Run RED — expect FAIL:** `pnpm vitest run src/experiments/strategy-critic/eval-harness.test.ts` → `Failed to load url ./eval-harness.ts`.
- [ ] **GREEN — create** `src/experiments/strategy-critic/eval-harness.ts`:
  ```ts
  // src/experiments/strategy-critic/eval-harness.ts
  import type { StrategyCriticPort } from '../../ports/strategy-critic.port.ts';
  import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
  import { scoreRefinement } from './scoring.ts';
  import type { Candidate, CandidateError, CandidateResult, CriticEvalCase, EvalRunResult, JudgeVerdict, ModelAggregate, Stats } from './types.ts';

  export interface RunEvalInput {
    candidates: Candidate[];
    cases: CriticEvalCase[];
    threshold: number;
    repeat?: number; // independent runs per (candidate, case); default 1, assumed >= 1
  }

  export interface RunEvalDeps {
    criticFor: (candidate: Candidate) => StrategyCriticPort;
    providerOf: (modelId: string) => { provider: string; modelId: string };
    clock: () => number;
    judge?: (refinement: StrategyRefinement, evalCase: CriticEvalCase) => Promise<JudgeVerdict>;
  }

  export function classifyError(err: unknown): CandidateError {
    const message = err instanceof Error ? err.message : String(err);
    let type: CandidateError['type'] = 'unknown';
    if (/timeout|timed out/i.test(message)) type = 'timeout';
    else if (/schema|zod|parse|validation|invalid/i.test(message)) type = 'schema';
    else if (/api key|provider|rate limit|status|fetch|network|econn|unauthorized/i.test(message)) type = 'provider';
    return { type, message };
  }

  function criticModelOf(c: Candidate): string {
    return c.mode === 'single' ? c.combinedModel : c.criticModel;
  }
  function refinerModelOf(c: Candidate): string | null {
    return c.mode === 'two_stage' ? c.refinerModel : null;
  }

  /** One independent run: refine() -> scoreRefinement() -> (optional) judge(). Never throws. */
  export async function runOnce(candidate: Candidate, evalCase: CriticEvalCase, input: RunEvalInput, deps: RunEvalDeps): Promise<CandidateResult> {
    const criticModel = criticModelOf(candidate);
    const refinerModel = refinerModelOf(candidate);
    const start = deps.clock();
    try {
      const critic = deps.criticFor(candidate);
      const raw = await critic.refine({ kind: 'manual_description', content: evalCase.text, title: evalCase.id });
      const latencyMs = deps.clock() - start;
      const score = scoreRefinement(raw, evalCase, { threshold: input.threshold });

      let judge: JudgeVerdict | null = null;
      if (deps.judge) {
        try {
          judge = await deps.judge(raw, evalCase);
        } catch (judgeErr) {
          // Judge is best-effort and NEVER affects the deterministic verdict.
          process.stderr.write(`judge failed for ${candidate.label}/${evalCase.id}: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}\n`);
          judge = null;
        }
      }

      return { label: candidate.label, mode: candidate.mode, criticModel, refinerModel, caseId: evalCase.id, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null, judge };
    } catch (err) {
      const latencyMs = deps.clock() - start;
      return { label: candidate.label, mode: candidate.mode, criticModel, refinerModel, caseId: evalCase.id, latencyMs, verdict: 'FAIL', score: null, rawOutput: null, error: classifyError(err), judge: null };
    }
  }

  export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
    const repeat = input.repeat ?? 1;
    const perCandidate: CandidateResult[] = [];
    const aggregates: ModelAggregate[] = [];

    // Sequential, candidate-major then case then run index — no parallelism (provider rate limits).
    for (const candidate of input.candidates) {
      const runs: CandidateResult[] = [];
      for (const evalCase of input.cases) {
        for (let k = 0; k < repeat; k++) {
          const r = await runOnce(candidate, evalCase, input, deps);
          runs.push(r);
          perCandidate.push(r);
        }
      }
      aggregates.push(aggregateRuns(runs));
    }

    return {
      threshold: input.threshold,
      repeat,
      judgeEnabled: deps.judge != null,
      candidates: input.candidates,
      cases: input.cases.map((c) => c.id),
      perCandidate,
      aggregates,
      overallSuccess: perCandidate.some((r) => r.verdict === 'PASS'),
    };
  }

  // TEMPORARY stub — replaced by an import from ./aggregate.ts in Task 7.
  function aggregateRuns(runs: CandidateResult[]): ModelAggregate {
    const first = runs[0]!;
    const failed = runs.filter((r) => r.error !== null);
    const passCount = runs.filter((r) => r.verdict === 'PASS').length;
    const zero: Stats = { mean: 0, median: 0, std: 0, min: 0, max: 0 };
    const latencies = runs.map((r) => r.latencyMs);
    return {
      label: first.label,
      mode: first.mode,
      criticModel: first.criticModel,
      refinerModel: first.refinerModel,
      runs: { total: runs.length, ok: runs.length - failed.length, failed: failed.length, failedByType: {} },
      passRate: passCount / runs.length,
      det: null,
      judge: null,
      latency: { mean: latencies.reduce((a, b) => a + b, 0) / latencies.length, median: 0 },
    };
  }
  ```
- [ ] **Run GREEN — expect PASS:** `pnpm vitest run src/experiments/strategy-critic/eval-harness.test.ts`.
- [ ] **Typecheck:** `pnpm typecheck`.
- [ ] **Commit:** `git add -A && git commit -m "feat(strategy-critic): eval harness runOnce/runEval (candidates × cases × repeat, best-effort judge)"`

---

### Task 7 — aggregate

Per-candidate aggregation + ranking. Replace the temporary stub from Task 6.

**Files**
- Create: `src/experiments/strategy-critic/aggregate.ts`
- Modify: `src/experiments/strategy-critic/eval-harness.ts` (delete the temporary stub; import the real `aggregateRuns`)
- Test: `src/experiments/strategy-critic/aggregate.test.ts`

**Interfaces**
- Produces: `mean`/`median`/`std`/`quantile`; `aggregateRuns(runs: CandidateResult[]): ModelAggregate`; `rankAggregates(aggs: ModelAggregate[], judgeEnabled: boolean): ModelAggregate[]`.
- Consumes: `CandidateResult`/`ModelAggregate`/`Stats` (types.ts).

Steps:

- [ ] **RED — write** `src/experiments/strategy-critic/aggregate.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { aggregateRuns, rankAggregates } from './aggregate.ts';
  import type { CandidateResult, ModelAggregate, ScoreResult } from './types.ts';

  function score(s: number): ScoreResult {
    return { gates: { schemaValid: true, directionPreserved: true, noRunnerOverreach: true, nonTrivialChange: true }, checks: [], score: s, threshold: 0.6, verdict: s >= 0.6 ? 'PASS' : 'FAIL' };
  }
  function run(over: Partial<CandidateResult>): CandidateResult {
    return { label: 'l', mode: 'single', criticModel: 'm', refinerModel: null, caseId: 'pump-short', latencyMs: 100, verdict: 'PASS', score: score(0.8), rawOutput: null, error: null, judge: null, ...over };
  }

  describe('aggregateRuns', () => {
    it('computes runs/passRate/det over repeated runs (failed counts as non-PASS)', () => {
      const agg = aggregateRuns([
        run({}),
        run({ verdict: 'FAIL', score: null, error: { type: 'schema', message: 'x' } }),
        run({ score: score(0.8) }),
      ]);
      expect(agg.runs).toEqual({ total: 3, ok: 2, failed: 1, failedByType: { schema: 1 } });
      expect(agg.passRate).toBeCloseTo(2 / 3, 10);
      expect(agg.det!.mean).toBeCloseTo(0.8, 10);
      expect(agg.det!.std).toBe(0); // 2 identical ok scores
    });
  });

  describe('rankAggregates', () => {
    it('sorts judge-mean -> passRate -> det-mean, carrying mode + role models', () => {
      const single: ModelAggregate = { label: 'single:a', mode: 'single', criticModel: 'a', refinerModel: null, runs: { total: 1, ok: 1, failed: 0, failedByType: {} }, passRate: 0.5, det: { mean: 0.7, median: 0.7, std: 0, min: 0.7, max: 0.7 }, judge: { mean: 0.6, median: 0.6, std: 0, min: 0.6, max: 0.6 }, latency: { mean: 100, median: 100 } };
      const twoStage: ModelAggregate = { label: 'two_stage:critic=a,refiner=b', mode: 'two_stage', criticModel: 'a', refinerModel: 'b', runs: { total: 1, ok: 1, failed: 0, failedByType: {} }, passRate: 1, det: { mean: 0.9, median: 0.9, std: 0, min: 0.9, max: 0.9 }, judge: { mean: 0.9, median: 0.9, std: 0, min: 0.9, max: 0.9 }, latency: { mean: 100, median: 100 } };
      const ranked = rankAggregates([single, twoStage], true);
      expect(ranked.map((a) => a.label)).toEqual(['two_stage:critic=a,refiner=b', 'single:a']);
      expect(ranked[0]!.mode).toBe('two_stage');
      expect(ranked[0]!.refinerModel).toBe('b');
    });
  });
  ```
- [ ] **Run RED — expect FAIL:** `pnpm vitest run src/experiments/strategy-critic/aggregate.test.ts` → `Failed to load url ./aggregate.ts`.
- [ ] **GREEN — create** `src/experiments/strategy-critic/aggregate.ts`:
  ```ts
  // src/experiments/strategy-critic/aggregate.ts
  // Pure aggregation over repeated runs. No I/O. Aggregates the deterministic scores /
  // judge verdicts that scoreRefinement / judge already produced.
  import type { CandidateResult, ModelAggregate, Stats } from './types.ts';

  export function mean(xs: number[]): number {
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  export function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const n = s.length;
    const mid = Math.floor(n / 2);
    return n % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
  }

  export function std(xs: number[]): number {
    if (xs.length <= 1) return 0;
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  }

  export function quantile(xs: number[], q: number): number {
    const s = [...xs].sort((a, b) => a - b);
    if (s.length === 1) return s[0]!;
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return s[lo]!;
    return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  }

  function stats(xs: number[]): Stats {
    return { mean: mean(xs), median: median(xs), std: std(xs), min: Math.min(...xs), max: Math.max(...xs) };
  }

  /** Aggregate N independent runs of a single candidate. `runs` must be non-empty and the same label. */
  export function aggregateRuns(runs: CandidateResult[]): ModelAggregate {
    const first = runs[0]!;
    const total = runs.length;
    const failed = runs.filter((r) => r.error !== null);
    const failedByType: Record<string, number> = {};
    for (const r of failed) failedByType[r.error!.type] = (failedByType[r.error!.type] ?? 0) + 1;

    const detScores = runs.filter((r) => r.score != null).map((r) => r.score!.score);
    const judgeScores = runs.filter((r) => r.judge != null).map((r) => r.judge!.overallScore);
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
      latency: { mean: mean(latencies), median: median(latencies) },
    };
  }

  /**
   * Rank candidates: judge-mean desc (only when judge ran) -> PASS-rate desc -> det-mean desc.
   * Candidates without a judge/det mean sort last on that key. Pure; returns a new array.
   */
  export function rankAggregates(aggs: ModelAggregate[], judgeEnabled: boolean): ModelAggregate[] {
    const j = (a: ModelAggregate): number => a.judge?.mean ?? -1;
    const d = (a: ModelAggregate): number => a.det?.mean ?? -1;
    return [...aggs].sort((a, b) => {
      if (judgeEnabled) {
        const dj = j(b) - j(a);
        if (dj !== 0) return dj;
      }
      const dp = b.passRate - a.passRate;
      if (dp !== 0) return dp;
      return d(b) - d(a);
    });
  }
  ```
- [ ] **GREEN — switch the harness to the real aggregate.** In `src/experiments/strategy-critic/eval-harness.ts`: add `import { aggregateRuns } from './aggregate.ts';` near the top, and DELETE the entire temporary `function aggregateRuns(...) { ... }` block at the bottom (and the now-unused `Stats` import if it is no longer referenced).
- [ ] **Run GREEN — expect PASS:** `pnpm vitest run src/experiments/strategy-critic/aggregate.test.ts src/experiments/strategy-critic/eval-harness.test.ts` (the repeat-aggregation test in Task 6 now exercises the real `aggregateRuns`).
- [ ] **Typecheck:** `pnpm typecheck`.
- [ ] **Commit:** `git add -A && git commit -m "feat(strategy-critic): per-candidate aggregation + ranking (single vs two_stage comparable)"`

---

### Task 8 — candidate parsing

Pure CLI-arg → `Candidate[]` builder.

**Files**
- Create: `src/experiments/strategy-critic/candidates.ts`
- Test: `src/experiments/strategy-critic/candidates.test.ts`

**Interfaces**
- Produces: `BuildCandidatesArgs { mode: 'single' | 'two_stage'; models?: string[]; criticModels?: string[]; refinerModels?: string[] }`; `buildCandidates(args: BuildCandidatesArgs): Candidate[]`.
- Consumes: `Candidate` (types.ts).

Steps:

- [ ] **RED — write** `src/experiments/strategy-critic/candidates.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { buildCandidates } from './candidates.ts';

  describe('buildCandidates', () => {
    it('single: one candidate per model with stable labels', () => {
      const out = buildCandidates({ mode: 'single', models: ['a', 'b'] });
      expect(out).toEqual([
        { mode: 'single', label: 'single:a', combinedModel: 'a' },
        { mode: 'single', label: 'single:b', combinedModel: 'b' },
      ]);
    });
    it('two_stage: cross-product of critic × refiner with stable labels', () => {
      const out = buildCandidates({ mode: 'two_stage', criticModels: ['a', 'b'], refinerModels: ['x', 'y'] });
      expect(out).toHaveLength(4);
      expect(out.map((c) => c.label)).toEqual([
        'two_stage:critic=a,refiner=x',
        'two_stage:critic=a,refiner=y',
        'two_stage:critic=b,refiner=x',
        'two_stage:critic=b,refiner=y',
      ]);
      expect(out[0]).toEqual({ mode: 'two_stage', label: 'two_stage:critic=a,refiner=x', criticModel: 'a', refinerModel: 'x' });
    });
    it('throws when single is missing --models', () => {
      expect(() => buildCandidates({ mode: 'single', models: [] })).toThrow(/--models/);
    });
    it('throws when two_stage is missing --critic-models or --refiner-models', () => {
      expect(() => buildCandidates({ mode: 'two_stage', criticModels: [], refinerModels: ['x'] })).toThrow(/--critic-models/);
      expect(() => buildCandidates({ mode: 'two_stage', criticModels: ['a'], refinerModels: [] })).toThrow(/--refiner-models/);
    });
  });
  ```
- [ ] **Run RED — expect FAIL:** `pnpm vitest run src/experiments/strategy-critic/candidates.test.ts` → `Failed to load url ./candidates.ts`.
- [ ] **GREEN — create** `src/experiments/strategy-critic/candidates.ts`:
  ```ts
  // src/experiments/strategy-critic/candidates.ts
  import type { Candidate } from './types.ts';

  export interface BuildCandidatesArgs {
    mode: 'single' | 'two_stage';
    models?: string[];        // single
    criticModels?: string[];  // two_stage
    refinerModels?: string[]; // two_stage
  }

  export function buildCandidates(args: BuildCandidatesArgs): Candidate[] {
    if (args.mode === 'single') {
      const models = args.models ?? [];
      if (models.length === 0) throw new Error('--mode single requires --models (comma-separated, e.g. anthropic/claude-x,openai/gpt-x)');
      return models.map((m) => ({ mode: 'single', label: `single:${m}`, combinedModel: m }));
    }
    const critics = args.criticModels ?? [];
    const refiners = args.refinerModels ?? [];
    if (critics.length === 0) throw new Error('--mode two_stage requires --critic-models (comma-separated)');
    if (refiners.length === 0) throw new Error('--mode two_stage requires --refiner-models (comma-separated)');
    const out: Candidate[] = [];
    for (const c of critics) {
      for (const r of refiners) {
        out.push({ mode: 'two_stage', label: `two_stage:critic=${c},refiner=${r}`, criticModel: c, refinerModel: r });
      }
    }
    return out;
  }
  ```
- [ ] **Run GREEN — expect PASS:** `pnpm vitest run src/experiments/strategy-critic/candidates.test.ts`.
- [ ] **Typecheck:** `pnpm typecheck`.
- [ ] **Commit:** `git add -A && git commit -m "feat(strategy-critic): buildCandidates (single + two_stage cross-product, stable labels)"`

---

### Task 9 — real-factory + artifacts + CLI + dry-run

The paid path (import-only-under-`--run`), artifact writer, dry-run paid-gate, the CLI, and the `critic:eval` npm script.

**Files**
- Create: `src/experiments/strategy-critic/real-critic-factory.ts`, `src/experiments/strategy-critic/artifacts.ts`, `src/experiments/strategy-critic/plan.ts`, `scripts/strategy-critic-eval.ts`
- Modify: `package.json` (add `critic:eval`)
- Test: `src/experiments/strategy-critic/plan.test.ts`

**Interfaces**
- Produces:
  - `real-critic-factory.ts`: `buildRealCriticFor(baseEnv: ModelProviderEnv): (candidate: Candidate) => StrategyCriticPort`; `buildRealJudge(baseEnv: ModelProviderEnv, judgeModelId: string): (refinement: StrategyRefinement, evalCase: CriticEvalCase) => Promise<JudgeVerdict>`.
  - `plan.ts`: `KEY_BY_PROVIDER`; `PlanInput`, `DryRunPlan`, `DryRunCandidatePlan`; `planDryRun(input: PlanInput): DryRunPlan`.
  - `artifacts.ts`: `slugLabel`, `compactTimestamp`, `writeRunArtifacts(outDir, meta, result): string[]`.
  - `scripts/strategy-critic-eval.ts`: `main()` (default dry-run; `--run` paid).
- Consumes: `composeMastra`/`MastraCompositionEnv` (compose-mastra), `TwoStageStrategyCritic`/`SingleStageStrategyCritic` (adapters), `resolveLanguageModel`/`parseRoleModel`/`ModelProviderEnv`/`ModelProvider`/`MODEL_PROVIDERS` (model-provider), `createStrategyCriticJudgeAgent` (Task 5 agent), `runJudge` (judge), `buildCandidates` (candidates), `resolveCase`/`CRITIC_EVAL_CASES` (fixtures), `runEval`/`rankAggregates` (harness/aggregate), types.

> The real factory mirrors `composeMastra`'s registration: two_stage → `rt.agents.strategyCritic` + `rt.agents.strategyRefiner`; single → `rt.agents.strategyCriticCombined` (confirmed in `src/mastra/compose-mastra.ts::composeMastra`). It is the ONLY harness module importing `composeMastra`; the CLI dynamic-imports it under `--run` only. No dedicated unit test (covered by typecheck + dry-run, mirroring `real-analyst-factory.ts`).

Steps:

- [ ] **RED — write** `src/experiments/strategy-critic/plan.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { planDryRun } from './plan.ts';
  import { buildCandidates } from './candidates.ts';

  describe('planDryRun', () => {
    it('counts refine + judge paid calls and reports missing keys WITHOUT constructing real adapters', () => {
      const candidates = buildCandidates({ mode: 'two_stage', criticModels: ['anthropic/claude-x'], refinerModels: ['openai/gpt-x', 'anthropic/claude-y'] });
      const plan = planDryRun({
        candidates,
        cases: ['pump-short', 'dump-long'],
        judge: true,
        judgeModel: 'anthropic/claude-opus',
        env: { OPENROUTER_API_KEY: undefined }, // no anthropic/openai keys present
        repeat: 1,
      });
      // 2 candidates × 2 calls-per-run (critic+refiner) × 2 cases × 1 repeat = 8 refine calls
      expect(plan.refineCalls).toBe(8);
      // 2 candidates × 2 cases × 1 repeat = 4 judge calls
      expect(plan.judgeCalls).toBe(4);
      expect(plan.totalPaidCalls).toBe(12);
      expect(plan.perCandidate).toHaveLength(2);
      expect(plan.perCandidate[0]!.callsPerRun).toBe(2);
      expect(plan.missingKeys.sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    });

    it('single mode: one call per run; present key is not reported missing', () => {
      const candidates = buildCandidates({ mode: 'single', models: ['anthropic/claude-x'] });
      const plan = planDryRun({ candidates, cases: ['pump-short'], judge: false, env: { ANTHROPIC_API_KEY: 'present' }, repeat: 3 });
      expect(plan.perCandidate[0]!.callsPerRun).toBe(1);
      expect(plan.refineCalls).toBe(3); // 1 × 1 × 1 × 3
      expect(plan.judgeCalls).toBe(0);
      expect(plan.missingKeys).toEqual([]);
    });
  });
  ```
- [ ] **Run RED — expect FAIL:** `pnpm vitest run src/experiments/strategy-critic/plan.test.ts` → `Failed to load url ./plan.ts`.
- [ ] **GREEN — create** `src/experiments/strategy-critic/plan.ts`:
  ```ts
  // src/experiments/strategy-critic/plan.ts
  import { parseRoleModel, MODEL_PROVIDERS, type ModelProvider, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
  import type { Candidate } from './types.ts';

  export const KEY_BY_PROVIDER: Record<ModelProvider, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  };

  export interface DryRunCandidatePlan {
    label: string;
    mode: 'single' | 'two_stage';
    models: string[];    // distinct role models this candidate uses
    callsPerRun: number; // model calls per (case × repeat): single=1, two_stage=2
  }

  export interface DryRunPlan {
    repeat: number;
    caseCount: number;
    perCandidate: DryRunCandidatePlan[];
    refineCalls: number;
    judgeCalls: number;
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
  }

  function rolesOf(c: Candidate): string[] {
    return c.mode === 'single' ? [c.combinedModel] : [c.criticModel, c.refinerModel];
  }

  function isProvider(value: string | undefined): value is ModelProvider {
    return value != null && (MODEL_PROVIDERS as readonly string[]).includes(value);
  }

  export function planDryRun(input: PlanInput): DryRunPlan {
    const repeat = input.repeat ?? 1;
    const caseCount = input.cases.length;
    const modelEnv: ModelProviderEnv = { MODEL_PROVIDER: input.env.MODEL_PROVIDER as ModelProvider };

    const perCandidate: DryRunCandidatePlan[] = input.candidates.map((c) => {
      const models = rolesOf(c);
      return { label: c.label, mode: c.mode, models, callsPerRun: models.length };
    });

    const refineCalls = perCandidate.reduce((s, p) => s + p.callsPerRun, 0) * caseCount * repeat;
    const judgeCalls = (input.judge ? input.candidates.length : 0) * caseCount * repeat;

    const allModels = new Set<string>();
    for (const p of perCandidate) for (const m of p.models) allModels.add(m);
    if (input.judge && input.judgeModel) allModels.add(input.judgeModel);

    const missing = new Set<string>();
    for (const m of allModels) {
      const { provider } = parseRoleModel(modelEnv, m);
      if (!isProvider(provider)) continue;
      const key = KEY_BY_PROVIDER[provider];
      if (!input.env[key]) missing.add(key);
    }

    return { repeat, caseCount, perCandidate, refineCalls, judgeCalls, totalPaidCalls: refineCalls + judgeCalls, missingKeys: [...missing] };
  }
  ```
- [ ] **GREEN — create** `src/experiments/strategy-critic/real-critic-factory.ts`:
  ```ts
  // src/experiments/strategy-critic/real-critic-factory.ts
  // IMPORTANT: the ONLY harness module that imports composeMastra / constructs real provider
  // models. The CLI dynamically imports it ONLY under --run, so dry-run never loads it.
  import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
  import { TwoStageStrategyCritic } from '../../adapters/strategy-critic/two-stage-strategy-critic.ts';
  import { SingleStageStrategyCritic } from '../../adapters/strategy-critic/single-stage-strategy-critic.ts';
  import { resolveLanguageModel, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
  import { createStrategyCriticJudgeAgent } from '../../mastra/agents/strategy-critic-judge.agent.ts';
  import { runJudge } from './judge.ts';
  import type { StrategyCriticPort } from '../../ports/strategy-critic.port.ts';
  import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
  import type { Candidate, CriticEvalCase, JudgeVerdict } from './types.ts';

  /** Base composition env: every adapter 'fake' except the strategy critic (set per candidate). */
  function baseCompositionEnv(baseEnv: ModelProviderEnv): MastraCompositionEnv {
    return {
      ...baseEnv,
      STRATEGY_ANALYST_ADAPTER: 'fake', STRATEGY_ANALYST_MODEL: 'fake',
      RESEARCHER_ADAPTER: 'fake', RESEARCHER_MODEL: 'fake',
      CRITIC_ADAPTER: 'fake', CRITIC_MODEL: 'fake', ENABLE_CRITIC_AGENT: false,
      TURN_INTERPRETER_ADAPTER: 'fake', TURN_INTERPRETER_MODEL: 'fake',
      BUILDER_ADAPTER: 'fake', BUILDER_MODEL: 'fake',
      STRATEGY_CRITIC_ADAPTER: 'mastra',
      STRATEGY_CRITIC_MODE: 'two_stage',
      STRATEGY_CRITIC_MODEL: 'fake',
      STRATEGY_REFINER_MODEL: 'fake',
      PHOENIX_ENABLED: false,
      PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces',
      PHOENIX_PROJECT_NAME: 'trading-lab',
    };
  }

  /** Build a composeMastra-backed critic for one candidate (mirrors buildStrategyCritic selection). */
  export function buildRealCriticFor(baseEnv: ModelProviderEnv): (candidate: Candidate) => StrategyCriticPort {
    return (candidate: Candidate) => {
      if (candidate.mode === 'single') {
        const env: MastraCompositionEnv = { ...baseCompositionEnv(baseEnv), STRATEGY_CRITIC_MODE: 'single', STRATEGY_CRITIC_MODEL: candidate.combinedModel };
        const rt = composeMastra(env);
        const combined = rt.agents.strategyCriticCombined;
        if (!combined) throw new Error('strategy-critic-combined agent was not composed (check STRATEGY_CRITIC_ADAPTER)');
        return new SingleStageStrategyCritic(combined.agent, combined.label);
      }
      const env: MastraCompositionEnv = { ...baseCompositionEnv(baseEnv), STRATEGY_CRITIC_MODE: 'two_stage', STRATEGY_CRITIC_MODEL: candidate.criticModel, STRATEGY_REFINER_MODEL: candidate.refinerModel };
      const rt = composeMastra(env);
      const critic = rt.agents.strategyCritic;
      const refiner = rt.agents.strategyRefiner;
      if (!critic || !refiner) throw new Error('strategy-critic / strategy-refiner agents were not composed (check STRATEGY_CRITIC_ADAPTER)');
      return new TwoStageStrategyCritic(critic.agent, refiner.agent, critic.label, refiner.label);
    };
  }

  /** Build a best-effort judge closure bound to a judge model. */
  export function buildRealJudge(
    baseEnv: ModelProviderEnv,
    judgeModelId: string,
  ): (refinement: StrategyRefinement, evalCase: CriticEvalCase) => Promise<JudgeVerdict> {
    const resolved = resolveLanguageModel(baseEnv, judgeModelId);
    const agent = createStrategyCriticJudgeAgent(resolved.model);
    return (refinement: StrategyRefinement, evalCase: CriticEvalCase) => runJudge(agent, { originalText: evalCase.text, refinement });
  }
  ```
- [ ] **GREEN — create** `src/experiments/strategy-critic/artifacts.ts`:
  ```ts
  // src/experiments/strategy-critic/artifacts.ts
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import type { CandidateResult, EvalRunResult, ManifestMeta } from './types.ts';

  export function slugLabel(label: string): string {
    return label.replace(/[/:=,]/g, '_');
  }

  export function compactTimestamp(date: Date): string {
    // 2026-06-27T15:30:00.000Z -> 20260627T153000Z
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  /**
   * Per candidate, writes one `<slug>.run<k>.json` per run (judge excluded), a
   * `<slug>.run<k>.judge.json` for runs that produced a judge verdict, and a
   * `<slug>.aggregate.json`. Plus a top-level `manifest.json`. Returns the written paths.
   */
  export function writeRunArtifacts(outDir: string, meta: ManifestMeta, result: EvalRunResult): string[] {
    mkdirSync(outDir, { recursive: true });
    const written: string[] = [];

    const byLabel = new Map<string, CandidateResult[]>();
    for (const c of result.perCandidate) {
      const arr = byLabel.get(c.label) ?? [];
      arr.push(c);
      byLabel.set(c.label, arr);
    }

    for (const [label, runs] of byLabel) {
      const slug = slugLabel(label);
      runs.forEach((candidate, i) => {
        const k = i + 1;
        const { judge, ...withoutJudge } = candidate;
        const runPath = join(outDir, `${slug}.run${k}.json`);
        writeJson(runPath, withoutJudge);
        written.push(runPath);
        if (judge != null) {
          const judgePath = join(outDir, `${slug}.run${k}.judge.json`);
          writeJson(judgePath, judge);
          written.push(judgePath);
        }
      });
      const aggregate = result.aggregates.find((a) => a.label === label);
      if (aggregate) {
        const aggPath = join(outDir, `${slug}.aggregate.json`);
        writeJson(aggPath, aggregate);
        written.push(aggPath);
      }
    }

    const manifestPath = join(outDir, 'manifest.json');
    writeJson(manifestPath, {
      timestamp: meta.timestamp,
      gitSha: meta.gitSha,
      harnessVersion: meta.harnessVersion,
      contractVersion: meta.contractVersion,
      mode: meta.mode,
      threshold: result.threshold,
      repeat: result.repeat,
      judgeEnabled: result.judgeEnabled,
      cases: result.cases,
      candidates: result.candidates.map((c) => c.label),
      perCandidate: result.aggregates.map((a) => ({
        label: a.label,
        aggregate: { passRate: a.passRate, detMean: a.det?.mean ?? null, judgeMean: a.judge?.mean ?? null },
      })),
      overallSuccess: result.overallSuccess,
    });
    written.push(manifestPath);

    return written;
  }
  ```
- [ ] **GREEN — create** `scripts/strategy-critic-eval.ts`:
  ```ts
  // scripts/strategy-critic-eval.ts
  // critic:eval — experimental StrategyCritic mode/model evaluation harness.
  // Default = DRY RUN (no real model construction, no composeMastra, no paid calls).
  // --run is the SOLE trigger for paid calls. No DB, no backtester, no persistence.
  import { parseArgs } from 'node:util';
  import { execSync } from 'node:child_process';
  import { buildCandidates } from '../src/experiments/strategy-critic/candidates.ts';
  import { CRITIC_EVAL_CASES, resolveCase } from '../src/experiments/strategy-critic/fixtures.ts';
  import { planDryRun } from '../src/experiments/strategy-critic/plan.ts';
  import { runEval } from '../src/experiments/strategy-critic/eval-harness.ts';
  import { rankAggregates } from '../src/experiments/strategy-critic/aggregate.ts';
  import { writeRunArtifacts, compactTimestamp } from '../src/experiments/strategy-critic/artifacts.ts';
  import { parseRoleModel, type ModelProvider, type ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';
  import type { ManifestMeta } from '../src/experiments/strategy-critic/types.ts';

  const HARNESS_VERSION = 'critic-eval-v1';
  const CONTRACT_VERSION = 'strategy-critic-v0';

  function splitList(v: string | undefined): string[] {
    return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function parseCli() {
    const { values } = parseArgs({
      options: {
        mode: { type: 'string', default: 'single' },
        models: { type: 'string' },
        'critic-models': { type: 'string' },
        'refiner-models': { type: 'string' },
        cases: { type: 'string' },
        run: { type: 'boolean', default: false },
        threshold: { type: 'string', default: '0.6' },
        judge: { type: 'boolean', default: false },
        'judge-model': { type: 'string' },
        repeat: { type: 'string', default: '1' },
      },
    });
    const mode = values.mode!;
    if (mode !== 'single' && mode !== 'two_stage') throw new Error(`--mode must be 'single' or 'two_stage', got ${mode}`);
    const candidates = buildCandidates({
      mode,
      models: splitList(values.models),
      criticModels: splitList(values['critic-models']),
      refinerModels: splitList(values['refiner-models']),
    });
    const caseIds = splitList(values.cases);
    const cases = caseIds.length > 0 ? caseIds : Object.keys(CRITIC_EVAL_CASES);
    const threshold = Number(values.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`--threshold must be in [0,1], got ${values.threshold}`);
    const repeat = Number(values.repeat);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error(`--repeat must be an integer in [1,20], got ${values.repeat}`);
    if (values.judge && !values['judge-model']) throw new Error('--judge requires --judge-model <provider/model>');
    return { candidates, cases, run: values.run!, threshold, judge: values.judge!, judgeModel: values['judge-model'], repeat };
  }

  function gitSha(): string {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  }

  function modelEnv(): ModelProviderEnv {
    return {
      MODEL_PROVIDER: process.env.MODEL_PROVIDER as ModelProvider,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
  }

  async function main(): Promise<number> {
    const args = parseCli();

    // ---------- DRY RUN (default): no model construction, no composeMastra ----------
    if (!args.run) {
      const plan = planDryRun({ candidates: args.candidates, cases: args.cases, judge: args.judge, judgeModel: args.judgeModel, env: process.env, repeat: args.repeat });
      process.stdout.write(`${JSON.stringify({
        mode: 'dry-run', threshold: args.threshold, judge: args.judge, repeat: args.repeat, cases: args.cases,
        plannedPaidCalls: plan.totalPaidCalls, refineCalls: plan.refineCalls, judgeCalls: plan.judgeCalls,
        candidates: plan.perCandidate, missingKeys: plan.missingKeys,
        note: 'DRY RUN — no real models constructed, nothing sent. Re-run with --run to make paid calls.',
      }, null, 2)}\n`);
      return 0;
    }

    // ---------- REAL RUN (--run): dynamically import the composeMastra-backed factory ----------
    const env = modelEnv();
    const { buildRealCriticFor, buildRealJudge } = await import('../src/experiments/strategy-critic/real-critic-factory.ts');

    let judge: Awaited<ReturnType<typeof buildRealJudge>> | undefined;
    if (args.judge && args.judgeModel) judge = buildRealJudge(env, args.judgeModel);

    const result = await runEval(
      { candidates: args.candidates, cases: args.cases.map((id) => resolveCase(id)), threshold: args.threshold, repeat: args.repeat },
      {
        criticFor: buildRealCriticFor(env),
        providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
        clock: () => Date.now(),
        judge,
      },
    );

    const now = new Date();
    const timestamp = compactTimestamp(now);
    const outDir = `.artifacts/experiments/strategy-critic/${timestamp}`;
    const meta: ManifestMeta = { timestamp, gitSha: gitSha(), harnessVersion: HARNESS_VERSION, contractVersion: CONTRACT_VERSION, mode: 'run' };
    const written = writeRunArtifacts(outDir, meta, result);

    const r3 = (x: number): number => Math.round(x * 1000) / 1000;
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
      latencyMeanMs: Math.round(a.latency.mean),
    }));

    process.stdout.write(`${JSON.stringify({
      mode: 'run', outDir, repeat: result.repeat, overallSuccess: result.overallSuccess,
      ranking, artifacts: written,
    }, null, 2)}\n`);

    return result.overallSuccess ? 0 : 3;
  }

  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`critic:eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  ```
- [ ] **GREEN — add the `critic:eval` script to `package.json`** (next to `analyst:eval`):
  ```json
  "critic:eval": "node --experimental-strip-types --env-file-if-exists=.env scripts/strategy-critic-eval.ts",
  ```
- [ ] **Run GREEN — expect PASS:** `pnpm vitest run src/experiments/strategy-critic/plan.test.ts`.
- [ ] **Manual dry-run smoke (no paid calls):** `pnpm critic:eval --mode two_stage --critic-models anthropic/claude-x --refiner-models openai/gpt-x,anthropic/claude-y --judge --judge-model anthropic/claude-opus` → prints `mode: "dry-run"`, `plannedPaidCalls`, `missingKeys`; exits 0; constructs nothing.
- [ ] **Typecheck:** `pnpm typecheck`.
- [ ] **Full suite:** `pnpm test`.
- [ ] **Commit:** `git add -A && git commit -m "feat(strategy-critic): real-critic factory + artifacts + dry-run paid-gate + critic:eval CLI"`

---

## Self-Review

**Spec coverage (§0–§8 + Testing):**
- §0 Platform-data grounding → Task 1 (`PLATFORM_DATA_CAPABILITIES` grounded in `MarketDataKind` + `ctx.market`; injected into refiner + combined; critic untouched; markers test positive + negative). ✓
- §1 Module layout → Tasks 2–9 create every listed file (`types`, `scoring`, `judge`, `eval-harness`, `aggregate`, `fixtures`, `real-critic-factory`, `__fixtures__/refinements`, judge agent, CLI). `candidates.ts` (§2) + `plan.ts` (§8 dry-run) added. ✓
- §2 Candidate model + CLI cross-product → Task 8 `buildCandidates` (single + two_stage cross-product, stable labels); discriminated `Candidate` in Task 2. ✓
- §3 runOnce/runEval flow + `RunEvalDeps` (`criticFor`, `providerOf`, `clock`, `judge?`) + `EvalRunResult` (`perCandidate`, `aggregates`, `judgeEnabled`, `overallSuccess`) → Task 6. ✓
- §4 Deterministic scorer (gates schemaValid/directionPreserved/noRunnerOverreach/nonTrivialChange + weighted coverage, threshold default 0.6) → Task 4. ✓
- §5 Judge (`buildJudgePrompt`/`runJudge` + `strategy-critic-judge.agent.ts`, opus rubric, best-effort) → Task 5; best-effort non-blocking verified in Task 6 test. ✓
- §6 Fixtures (2 real RU cases + `__fixtures__/refinements`) → Task 3. ✓
- §7 Aggregation/ranking (`aggregateRuns`/`rankAggregates`, mode + role models on rows) → Task 7. ✓
- §8 real-critic-factory + CLI dry-run paid-gate (import-only-under-`--run`, artifacts under `.artifacts/experiments/strategy-critic/<timestamp>/`, ranking render, exit 0/3) → Task 9. ✓
- Testing (scoring/eval-harness/aggregate/agent-grounding/judge-construction/dry-run) → all present across Tasks 1,4,5,6,7,9. ✓
- Out-of-scope items (round-trip, pairwise judge, executing paid run, dynamic capabilities sourcing) → correctly NOT in any task. ✓

**Placeholder scan:** No "similar to Task N", no "...", no TODO; every code step is complete source. The only intentional transient is Task 6's clearly-labelled temporary `aggregateRuns` stub, explicitly deleted in Task 7.

**Type-consistency (identical everywhere):**
- `Candidate` discriminated union — same shape in types.ts (Task 2), candidates.ts (Task 8), plan.ts/factory (Task 9), harness (Task 6). ✓
- `scoreRefinement(refinement, evalCase, opts?: { threshold? })` — defined Task 4, called identically in Task 6 runOnce. ✓
- `runOnce(candidate, evalCase, input, deps)` / `runEval(input, deps)` — defined + tested with that exact arity (Task 6); CLI calls `runEval` with `{ candidates, cases, threshold, repeat }` (Task 9). ✓
- `aggregateRuns(runs)` / `rankAggregates(aggs, judgeEnabled)` — Task 7; consumed by harness + CLI. ✓
- `JudgeVerdict`/`JudgeVerdictSchema` (fields `dimensions`/`overallScore`/`hallucinations`/`missing`/`notes`) — types.ts; used in judge.ts, harness tests, CLI. ✓
- Agent IDs / factory names: `STRATEGY_CRITIC_JUDGE_AGENT_ID='strategy-critic-judge'`, `createStrategyCriticJudgeAgent` — Task 5; imported in factory (Task 9). ✓
- `PLATFORM_DATA_CAPABILITIES` symbol — defined Task 1 in `src/mastra/agents/platform-data-capabilities.ts`, imported by both rewriting agents; referenced in judge instructions prose. ✓
- `RunEvalDeps.judge` signature `(refinement, evalCase) => Promise<JudgeVerdict>` — same in harness, harness tests, `buildRealJudge` return type. ✓

**Constraint conformance:** No TS parameter-properties anywhere (factory/adapters use existing field+assign classes; new code is functions/consts). All relative imports carry `.ts`. New agents live under `src/mastra/**`. Every RED is an unresolved-import runtime failure (vitest strip-types safe), never a type error. Default OFF + `buildStrategyCritic` untouched. `strategy-critic.agent.ts` untouched (Task 1 asserts the negative via fs read, no import/edit).
