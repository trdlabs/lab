# SP-3 Research Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Research Cycle (§8.2): a `research.run_cycle` workflow that turns a persisted `StrategyProfile` into deterministically-validated, audited, deduped `HypothesisProposal` rows — Researcher agent → mandatory deterministic Validator → optional advisory Critic → persistence.

**Architecture:** Hexagonal, mirroring SP-2. Agents (`ResearcherPort`, `CriticPort`) return schema-validated JSON only. A deterministic `validateHypothesis` is the **only** accept/reject gate. Exact-fingerprint dedupe is the **only** mandatory dedupe; `SimilarHypothesisSearchPort` is advisory. The orchestrator handler owns every side-effect (DB writes, event audit). No code generation, no backtest, no pgvector — those are later SPs.

**Tech Stack:** TypeScript (ESM/NodeNext, Node native type-stripping), Zod, Drizzle ORM (Postgres), Mastra + `@ai-sdk/anthropic`, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-10-trading-lab-sp3-research-cycle-design.md`

---

## Critical conventions (read before every task)

- **NO TypeScript parameter properties** (`constructor(private x: T)`) — they throw at runtime under `--experimental-strip-types`. Always declare an explicit field and assign in the constructor body:
  ```ts
  export class Foo {
    private readonly bar: Bar;
    constructor(bar: Bar) { this.bar = bar; }
  }
  ```
- **All relative imports use explicit `.ts` extensions** (`from './x.ts'`).
- **Never put a raw NUL byte in a source file.** Use the explicit escape `const sep = '\u0000';` (six source characters). After writing any file that contains `\u0000`, verify: `python3 -c "print(open('PATH','rb').read().count(b'\x00'))"` must print `0`.
- **Agents return only schema-validated JSON.** Side-effects belong to the handler.
- **Determinism:** sort issue lists with a locale-independent comparator (`a < b ? -1 : a > b ? 1 : 0`), never `localeCompare`.
- Run `pnpm typecheck` and `pnpm test` after each task. Integration tests are gated on `DATABASE_URL`; live-LLM tests on `RUN_LLM_TESTS=true` + `ANTHROPIC_API_KEY` (otherwise `describe.skip`).
- Commit after every task with a `feat(sp3): ...` / `test(sp3): ...` message.

---

## File map

```
src/domain/hypothesis-rules.ts                       OVERLAY_ACTIONS, LAB_FEATURE_CATALOG, normalizeFeature, denylists
src/domain/hypothesis.ts                             schemas, types, hypothesisFingerprint, SimilarHypothesisSummary
src/domain/critic.ts                                 Critic Zod schemas + CriticInput/Output/Concern + HypothesisReview
src/validation/hypothesis-validator.ts               validateHypothesis (mandatory gate)
src/ports/researcher.port.ts                         ResearcherPort + ResearcherInput
src/ports/critic.port.ts                             CriticPort
src/ports/hypothesis-proposal.repository.ts          repo interface
src/ports/hypothesis-review.repository.ts            repo interface
src/ports/similar-hypothesis-search.port.ts          search interface
src/adapters/researcher/fake-researcher.ts
src/adapters/researcher/mastra-researcher.ts
src/adapters/critic/fake-critic.ts
src/adapters/critic/mastra-critic.ts
src/adapters/repository/in-memory-hypothesis-proposal.repository.ts
src/adapters/repository/drizzle-hypothesis-proposal.repository.ts
src/adapters/repository/in-memory-hypothesis-review.repository.ts
src/adapters/repository/drizzle-hypothesis-review.repository.ts
src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts
src/orchestrator/handlers/research-run-cycle.handler.ts
src/orchestrator/app-services.ts                     (extend)
src/composition.ts                                   (extend)
src/config/env.ts                                    (extend)
src/db/schema.ts                                     (extend: hypothesis_proposal, hypothesis_review)
migrations/0002_*.sql                                (generated)
test/support/make-services.ts                        (extend)
test/e2e/research-run-cycle.test.ts
+ unit/integration tests colocated next to each source file
```

---

## Task 1: Hypothesis rules — actions, feature catalog, normalization, denylists

**Files:**
- Create: `src/domain/hypothesis-rules.ts`
- Test: `src/domain/hypothesis-rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/hypothesis-rules.test.ts
import { describe, it, expect } from 'vitest';
import {
  OVERLAY_ACTIONS, LAB_FEATURE_CATALOG, normalizeFeature,
  LIVE_INTENT_DENYLIST, LOOKAHEAD_DENYLIST, PARAM_DENYLIST, AUTHORITY_DENYLIST,
} from './hypothesis-rules.ts';

describe('hypothesis-rules', () => {
  it('exposes the overlay action allowlist', () => {
    expect(OVERLAY_ACTIONS).toContain('skip_entry');
    expect(OVERLAY_ACTIONS).toContain('no_op');
  });

  it('exposes the lab feature catalog', () => {
    expect([...LAB_FEATURE_CATALOG]).toEqual(
      ['ohlcv', 'volume', 'oi', 'funding', 'liquidations', 'cvd', 'market_context', 'market_regime'],
    );
  });

  it('normalizes case, separators and trims', () => {
    expect(normalizeFeature('  Open Interest ')).toBe('oi');
    expect(normalizeFeature('CVD')).toBe('cvd');
    expect(normalizeFeature('funding-rate')).toBe('funding');
    expect(normalizeFeature('market regime')).toBe('market_regime');
  });

  it('maps known synonyms', () => {
    expect(normalizeFeature('open_interest')).toBe('oi');
    expect(normalizeFeature('liqs')).toBe('liquidations');
    expect(normalizeFeature('candles')).toBe('ohlcv');
  });

  it('leaves unknown features as a normalized slug', () => {
    expect(normalizeFeature('Order Book Imbalance')).toBe('order_book_imbalance');
  });

  it('exposes non-empty denylists', () => {
    expect(LIVE_INTENT_DENYLIST.length).toBeGreaterThan(0);
    expect(LOOKAHEAD_DENYLIST.length).toBeGreaterThan(0);
    expect(PARAM_DENYLIST).toContain('leverage');
    expect(AUTHORITY_DENYLIST.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/domain/hypothesis-rules.test.ts`
Expected: FAIL — cannot find module `./hypothesis-rules.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/hypothesis-rules.ts

/** Research-only overlay intents. NOT executable orders or risk authority — the runner/platform
 *  owns sizing, fills and execution. Action-specific param schemas land in SP-4. */
export const OVERLAY_ACTIONS = [
  'skip_entry', 'allow_entry', 'scale_in', 'scale_out',
  'tighten_stop', 'widen_stop', 'exit_now', 'adjust_size', 'no_op',
] as const;
export type OverlayAction = (typeof OVERLAY_ACTIONS)[number];

/** Baseline features the lab always knows how to source. Allowed set for a cycle is this
 *  union the profile's own (normalized) requiredMarketFeatures. */
export const LAB_FEATURE_CATALOG = [
  'ohlcv', 'volume', 'oi', 'funding', 'liquidations', 'cvd', 'market_context', 'market_regime',
] as const;

const FEATURE_SYNONYMS: Record<string, string> = {
  open_interest: 'oi', openinterest: 'oi',
  funding_rate: 'funding', fundingrate: 'funding',
  liqs: 'liquidations', liquidation: 'liquidations',
  cumulative_volume_delta: 'cvd',
  candles: 'ohlcv', candle: 'ohlcv', ohlc: 'ohlcv', price: 'ohlcv',
  vol: 'volume',
  regime: 'market_regime',
};

/** Lowercase, trim, collapse non-alphanumeric runs to '_', strip edge '_', then apply synonyms. */
export function normalizeFeature(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return FEATURE_SYNONYMS[slug] ?? slug;
}

/** Substring markers that signal live-execution intent in research-only text. Conservative by design. */
export const LIVE_INTENT_DENYLIST = [
  'place order', 'placeorder', 'market order', 'marketorder', 'limit order',
  'submit order', 'send order', 'execute trade', 'live trade', 'live trading',
  'real money', 'broker', 'exchange api',
] as const;

/** Markers that signal use of future information. */
export const LOOKAHEAD_DENYLIST = [
  'future candle', 'next candle close', 'next close known', 'future price',
  'lookahead', 'look-ahead', 'look ahead', 'knowledge of the future',
] as const;

/** Claims on runner-owned authority (sizing / fills / execution). */
export const AUTHORITY_DENYLIST = [
  'set leverage', 'adjust leverage', 'position sizing', 'risk sizing',
  'manage fills', 'own execution', 'execution authority',
] as const;

/** Tokens forbidden in rule param keys/values (safe-JSON guard). */
export const PARAM_DENYLIST = [
  'order', 'placeorder', 'marketorder', 'exchange', 'leverage',
  'apikey', 'api_key', 'secret', 'live', 'withdraw',
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/domain/hypothesis-rules.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/domain/hypothesis-rules.ts src/domain/hypothesis-rules.test.ts
git commit -m "feat(sp3): hypothesis rules — actions, feature catalog, normalization, denylists"
```

---

## Task 2: HypothesisProposal schemas, types, and fingerprint

**Files:**
- Create: `src/domain/hypothesis.ts`
- Test: `src/domain/hypothesis.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/hypothesis.test.ts
import { describe, it, expect } from 'vitest';
import {
  HypothesisProposalDraftSchema, ResearcherOutputSchema, RuleActionSchema,
  hypothesisFingerprint, HYPOTHESIS_PROPOSAL_CONTRACT_VERSION,
} from './hypothesis.ts';

const draft = {
  thesis: 'Skipping entries while OI is falling improves win rate',
  targetBehavior: 'Filter entries by open interest trend',
  ruleAction: { appliesTo: 'long' as const, rules: [{ when: 'oi falling', action: 'skip_entry' as const, params: { bars: 3 } }] },
  requiredFeatures: ['oi'],
  validationPlan: 'Backtest baseline vs variant over 90 days',
  expectedEffect: { metric: 'win_rate', direction: 'increase' as const },
  invalidationCriteria: ['No win_rate improvement vs baseline'],
  confidence: 0.6,
};

describe('hypothesis schemas', () => {
  it('accepts a well-formed draft', () => {
    expect(HypothesisProposalDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('rejects an empty invalidationCriteria', () => {
    const bad = { ...draft, invalidationCriteria: [] };
    expect(HypothesisProposalDraftSchema.safeParse(bad).success).toBe(false);
  });

  it('defaults rule params to an empty object', () => {
    const parsed = RuleActionSchema.parse({ appliesTo: 'short', rules: [{ when: 'x', action: 'no_op' }] });
    expect(parsed.rules[0].params).toEqual({});
  });

  it('parses a researcher output envelope', () => {
    const ok = ResearcherOutputSchema.safeParse({ hypotheses: [draft], researchSummary: 's' });
    expect(ok.success).toBe(true);
  });

  it('exposes the contract version', () => {
    expect(HYPOTHESIS_PROPOSAL_CONTRACT_VERSION).toBe('hypothesis-proposal-v1');
  });
});

describe('hypothesisFingerprint', () => {
  it('is stable regardless of ruleAction key order', () => {
    const a = hypothesisFingerprint(draft.thesis, { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: { bars: 3, z: 1 } }] });
    const b = hypothesisFingerprint(draft.thesis, { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: { z: 1, bars: 3 } }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when the thesis changes', () => {
    const a = hypothesisFingerprint('thesis one', draft.ruleAction);
    const b = hypothesisFingerprint('thesis two', draft.ruleAction);
    expect(a).not.toBe(b);
  });

  it('is insensitive to CRLF and surrounding whitespace in the thesis', () => {
    const a = hypothesisFingerprint('a\r\nb', draft.ruleAction);
    const b = hypothesisFingerprint('  a\nb  ', draft.ruleAction);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/domain/hypothesis.test.ts`
Expected: FAIL — cannot find module `./hypothesis.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/hypothesis.ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OVERLAY_ACTIONS } from './hypothesis-rules.ts';
import { DIRECTIONS } from './strategy-profile.ts';
import { canonicalizeContent } from './fingerprint.ts';
import type { ValidationIssue } from './schemas.ts';

export const HypothesisRuleSchema = z.object({
  when: z.string().min(1),
  action: z.enum(OVERLAY_ACTIONS),
  params: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  rationale: z.string().optional(),
});
export type HypothesisRule = z.infer<typeof HypothesisRuleSchema>;

export const RuleActionSchema = z.object({
  appliesTo: z.enum(DIRECTIONS),
  rules: z.array(HypothesisRuleSchema).min(1),
});
export type RuleAction = z.infer<typeof RuleActionSchema>;

export const ExpectedEffectSchema = z.object({
  metric: z.string().min(1),
  direction: z.enum(['increase', 'decrease']),
  magnitude: z.string().optional(),
});
export type ExpectedEffect = z.infer<typeof ExpectedEffectSchema>;

export const HypothesisProposalDraftSchema = z.object({
  thesis: z.string().min(1),
  targetBehavior: z.string().min(1),
  ruleAction: RuleActionSchema,
  requiredFeatures: z.array(z.string()),
  validationPlan: z.string().min(1),
  expectedEffect: ExpectedEffectSchema,
  invalidationCriteria: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});
export type HypothesisProposalDraft = z.infer<typeof HypothesisProposalDraftSchema>;

export const ResearcherOutputSchema = z.object({
  hypotheses: z.array(HypothesisProposalDraftSchema),
  researchSummary: z.string(),
});
export type ResearcherOutput = z.infer<typeof ResearcherOutputSchema>;

export const HYPOTHESIS_PROPOSAL_CONTRACT_VERSION = 'hypothesis-proposal-v1';

export type HypothesisStatus = 'validated' | 'rejected';

export interface HypothesisProposal {
  id: string;
  strategyProfileId: string;
  thesis: string;
  targetBehavior: string;
  ruleAction: RuleAction;
  requiredFeatures: string[]; // normalized
  validationPlan: string;
  expectedEffect: ExpectedEffect;
  invalidationCriteria: string[];
  confidence: number;
  status: HypothesisStatus;
  fingerprint: string;
  proposal: HypothesisProposalDraft; // full original draft
  issues: ValidationIssue[]; // [] for validated; reasons for rejected
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

/** Advisory similarity hit (lexical in MVP, pgvector later). Never gates. */
export interface SimilarHypothesisSummary {
  hypothesisId: string;
  thesis: string;
  status: HypothesisStatus;
  score: number;
}

/** Deterministic JSON with sorted object keys, so fingerprints ignore key ordering. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Exact-dedupe fingerprint over canonical thesis + canonical ruleAction. */
export function hypothesisFingerprint(thesis: string, ruleAction: RuleAction): string {
  const sep = '\u0000'; // explicit NUL separator (escape sequence — no raw NUL byte in source)
  const canonicalThesis = canonicalizeContent(thesis);
  const canonicalRule = canonicalizeContent(stableStringify(ruleAction));
  const hex = createHash('sha256').update(`${canonicalThesis}${sep}${canonicalRule}`, 'utf8').digest('hex');
  return `sha256:${hex}`;
}
```

- [ ] **Step 4: Run test to verify it passes, and verify no NUL bytes**

Run: `pnpm vitest run src/domain/hypothesis.test.ts`
Expected: PASS (8 tests).

Run: `python3 -c "print(open('src/domain/hypothesis.ts','rb').read().count(b'\x00'))"`
Expected: `0`.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/domain/hypothesis.ts src/domain/hypothesis.test.ts
git commit -m "feat(sp3): HypothesisProposal schemas, types, and exact-dedupe fingerprint"
```

---

## Task 3: Deterministic hypothesis Validator (the mandatory gate)

**Files:**
- Create: `src/validation/hypothesis-validator.ts`
- Test: `src/validation/hypothesis-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/validation/hypothesis-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateHypothesis } from './hypothesis-validator.ts';
import { LAB_FEATURE_CATALOG } from '../domain/hypothesis-rules.ts';
import type { HypothesisProposalDraft } from '../domain/hypothesis.ts';

const allowed = new Set<string>([...LAB_FEATURE_CATALOG]);

function baseDraft(): HypothesisProposalDraft {
  return {
    thesis: 'Skip entries while OI is falling',
    targetBehavior: 'Filter entries by OI trend',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: { bars: 3 } }] },
    requiredFeatures: ['Open Interest'],
    validationPlan: 'Backtest baseline vs variant',
    expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['No improvement vs baseline'],
    confidence: 0.6,
  };
}

describe('validateHypothesis', () => {
  it('validates a clean draft and normalizes features', () => {
    const r = validateHypothesis(baseDraft(), { allowedFeatures: allowed });
    expect(r.status).toBe('validated');
    expect(r.issues).toEqual([]);
    expect(r.normalizedFeatures).toEqual(['oi']);
  });

  it('rejects empty invalidationCriteria', () => {
    const r = validateHypothesis({ ...baseDraft(), invalidationCriteria: [] }, { allowedFeatures: allowed });
    expect(r.status).toBe('rejected');
    expect(r.issues.map((i) => i.code)).toContain('missing_falsifiability');
  });

  it('rejects an unavailable feature', () => {
    const r = validateHypothesis({ ...baseDraft(), requiredFeatures: ['some_unknown_feature'] }, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('unavailable_feature');
  });

  it('rejects disallowed param key semantics', () => {
    const d = baseDraft();
    d.ruleAction.rules[0].params = { leverage: 5 };
    const r = validateHypothesis(d, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('action_param_violation');
  });

  it('rejects disallowed param value semantics', () => {
    const d = baseDraft();
    d.ruleAction.rules[0].params = { note: 'place order on exchange' };
    const r = validateHypothesis(d, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('action_param_violation');
  });

  it('rejects live-execution intent in text', () => {
    const r = validateHypothesis({ ...baseDraft(), thesis: 'Place order on the exchange when OI falls' }, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('live_intent');
  });

  it('rejects lookahead markers', () => {
    const r = validateHypothesis({ ...baseDraft(), targetBehavior: 'Use next candle close known in advance' }, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('lookahead_marker');
  });

  it('rejects runner-owned authority claims', () => {
    const r = validateHypothesis({ ...baseDraft(), thesis: 'Set leverage to 5x and own execution' }, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('authority_violation');
  });

  it('produces deterministically sorted issues', () => {
    const d = baseDraft();
    d.invalidationCriteria = [];
    d.requiredFeatures = ['nope'];
    const r1 = validateHypothesis(d, { allowedFeatures: allowed });
    const r2 = validateHypothesis(d, { allowedFeatures: allowed });
    expect(r1.issues).toEqual(r2.issues);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/validation/hypothesis-validator.test.ts`
Expected: FAIL — cannot find module `./hypothesis-validator.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/validation/hypothesis-validator.ts
import type { HypothesisProposalDraft } from '../domain/hypothesis.ts';
import type { ValidationIssue } from '../domain/schemas.ts';
import {
  OVERLAY_ACTIONS, normalizeFeature,
  LIVE_INTENT_DENYLIST, LOOKAHEAD_DENYLIST, AUTHORITY_DENYLIST, PARAM_DENYLIST,
} from '../domain/hypothesis-rules.ts';

export interface HypothesisValidation {
  status: 'validated' | 'rejected';
  issues: ValidationIssue[];
  normalizedFeatures: string[];
}

/** Locale-independent total order, so the gate is deterministic across environments. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const OVERLAY_ACTION_SET = new Set<string>(OVERLAY_ACTIONS);

/** Mandatory accept/reject gate. Runs AFTER the schema gate. Dedupe is NOT checked here —
 *  the handler owns exact-fingerprint dedupe so this stays a pure function. */
export function validateHypothesis(
  draft: HypothesisProposalDraft,
  ctx: { allowedFeatures: Set<string> },
): HypothesisValidation {
  const issues: ValidationIssue[] = [];
  const normalizedFeatures = draft.requiredFeatures.map(normalizeFeature);

  if (draft.invalidationCriteria.length === 0) {
    issues.push({ code: 'missing_falsifiability', severity: 'error', path: 'invalidationCriteria', message: 'invalidationCriteria must not be empty' });
  }

  draft.ruleAction.rules.forEach((rule, i) => {
    if (!OVERLAY_ACTION_SET.has(rule.action)) {
      issues.push({ code: 'disallowed_action', severity: 'error', path: `ruleAction.rules.${i}.action`, message: `action '${rule.action}' is not allowed` });
    }
    for (const [key, value] of Object.entries(rule.params)) {
      const lowerKey = key.toLowerCase();
      if (PARAM_DENYLIST.some((t) => lowerKey.includes(t))) {
        issues.push({ code: 'action_param_violation', severity: 'error', path: `ruleAction.rules.${i}.params.${key}`, message: `param key '${key}' carries disallowed live/order semantics` });
      }
      if (typeof value === 'string') {
        const lowerVal = value.toLowerCase();
        if (PARAM_DENYLIST.some((t) => lowerVal.includes(t))) {
          issues.push({ code: 'action_param_violation', severity: 'error', path: `ruleAction.rules.${i}.params.${key}`, message: `param value carries disallowed live/order semantics` });
        }
      } else if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') {
        issues.push({ code: 'action_param_violation', severity: 'error', path: `ruleAction.rules.${i}.params.${key}`, message: 'param value must be a primitive (string/number/boolean/null)' });
      }
    }
  });

  normalizedFeatures.forEach((f, i) => {
    if (!ctx.allowedFeatures.has(f)) {
      issues.push({ code: 'unavailable_feature', severity: 'error', path: `requiredFeatures.${i}`, message: `feature '${f}' is not in the allowed set` });
    }
  });

  const haystack = [
    draft.thesis,
    draft.targetBehavior,
    ...draft.ruleAction.rules.flatMap((r) => [r.when, r.rationale ?? '']),
  ].join(' \n ').toLowerCase();

  const liveHits = LIVE_INTENT_DENYLIST.filter((t) => haystack.includes(t));
  if (liveHits.length > 0) {
    issues.push({ code: 'live_intent', severity: 'error', path: 'thesis', message: `live-execution markers not allowed: ${liveHits.join(', ')}` });
  }
  const lookaheadHits = LOOKAHEAD_DENYLIST.filter((t) => haystack.includes(t));
  if (lookaheadHits.length > 0) {
    issues.push({ code: 'lookahead_marker', severity: 'error', path: 'thesis', message: `lookahead markers not allowed: ${lookaheadHits.join(', ')}` });
  }
  const authorityHits = AUTHORITY_DENYLIST.filter((t) => haystack.includes(t));
  if (authorityHits.length > 0) {
    issues.push({ code: 'authority_violation', severity: 'error', path: 'thesis', message: `runner-owned authority claims not allowed: ${authorityHits.join(', ')}` });
  }

  issues.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.code, b.code));
  const status = issues.some((i) => i.severity === 'error') ? 'rejected' : 'validated';
  return { status, issues, normalizedFeatures };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/validation/hypothesis-validator.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/validation/hypothesis-validator.ts src/validation/hypothesis-validator.test.ts
git commit -m "feat(sp3): deterministic hypothesis Validator (mandatory accept/reject gate)"
```

---

## Task 4: ResearcherPort + FakeResearcher

**Files:**
- Create: `src/ports/researcher.port.ts`
- Create: `src/adapters/researcher/fake-researcher.ts`
- Test: `src/adapters/researcher/fake-researcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/researcher/fake-researcher.test.ts
import { describe, it, expect } from 'vitest';
import { FakeResearcher } from './fake-researcher.ts';
import { ResearcherOutputSchema } from '../../domain/hypothesis.ts';
import type { ResearcherInput } from '../../ports/researcher.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

function profile(): StrategyProfile {
  return {
    id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:abc',
    direction: 'long', coreIdea: 'Long OI divergence', requiredMarketFeatures: ['oi'],
    confidence: 0.5, unknowns: [], profile: {} as never,
    sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function input(maxHypotheses: number): ResearcherInput {
  return {
    profile: profile(),
    marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: { oi: 1 } },
    marketRegime: 'ranging',
    similarHypotheses: [],
    maxHypotheses,
  };
}

describe('FakeResearcher', () => {
  it('reports fake adapter identity', () => {
    const r = new FakeResearcher();
    expect(r.adapter).toBe('fake');
    expect(r.model).toBe('fake');
  });

  it('returns schema-valid output bounded by maxHypotheses', async () => {
    const out = await new FakeResearcher().propose(input(5));
    expect(ResearcherOutputSchema.safeParse(out).success).toBe(true);
    expect(out.hypotheses.length).toBe(2);
  });

  it('never exceeds maxHypotheses', async () => {
    const out = await new FakeResearcher().propose(input(1));
    expect(out.hypotheses.length).toBe(1);
  });

  it('produces distinct fingerprintable theses', async () => {
    const out = await new FakeResearcher().propose(input(2));
    expect(out.hypotheses[0].thesis).not.toBe(out.hypotheses[1].thesis);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/researcher/fake-researcher.test.ts`
Expected: FAIL — cannot find module `./fake-researcher.ts`.

- [ ] **Step 3: Write the port and the fake adapter**

```ts
// src/ports/researcher.port.ts
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { ResearcherOutput, SimilarHypothesisSummary } from '../domain/hypothesis.ts';
import type { MarketContext, MarketRegime } from './platform-gateway.port.ts';

export interface ResearcherInput {
  profile: StrategyProfile;
  marketContext: MarketContext;
  marketRegime: MarketRegime;
  similarHypotheses: SimilarHypothesisSummary[];
  maxHypotheses: number;
}

export interface ResearcherPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  propose(input: ResearcherInput): Promise<ResearcherOutput>;
}
```

```ts
// src/adapters/researcher/fake-researcher.ts
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import type { ResearcherOutput } from '../../domain/hypothesis.ts';

/** Deterministic stub: emits up to two clean, Validator-passing hypotheses derived from the
 *  profile. Uses only LAB_FEATURE_CATALOG features and avoids all denylist markers. No network. */
export class FakeResearcher implements ResearcherPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';

  async propose(input: ResearcherInput): Promise<ResearcherOutput> {
    const n = Math.max(0, Math.min(2, input.maxHypotheses));
    const hypotheses = Array.from({ length: n }, (_unused, i) => ({
      thesis: `Hypothesis ${i + 1}: ${input.profile.coreIdea} conditioned on ${input.marketRegime} regime`,
      targetBehavior: 'Adjust entry filtering using open interest trend',
      ruleAction: {
        appliesTo: input.profile.direction,
        rules: [{ when: `oi trend persists for ${i + 1} bars`, action: 'skip_entry' as const, params: { bars: i + 1 } }],
      },
      requiredFeatures: ['oi', 'funding'],
      validationPlan: 'Backtest baseline vs variant over the last 90 days',
      expectedEffect: { metric: 'win_rate', direction: 'increase' as const },
      invalidationCriteria: ['No win_rate improvement vs baseline'],
      confidence: 0.5,
    }));
    return { hypotheses, researchSummary: `Fake researcher produced ${n} hypotheses` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/researcher/fake-researcher.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/ports/researcher.port.ts src/adapters/researcher/fake-researcher.ts src/adapters/researcher/fake-researcher.test.ts
git commit -m "feat(sp3): ResearcherPort + deterministic FakeResearcher"
```

---

## Task 5: MastraResearcher (LLM adapter)

**Files:**
- Create: `src/adapters/researcher/mastra-researcher.ts`
- Test: `src/adapters/researcher/mastra-researcher.test.ts`

- [ ] **Step 1: Write the failing test** (live, `describe.skip` unless `RUN_LLM_TESTS`)

```ts
// src/adapters/researcher/mastra-researcher.test.ts
import { describe, it, expect } from 'vitest';
import { MastraResearcher } from './mastra-researcher.ts';
import { ResearcherOutputSchema } from '../../domain/hypothesis.ts';
import type { ResearcherInput } from '../../ports/researcher.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const run = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;

describe('MastraResearcher (construction)', () => {
  it('rejects non-Anthropic models', () => {
    expect(() => new MastraResearcher('openai/gpt-4o')).toThrow();
  });
  it('exposes adapter identity', () => {
    const r = new MastraResearcher('anthropic/claude-sonnet-4-6');
    expect(r.adapter).toBe('mastra');
    expect(r.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

(run ? describe : describe.skip)('MastraResearcher (live)', () => {
  it('returns schema-valid output', async () => {
    const profile: StrategyProfile = {
      id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:abc',
      direction: 'long', coreIdea: 'Buy capitulation wicks on high OI', requiredMarketFeatures: ['oi'],
      confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
      contractVersion: 'strategy-profile-v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    const input: ResearcherInput = {
      profile, marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: { oi: 1 } },
      marketRegime: 'capitulation', similarHypotheses: [], maxHypotheses: 2,
    };
    const out = await new MastraResearcher('anthropic/claude-sonnet-4-6').propose(input);
    expect(ResearcherOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/researcher/mastra-researcher.test.ts`
Expected: FAIL — cannot find module `./mastra-researcher.ts`.

- [ ] **Step 3: Write the implementation** (mirror `MastraStrategyAnalyst`)

```ts
// src/adapters/researcher/mastra-researcher.ts
import { Agent } from '@mastra/core/agent';
import { anthropic } from '@ai-sdk/anthropic';
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import { ResearcherOutputSchema, type ResearcherOutput } from '../../domain/hypothesis.ts';
import { OVERLAY_ACTIONS, LAB_FEATURE_CATALOG } from '../../domain/hypothesis-rules.ts';

const INSTRUCTIONS = [
  'You are a quantitative trading researcher.',
  'Given a strategy profile and market context, propose FALSIFIABLE hypotheses as overlay intents.',
  'Each hypothesis must change a specific behavior of the base strategy and be testable by backtest.',
  'This is research-only: never propose live order placement, execution, leverage, or risk sizing —',
  'those belong to the runner/platform. Use only overlay actions from the allowed set.',
  `Allowed overlay actions: ${OVERLAY_ACTIONS.join(', ')}.`,
  `Prefer market features from: ${LAB_FEATURE_CATALOG.join(', ')} (or features named in the profile).`,
  'Always provide invalidationCriteria (what observation would prove the hypothesis wrong).',
  'Respect the requested maximum number of hypotheses.',
].join(' ');

function buildPrompt(input: ResearcherInput): string {
  const similar = input.similarHypotheses.length > 0
    ? input.similarHypotheses.map((s) => `- [${s.status}] ${s.thesis}`).join('\n')
    : '(none)';
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Direction: ${input.profile.direction}`,
    `Profile required features: ${input.profile.requiredMarketFeatures.join(', ') || '(none)'}`,
    `Market regime: ${input.marketRegime}`,
    `Market context features: ${JSON.stringify(input.marketContext.features)}`,
    `Similar past hypotheses (advisory, avoid duplicating):\n${similar}`,
    `Produce at most ${input.maxHypotheses} hypotheses.`,
  ].join('\n');
}

export class MastraResearcher implements ResearcherPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(model: string) {
    this.model = model;
    const bareModelId = model.replace(/^anthropic\//, '');
    if (bareModelId.includes('/')) {
      throw new Error(`MastraResearcher only supports Anthropic models; got '${model}'`);
    }
    this.agent = new Agent({
      id: 'researcher',
      name: 'Researcher',
      instructions: INSTRUCTIONS,
      model: anthropic(bareModelId),
    });
  }

  async propose(input: ResearcherInput): Promise<ResearcherOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: ResearcherOutputSchema },
    });
    return ResearcherOutputSchema.parse(result.object);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/researcher/mastra-researcher.test.ts`
Expected: PASS — 2 construction tests pass; live block skipped (unless `RUN_LLM_TESTS=true`).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/adapters/researcher/mastra-researcher.ts src/adapters/researcher/mastra-researcher.test.ts
git commit -m "feat(sp3): MastraResearcher LLM adapter (Anthropic-only, schema-validated)"
```

---

## Task 6: Critic domain types + CriticPort + FakeCritic

**Files:**
- Create: `src/domain/critic.ts`
- Create: `src/ports/critic.port.ts`
- Create: `src/adapters/critic/fake-critic.ts`
- Test: `src/adapters/critic/fake-critic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/critic/fake-critic.test.ts
import { describe, it, expect } from 'vitest';
import { FakeCritic } from './fake-critic.ts';
import { CriticOutputSchema } from '../../domain/critic.ts';
import type { HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const draft: HypothesisProposalDraft = {
  thesis: 'Skip entries while OI is falling', targetBehavior: 'Filter entries',
  ruleAction: { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: {} }] },
  requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
  invalidationCriteria: ['no improvement'], confidence: 0.5,
};
const profile = { id: 'p1', coreIdea: 'x', direction: 'long' } as unknown as StrategyProfile;

describe('FakeCritic', () => {
  it('reports fake adapter identity', () => {
    const c = new FakeCritic();
    expect(c.adapter).toBe('fake');
    expect(c.model).toBe('fake');
  });

  it('returns schema-valid advisory output', async () => {
    const out = await new FakeCritic().review({ proposal: draft, profile });
    expect(CriticOutputSchema.safeParse(out).success).toBe(true);
    expect(out.verdict).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/critic/fake-critic.test.ts`
Expected: FAIL — cannot find module `./fake-critic.ts`.

- [ ] **Step 3: Write the domain, port, and fake adapter**

```ts
// src/domain/critic.ts
import { z } from 'zod';
import type { HypothesisProposalDraft } from './hypothesis.ts';
import type { StrategyProfile } from './strategy-profile.ts';

export const CriticConcernSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['info', 'warning']),
  message: z.string().min(1),
});
export type CriticConcern = z.infer<typeof CriticConcernSchema>;

export const CriticOutputSchema = z.object({
  verdict: z.enum(['ok', 'concerns']),
  concerns: z.array(CriticConcernSchema),
  summary: z.string(),
});
export type CriticOutput = z.infer<typeof CriticOutputSchema>;

export interface CriticInput {
  proposal: HypothesisProposalDraft;
  profile: StrategyProfile;
}

/** Persisted advisory review. Critic NEVER gates; this is audit only. */
export interface HypothesisReview {
  id: string;
  hypothesisId: string;
  criticAdapter: string;
  criticModel: string;
  verdict: 'ok' | 'concerns';
  concerns: CriticConcern[];
  summary: string;
  createdAt: string;
}
```

```ts
// src/ports/critic.port.ts
import type { CriticInput, CriticOutput } from '../domain/critic.ts';

export interface CriticPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  review(input: CriticInput): Promise<CriticOutput>;
}
```

```ts
// src/adapters/critic/fake-critic.ts
import type { CriticPort } from '../../ports/critic.port.ts';
import type { CriticInput, CriticOutput } from '../../domain/critic.ts';

export class FakeCritic implements CriticPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';

  async review(input: CriticInput): Promise<CriticOutput> {
    return { verdict: 'ok', concerns: [], summary: `Fake critic reviewed: ${input.proposal.thesis.slice(0, 60)}` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/critic/fake-critic.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/domain/critic.ts src/ports/critic.port.ts src/adapters/critic/fake-critic.ts src/adapters/critic/fake-critic.test.ts
git commit -m "feat(sp3): Critic domain types, CriticPort, FakeCritic (advisory only)"
```

---

## Task 7: MastraCritic (LLM adapter)

**Files:**
- Create: `src/adapters/critic/mastra-critic.ts`
- Test: `src/adapters/critic/mastra-critic.test.ts`

- [ ] **Step 1: Write the failing test** (live, gated)

```ts
// src/adapters/critic/mastra-critic.test.ts
import { describe, it, expect } from 'vitest';
import { MastraCritic } from './mastra-critic.ts';
import { CriticOutputSchema } from '../../domain/critic.ts';
import type { HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const run = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;

describe('MastraCritic (construction)', () => {
  it('rejects non-Anthropic models', () => {
    expect(() => new MastraCritic('openai/gpt-4o')).toThrow();
  });
  it('exposes adapter identity', () => {
    const c = new MastraCritic('anthropic/claude-sonnet-4-6');
    expect(c.adapter).toBe('mastra');
    expect(c.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

(run ? describe : describe.skip)('MastraCritic (live)', () => {
  it('returns schema-valid advisory output', async () => {
    const draft: HypothesisProposalDraft = {
      thesis: 'Skip entries while OI is falling', targetBehavior: 'Filter entries',
      ruleAction: { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: {} }] },
      requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
      invalidationCriteria: ['no improvement'], confidence: 0.5,
    };
    const profile = { id: 'p1', coreIdea: 'x', direction: 'long', requiredMarketFeatures: ['oi'] } as unknown as StrategyProfile;
    const out = await new MastraCritic('anthropic/claude-sonnet-4-6').review({ proposal: draft, profile });
    expect(CriticOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/critic/mastra-critic.test.ts`
Expected: FAIL — cannot find module `./mastra-critic.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/adapters/critic/mastra-critic.ts
import { Agent } from '@mastra/core/agent';
import { anthropic } from '@ai-sdk/anthropic';
import type { CriticPort } from '../../ports/critic.port.ts';
import { CriticOutputSchema, type CriticInput, type CriticOutput } from '../../domain/critic.ts';

const INSTRUCTIONS = [
  'You are a skeptical research reviewer for trading hypotheses.',
  'Assess: is the hypothesis falsifiable? Is it likely overfit? Does it rely on lookahead or unavailable data?',
  'Is the sample size plausible? Does it overstep research-only boundaries (live execution, risk sizing)?',
  'Return concerns as advisory notes with severity info or warning. You do NOT approve or reject —',
  'a deterministic validator owns that decision. Set verdict to "concerns" if you raise any, else "ok".',
].join(' ');

function buildPrompt(input: CriticInput): string {
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Thesis: ${input.proposal.thesis}`,
    `Target behavior: ${input.proposal.targetBehavior}`,
    `Rule action: ${JSON.stringify(input.proposal.ruleAction)}`,
    `Validation plan: ${input.proposal.validationPlan}`,
    `Invalidation criteria: ${input.proposal.invalidationCriteria.join('; ')}`,
  ].join('\n');
}

export class MastraCritic implements CriticPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(model: string) {
    this.model = model;
    const bareModelId = model.replace(/^anthropic\//, '');
    if (bareModelId.includes('/')) {
      throw new Error(`MastraCritic only supports Anthropic models; got '${model}'`);
    }
    this.agent = new Agent({
      id: 'critic',
      name: 'Critic',
      instructions: INSTRUCTIONS,
      model: anthropic(bareModelId),
    });
  }

  async review(input: CriticInput): Promise<CriticOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: CriticOutputSchema },
    });
    return CriticOutputSchema.parse(result.object);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/critic/mastra-critic.test.ts`
Expected: PASS — 2 construction tests; live block skipped.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/adapters/critic/mastra-critic.ts src/adapters/critic/mastra-critic.test.ts
git commit -m "feat(sp3): MastraCritic LLM adapter (advisory, Anthropic-only)"
```

---

## Task 8: HypothesisProposalRepository (port + in-memory)

**Files:**
- Create: `src/ports/hypothesis-proposal.repository.ts`
- Create: `src/adapters/repository/in-memory-hypothesis-proposal.repository.ts`
- Test: `src/adapters/repository/in-memory-hypothesis-proposal.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/repository/in-memory-hypothesis-proposal.repository.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryHypothesisProposalRepository } from './in-memory-hypothesis-proposal.repository.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';

function hyp(id: string, profileId: string, fp: string): HypothesisProposal {
  return {
    id, strategyProfileId: profileId, thesis: 't', targetBehavior: 'b',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
    requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'], confidence: 0.5, status: 'validated', fingerprint: fp,
    proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('InMemoryHypothesisProposalRepository', () => {
  it('creates and finds by id', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:a'));
    expect((await repo.findById('h1'))?.id).toBe('h1');
    expect(await repo.findById('missing')).toBeNull();
  });

  it('throws on duplicate id', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:a'));
    await expect(repo.create(hyp('h1', 'p1', 'sha256:b'))).rejects.toThrow();
  });

  it('throws on duplicate (strategyProfileId, fingerprint) — mirrors the DB unique guard', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:dup'));
    // Same profile + same fingerprint, different id -> must still throw.
    await expect(repo.create(hyp('h2', 'p1', 'sha256:dup'))).rejects.toThrow();
    // Same fingerprint under a DIFFERENT profile is allowed (dedupe is per profile).
    await expect(repo.create(hyp('h3', 'p2', 'sha256:dup'))).resolves.toBeUndefined();
  });

  it('lists by strategy profile in insertion order', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:a'));
    await repo.create(hyp('h2', 'p2', 'sha256:b'));
    await repo.create(hyp('h3', 'p1', 'sha256:c'));
    expect((await repo.listByStrategyProfile('p1')).map((h) => h.id)).toEqual(['h1', 'h3']);
  });

  it('lists fingerprints for a profile', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:a'));
    await repo.create(hyp('h2', 'p1', 'sha256:c'));
    expect((await repo.listFingerprints('p1')).sort()).toEqual(['sha256:a', 'sha256:c']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/repository/in-memory-hypothesis-proposal.repository.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the port and in-memory adapter**

```ts
// src/ports/hypothesis-proposal.repository.ts
import type { HypothesisProposal } from '../domain/hypothesis.ts';

export interface HypothesisProposalRepository {
  create(proposal: HypothesisProposal): Promise<void>;
  findById(id: string): Promise<HypothesisProposal | null>;
  listByStrategyProfile(strategyProfileId: string): Promise<HypothesisProposal[]>;
  listFingerprints(strategyProfileId: string): Promise<string[]>;
}
```

```ts
// src/adapters/repository/in-memory-hypothesis-proposal.repository.ts
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { HypothesisProposalRepository } from '../../ports/hypothesis-proposal.repository.ts';

export class InMemoryHypothesisProposalRepository implements HypothesisProposalRepository {
  private readonly byId = new Map<string, HypothesisProposal>();

  async create(proposal: HypothesisProposal): Promise<void> {
    if (this.byId.has(proposal.id)) throw new Error(`hypothesis_proposal already exists: ${proposal.id}`);
    // Mirror the DB unique (strategy_profile_id, fingerprint) guard so both adapters behave
    // identically. The handler dedupes via `seen` before insert, so this is a race backstop.
    for (const p of this.byId.values()) {
      if (p.strategyProfileId === proposal.strategyProfileId && p.fingerprint === proposal.fingerprint) {
        throw new Error(`hypothesis_proposal already exists for fingerprint: ${proposal.fingerprint} (profile ${proposal.strategyProfileId})`);
      }
    }
    this.byId.set(proposal.id, { ...proposal });
  }

  async findById(id: string): Promise<HypothesisProposal | null> {
    return this.byId.get(id) ?? null;
  }

  async listByStrategyProfile(strategyProfileId: string): Promise<HypothesisProposal[]> {
    return [...this.byId.values()].filter((h) => h.strategyProfileId === strategyProfileId);
  }

  async listFingerprints(strategyProfileId: string): Promise<string[]> {
    return [...this.byId.values()]
      .filter((h) => h.strategyProfileId === strategyProfileId)
      .map((h) => h.fingerprint);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/repository/in-memory-hypothesis-proposal.repository.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/ports/hypothesis-proposal.repository.ts src/adapters/repository/in-memory-hypothesis-proposal.repository.ts src/adapters/repository/in-memory-hypothesis-proposal.repository.test.ts
git commit -m "feat(sp3): HypothesisProposalRepository port + in-memory adapter"
```

---

## Task 9: HypothesisReviewRepository (port + in-memory)

**Files:**
- Create: `src/ports/hypothesis-review.repository.ts`
- Create: `src/adapters/repository/in-memory-hypothesis-review.repository.ts`
- Test: `src/adapters/repository/in-memory-hypothesis-review.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/repository/in-memory-hypothesis-review.repository.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryHypothesisReviewRepository } from './in-memory-hypothesis-review.repository.ts';
import type { HypothesisReview } from '../../domain/critic.ts';

function review(id: string, hypothesisId: string): HypothesisReview {
  return {
    id, hypothesisId, criticAdapter: 'fake', criticModel: 'fake',
    verdict: 'ok', concerns: [], summary: 's', createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('InMemoryHypothesisReviewRepository', () => {
  it('creates and lists by hypothesis in insertion order', async () => {
    const repo = new InMemoryHypothesisReviewRepository();
    await repo.create(review('r1', 'h1'));
    await repo.create(review('r2', 'h2'));
    await repo.create(review('r3', 'h1'));
    expect((await repo.listByHypothesis('h1')).map((r) => r.id)).toEqual(['r1', 'r3']);
  });

  it('throws on duplicate id', async () => {
    const repo = new InMemoryHypothesisReviewRepository();
    await repo.create(review('r1', 'h1'));
    await expect(repo.create(review('r1', 'h1'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/repository/in-memory-hypothesis-review.repository.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the port and in-memory adapter**

```ts
// src/ports/hypothesis-review.repository.ts
import type { HypothesisReview } from '../domain/critic.ts';

export interface HypothesisReviewRepository {
  create(review: HypothesisReview): Promise<void>;
  listByHypothesis(hypothesisId: string): Promise<HypothesisReview[]>;
}
```

```ts
// src/adapters/repository/in-memory-hypothesis-review.repository.ts
import type { HypothesisReview } from '../../domain/critic.ts';
import type { HypothesisReviewRepository } from '../../ports/hypothesis-review.repository.ts';

export class InMemoryHypothesisReviewRepository implements HypothesisReviewRepository {
  private readonly byId = new Map<string, HypothesisReview>();

  async create(review: HypothesisReview): Promise<void> {
    if (this.byId.has(review.id)) throw new Error(`hypothesis_review already exists: ${review.id}`);
    this.byId.set(review.id, { ...review });
  }

  async listByHypothesis(hypothesisId: string): Promise<HypothesisReview[]> {
    return [...this.byId.values()].filter((r) => r.hypothesisId === hypothesisId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/repository/in-memory-hypothesis-review.repository.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/ports/hypothesis-review.repository.ts src/adapters/repository/in-memory-hypothesis-review.repository.ts src/adapters/repository/in-memory-hypothesis-review.repository.test.ts
git commit -m "feat(sp3): HypothesisReviewRepository port + in-memory adapter"
```

---

## Task 10: SimilarHypothesisSearchPort + in-memory lexical adapter (advisory)

**Files:**
- Create: `src/ports/similar-hypothesis-search.port.ts`
- Create: `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts`
- Test: `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryLexicalSimilarHypothesisSearch } from './in-memory-lexical-similar-hypothesis-search.ts';
import { InMemoryHypothesisProposalRepository } from '../repository/in-memory-hypothesis-proposal.repository.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';

function hyp(id: string, thesis: string): HypothesisProposal {
  return {
    id, strategyProfileId: 'p1', thesis, targetBehavior: 'b',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
    requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'], confidence: 0.5, status: 'validated', fingerprint: `sha256:${id}`,
    proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('InMemoryLexicalSimilarHypothesisSearch', () => {
  it('ranks by token overlap and respects limit', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'skip entries when open interest is falling'));
    await repo.create(hyp('h2', 'buy capitulation wicks on high volume'));
    const search = new InMemoryLexicalSimilarHypothesisSearch(repo);
    const results = await search.search('p1', 'skip entries when open interest falls', 1);
    expect(results.length).toBe(1);
    expect(results[0].hypothesisId).toBe('h1');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('returns empty when the profile has no hypotheses', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    const search = new InMemoryLexicalSimilarHypothesisSearch(repo);
    expect(await search.search('p1', 'anything', 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the port and adapter**

```ts
// src/ports/similar-hypothesis-search.port.ts
import type { SimilarHypothesisSummary } from '../domain/hypothesis.ts';

/** Advisory similarity search. NEVER a gate — mandatory dedupe is exact fingerprint only.
 *  In-memory lexical for MVP; pgvector adapter lands later behind this same port. */
export interface SimilarHypothesisSearchPort {
  search(strategyProfileId: string, query: string, limit: number): Promise<SimilarHypothesisSummary[]>;
}
```

```ts
// src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts
import type { SimilarHypothesisSummary } from '../../domain/hypothesis.ts';
import type { HypothesisProposalRepository } from '../../ports/hypothesis-proposal.repository.ts';
import type { SimilarHypothesisSearchPort } from '../../ports/similar-hypothesis-search.port.ts';

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class InMemoryLexicalSimilarHypothesisSearch implements SimilarHypothesisSearchPort {
  private readonly repo: HypothesisProposalRepository;
  constructor(repo: HypothesisProposalRepository) {
    this.repo = repo;
  }

  async search(strategyProfileId: string, query: string, limit: number): Promise<SimilarHypothesisSummary[]> {
    const all = await this.repo.listByStrategyProfile(strategyProfileId);
    const queryTokens = tokenize(query);
    const scored = all.map((h) => ({
      hypothesisId: h.id,
      thesis: h.thesis,
      status: h.status,
      score: jaccard(queryTokens, tokenize(h.thesis)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/ports/similar-hypothesis-search.port.ts src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts
git commit -m "feat(sp3): SimilarHypothesisSearchPort + in-memory lexical adapter (advisory)"
```

---

## Task 11: DB schema tables + migration

**Files:**
- Modify: `src/db/schema.ts` (append two tables)
- Create: `migrations/0002_*.sql` (generated)

- [ ] **Step 1: Add the Drizzle tables**

Append to `src/db/schema.ts` (the `pgTable`, `text`, `jsonb`, `timestamp`, `index`, `uniqueIndex`, `integer`, `real` imports already exist):

```ts
export const hypothesisProposal = pgTable('hypothesis_proposal', {
  id: text('id').primaryKey(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  thesis: text('thesis').notNull(),
  targetBehavior: text('target_behavior').notNull(),
  ruleAction: jsonb('rule_action').notNull().$type<import('../domain/hypothesis.ts').RuleAction>(),
  requiredFeatures: jsonb('required_features').notNull().$type<string[]>(),
  validationPlan: text('validation_plan').notNull(),
  expectedEffect: jsonb('expected_effect').notNull().$type<import('../domain/hypothesis.ts').ExpectedEffect>(),
  invalidationCriteria: jsonb('invalidation_criteria').notNull().$type<string[]>(),
  confidence: real('confidence').notNull(),
  status: text('status').notNull(),
  fingerprint: text('fingerprint').notNull(),
  proposal: jsonb('proposal').notNull().$type<import('../domain/hypothesis.ts').HypothesisProposalDraft>(),
  issues: jsonb('issues').notNull().$type<import('../domain/schemas.ts').ValidationIssue[]>(),
  contractVersion: text('contract_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Per-profile exact-dedupe guard at the DB level. The handler skips known fingerprints
  // before insert, so this is a race backstop, never the primary dedupe path.
  profileFpUq: uniqueIndex('hypothesis_proposal_profile_fp_uq').on(t.strategyProfileId, t.fingerprint),
  profileIdx: index('hypothesis_proposal_profile_idx').on(t.strategyProfileId),
  statusIdx: index('hypothesis_proposal_status_idx').on(t.status),
}));

export const hypothesisReview = pgTable('hypothesis_review', {
  id: text('id').primaryKey(),
  hypothesisId: text('hypothesis_id').notNull(),
  criticAdapter: text('critic_adapter').notNull(),
  criticModel: text('critic_model').notNull(),
  verdict: text('verdict').notNull(),
  concerns: jsonb('concerns').notNull().$type<import('../domain/critic.ts').CriticConcern[]>(),
  summary: text('summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // No FK to hypothesis_proposal by design — review is an append-only audit row.
  hypothesisIdx: index('hypothesis_review_hypothesis_idx').on(t.hypothesisId),
}));
```

> Note: the inline `import('...').Type` type-only references avoid adding new top-of-file imports for types already defined elsewhere; if the project prefers top-level `import type`, add them instead — both compile identically.

- [ ] **Step 2: Typecheck the schema**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `migrations/0002_<name>.sql` containing `CREATE TABLE "hypothesis_proposal"` and `CREATE TABLE "hypothesis_review"` plus the unique/index statements. Verify it references both tables and the unique index `hypothesis_proposal_profile_fp_uq`.

- [ ] **Step 4: Verify migration applies (if `DATABASE_URL` is set)**

Run (only with a live DB): `pnpm db:migrate`
Expected: applies cleanly. If no DB is available, skip — Task 12 integration tests will exercise it.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts migrations/
git commit -m "feat(sp3): hypothesis_proposal + hypothesis_review tables and migration"
```

---

## Task 12: Drizzle repositories (proposal + review)

**Files:**
- Create: `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts`
- Create: `src/adapters/repository/drizzle-hypothesis-review.repository.ts`
- Test: `src/adapters/repository/drizzle-hypothesis.repository.test.ts` (integration, gated on `DATABASE_URL`)

- [ ] **Step 1: Write the failing integration test**

```ts
// src/adapters/repository/drizzle-hypothesis.repository.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createDbClient } from '../../db/client.ts';
import { DrizzleHypothesisProposalRepository } from './drizzle-hypothesis-proposal.repository.ts';
import { DrizzleHypothesisReviewRepository } from './drizzle-hypothesis-review.repository.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { HypothesisReview } from '../../domain/critic.ts';

const url = process.env.DATABASE_URL;

function hyp(id: string, fp: string, status: 'validated' | 'rejected' = 'validated'): HypothesisProposal {
  return {
    id, strategyProfileId: 'p-drizzle', thesis: 'thesis ' + id, targetBehavior: 'b',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: { n: 1 } }] },
    requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'], confidence: 0.5, status, fingerprint: fp,
    proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

(url ? describe : describe.skip)('Drizzle hypothesis repositories (integration)', () => {
  let proposals: DrizzleHypothesisProposalRepository;
  let reviews: DrizzleHypothesisReviewRepository;
  let pool: Pool;

  beforeAll(() => {
    const client = createDbClient(url as string);
    pool = client.pool;
    proposals = new DrizzleHypothesisProposalRepository(client.db);
    reviews = new DrizzleHypothesisReviewRepository(client.db);
  });

  afterAll(async () => {
    await pool.end(); // close the Postgres pool so the test process exits cleanly
  });

  it('persists and reads back a proposal', async () => {
    const id = 'h-' + Date.now();
    await proposals.create(hyp(id, 'sha256:' + id));
    const found = await proposals.findById(id);
    expect(found?.id).toBe(id);
    expect(found?.ruleAction.rules[0].action).toBe('no_op');
  });

  it('lists fingerprints for a profile', async () => {
    const fps = await proposals.listFingerprints('p-drizzle');
    expect(Array.isArray(fps)).toBe(true);
  });

  it('enforces the unique (profile, fingerprint) index', async () => {
    const fp = 'sha256:dup-' + Date.now();
    await proposals.create(hyp('a-' + Date.now(), fp));
    await expect(proposals.create(hyp('b-' + Date.now(), fp))).rejects.toThrow();
  });

  it('persists and lists a review', async () => {
    const hid = 'h-rev-' + Date.now();
    const review: HypothesisReview = {
      id: 'r-' + Date.now(), hypothesisId: hid, criticAdapter: 'fake', criticModel: 'fake',
      verdict: 'ok', concerns: [], summary: 's', createdAt: new Date().toISOString(),
    };
    await reviews.create(review);
    expect((await reviews.listByHypothesis(hid)).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/repository/drizzle-hypothesis.repository.test.ts`
Expected: FAIL — cannot find modules (or `describe.skip` with no DB; in that case proceed — the modules still must exist to import, so the failure is the missing-module import error).

- [ ] **Step 3: Write the Drizzle adapters**

```ts
// src/adapters/repository/drizzle-hypothesis-proposal.repository.ts
import { eq, asc } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { hypothesisProposal } from '../../db/schema.ts';
import type {
  HypothesisProposal, HypothesisStatus, RuleAction, ExpectedEffect, HypothesisProposalDraft,
} from '../../domain/hypothesis.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import type { HypothesisProposalRepository } from '../../ports/hypothesis-proposal.repository.ts';

type Row = typeof hypothesisProposal.$inferSelect;

function toDomain(row: Row): HypothesisProposal {
  return {
    id: row.id,
    strategyProfileId: row.strategyProfileId,
    thesis: row.thesis,
    targetBehavior: row.targetBehavior,
    ruleAction: row.ruleAction as RuleAction,
    requiredFeatures: row.requiredFeatures,
    validationPlan: row.validationPlan,
    expectedEffect: row.expectedEffect as ExpectedEffect,
    invalidationCriteria: row.invalidationCriteria,
    confidence: row.confidence,
    status: row.status as HypothesisStatus,
    fingerprint: row.fingerprint,
    proposal: row.proposal as HypothesisProposalDraft,
    issues: row.issues as ValidationIssue[],
    contractVersion: row.contractVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleHypothesisProposalRepository implements HypothesisProposalRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async create(p: HypothesisProposal): Promise<void> {
    await this.db.insert(hypothesisProposal).values({
      id: p.id, strategyProfileId: p.strategyProfileId, thesis: p.thesis, targetBehavior: p.targetBehavior,
      ruleAction: p.ruleAction, requiredFeatures: p.requiredFeatures, validationPlan: p.validationPlan,
      expectedEffect: p.expectedEffect, invalidationCriteria: p.invalidationCriteria, confidence: p.confidence,
      status: p.status, fingerprint: p.fingerprint, proposal: p.proposal, issues: p.issues,
      contractVersion: p.contractVersion, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
    });
  }

  async findById(id: string): Promise<HypothesisProposal | null> {
    const rows = await this.db.select().from(hypothesisProposal).where(eq(hypothesisProposal.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async listByStrategyProfile(strategyProfileId: string): Promise<HypothesisProposal[]> {
    const rows = await this.db
      .select().from(hypothesisProposal)
      .where(eq(hypothesisProposal.strategyProfileId, strategyProfileId))
      .orderBy(asc(hypothesisProposal.createdAt));
    return rows.map(toDomain);
  }

  async listFingerprints(strategyProfileId: string): Promise<string[]> {
    const rows = await this.db
      .select({ fingerprint: hypothesisProposal.fingerprint })
      .from(hypothesisProposal)
      .where(eq(hypothesisProposal.strategyProfileId, strategyProfileId));
    return rows.map((r) => r.fingerprint);
  }
}
```

```ts
// src/adapters/repository/drizzle-hypothesis-review.repository.ts
import { eq, asc } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { hypothesisReview } from '../../db/schema.ts';
import type { HypothesisReview, CriticConcern } from '../../domain/critic.ts';
import type { HypothesisReviewRepository } from '../../ports/hypothesis-review.repository.ts';

type Row = typeof hypothesisReview.$inferSelect;

function toDomain(row: Row): HypothesisReview {
  return {
    id: row.id,
    hypothesisId: row.hypothesisId,
    criticAdapter: row.criticAdapter,
    criticModel: row.criticModel,
    verdict: row.verdict as 'ok' | 'concerns',
    concerns: row.concerns as CriticConcern[],
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleHypothesisReviewRepository implements HypothesisReviewRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async create(review: HypothesisReview): Promise<void> {
    await this.db.insert(hypothesisReview).values({
      id: review.id, hypothesisId: review.hypothesisId, criticAdapter: review.criticAdapter,
      criticModel: review.criticModel, verdict: review.verdict, concerns: review.concerns,
      summary: review.summary, createdAt: new Date(review.createdAt),
    });
  }

  async listByHypothesis(hypothesisId: string): Promise<HypothesisReview[]> {
    const rows = await this.db
      .select().from(hypothesisReview)
      .where(eq(hypothesisReview.hypothesisId, hypothesisId))
      .orderBy(asc(hypothesisReview.createdAt));
    return rows.map(toDomain);
  }
}
```

- [ ] **Step 4: Run tests**

Run (with infra up): `DATABASE_URL=postgres://... pnpm vitest run src/adapters/repository/drizzle-hypothesis.repository.test.ts`
Expected: PASS (4 tests). Without `DATABASE_URL`: the suite is `describe.skip` and only verifies the modules import/typecheck.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/repository/drizzle-hypothesis-proposal.repository.ts src/adapters/repository/drizzle-hypothesis-review.repository.ts src/adapters/repository/drizzle-hypothesis.repository.test.ts
git commit -m "feat(sp3): Drizzle hypothesis proposal + review repositories"
```

---

## Task 13: env additions + AppServices extension + make-services + composition service wiring

> This task extends `AppServices` with new **required** fields. To keep `pnpm typecheck` green after this commit (a hard requirement for Subagent-Driven), it ALSO wires those fields into `src/composition.ts` in the same task — populating every new service field with its real adapter. Only the `research.run_cycle` handler *registration* is deferred to Task 15 (the handler does not exist until Task 14).

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/orchestrator/app-services.ts`
- Modify: `test/support/make-services.ts`
- Modify: `src/composition.ts`
- Test: `src/config/env.test.ts` (extend if it exists, else create)

- [ ] **Step 1: Write the failing env test**

```ts
// src/config/env.test.ts  (add these cases; create the file if absent)
import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';

describe('loadEnv SP-3 fields', () => {
  it('defaults researcher and critic to fake and bounds hypotheses', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.RESEARCHER_ADAPTER).toBe('fake');
    expect(env.CRITIC_ADAPTER).toBe('fake');
    expect(env.MAX_HYPOTHESES_PER_CYCLE).toBe(5);
  });

  it('honors overrides and rejects non-positive guardrails', () => {
    const env = loadEnv({ RESEARCHER_ADAPTER: 'mastra', MAX_HYPOTHESES_PER_CYCLE: '0' } as NodeJS.ProcessEnv);
    expect(env.RESEARCHER_ADAPTER).toBe('mastra');
    expect(env.MAX_HYPOTHESES_PER_CYCLE).toBe(5); // 0 is invalid -> fallback
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/config/env.test.ts`
Expected: FAIL — `RESEARCHER_ADAPTER` undefined.

- [ ] **Step 3: Extend `src/config/env.ts`**

Add fields to the `Env` interface:

```ts
  RESEARCHER_ADAPTER: 'fake' | 'mastra';
  RESEARCHER_MODEL: string;
  CRITIC_ADAPTER: 'fake' | 'mastra';
  CRITIC_MODEL: string;
  MAX_HYPOTHESES_PER_CYCLE: number;
```

Add a parser above `loadEnv`:

```ts
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
```

Add to the object returned by `loadEnv`:

```ts
    RESEARCHER_ADAPTER: source.RESEARCHER_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    RESEARCHER_MODEL: source.RESEARCHER_MODEL ?? 'anthropic/claude-sonnet-4-6',
    CRITIC_ADAPTER: source.CRITIC_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    CRITIC_MODEL: source.CRITIC_MODEL ?? 'anthropic/claude-sonnet-4-6',
    MAX_HYPOTHESES_PER_CYCLE: parsePositiveInt(source.MAX_HYPOTHESES_PER_CYCLE, 5),
```

- [ ] **Step 4: Extend `AppServices` and `make-services`**

`src/orchestrator/app-services.ts` — add imports and fields:

```ts
import type { PlatformGatewayPort } from '../ports/platform-gateway.port.ts';
import type { ResearcherPort } from '../ports/researcher.port.ts';
import type { CriticPort } from '../ports/critic.port.ts';
import type { HypothesisProposalRepository } from '../ports/hypothesis-proposal.repository.ts';
import type { HypothesisReviewRepository } from '../ports/hypothesis-review.repository.ts';
import type { SimilarHypothesisSearchPort } from '../ports/similar-hypothesis-search.port.ts';
```

Add to the `AppServices` interface:

```ts
  platform: PlatformGatewayPort;
  researcher: ResearcherPort;
  critic: CriticPort | null;          // null when ENABLE_CRITIC_AGENT=false
  hypotheses: HypothesisProposalRepository;
  hypothesisReviews: HypothesisReviewRepository;
  similarHypotheses: SimilarHypothesisSearchPort;
  maxHypothesesPerCycle: number;      // budget guardrail injected from env
```

`test/support/make-services.ts` — extend to wire all in-memory/fake instances. Replace the file with:

```ts
import type { AppServices } from '../../src/orchestrator/app-services.ts';
import { InMemoryResearchTaskRepository } from '../../src/adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../../src/adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryAgentEventRepository } from '../../src/adapters/repository/in-memory-agent-event.repository.ts';
import { InMemoryArtifactStore } from '../../src/adapters/artifact/in-memory-artifact-store.ts';
import { FakeStrategyAnalyst } from '../../src/adapters/analyst/fake-strategy-analyst.ts';
import { MockPlatformGatewayAdapter } from '../../src/adapters/platform/mock-platform-gateway.adapter.ts';
import { FakeResearcher } from '../../src/adapters/researcher/fake-researcher.ts';
import { InMemoryHypothesisProposalRepository } from '../../src/adapters/repository/in-memory-hypothesis-proposal.repository.ts';
import { InMemoryHypothesisReviewRepository } from '../../src/adapters/repository/in-memory-hypothesis-review.repository.ts';
import { InMemoryLexicalSimilarHypothesisSearch } from '../../src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts';

export function makeServices(overrides: Partial<AppServices> = {}): AppServices {
  const hypotheses = new InMemoryHypothesisProposalRepository();
  return {
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    analyst: new FakeStrategyAnalyst(),
    artifacts: new InMemoryArtifactStore(),
    events: new InMemoryAgentEventRepository(),
    platform: new MockPlatformGatewayAdapter(),
    researcher: new FakeResearcher(),
    critic: null, // base happy-path does not invoke Critic; tests opt in via overrides
    hypotheses,
    hypothesisReviews: new InMemoryHypothesisReviewRepository(),
    similarHypotheses: new InMemoryLexicalSimilarHypothesisSearch(hypotheses),
    maxHypothesesPerCycle: 5,
    ...overrides,
  };
}
```

- [ ] **Step 5: Wire the new service fields into `src/composition.ts` (no handler registration yet)**

`AppServices` now has new required fields, so `composeRuntime` must populate them or the project will not typecheck. Add these imports to `src/composition.ts`:

```ts
import { MockPlatformGatewayAdapter } from './adapters/platform/mock-platform-gateway.adapter.ts';
import { FakeResearcher } from './adapters/researcher/fake-researcher.ts';
import { MastraResearcher } from './adapters/researcher/mastra-researcher.ts';
import { FakeCritic } from './adapters/critic/fake-critic.ts';
import { MastraCritic } from './adapters/critic/mastra-critic.ts';
import { DrizzleHypothesisProposalRepository } from './adapters/repository/drizzle-hypothesis-proposal.repository.ts';
import { DrizzleHypothesisReviewRepository } from './adapters/repository/drizzle-hypothesis-review.repository.ts';
import { InMemoryLexicalSimilarHypothesisSearch } from './adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts';
import type { ResearcherPort } from './ports/researcher.port.ts';
import type { CriticPort } from './ports/critic.port.ts';
```

Add the two builder functions next to the existing `buildAnalyst`:

```ts
function buildResearcher(env: ReturnType<typeof loadEnv>): ResearcherPort {
  if (env.RESEARCHER_ADAPTER === 'mastra') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required when RESEARCHER_ADAPTER=mastra');
    return new MastraResearcher(env.RESEARCHER_MODEL);
  }
  console.warn('[composition] RESEARCHER_ADAPTER is not "mastra"; using FakeResearcher (stub hypotheses)');
  return new FakeResearcher();
}

function buildCritic(env: ReturnType<typeof loadEnv>): CriticPort | null {
  if (!env.ENABLE_CRITIC_AGENT) return null; // advisory; off by default
  if (env.CRITIC_ADAPTER === 'mastra') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required when CRITIC_ADAPTER=mastra');
    return new MastraCritic(env.CRITIC_MODEL);
  }
  console.warn('[composition] ENABLE_CRITIC_AGENT=true but CRITIC_ADAPTER is not "mastra"; using FakeCritic');
  return new FakeCritic();
}
```

In `composeRuntime`, replace the `services` construction so it includes the new fields (build `hypotheses` first so the lexical search can wrap it):

```ts
  const hypotheses = new DrizzleHypothesisProposalRepository(db);

  const services: AppServices = {
    researchTasks: new DrizzleResearchTaskRepository(db),
    strategyProfiles: new DrizzleStrategyProfileRepository(db),
    analyst: buildAnalyst(env),
    artifacts: new LocalFileArtifactStore(env.ARTIFACT_DIR),
    events: new DrizzleAgentEventRepository(db),
    platform: new MockPlatformGatewayAdapter(),
    researcher: buildResearcher(env),
    critic: buildCritic(env),
    hypotheses,
    hypothesisReviews: new DrizzleHypothesisReviewRepository(db),
    similarHypotheses: new InMemoryLexicalSimilarHypothesisSearch(hypotheses),
    maxHypothesesPerCycle: env.MAX_HYPOTHESES_PER_CYCLE,
  };
```

Do **not** add `router.register('research.run_cycle', ...)` yet — the handler is created in Task 14 and registered in Task 15. The existing `strategy.onboard` registration stays as-is.

- [ ] **Step 6: Run tests, typecheck (must be green), commit**

Run: `pnpm vitest run src/config/env.test.ts`
Expected: PASS.

Run: `pnpm typecheck`
Expected: PASS for the **whole project** — `AppServices`, `makeServices`, and `composition.ts` are now all consistent.

```bash
git add src/config/env.ts src/config/env.test.ts src/orchestrator/app-services.ts test/support/make-services.ts src/composition.ts
git commit -m "feat(sp3): env fields, AppServices extension, make-services + composition service wiring"
```

---

## Task 14: research.run_cycle handler

**Files:**
- Create: `src/orchestrator/handlers/research-run-cycle.handler.ts`
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts`

- [ ] **Step 1: Write the failing test** (covers dedupe incl. batch-internal, validate accept/reject, effectiveMax clamp, critic on/off, similarity-is-not-a-gate, event trail)

```ts
// src/orchestrator/handlers/research-run-cycle.handler.test.ts
import { describe, it, expect } from 'vitest';
import { researchRunCycleHandler } from './research-run-cycle.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { FakeCritic } from '../../adapters/critic/fake-critic.ts';
import type { HypothesisProposalDraft, ResearcherOutput } from '../../domain/hypothesis.ts';
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { AppServices } from '../app-services.ts';

function profile(): StrategyProfile {
  return {
    id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:p',
    direction: 'long', coreIdea: 'Long OI divergence', requiredMarketFeatures: ['oi'],
    confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function task(payload: Record<string, unknown>): ResearchTask {
  return {
    id: 't1', taskType: 'research.run_cycle', source: 'operator', correlationId: 'c1',
    status: 'running', payload, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function draft(thesis: string, action: 'skip_entry' | 'no_op' = 'skip_entry', bars = 1): HypothesisProposalDraft {
  return {
    thesis, targetBehavior: 'filter entries',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend', action, params: { bars } }] },
    requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['no improvement'], confidence: 0.5,
  };
}

/** Researcher stub returning a fixed output, ignoring input. */
function stubResearcher(out: ResearcherOutput): ResearcherPort {
  return { adapter: 'fake', model: 'stub', async propose(_in: ResearcherInput) { return out; } };
}

async function seedProfile(services: AppServices) {
  await services.strategyProfiles.create(profile());
}

async function types(services: AppServices): Promise<string[]> {
  return (await services.events.listByTask('t1')).map((e) => e.type);
}

describe('researchRunCycleHandler', () => {
  it('throws on invalid payload', async () => {
    const services = makeServices();
    await expect(researchRunCycleHandler(task({}), services)).rejects.toThrow();
  });

  it('throws when the strategy profile is missing', async () => {
    const services = makeServices();
    await expect(researchRunCycleHandler(task({ strategyProfileId: 'nope' }), services)).rejects.toThrow();
  });

  it('persists validated hypotheses and emits the audit trail', async () => {
    const services = makeServices({ researcher: stubResearcher({ hypotheses: [draft('thesis A')], researchSummary: 's' }) });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    const stored = await services.hypotheses.listByStrategyProfile('p1');
    expect(stored.length).toBe(1);
    expect(stored[0].status).toBe('validated');
    const t = await types(services);
    expect(t[0]).toBe('research.run_cycle.started');
    expect(t).toContain('hypothesis.validated');
    expect(t.at(-1)).toBe('research.run_cycle.completed');
  });

  it('persists rejected hypotheses with issues', async () => {
    const bad = draft('Place order on the exchange now'); // live_intent
    const services = makeServices({ researcher: stubResearcher({ hypotheses: [bad], researchSummary: 's' }) });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    const stored = await services.hypotheses.listByStrategyProfile('p1');
    expect(stored.length).toBe(1);
    expect(stored[0].status).toBe('rejected');
    expect(stored[0].issues.map((i) => i.code)).toContain('live_intent');
    expect(await types(services)).toContain('hypothesis.rejected');
  });

  it('dedupes a batch-internal duplicate: first persists, second only emits deduped', async () => {
    // Two drafts with identical thesis AND ruleAction => identical fingerprint.
    const d = draft('same thesis', 'no_op');
    const services = makeServices({ researcher: stubResearcher({ hypotheses: [d, { ...d }], researchSummary: 's' }) });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    const stored = await services.hypotheses.listByStrategyProfile('p1');
    expect(stored.length).toBe(1); // only the first row persisted
    const t = await types(services);
    expect(t.filter((x) => x === 'hypothesis.deduped').length).toBe(1);
  });

  it('adds rejected fingerprints to seen so an identical later draft dedupes (seen.add on both paths)', async () => {
    const bad = draft('Place order live', 'no_op'); // rejected by Validator
    const services = makeServices({ researcher: stubResearcher({ hypotheses: [bad, { ...bad }], researchSummary: 's' }) });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    const stored = await services.hypotheses.listByStrategyProfile('p1');
    expect(stored.length).toBe(1); // first rejected row persisted; duplicate skipped
    expect(stored[0].status).toBe('rejected');
    expect((await types(services)).filter((x) => x === 'hypothesis.deduped').length).toBe(1);
  });

  it('clamps effectiveMax to the env guardrail even when payload asks for more', async () => {
    const many = Array.from({ length: 4 }, (_u, i) => draft(`thesis ${i}`, 'no_op', i));
    const services = makeServices({
      maxHypothesesPerCycle: 2,
      researcher: stubResearcher({ hypotheses: many, researchSummary: 's' }),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', maxHypotheses: 99 }), services);

    expect((await services.hypotheses.listByStrategyProfile('p1')).length).toBe(2);
  });

  it('runs the Critic only when enabled and never lets it gate', async () => {
    const off = makeServices({ researcher: stubResearcher({ hypotheses: [draft('thesis C')], researchSummary: 's' }) });
    await seedProfile(off);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), off);
    expect((await off.hypothesisReviews.listByHypothesis((await off.hypotheses.listByStrategyProfile('p1'))[0].id)).length).toBe(0);

    const on = makeServices({ critic: new FakeCritic(), researcher: stubResearcher({ hypotheses: [draft('thesis C')], researchSummary: 's' }) });
    await seedProfile(on);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), on);
    const h = (await on.hypotheses.listByStrategyProfile('p1'))[0];
    expect((await on.hypothesisReviews.listByHypothesis(h.id)).length).toBe(1);
    expect((await types(on))).toContain('critic.reviewed');
  });

  it('does not block a hypothesis even when lexical similarity is high (similarity is not a gate)', async () => {
    // Shared in-memory repos across two handler runs.
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('identical thesis text', 'no_op', 1)], researchSummary: 's' }),
    });
    await seedProfile(services);

    // Run 1: persist the first hypothesis.
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
    expect((await services.hypotheses.listByStrategyProfile('p1')).length).toBe(1);

    // Run 2: SAME thesis text (maximal lexical similarity) but DIFFERENT ruleAction => different fingerprint.
    // Reuse the same repos by spreading `...services`, swapping only the researcher output.
    const second = makeServices({
      ...services,
      researcher: stubResearcher({ hypotheses: [draft('identical thesis text', 'skip_entry', 7)], researchSummary: 's' }),
    });
    const t2 = task({ strategyProfileId: 'p1' });
    t2.id = 't2';
    await researchRunCycleHandler(t2, second);

    // Persisted (NOT blocked by similarity); two rows now exist.
    expect((await second.hypotheses.listByStrategyProfile('p1')).length).toBe(2);
    expect((await second.events.listByTask('t2')).map((e) => e.type)).not.toContain('hypothesis.deduped');
  });
});
```

> Note on the similarity test: it reuses one shared services object across two handler runs by spreading `...services` so the same in-memory `hypotheses`/`events` repos persist between runs. The key assertion is that a high lexical-similarity match does not produce a `hypothesis.deduped` event and does not prevent persistence — only an exact fingerprint match would.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: FAIL — cannot find module `./research-run-cycle.handler.ts`.

- [ ] **Step 3: Write the handler**

```ts
// src/orchestrator/handlers/research-run-cycle.handler.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { validateHypothesis } from '../../validation/hypothesis-validator.ts';
import { LAB_FEATURE_CATALOG, normalizeFeature } from '../../domain/hypothesis-rules.ts';
import {
  ResearcherOutputSchema, hypothesisFingerprint,
  HYPOTHESIS_PROPOSAL_CONTRACT_VERSION, type HypothesisProposal, type ResearcherOutput,
} from '../../domain/hypothesis.ts';

export const RESEARCH_DEFAULT_SYMBOL = 'BTCUSDT';

export const ResearchRunCyclePayloadSchema = z.object({
  strategyProfileId: z.string().min(1),
  symbol: z.string().min(1).optional(),
  ts: z.string().min(1).optional(),
  maxHypotheses: z.number().int().positive().optional(),
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function event(taskId: string, type: string, payload: Record<string, unknown>) {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}

export const researchRunCycleHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(ResearchRunCyclePayloadSchema, task.payload);
  if (parsed.status === 'invalid') {
    throw new Error(`invalid research.run_cycle payload: ${JSON.stringify(parsed.issues)}`);
  }
  const payload = parsed.data;

  const profile = await services.strategyProfiles.findById(payload.strategyProfileId);
  if (!profile) throw new Error(`strategy profile not found: ${payload.strategyProfileId}`);

  const effectiveMax = Math.min(
    payload.maxHypotheses ?? services.maxHypothesesPerCycle,
    services.maxHypothesesPerCycle,
  );

  await services.events.append(event(task.id, 'research.run_cycle.started', {
    strategyProfileId: profile.id,
    researcher: services.researcher.adapter,
    model: services.researcher.model,
    criticEnabled: services.critic !== null,
    effectiveMax,
  }));

  const symbol = payload.symbol ?? RESEARCH_DEFAULT_SYMBOL;
  const ts = payload.ts ?? new Date().toISOString();
  const marketContext = await services.platform.getMarketContext(symbol, ts);
  const marketRegime = await services.platform.getMarketRegime(symbol, ts);

  // Advisory only — surfaced to the Researcher prompt, never used to gate.
  const similarHypotheses = await services.similarHypotheses.search(profile.id, profile.coreIdea, 5);

  await services.events.append(event(task.id, 'researcher.started', { strategyProfileId: profile.id }));
  let output: ResearcherOutput;
  try {
    output = await services.researcher.propose({
      profile, marketContext, marketRegime, similarHypotheses, maxHypotheses: effectiveMax,
    });
  } catch (err) {
    await services.events.append(event(task.id, 'researcher.failed', { error: errMsg(err) }));
    throw err;
  }
  await services.events.append(event(task.id, 'researcher.completed', { count: output.hypotheses.length }));

  const outParsed = validateWithSchema(ResearcherOutputSchema, output);
  if (outParsed.status === 'invalid') {
    throw new Error(`researcher returned invalid output: ${JSON.stringify(outParsed.issues)}`);
  }

  const drafts = outParsed.data.hypotheses.slice(0, effectiveMax);
  const allowedFeatures = new Set<string>([
    ...profile.requiredMarketFeatures.map(normalizeFeature),
    ...LAB_FEATURE_CATALOG,
  ]);

  const seen = new Set<string>(await services.hypotheses.listFingerprints(profile.id));
  let validated = 0;
  let rejected = 0;
  let deduped = 0;
  let criticReviews = 0;

  for (const draft of drafts) {
    const fingerprint = hypothesisFingerprint(draft.thesis, draft.ruleAction);
    if (seen.has(fingerprint)) {
      await services.events.append(event(task.id, 'hypothesis.deduped', { fingerprint }));
      deduped += 1;
      continue;
    }

    const result = validateHypothesis(draft, { allowedFeatures });
    seen.add(fingerprint); // add for BOTH validated and rejected, so identical later drafts dedupe

    const now = new Date().toISOString();
    const hypothesis: HypothesisProposal = {
      id: randomUUID(),
      strategyProfileId: profile.id,
      thesis: draft.thesis,
      targetBehavior: draft.targetBehavior,
      ruleAction: draft.ruleAction,
      requiredFeatures: result.normalizedFeatures,
      validationPlan: draft.validationPlan,
      expectedEffect: draft.expectedEffect,
      invalidationCriteria: draft.invalidationCriteria,
      confidence: draft.confidence,
      status: result.status,
      fingerprint,
      proposal: draft,
      issues: result.issues,
      contractVersion: HYPOTHESIS_PROPOSAL_CONTRACT_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    await services.hypotheses.create(hypothesis);

    if (result.status === 'validated') {
      validated += 1;
      await services.events.append(event(task.id, 'hypothesis.validated', { hypothesisId: hypothesis.id, fingerprint }));
      if (services.critic) {
        try {
          const review = await services.critic.review({ proposal: draft, profile });
          await services.hypothesisReviews.create({
            id: randomUUID(),
            hypothesisId: hypothesis.id,
            criticAdapter: services.critic.adapter,
            criticModel: services.critic.model,
            verdict: review.verdict,
            concerns: review.concerns,
            summary: review.summary,
            createdAt: new Date().toISOString(),
          });
          criticReviews += 1;
          await services.events.append(event(task.id, 'critic.reviewed', { hypothesisId: hypothesis.id, verdict: review.verdict }));
        } catch (err) {
          // Critic is advisory — its failure must not fail the cycle.
          await services.events.append(event(task.id, 'critic.failed', { hypothesisId: hypothesis.id, error: errMsg(err) }));
        }
      }
    } else {
      rejected += 1;
      await services.events.append(event(task.id, 'hypothesis.rejected', {
        hypothesisId: hypothesis.id, fingerprint, codes: result.issues.map((i) => i.code),
      }));
    }
  }

  await services.events.append(event(task.id, 'research.run_cycle.completed', {
    proposed: drafts.length, validated, rejected, deduped, criticReviews,
  }));
};
```

- [ ] **Step 4: Run test to verify it passes, and verify no NUL bytes**

Run: `pnpm vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: PASS (9 tests).

Run: `python3 -c "print(open('src/orchestrator/handlers/research-run-cycle.handler.ts','rb').read().count(b'\x00'))"`
Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(sp3): research.run_cycle handler (validate, dedupe, advisory critic, audit)"
```

---

## Task 15: Register research.run_cycle handler in composition + e2e

> The new service fields were already wired into `src/composition.ts` in Task 13. This task only adds the handler *registration* (now that the handler exists from Task 14) and the end-to-end test. The e2e itself uses `makeServices` + a manually-constructed `WorkflowRouter`, so it does not depend on composition.

**Files:**
- Modify: `src/composition.ts` (register the handler — one import + one line)
- Create: `test/e2e/research-run-cycle.test.ts`

- [ ] **Step 1: Write the e2e test** (the handler and services already exist from Tasks 13–14, so this verifies the full path rather than driving red-first)

```ts
// test/e2e/research-run-cycle.test.ts
import { describe, it, expect } from 'vitest';
import { createIngressApp } from '../../src/ingress/app.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { researchRunCycleHandler } from '../../src/orchestrator/handlers/research-run-cycle.handler.ts';
import { makeServices } from '../support/make-services.ts';
import type { StrategyProfile } from '../../src/domain/strategy-profile.ts';

function profile(): StrategyProfile {
  return {
    id: 'p-e2e', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:e2e',
    direction: 'long', coreIdea: 'Long OI divergence', requiredMarketFeatures: ['oi'],
    confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('E2E: research.run_cycle ingress -> worker -> persisted hypotheses', () => {
  it('drives a run-cycle task from POST to persisted hypotheses', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    await services.strategyProfiles.create(profile());

    const router = new WorkflowRouter();
    router.register('research.run_cycle', researchRunCycleHandler);
    startWorker({ queue, router, services });

    const app = createIngressApp({ repo: services.researchTasks, queue });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'research.run_cycle', source: 'operator', payload: { strategyProfileId: 'p-e2e' } }),
    });
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };

    await queue.drain();

    expect((await services.researchTasks.findById(taskId))?.status).toBe('completed');
    const stored = await services.hypotheses.listByStrategyProfile('p-e2e');
    expect(stored.length).toBe(2); // FakeResearcher emits two validated hypotheses
    expect(stored.every((h) => h.status === 'validated')).toBe(true);

    const events = (await services.events.listByTask(taskId)).map((e) => e.type);
    expect(events[0]).toBe('research.run_cycle.started');
    expect(events.at(-1)).toBe('research.run_cycle.completed');
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (the e2e is self-contained via `makeServices` + manual router)

Run: `pnpm vitest run test/e2e/research-run-cycle.test.ts`
Expected: PASS. (The e2e wires its own `WorkflowRouter` and `makeServices`, so it works without touching composition. If it fails, fix the handler/wiring before proceeding.)

- [ ] **Step 3: Register the handler in `src/composition.ts`**

The service fields are already wired (Task 13). Add the handler import:

```ts
import { researchRunCycleHandler } from './orchestrator/handlers/research-run-cycle.handler.ts';
```

And register it next to the existing `strategy.onboard` registration in `composeRuntime`:

```ts
  router.register('research.run_cycle', researchRunCycleHandler);
```

- [ ] **Step 4: Run the full gate**

Run: `pnpm typecheck`
Expected: PASS (whole project consistent).

Run: `pnpm test`
Expected: all suites green; integration + live-LLM suites skipped unless their env vars are set.

- [ ] **Step 5: Commit**

```bash
git add src/composition.ts test/e2e/research-run-cycle.test.ts
git commit -m "feat(sp3): register research.run_cycle handler + e2e"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite with infra up (Postgres + Redis) to exercise integration tests:
  ```bash
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/trading_lab REDIS_URL=redis://localhost:6379 pnpm test
  ```
  Expected: all suites pass; only live-LLM suites skipped (no `RUN_LLM_TESTS`).
- [ ] `pnpm typecheck` clean.
- [ ] Confirm 0 raw NUL bytes across new sources:
  ```bash
  grep -rlIP '\x00' src/ test/ || echo "no NUL bytes"
  ```
- [ ] Dispatch a final holistic code review across the whole SP-3 diff before finishing the branch (superpowers:finishing-a-development-branch).

---

## Self-review notes (coverage map spec → tasks)

- Spec §1.1 OverlayActions / research-only → Task 1 (+ Validator denylists Task 3).
- Spec §1.2 LAB_FEATURE_CATALOG + normalization → Task 1; allowed-set union → Task 14.
- Spec §1.3 schemas / §1.4 fingerprint → Task 2.
- Spec §2 deterministic Validator (all 7 codes incl. action_param_violation, authority_violation) → Task 3.
- Spec §3 handler workflow + persistence semantics (validated/rejected/deduped, seen.add on both) → Task 14.
- Spec §4 storage (unique (profile, fp), indexes) → Tasks 11–12.
- Spec §5 ports/adapters (researcher/critic fake+mastra, repos, lexical search) → Tasks 4–10, 12.
- Spec §6 wiring (AppServices, composition, env) → Tasks 13, 15.
- Spec §7 audit events → Task 14 (started/completed, validated/rejected/deduped, critic.reviewed/failed, researcher.*).
- Spec §8 testing (unit, integration gated, handler, e2e, live-LLM gated) → every task.
- User test additions: batch-internal duplicate (seen.add on both paths) + similarity-is-not-a-gate → Task 14 explicit tests.
- Spec §9 out-of-scope respected: no build/backtest, no pgvector, no trades/decision logs, no per-action param schemas.
