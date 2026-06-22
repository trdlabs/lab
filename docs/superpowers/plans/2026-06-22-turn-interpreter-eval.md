# TurnInterpreter eval harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline-deterministic eval harness for the `TurnInterpreter` that scores structured-extraction quality, sweeps a small model set, and prints an env recommendation — mirroring the existing `intent-classifier` harness.

**Architecture:** A new `src/experiments/turn-interpreter/` package (types / fixtures / scoring / aggregate / eval-harness / real factory) + a `src/mastra/agents/turn-interpreter-judge.agent.ts` + a thin CLI `scripts/turn-interpreter-eval.ts`. The harness re-validates each candidate's RAW output through the production trust boundary (`normalizeTurnOutput` → `TurnInterpretationSchema`), scores a weighted sum over the structured fields with a no-fabrication penalty, and (only under `--run`) dynamically imports the one composeMastra-touching factory.

**Tech Stack:** TypeScript, `node --experimental-strip-types`, Vitest, Zod, Mastra.

## Global Constraints

- Runtime is `node --experimental-strip-types` — **no TS parameter properties** anywhere under `src/` or `scripts/` (AST guard `src/strip-types-no-param-properties.test.ts`). Use explicit field declarations / plain functions.
- **Mirror the existing `intent-classifier` harness** at `src/experiments/intent-classifier/` (+ `scripts/intent-classifier-eval.ts`, `src/experiments/intent-classifier/__fixtures__/chat-intents-v1.json`). Read those files and follow their structure, naming, and conventions; this plan gives the deltas + the novel logic in full.
- **Trust boundary parity:** the scorer re-validates through the EXACT prod path — `normalizeTurnOutput(raw)` then `TurnInterpretationSchema.safeParse` (the same `normalizeTurnOutput` used at `src/chat/chat-handler.ts:139`; confirm its import module). No parallel/looser schema.
- **No paid calls without `--run`:** `real-turn-interpreter-factory.ts` is the ONLY module importing `composeMastra` / constructing real models, dynamically `import()`-ed ONLY under `--run`. No other harness module imports composeMastra.
- **Judge agents live in `src/mastra/agents/`** (never under `experiments/`).
- **Composition is untouched** — the harness never mutates the operator runtime or env wiring.
- Scoring weights, `DEFAULT_THRESHOLD = 0.75`, `FABRICATION_PENALTY = 0.25`, `ENV_RECOMMEND_MARGIN = 0.05` are exact constants (tunable later).
- TurnInterpreter output type: `TurnInterpretationSchema` / `InterpretedTurn` at `src/chat/turn-interpretation.ts`; port `TurnInterpreterPort.interpret(message): Promise<unknown>` at `src/ports/turn-interpreter.port.ts`.

---

### Task 1: Types + dataset + fixtures loader

**Files:**
- Create: `src/experiments/turn-interpreter/types.ts`
- Create: `src/experiments/turn-interpreter/__fixtures__/turn-interpretations-v1.json`
- Create: `src/experiments/turn-interpreter/fixtures.ts`
- Test: `src/experiments/turn-interpreter/fixtures.test.ts`

**Interfaces:**
- Consumes: `SUBJECTS`, `TURN_GOALS` from `src/chat/turn-interpretation.ts`.
- Produces: `EvalCase`, `EvalCaseExpect`, `Subject`, `TurnGoal`, `CaseResult`, `ScoreResult`, `CandidateResult`, `ModelAggregate`, `EvalRunResult`, `ManifestMeta`, `JudgeVerdictSchema`/`JudgeVerdict` (types.ts); `EvalCaseSchema`, `DatasetSchema`, `loadCases(id: string): EvalCase[]`, `fingerprintCases(cases: EvalCase[]): string`, `DATASETS` (fixtures.ts).

- [ ] **Step 1: Write `types.ts`**

```ts
import { z } from 'zod';
import { SUBJECTS, TURN_GOALS } from '../../chat/turn-interpretation.ts';

export type Subject = (typeof SUBJECTS)[number];
export type TurnGoal = (typeof TURN_GOALS)[number];
export type ConstraintField = 'market' | 'symbol' | 'timeframe' | 'direction';

export interface EvalCaseExpect {
  subject: Subject;                         // primary, always scored
  goal?: TurnGoal | 'none';                 // 'none' = expected absent
  hasStrategyText?: boolean;                // presence, not content
  constraints?: {
    market?: string; symbol?: string; timeframe?: string;
    direction?: 'long' | 'short' | 'both';
  };
  absentConstraints?: ConstraintField[];    // must NOT be fabricated
  references?: string[];                    // set match when declared
}

export interface EvalCase {
  id: string;
  lang: 'ru' | 'en';
  message: string;
  expect: EvalCaseExpect;
}

export type ScoredField =
  | 'subject' | 'goal' | 'direction' | 'market' | 'symbol' | 'timeframe' | 'strategyText' | 'references';

export interface CaseResult {
  id: string;
  lang: 'ru' | 'en';
  schemaValid: boolean;
  score: number;                            // 0..1
  latencyMs: number;
  fields: Partial<Record<ScoredField, number>>; // per-declared-field 0/1
  fabricatedCount: number;
  subject: string;                          // parsed subject or best-effort
}

export interface ScoreResult {
  schemaValidRate: number;
  subjectAccuracy: number;
  fieldAccuracies: Partial<Record<ScoredField, number>>;
  fabricationRate: number;                  // share of cases with ≥1 fabrication
  score: number;                            // mean caseScore
  threshold: number;
  verdict: 'PASS' | 'FAIL';
  cases: CaseResult[];
}

export const JudgeVerdictSchema = z.object({
  dimensions: z.array(z.object({ name: z.string(), score: z.number(), rationale: z.string() })),
  overallScore: z.number(),
  hallucinations: z.array(z.string()),
  missingFromExpected: z.array(z.string()),
  notes: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface CandidateResult {
  modelId: string;
  provider: string;
  ok: boolean;
  error?: string;
  result?: ScoreResult;
  judge?: JudgeVerdict[];
}

export interface ModelAggregate {
  modelId: string;
  provider: string;
  runs: number;
  meanScore: number;
  passRate: number;
  meanLatencyMs: number;
  judgeMean?: number;
}

export interface ManifestMeta {
  datasetId: string;
  datasetFingerprint: string;
  models: string[];
  repeat: number;
  threshold: number;
  caseCount: number;
  judgeEnabled: boolean;
}

export interface EvalRunResult {
  manifest: ManifestMeta;
  candidates: CandidateResult[];
  aggregates: ModelAggregate[];
}
```

- [ ] **Step 2: Author `__fixtures__/turn-interpretations-v1.json`**

Author ~30 cases per the spec coverage matrix. Shape: `{ "version": "turn-interpretations-v1", "cases": [ … ] }`. Concrete examples to follow (extend to full coverage):

```json
{
  "version": "turn-interpretations-v1",
  "cases": [
    { "id": "ru-research-oi-long", "lang": "ru",
      "message": "Протестируй стратегию: лонг при росте открытого интереса на BTCUSDT-PERP 1h",
      "expect": { "subject": "strategy", "goal": "research", "hasStrategyText": true,
        "constraints": { "symbol": "BTCUSDT", "timeframe": "1h", "direction": "long" } } },
    { "id": "en-analyze-no-constraints", "lang": "en",
      "message": "Take a look at this mean-reversion idea and tell me what you think",
      "expect": { "subject": "strategy", "goal": "analyze", "hasStrategyText": true,
        "absentConstraints": ["symbol", "timeframe", "direction"] } },
    { "id": "ru-show-results", "lang": "ru", "message": "Покажи результаты последнего бэктеста",
      "expect": { "subject": "results", "goal": "show_results", "references": ["last_backtest"] } },
    { "id": "en-unknown", "lang": "en", "message": "What's the weather today?",
      "expect": { "subject": "unknown" } },
    { "id": "ru-antifab-symbol", "lang": "ru", "message": "Сделай моментум-стратегию на 4h",
      "expect": { "subject": "strategy", "goal": "research", "hasStrategyText": true,
        "constraints": { "timeframe": "4h" }, "absentConstraints": ["symbol", "direction"] } }
  ]
}
```

Cover: every `subject` (strategy/bot/results/task/hypothesis/unknown) × applicable `goal`; constraint variety (market/symbol/timeframe/direction in combos, RU+EN); ≥4 `hasStrategyText:true` cases; ≥2 `references` cases; ≥4 `absentConstraints` (anti-fabrication) cases; ≥2 ambiguous/edge cases. Keep RU and EN roughly balanced.

- [ ] **Step 3: Write `fixtures.ts`** (mirror `intent-classifier/fixtures.ts`)

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SUBJECTS, TURN_GOALS } from '../../chat/turn-interpretation.ts';
import type { EvalCase } from './types.ts';
import datasetV1 from './__fixtures__/turn-interpretations-v1.json' with { type: 'json' };

const ExpectSchema = z.object({
  subject: z.enum(SUBJECTS),
  goal: z.union([z.enum(TURN_GOALS), z.literal('none')]).optional(),
  hasStrategyText: z.boolean().optional(),
  constraints: z.object({
    market: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    timeframe: z.string().min(1).optional(),
    direction: z.enum(['long', 'short', 'both']).optional(),
  }).strict().optional(),
  absentConstraints: z.array(z.enum(['market', 'symbol', 'timeframe', 'direction'])).optional(),
  references: z.array(z.string().min(1)).optional(),
}).strict();

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  lang: z.enum(['ru', 'en']),
  message: z.string().min(1),
  expect: ExpectSchema,
});
export const DatasetSchema = z.object({ version: z.string().min(1), cases: z.array(EvalCaseSchema).min(1) });

const DATASET_SOURCES: Record<string, unknown> = { 'turn-interpretations-v1': datasetV1 };
export const DATASETS = Object.keys(DATASET_SOURCES);

export function loadCases(id: string): EvalCase[] {
  const src = DATASET_SOURCES[id];
  if (!src) throw new Error(`unknown dataset: ${id} (known: ${DATASETS.join(', ')})`);
  return DatasetSchema.parse(src).cases;
}

export function fingerprintCases(cases: EvalCase[]): string {
  const canonical = JSON.stringify(cases.map((c) => ({ id: c.id, lang: c.lang, message: c.message, expect: c.expect })));
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}
```

(Confirm the repo's JSON-import syntax against `intent-classifier/fixtures.ts` — match whatever import assertion form it uses.)

- [ ] **Step 4: Write the failing test `fixtures.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loadCases, fingerprintCases, DATASETS } from './fixtures.ts';
import { SUBJECTS } from '../../chat/turn-interpretation.ts';

describe('turn-interpreter fixtures', () => {
  it('loads + validates turn-interpretations-v1', () => {
    expect(DATASETS).toContain('turn-interpretations-v1');
    const cases = loadCases('turn-interpretations-v1');
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
  it('covers every subject and has anti-fabrication + both langs', () => {
    const cases = loadCases('turn-interpretations-v1');
    const subjects = new Set(cases.map((c) => c.expect.subject));
    for (const s of SUBJECTS) expect(subjects.has(s)).toBe(true);
    expect(cases.filter((c) => (c.expect.absentConstraints?.length ?? 0) > 0).length).toBeGreaterThanOrEqual(3);
    expect(cases.some((c) => c.lang === 'ru')).toBe(true);
    expect(cases.some((c) => c.lang === 'en')).toBe(true);
  });
  it('fingerprint is stable + order-sensitive', () => {
    const cases = loadCases('turn-interpretations-v1');
    expect(fingerprintCases(cases)).toBe(fingerprintCases(cases));
    expect(fingerprintCases(cases)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('rejects an invalid case', () => {
    expect(() => DatasetParseShouldThrow()).toThrow();
  });
});
function DatasetParseShouldThrow(): never {
  const { DatasetSchema } = require('./fixtures.ts');
  DatasetSchema.parse({ version: 'x', cases: [{ id: '', lang: 'ru', message: 'm', expect: { subject: 'strategy' } }] });
  throw new Error('unreachable');
}
```

(If `require` is unavailable under ESM/strip-types, import `DatasetSchema` at top and inline the throw assertion — match the sibling test's import style.)

- [ ] **Step 5: Run tests — verify fail then pass**

Run: `npx vitest run src/experiments/turn-interpreter/fixtures.test.ts`
Expected: FAIL before types/fixtures/dataset exist (module not found), PASS after Steps 1-3 + the authored dataset.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.
```bash
git add src/experiments/turn-interpreter/types.ts src/experiments/turn-interpreter/fixtures.ts src/experiments/turn-interpreter/__fixtures__/turn-interpretations-v1.json src/experiments/turn-interpreter/fixtures.test.ts
git commit -m "feat(turn-interpreter-eval): types, dataset, fixtures loader"
```

---

### Task 2: Deterministic scoring

**Files:**
- Create: `src/experiments/turn-interpreter/scoring.ts`
- Test: `src/experiments/turn-interpreter/scoring.test.ts`

**Interfaces:**
- Consumes: `EvalCase`, `CaseResult`, `ScoreResult`, `ScoredField` (types.ts); `normalizeTurnOutput` + `TurnInterpretationSchema` (from `src/chat/…` — confirm the module path used at `chat-handler.ts:139`).
- Produces: `WEIGHTS`, `DEFAULT_THRESHOLD`, `FABRICATION_PENALTY`, `scoreCase(raw: unknown, c: EvalCase, latencyMs: number): CaseResult`, `scoreRun(cases: CaseResult[], opts?: { threshold?: number }): ScoreResult`, `bestEffortSubject(raw: unknown): string`.

- [ ] **Step 1: Write the failing test `scoring.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { scoreCase, scoreRun, DEFAULT_THRESHOLD } from './scoring.ts';
import type { EvalCase } from './types.ts';

const C = (expect_: EvalCase['expect']): EvalCase => ({ id: 't', lang: 'en', message: 'm', expect: expect_ });

describe('scoreCase', () => {
  it('full marks on exact subject+goal+constraints', () => {
    const raw = { subject: 'strategy', goal: 'research', strategyText: 'x',
      constraints: { symbol: 'BTCUSDT', timeframe: '1h', direction: 'long' }, references: [], confidence: 0.9 };
    const r = scoreCase(raw, C({ subject: 'strategy', goal: 'research', hasStrategyText: true,
      constraints: { symbol: 'BTCUSDT', timeframe: '1h', direction: 'long' } }), 10);
    expect(r.schemaValid).toBe(true);
    expect(r.score).toBeCloseTo(1, 5);
  });

  it('normalizes symbol/timeframe before compare', () => {
    const raw = { subject: 'strategy', constraints: { symbol: 'btc/usdt' }, references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'strategy', constraints: { symbol: 'BTCUSDT' } }), 10);
    expect(r.fields.symbol).toBe(1);
  });

  it('scores strategyText by presence vs expectation', () => {
    const raw = { subject: 'strategy', references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'strategy', hasStrategyText: false }), 10);
    expect(r.fields.strategyText).toBe(1);
  });

  it('goal:none rewards an absent goal', () => {
    const raw = { subject: 'unknown', references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'unknown', goal: 'none' }), 10);
    expect(r.fields.goal).toBe(1);
  });

  it('applies the no-fabrication penalty', () => {
    const raw = { subject: 'strategy', constraints: { symbol: 'ETHUSDT' }, references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'strategy', absentConstraints: ['symbol'] }), 10);
    expect(r.fabricatedCount).toBe(1);
    expect(r.score).toBeCloseTo(Math.max(0, 1 - 0.25), 5); // only subject declared (→1), minus one fabrication
  });

  it('schema-invalid raw scores 0 with a best-effort subject', () => {
    const r = scoreCase({ subject: 'strategy', constraints: { bogus: 1 } }, C({ subject: 'strategy' }), 10);
    expect(r.schemaValid).toBe(false);
    expect(r.score).toBe(0);
    expect(r.subject).toBe('strategy');
  });

  it('normalizes weights over declared fields only (sparse case)', () => {
    const raw = { subject: 'bot', constraints: {}, references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'bot' }), 10); // only subject declared
    expect(r.score).toBeCloseTo(1, 5);
  });
});

describe('scoreRun', () => {
  it('aggregates mean score + PASS/FAIL by threshold', () => {
    const good = scoreCase({ subject: 'bot', constraints: {}, references: [], confidence: 0.5 }, C({ subject: 'bot' }), 5);
    const bad = scoreCase({ subject: 'task', constraints: {}, references: [], confidence: 0.5 }, C({ subject: 'bot' }), 5);
    const res = scoreRun([good, bad], { threshold: DEFAULT_THRESHOLD });
    expect(res.subjectAccuracy).toBeCloseTo(0.5, 5);
    expect(res.verdict).toBe('FAIL');
  });
});
```

- [ ] **Step 2: Run it — verify fail**

Run: `npx vitest run src/experiments/turn-interpreter/scoring.test.ts`
Expected: FAIL — `./scoring.ts` does not exist.

- [ ] **Step 3: Write `scoring.ts`**

```ts
import { normalizeTurnOutput } from '../../chat/turn-interpretation.ts'; // CONFIRM module: same normalizer used at chat-handler.ts:139
import { TurnInterpretationSchema } from '../../chat/turn-interpretation.ts';
import type { EvalCase, CaseResult, ScoreResult, ScoredField } from './types.ts';

export const DEFAULT_THRESHOLD = 0.75;
export const FABRICATION_PENALTY = 0.25;
export const WEIGHTS: Record<ScoredField, number> = {
  subject: 0.20, goal: 0.15, direction: 0.10,
  market: 0.10, symbol: 0.10, timeframe: 0.10,
  strategyText: 0.15, references: 0.10,
};

function normToken(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[\s/_-]+/g, '');
}
function setEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a), sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
export function bestEffortSubject(raw: unknown): string {
  const v = (raw as { subject?: unknown })?.subject;
  return typeof v === 'string' ? v : 'unknown';
}

export function scoreCase(raw: unknown, c: EvalCase, latencyMs: number): CaseResult {
  const parsed = TurnInterpretationSchema.safeParse(normalizeTurnOutput(raw));
  if (!parsed.success) {
    return { id: c.id, lang: c.lang, schemaValid: false, score: 0, latencyMs, fields: {}, fabricatedCount: 0, subject: bestEffortSubject(raw) };
  }
  const out = parsed.data;
  const e = c.expect;
  const fields: Partial<Record<ScoredField, number>> = {};

  fields.subject = out.subject === e.subject ? 1 : 0;
  if (e.goal !== undefined) {
    fields.goal = e.goal === 'none' ? (out.goal === undefined ? 1 : 0) : (out.goal === e.goal ? 1 : 0);
  }
  const ec = e.constraints ?? {};
  if (ec.direction !== undefined) fields.direction = out.constraints.direction === ec.direction ? 1 : 0;
  for (const k of ['market', 'symbol', 'timeframe'] as const) {
    if (ec[k] !== undefined) fields[k] = normToken(out.constraints[k]) === normToken(ec[k]) ? 1 : 0;
  }
  if (e.hasStrategyText !== undefined) fields.strategyText = Boolean(out.strategyText) === e.hasStrategyText ? 1 : 0;
  if (e.references !== undefined) {
    fields.references = setEqual(out.references.map(normToken), e.references.map(normToken)) ? 1 : 0;
  }

  const declared = Object.keys(fields) as ScoredField[];
  const wsum = declared.reduce((a, k) => a + WEIGHTS[k], 0) || 1;
  const weighted = declared.reduce((a, k) => a + WEIGHTS[k] * (fields[k] as number), 0) / wsum;

  let fabricatedCount = 0;
  for (const f of e.absentConstraints ?? []) {
    if ((out.constraints as Record<string, unknown>)[f] !== undefined) fabricatedCount += 1;
  }
  const score = Math.max(0, Math.min(1, weighted - fabricatedCount * FABRICATION_PENALTY));
  return { id: c.id, lang: c.lang, schemaValid: true, score, latencyMs, fields, fabricatedCount, subject: out.subject };
}

export function scoreRun(cases: CaseResult[], opts?: { threshold?: number }): ScoreResult {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const n = cases.length || 1;
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const fieldAccuracies: Partial<Record<ScoredField, number>> = {};
  for (const k of Object.keys(WEIGHTS) as ScoredField[]) {
    const vals = cases.map((c) => c.fields[k]).filter((v): v is number => v !== undefined);
    if (vals.length) fieldAccuracies[k] = mean(vals);
  }
  const score = mean(cases.map((c) => c.score));
  return {
    schemaValidRate: cases.filter((c) => c.schemaValid).length / n,
    subjectAccuracy: fieldAccuracies.subject ?? 0,
    fieldAccuracies,
    fabricationRate: cases.filter((c) => c.fabricatedCount > 0).length / n,
    score,
    threshold,
    verdict: score >= threshold ? 'PASS' : 'FAIL',
    cases,
  };
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run src/experiments/turn-interpreter/scoring.test.ts`
Expected: PASS (all cases). If `normalizeTurnOutput` is not exported from `turn-interpretation.ts`, fix the import to its real module (grep `normalizeTurnOutput`) and re-run.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/experiments/turn-interpreter/scoring.ts src/experiments/turn-interpreter/scoring.test.ts
git commit -m "feat(turn-interpreter-eval): deterministic weighted-extraction scoring"
```

---

### Task 3: DI eval orchestrator

**Files:**
- Create: `src/experiments/turn-interpreter/eval-harness.ts`
- Test: `src/experiments/turn-interpreter/eval-harness.test.ts`

**Interfaces:**
- Consumes: `scoreCase`/`scoreRun` (scoring.ts); `EvalCase`, `CandidateResult`, `EvalRunResult`, `ManifestMeta`, `JudgeVerdict` (types.ts); `TurnInterpreterPort` (`src/ports/turn-interpreter.port.ts`).
- Produces: `RunEvalInput`, `RunEvalDeps`, `runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult>`.

Mirror `intent-classifier/eval-harness.ts` exactly (model-major, sequential, per-model failure isolation; this module imports NO composeMastra). Deltas: it calls `interpreter.interpret(message)` (not `classify`), scores with `scoreCase`/`scoreRun`, and the optional `judge` takes the parsed interpretation.

- [ ] **Step 1: Write the failing test `eval-harness.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { runEval } from './eval-harness.ts';
import type { EvalCase } from './types.ts';
import type { TurnInterpreterPort } from '../../ports/turn-interpreter.port.ts';

const cases: EvalCase[] = [
  { id: 'a', lang: 'en', message: 'research BTCUSDT 1h long', expect: { subject: 'strategy', goal: 'research' } },
];

function fakeInterpreter(modelId: string): TurnInterpreterPort {
  return {
    adapter: 'fake', model: modelId,
    interpret: async () => ({ subject: 'strategy', goal: 'research', constraints: {}, references: [], confidence: 0.9 }),
  };
}

describe('runEval', () => {
  it('runs model-major and aggregates per model', async () => {
    const res = await runEval(
      { models: ['m1', 'm2'], datasetId: 'd', cases, datasetFingerprint: 'fp', threshold: 0.75, repeat: 1 },
      { interpreterFor: (m) => fakeInterpreter(m), providerOf: (m) => ({ provider: 'fake', modelId: m }), clock: () => 0 },
    );
    expect(res.aggregates.map((a) => a.modelId)).toEqual(['m1', 'm2']);
    expect(res.aggregates[0].passRate).toBe(1);
    expect(res.manifest.caseCount).toBe(1);
  });

  it('isolates a model that fails to build', async () => {
    const res = await runEval(
      { models: ['ok', 'broken'], datasetId: 'd', cases, datasetFingerprint: 'fp', threshold: 0.75, repeat: 1 },
      { interpreterFor: (m) => { if (m === 'broken') throw new Error('no key'); return fakeInterpreter(m); },
        providerOf: (m) => ({ provider: 'fake', modelId: m }), clock: () => 0 },
    );
    const broken = res.candidates.find((c) => c.modelId === 'broken');
    expect(broken?.ok).toBe(false);
    expect(res.candidates.find((c) => c.modelId === 'ok')?.ok).toBe(true);
  });

  it('a throwing interpret() is a schema-invalid miss, not a crash', async () => {
    const res = await runEval(
      { models: ['m'], datasetId: 'd', cases, datasetFingerprint: 'fp', threshold: 0.75, repeat: 1 },
      { interpreterFor: () => ({ adapter: 'fake', model: 'm', interpret: async () => { throw new Error('boom'); } }),
        providerOf: (m) => ({ provider: 'fake', modelId: m }), clock: () => 0 },
    );
    expect(res.candidates[0].ok).toBe(true);
    expect(res.candidates[0].result?.schemaValidRate).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — verify fail** (`npx vitest run …/eval-harness.test.ts`) → FAIL (module missing).

- [ ] **Step 3: Implement `eval-harness.ts`**

```ts
import { scoreCase, scoreRun } from './scoring.ts';
import { normalizeTurnOutput } from '../../chat/turn-interpretation.ts'; // CONFIRM path (Task 2 note)
import { TurnInterpretationSchema } from '../../chat/turn-interpretation.ts';
import type { EvalCase, CandidateResult, CaseResult, EvalRunResult, ManifestMeta, JudgeVerdict, ModelAggregate } from './types.ts';
import type { TurnInterpreterPort } from '../../ports/turn-interpreter.port.ts';

export interface RunEvalInput {
  models: string[];
  datasetId: string;
  cases: EvalCase[];
  datasetFingerprint: string;
  threshold: number;
  repeat?: number;
}
export interface RunEvalDeps {
  interpreterFor: (modelId: string) => TurnInterpreterPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  judge?: (parsed: unknown, c: EvalCase) => Promise<JudgeVerdict>;
}

export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const repeat = input.repeat ?? 1;
  const candidates: CandidateResult[] = [];

  for (const modelId of input.models) {
    const { provider } = deps.providerOf(modelId);
    let interpreter: TurnInterpreterPort;
    try {
      interpreter = deps.interpreterFor(modelId);
    } catch (err) {
      candidates.push({ modelId, provider, ok: false, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const allCaseResults: CaseResult[] = [];
    const judgeVerdicts: JudgeVerdict[] = [];
    for (let r = 0; r < repeat; r++) {
      for (const c of input.cases) {
        const t0 = deps.clock();
        let raw: unknown = undefined;
        try {
          raw = await interpreter.interpret(c.message);
        } catch {
          raw = { __throw: true }; // becomes a schema-invalid miss in scoreCase
        }
        const latency = deps.clock() - t0;
        allCaseResults.push(scoreCase(raw, c, latency));
        if (deps.judge) {
          const parsed = TurnInterpretationSchema.safeParse(normalizeTurnOutput(raw));
          if (parsed.success) judgeVerdicts.push(await deps.judge(parsed.data, c));
        }
      }
    }
    const result = scoreRun(allCaseResults, { threshold: input.threshold });
    candidates.push({ modelId, provider, ok: true, result, judge: deps.judge ? judgeVerdicts : undefined });
  }

  const aggregates: ModelAggregate[] = candidates.map((c) => {
    const cases = c.result?.cases ?? [];
    const meanLatency = cases.length ? cases.reduce((a, x) => a + x.latencyMs, 0) / cases.length : 0;
    return {
      modelId: c.modelId, provider: c.provider, runs: repeat,
      meanScore: c.result?.score ?? 0,
      passRate: c.result ? (c.result.verdict === 'PASS' ? 1 : 0) : 0,
      meanLatencyMs: meanLatency,
      judgeMean: c.judge && c.judge.length ? c.judge.reduce((a, v) => a + v.overallScore, 0) / c.judge.length : undefined,
    };
  });

  const manifest: ManifestMeta = {
    datasetId: input.datasetId, datasetFingerprint: input.datasetFingerprint,
    models: input.models, repeat, threshold: input.threshold,
    caseCount: input.cases.length, judgeEnabled: Boolean(deps.judge),
  };
  return { manifest, candidates, aggregates };
}
```

- [ ] **Step 4: Run tests — verify pass** (`npx vitest run …/eval-harness.test.ts`) → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/experiments/turn-interpreter/eval-harness.ts src/experiments/turn-interpreter/eval-harness.test.ts
git commit -m "feat(turn-interpreter-eval): DI eval orchestrator (model-major, failure-isolated)"
```

---

### Task 4: Aggregate ranking + env recommendation

**Files:**
- Create: `src/experiments/turn-interpreter/aggregate.ts`
- Test: `src/experiments/turn-interpreter/aggregate.test.ts`

**Interfaces:**
- Consumes: `ModelAggregate` (types.ts).
- Produces: `ENV_RECOMMEND_MARGIN`, `rankAggregates(aggregates: ModelAggregate[], judgeEnabled: boolean): ModelAggregate[]`, `recommendEnv(ranked: ModelAggregate[], opts: { incumbentModelId: string; threshold: number; margin?: number }): { decision: 'own-env' | 'keep-sharing'; recommendedModelId: string | null; incumbentScore: number; bestScore: number; delta: number; reason: string }`.

- [ ] **Step 1: Write the failing test `aggregate.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { rankAggregates, recommendEnv } from './aggregate.ts';
import type { ModelAggregate } from './types.ts';

const agg = (modelId: string, meanScore: number, passRate = 1, lat = 100): ModelAggregate =>
  ({ modelId, provider: 'p', runs: 1, meanScore, passRate, meanLatencyMs: lat });

describe('rankAggregates', () => {
  it('ranks by meanScore, then passRate, then latency', () => {
    const ranked = rankAggregates([agg('a', 0.7), agg('b', 0.9), agg('c', 0.9, 1, 50)], false);
    expect(ranked.map((r) => r.modelId)).toEqual(['c', 'b', 'a']);
  });
});

describe('recommendEnv', () => {
  it('recommends own-env when best beats incumbent by >= margin and PASSes', () => {
    const ranked = rankAggregates([agg('nano', 0.78), agg('strong', 0.90)], false);
    const rec = recommendEnv(ranked, { incumbentModelId: 'nano', threshold: 0.75, margin: 0.05 });
    expect(rec.decision).toBe('own-env');
    expect(rec.recommendedModelId).toBe('strong');
    expect(rec.delta).toBeCloseTo(0.12, 5);
  });
  it('keeps sharing when the margin is not met', () => {
    const ranked = rankAggregates([agg('nano', 0.86), agg('strong', 0.88)], false);
    const rec = recommendEnv(ranked, { incumbentModelId: 'nano', threshold: 0.75, margin: 0.05 });
    expect(rec.decision).toBe('keep-sharing');
  });
  it('keeps sharing when the best does not clear the threshold', () => {
    const ranked = rankAggregates([agg('nano', 0.40, 0), agg('strong', 0.60, 0)], false);
    const rec = recommendEnv(ranked, { incumbentModelId: 'nano', threshold: 0.75, margin: 0.05 });
    expect(rec.decision).toBe('keep-sharing');
  });
});
```

- [ ] **Step 2: Run it — verify fail.**

- [ ] **Step 3: Implement `aggregate.ts`**

```ts
import type { ModelAggregate } from './types.ts';

export const ENV_RECOMMEND_MARGIN = 0.05;

export function rankAggregates(aggregates: ModelAggregate[], judgeEnabled: boolean): ModelAggregate[] {
  return [...aggregates].sort((a, b) => {
    if (judgeEnabled && a.judgeMean !== undefined && b.judgeMean !== undefined && a.judgeMean !== b.judgeMean) {
      return b.judgeMean - a.judgeMean;
    }
    if (a.meanScore !== b.meanScore) return b.meanScore - a.meanScore;
    if (a.passRate !== b.passRate) return b.passRate - a.passRate;
    return a.meanLatencyMs - b.meanLatencyMs;
  });
}

export function recommendEnv(
  ranked: ModelAggregate[],
  opts: { incumbentModelId: string; threshold: number; margin?: number },
): { decision: 'own-env' | 'keep-sharing'; recommendedModelId: string | null; incumbentScore: number; bestScore: number; delta: number; reason: string } {
  const margin = opts.margin ?? ENV_RECOMMEND_MARGIN;
  const incumbent = ranked.find((a) => a.modelId === opts.incumbentModelId);
  const best = ranked[0];
  const incumbentScore = incumbent?.meanScore ?? 0;
  const bestScore = best?.meanScore ?? 0;
  const delta = bestScore - incumbentScore;
  if (best && best.modelId !== opts.incumbentModelId && bestScore >= opts.threshold && delta >= margin) {
    return { decision: 'own-env', recommendedModelId: best.modelId, incumbentScore, bestScore, delta,
      reason: `${best.modelId} clears threshold ${opts.threshold} and beats incumbent by ${delta.toFixed(3)} (≥ ${margin})` };
  }
  return { decision: 'keep-sharing', recommendedModelId: null, incumbentScore, bestScore, delta,
    reason: `no candidate both clears ${opts.threshold} and beats incumbent by ≥ ${margin}` };
}
```

- [ ] **Step 4: Run tests — verify pass.**

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/experiments/turn-interpreter/aggregate.ts src/experiments/turn-interpreter/aggregate.test.ts
git commit -m "feat(turn-interpreter-eval): ranking + env recommendation rule"
```

---

### Task 5: Real factory + judge agent

**Files:**
- Create: `src/mastra/agents/turn-interpreter-judge.agent.ts`
- Create: `src/experiments/turn-interpreter/real-turn-interpreter-factory.ts`
- Test: `src/mastra/agents/turn-interpreter-judge.agent.test.ts`

**Interfaces:**
- Consumes: `JudgeVerdictSchema` (types.ts); the Mastra agent + composeMastra wiring used by `intent-classifier/real-classifier-factory.ts` and `src/mastra/agents/strategy-analyst-judge.agent.ts`; the existing `createTurnInterpreterAgent` (`src/mastra/agents/turn-interpreter.agent.ts`).
- Produces: `createTurnInterpreterJudgeAgent(model)` (judge agent); `buildRealInterpreterFor(env): (modelId: string) => TurnInterpreterPort` and `buildRealJudge(env, judgeModelId): (parsed: unknown, c: EvalCase) => Promise<JudgeVerdict>` (real factory). These are the ONLY composeMastra importers; the CLI dynamically imports them under `--run` only.

Mirror `src/mastra/agents/strategy-analyst-judge.agent.ts` for the judge agent and `src/experiments/intent-classifier/real-classifier-factory.ts` for the factory (it shows how a per-model real `TurnInterpreterPort`/classifier is built from `composeMastra` + a model id, and how the judge is bound). The judge agent's `structuredOutput` schema is `JudgeVerdictSchema`; instruct the judge to compare the parsed interpretation against the message for constraint faithfulness + strategyText capture.

- [ ] **Step 1: Write the failing test `turn-interpreter-judge.agent.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createTurnInterpreterJudgeAgent } from './turn-interpreter-judge.agent.ts';

describe('createTurnInterpreterJudgeAgent', () => {
  it('builds an agent with the judge id and no tools', () => {
    const fakeModel = {} as never; // mirror how strategy-analyst-judge.agent.test.ts passes a model stub
    const agent = createTurnInterpreterJudgeAgent(fakeModel);
    expect(agent).toBeDefined();
    // assert agent id / shape exactly as the sibling judge-agent test does
  });
});
```

(Match the sibling `strategy-analyst-judge.agent.test.ts` assertions precisely — agent id `'turn-interpreter-judge'`, instructions present, no tools.)

- [ ] **Step 2: Run it — verify fail.**

- [ ] **Step 3: Implement the judge agent + real factory.** Mirror the two sibling files. The factory must:
  - import `composeMastra` (or the same composition entry the intent factory uses) only here;
  - `buildRealInterpreterFor(env)` → returns `(modelId) => MastraTurnInterpreter` built with the agent resolved for `modelId` (reuse `createTurnInterpreterAgent` via the same path `compose-mastra.ts` uses; the baseline `modelId` equals `env.INTENT_CLASSIFIER_MODEL`);
  - `buildRealJudge(env, judgeModelId)` → binds `createTurnInterpreterJudgeAgent` + returns `(parsed, c) => JudgeVerdict` via `JudgeVerdictSchema` structured output.

- [ ] **Step 4: Run the judge-agent test — verify pass; typecheck.**

Run: `npx vitest run src/mastra/agents/turn-interpreter-judge.agent.test.ts && npm run typecheck`
(The real factory is integration-only — no unit test; typecheck covers it. Confirm no module other than the factory imports composeMastra: `grep -rl composeMastra src/experiments/turn-interpreter` returns nothing.)

- [ ] **Step 5: Commit**

```bash
git add src/mastra/agents/turn-interpreter-judge.agent.ts src/mastra/agents/turn-interpreter-judge.agent.test.ts src/experiments/turn-interpreter/real-turn-interpreter-factory.ts
git commit -m "feat(turn-interpreter-eval): judge agent + real (composeMastra) factory"
```

---

### Task 6: CLI + dry-run plan + report + npm script

**Files:**
- Create: `scripts/turn-interpreter-eval.ts`
- Create: `src/experiments/turn-interpreter/report.ts` (planDryRun + writeReport + writeRunArtifacts — pure/testable parts)
- Modify: `package.json` (add `"turn-interpreter:eval"` script)
- Test: `src/experiments/turn-interpreter/report.test.ts`

**Interfaces:**
- Consumes: `rankAggregates`/`recommendEnv` (aggregate.ts), `EvalRunResult`/`ModelAggregate`/`ManifestMeta` (types.ts), `loadCases`/`fingerprintCases` (fixtures.ts).
- Produces: `parseArgs(argv: string[]): CliArgs`, `planDryRun(args, caseCount): { plannedPaidCalls: number; classifyCalls: number; missingKeys: string[] }`, `renderReport(run: EvalRunResult, rec): string`. The CLI wires these; `--run` dynamically imports `real-turn-interpreter-factory.ts`.

Mirror `scripts/intent-classifier-eval.ts` (dry-run-default, `--run` sole paid trigger, dynamic import of the real factory, artifact writing to `.artifacts/experiments/turn-interpreter/<dataset>/<timestamp>/`, exit code 3 on no-PASS). Put the pure helpers in `report.ts` so they unit-test without touching the model layer.

- [ ] **Step 1: Write the failing test `report.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseArgs, planDryRun, renderReport } from './report.ts';

describe('parseArgs', () => {
  it('defaults to dry run; --run flips it', () => {
    expect(parseArgs(['--models', 'a,b']).run).toBe(false);
    expect(parseArgs(['--models', 'a', '--run']).run).toBe(true);
    expect(parseArgs(['--models', 'a,b']).models).toEqual(['a', 'b']);
  });
});

describe('planDryRun', () => {
  it('computes paid-call volume = models × repeat × caseCount', () => {
    const plan = planDryRun(parseArgs(['--models', 'a,b', '--repeat', '3']), 10);
    expect(plan.classifyCalls).toBe(2 * 3 * 10);
  });
});

describe('renderReport', () => {
  it('includes the env recommendation line', () => {
    const run = { manifest: { datasetId: 'd', datasetFingerprint: 'fp', models: ['nano', 'strong'], repeat: 1, threshold: 0.75, caseCount: 1, judgeEnabled: false },
      candidates: [], aggregates: [
        { modelId: 'nano', provider: 'p', runs: 1, meanScore: 0.78, passRate: 1, meanLatencyMs: 100 },
        { modelId: 'strong', provider: 'p', runs: 1, meanScore: 0.90, passRate: 1, meanLatencyMs: 100 }] };
    const md = renderReport(run as never, { decision: 'own-env', recommendedModelId: 'strong', incumbentScore: 0.78, bestScore: 0.90, delta: 0.12, reason: 'x' });
    expect(md).toContain('own-env');
    expect(md).toContain('strong');
  });
});
```

- [ ] **Step 2: Run it — verify fail.**

- [ ] **Step 3: Implement `report.ts`** — `parseArgs` (flags `--dataset --models --run --threshold --judge --judge-model --repeat`, models required, comma-split, `run` default false), `planDryRun` (`classifyCalls = models.length × (repeat ?? 1) × caseCount`; `plannedPaidCalls` = same when keys present; `missingKeys` from env presence — mirror the sibling's key check), and `renderReport` (markdown: manifest, ranked table, and an explicit `Env recommendation: <decision> (<recommendedModelId>) — Δ<delta>` line). `writeRunArtifacts`/`writeReport` write JSON + `report.md` under `.artifacts/experiments/turn-interpreter/<dataset>/<timestamp>/` (mirror the sibling).

- [ ] **Step 4: Implement `scripts/turn-interpreter-eval.ts`** — mirror `scripts/intent-classifier-eval.ts`: load cases + fingerprint; if not `--run` → print `planDryRun` (plannedPaidCalls/classifyCalls/missingKeys) and exit 0 WITHOUT importing composeMastra; if `--run` → `await import('../src/experiments/turn-interpreter/real-turn-interpreter-factory.ts')`, build deps (`interpreterFor` = `buildRealInterpreterFor(env)`, `providerOf`, `clock: () => Date.now()`, `judge` only when `--judge --judge-model`), `runEval`, `rankAggregates`, `recommendEnv` (incumbent = `process.env.INTENT_CLASSIFIER_MODEL`), `writeRunArtifacts` + `writeReport`, exit 3 when no aggregate PASSes else 0.

- [ ] **Step 5: Add the npm script** to `package.json` (next to `intent:eval` / `analyst:eval`):
```json
"turn-interpreter:eval": "node --experimental-strip-types --env-file-if-exists=.env scripts/turn-interpreter-eval.ts",
```

- [ ] **Step 6: Run tests + dry-run smoke + full gates**

Run:
```
npx vitest run src/experiments/turn-interpreter/report.test.ts
npm run turn-interpreter:eval -- --models claude-haiku-4-5,gpt-5.4-nano   # DRY RUN: prints plan, builds nothing, exits 0
npx vitest run && npm run typecheck
```
Expected: report tests PASS; dry-run prints `classifyCalls`/`missingKeys` and makes NO paid call; full suite + typecheck green (incl. strip-types guard).

- [ ] **Step 7: Commit**

```bash
git add scripts/turn-interpreter-eval.ts src/experiments/turn-interpreter/report.ts src/experiments/turn-interpreter/report.test.ts package.json
git commit -m "feat(turn-interpreter-eval): CLI, dry-run plan, report with env recommendation"
```

---

## Self-review notes

- **Spec coverage:** Task 1 → architecture (package) + dataset + fixtures; Task 2 → scoring (weighted extraction + no-fabrication + trust-boundary parity); Task 3 → DI orchestrator (no composeMastra, failure isolation); Task 4 → ranking + env-recommendation rule (Δ≥0.05); Task 5 → real factory (sole composeMastra importer, --run-only) + judge agent (in src/mastra); Task 6 → CLI dry-run-default + report + npm + paid-call-volume. Judge opt-in covered in Tasks 3 (harness `judge?`) + 5 (agent/binding) + 6 (`--judge` flag).
- **Type consistency:** `scoreCase`/`scoreRun` signatures and `CaseResult`/`ScoreResult`/`ModelAggregate` field names are identical across Tasks 1-4; `interpreterFor`/`providerOf`/`judge?` consistent between Task 3 (def) and Task 6 (CLI wiring); `recommendEnv` return shape consistent between Task 4 (def) and Task 6 (`renderReport` consumer).
- **Mirror caveat:** Tasks 3/5/6 lean on reading the sibling intent-classifier harness for the boilerplate skeleton — the novel logic (scoring, recommendEnv, types, dataset) is given in full here.
- **Known v1 gap (from spec):** references fabrication is not penalized (only constraints) — accepted.

## Definition of Done

Full lab suite + typecheck green (incl. strip-types AST guard); dry-run prints the paid-call plan and makes zero model calls; the deterministic scorer + harness + aggregate + report unit-tested offline; `--run` path wired (paid, not exercised in CI). A real `--run` sweep (incumbent + 1-2 candidates) and acting on the env recommendation are follow-ups, not part of this slice's green bar.
