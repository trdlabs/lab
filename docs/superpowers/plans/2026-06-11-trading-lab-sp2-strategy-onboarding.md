# trading-lab SP-2 — Strategy Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboard a strategy *source* into a validated, persisted, deduplicated `StrategyProfile` via the first real LLM agent (Mastra `Agent` primitive), with deterministic gating, fingerprint dedupe, and LLM audit.

**Architecture:** Hexagonal, building on SP-1. A `StrategyAnalystPort` (fake default / Mastra real, selected by env) is invoked from a deterministic `strategyOnboardHandler` registered on `strategy.onboard`. The handler owns side-effects (fingerprint dedupe → store source → audit → analyze → gate → persist); the worker still owns task lifecycle. `HandlerDeps` evolves into an `AppServices` bag.

**Tech Stack:** TypeScript (ESM/NodeNext, Node native type-stripping), Vitest, Zod, Drizzle/Postgres, `@mastra/core` + `@ai-sdk/anthropic`.

---

## Conventions (carry over from SP-1 — do not violate)

- **No TypeScript parameter properties** (`constructor(private x)`). Node `--experimental-strip-types` throws on them. Use an explicit field + assignment.
- **All relative imports use explicit `.ts` extensions.**
- Unit tests are offline and deterministic (FakeStrategyAnalyst + in-memory adapters). Integration tests are gated on env vars and `describe.skip` when absent: Postgres on `DATABASE_URL`, live LLM on `RUN_LLM_TESTS=true` **and** `ANTHROPIC_API_KEY`.
- Branch: `sp2-strategy-onboarding` (already created from `main`).

---

## File Structure

```
src/config/env.ts                                   (modify) + 4 env vars
src/domain/strategy-source.ts                       (new) SourceKind, StrategyAnalystInput + schema
src/domain/strategy-profile.ts                      (new) StrategyParameter, AnalystProfileOutput, StrategyProfile + schemas
src/domain/fingerprint.ts                           (new) canonicalizeContent, sourceFingerprint
src/ports/strategy-analyst.port.ts                  (new)
src/ports/strategy-profile.repository.ts            (new)
src/ports/agent-event.repository.ts                 (new)
src/adapters/analyst/fake-strategy-analyst.ts       (new)
src/adapters/analyst/mastra-strategy-analyst.ts     (new)
src/adapters/artifact/in-memory-artifact-store.ts   (new)
src/adapters/repository/in-memory-strategy-profile.repository.ts   (new)
src/adapters/repository/drizzle-strategy-profile.repository.ts     (new)
src/adapters/repository/in-memory-agent-event.repository.ts        (new)
src/adapters/repository/drizzle-agent-event.repository.ts          (new)
src/orchestrator/app-services.ts                    (new) AppServices
src/orchestrator/workflow-router.ts                 (modify) HandlerDeps = AppServices
src/orchestrator/handlers/strategy-onboard.handler.ts  (new)
src/worker/worker.ts                                (modify) WorkerDeps.services
src/db/schema.ts                                    (modify) + strategy_profile table
src/composition.ts                                  (modify) adapter selection + register onboard handler
test/support/make-services.ts                       (new) makeServices() test factory
```

---

### Task 1: Config — analyst env vars

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Test: `test/smoke.test.ts` (extend)

- [ ] **Step 1: Write failing tests** — append inside the existing `describe('env', ...)` block in `test/smoke.test.ts`:

```ts
  it('defaults STRATEGY_ANALYST_ADAPTER to fake', () => {
    expect(loadEnv({}).STRATEGY_ANALYST_ADAPTER).toBe('fake');
  });
  it('parses STRATEGY_ANALYST_ADAPTER=mastra', () => {
    expect(loadEnv({ STRATEGY_ANALYST_ADAPTER: 'mastra' }).STRATEGY_ANALYST_ADAPTER).toBe('mastra');
  });
  it('defaults STRATEGY_ANALYST_MODEL to anthropic/claude-sonnet-4-6', () => {
    expect(loadEnv({}).STRATEGY_ANALYST_MODEL).toBe('anthropic/claude-sonnet-4-6');
  });
  it('defaults RUN_LLM_TESTS to false and parses true', () => {
    expect(loadEnv({}).RUN_LLM_TESTS).toBe(false);
    expect(loadEnv({ RUN_LLM_TESTS: 'true' }).RUN_LLM_TESTS).toBe(true);
  });
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run test/smoke.test.ts`
Expected: FAIL — `STRATEGY_ANALYST_ADAPTER` undefined.

- [ ] **Step 3: Update `src/config/env.ts`** — replace the `Env` interface and `loadEnv` body:

```ts
export interface Env {
  DATABASE_URL?: string;
  REDIS_URL?: string;
  ARTIFACT_DIR: string;
  ENABLE_CRITIC_AGENT: boolean;
  INGRESS_PORT: number;
  STRATEGY_ANALYST_ADAPTER: 'fake' | 'mastra';
  STRATEGY_ANALYST_MODEL: string;
  ANTHROPIC_API_KEY?: string;
  RUN_LLM_TESTS: boolean;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    DATABASE_URL: source.DATABASE_URL,
    REDIS_URL: source.REDIS_URL,
    ARTIFACT_DIR: source.ARTIFACT_DIR ?? '.artifacts',
    ENABLE_CRITIC_AGENT: source.ENABLE_CRITIC_AGENT === 'true',
    INGRESS_PORT: parsePort(source.INGRESS_PORT, 3000),
    STRATEGY_ANALYST_ADAPTER: source.STRATEGY_ANALYST_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    STRATEGY_ANALYST_MODEL: source.STRATEGY_ANALYST_MODEL ?? 'anthropic/claude-sonnet-4-6',
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
    RUN_LLM_TESTS: source.RUN_LLM_TESTS === 'true',
  };
}
```

- [ ] **Step 4: Append to `.env.example`**:

```
STRATEGY_ANALYST_ADAPTER=fake
STRATEGY_ANALYST_MODEL=anthropic/claude-sonnet-4-6
ANTHROPIC_API_KEY=
RUN_LLM_TESTS=false
```

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run test/smoke.test.ts && pnpm typecheck`
Expected: PASS (9 tests); typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts .env.example test/smoke.test.ts
git commit -m "feat(sp2): add strategy-analyst adapter/model/LLM-test env vars"
```

---

### Task 2: Domain — strategy source types + schema

**Files:**
- Create: `src/domain/strategy-source.ts`, `src/domain/strategy-source.test.ts`

- [ ] **Step 1: Write failing test** — `src/domain/strategy-source.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { StrategyAnalystInputSchema, SOURCE_KINDS } from './strategy-source.ts';

describe('StrategyAnalystInputSchema', () => {
  it('accepts a valid bot_code input', () => {
    const r = StrategyAnalystInputSchema.safeParse({ kind: 'bot_code', content: 'def run(): pass' });
    expect(r.success).toBe(true);
  });
  it('rejects an unknown kind', () => {
    expect(StrategyAnalystInputSchema.safeParse({ kind: 'tweet', content: 'x' }).success).toBe(false);
  });
  it('rejects empty content', () => {
    expect(StrategyAnalystInputSchema.safeParse({ kind: 'article', content: '' }).success).toBe(false);
  });
  it('exposes the six source kinds', () => {
    expect(SOURCE_KINDS).toEqual(['bot_code', 'readme', 'article', 'notebooklm_summary', 'manual_description', 'crawler']);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/domain/strategy-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/domain/strategy-source.ts`**:

```ts
import { z } from 'zod';

export const SOURCE_KINDS = [
  'bot_code', 'readme', 'article', 'notebooklm_summary', 'manual_description', 'crawler',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const StrategyAnalystInputSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  content: z.string().min(1),
  uri: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});
export type StrategyAnalystInput = z.infer<typeof StrategyAnalystInputSchema>;
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run src/domain/strategy-source.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/strategy-source.ts src/domain/strategy-source.test.ts
git commit -m "feat(sp2): add StrategyAnalystInput domain type + schema"
```

---

### Task 3: Domain — strategy profile types + schemas

**Files:**
- Create: `src/domain/strategy-profile.ts`, `src/domain/strategy-profile.test.ts`

- [ ] **Step 1: Write failing test** — `src/domain/strategy-profile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AnalystProfileOutputSchema, StrategyParameterSchema, STRATEGY_PROFILE_CONTRACT_VERSION } from './strategy-profile.ts';

const validOutput = {
  direction: 'long', coreIdea: 'buy dips', summary: 'long strat',
  requiredMarketFeatures: ['oi'], entryConditions: ['rsi<30'], exitConditions: ['rsi>70'],
  timeframes: ['1h'], indicators: ['rsi'],
  parameters: [{ name: 'rsiLen', value: 14, unit: null, description: 'RSI length', tunable: true }],
  watchLifecycleSummary: null, positionManagementSummary: null, riskManagementSummary: null,
  runnerOwnedAuthorities: ['fills'], confidence: 0.7, unknowns: [], evidence: ['line 3'],
};

describe('AnalystProfileOutputSchema', () => {
  it('accepts a complete valid output', () => {
    expect(AnalystProfileOutputSchema.safeParse(validOutput).success).toBe(true);
  });
  it('rejects confidence above 1', () => {
    expect(AnalystProfileOutputSchema.safeParse({ ...validOutput, confidence: 1.4 }).success).toBe(false);
  });
  it('rejects an unknown direction', () => {
    expect(AnalystProfileOutputSchema.safeParse({ ...validOutput, direction: 'sideways' }).success).toBe(false);
  });
  it('accepts a parameter with a string value and no unit', () => {
    const r = StrategyParameterSchema.safeParse({ name: 'mode', value: 'aggressive', description: 'x', tunable: false });
    expect(r.success).toBe(true);
  });
  it('exposes the contract version', () => {
    expect(STRATEGY_PROFILE_CONTRACT_VERSION).toBe('strategy-profile-v1');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/domain/strategy-profile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/domain/strategy-profile.ts`**:

```ts
import { z } from 'zod';
import type { ArtifactRef } from './types.ts';
import type { SourceKind } from './strategy-source.ts';

export const DIRECTIONS = ['long', 'short', 'both', 'unknown'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const StrategyParameterSchema = z.object({
  name: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  unit: z.string().nullish(),
  description: z.string(),
  tunable: z.boolean(),
});
export type StrategyParameter = z.infer<typeof StrategyParameterSchema>;

export const AnalystProfileOutputSchema = z.object({
  direction: z.enum(DIRECTIONS).describe('Net directional bias of the strategy'),
  coreIdea: z.string().min(1).describe('1-2 sentence core thesis'),
  summary: z.string().describe('Fuller description of how the strategy works'),
  requiredMarketFeatures: z.array(z.string()).describe('Market features needed, e.g. oi, funding, cvd'),
  entryConditions: z.array(z.string()),
  exitConditions: z.array(z.string()),
  timeframes: z.array(z.string()).describe('Timeframes used, e.g. 5m, 1h'),
  indicators: z.array(z.string()),
  parameters: z.array(StrategyParameterSchema),
  watchLifecycleSummary: z.string().nullish(),
  positionManagementSummary: z.string().nullish(),
  riskManagementSummary: z.string().nullish(),
  runnerOwnedAuthorities: z.array(z.string()).describe('Concerns owned by runner/platform: risk sizing, fills, execution'),
  confidence: z.number().min(0).max(1),
  unknowns: z.array(z.string()),
  evidence: z.array(z.string()).describe('Quotes/refs from the source supporting the profile'),
});
export type AnalystProfileOutput = z.infer<typeof AnalystProfileOutputSchema>;

export const STRATEGY_PROFILE_CONTRACT_VERSION = 'strategy-profile-v1';

export interface StrategyProfile {
  id: string;
  version: number;
  sourceKind: SourceKind;
  sourceFingerprint: string;
  direction: Direction;
  coreIdea: string;
  requiredMarketFeatures: string[];
  confidence: number;
  unknowns: string[];
  profile: AnalystProfileOutput;
  sourceArtifactRef: ArtifactRef;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run src/domain/strategy-profile.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/strategy-profile.ts src/domain/strategy-profile.test.ts
git commit -m "feat(sp2): add AnalystProfileOutput + StrategyProfile domain types"
```

---

### Task 4: Domain — source fingerprint

**Files:**
- Create: `src/domain/fingerprint.ts`, `src/domain/fingerprint.test.ts`

- [ ] **Step 1: Write failing test** — `src/domain/fingerprint.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sourceFingerprint, canonicalizeContent } from './fingerprint.ts';

describe('sourceFingerprint', () => {
  it('returns sha256:<64hex>', () => {
    expect(sourceFingerprint('article', 'hello')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('is stable across CRLF vs LF and surrounding whitespace', () => {
    expect(sourceFingerprint('bot_code', '  a\r\nb  ')).toBe(sourceFingerprint('bot_code', 'a\nb'));
  });
  it('differs when sourceKind differs for identical content', () => {
    expect(sourceFingerprint('article', 'same')).not.toBe(sourceFingerprint('readme', 'same'));
  });
  it('does NOT collapse internal whitespace (bot_code stays distinct)', () => {
    expect(sourceFingerprint('bot_code', 'a  b')).not.toBe(sourceFingerprint('bot_code', 'a b'));
  });
});

describe('canonicalizeContent', () => {
  it('normalizes CRLF to LF and trims', () => {
    expect(canonicalizeContent('  x\r\ny  ')).toBe('x\ny');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/domain/fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/domain/fingerprint.ts`**:

```ts
import { createHash } from 'node:crypto';
import type { SourceKind } from './strategy-source.ts';

/**
 * Canonicalize source content for stable hashing: CR/CRLF -> LF, Unicode NFC, trim.
 * Internal whitespace is preserved on purpose — collapsing it would create false
 * fingerprint matches for bot_code.
 */
export function canonicalizeContent(content: string): string {
  return content.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

export function sourceFingerprint(kind: SourceKind, content: string): string {
  const canonical = canonicalizeContent(content);
  const sep = '\u0000'; // explicit separator — never embed a literal NUL in the template
  const hex = createHash('sha256').update(`${kind}${sep}${canonical}`, 'utf8').digest('hex');
  return `sha256:${hex}`;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run src/domain/fingerprint.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/fingerprint.ts src/domain/fingerprint.test.ts
git commit -m "feat(sp2): add deterministic source fingerprint"
```

---

### Task 5: StrategyAnalystPort + FakeStrategyAnalyst

**Files:**
- Create: `src/ports/strategy-analyst.port.ts`, `src/adapters/analyst/fake-strategy-analyst.ts`, `src/adapters/analyst/fake-strategy-analyst.test.ts`

- [ ] **Step 1: Write failing test** — `src/adapters/analyst/fake-strategy-analyst.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeStrategyAnalyst } from './fake-strategy-analyst.ts';
import { AnalystProfileOutputSchema } from '../../domain/strategy-profile.ts';

describe('FakeStrategyAnalyst', () => {
  it('reports adapter=fake and returns a schema-valid output', async () => {
    const a = new FakeStrategyAnalyst();
    expect(a.adapter).toBe('fake');
    expect(a.model).toBe('fake');
    const out = await a.analyze({ kind: 'article', content: 'x' });
    expect(AnalystProfileOutputSchema.safeParse(out).success).toBe(true);
  });
  it('returns canned output when provided', async () => {
    const canned = AnalystProfileOutputSchema.parse({
      direction: 'short', coreIdea: 'c', summary: 's', requiredMarketFeatures: [], entryConditions: [],
      exitConditions: [], timeframes: [], indicators: [], parameters: [], watchLifecycleSummary: null,
      positionManagementSummary: null, riskManagementSummary: null, runnerOwnedAuthorities: [],
      confidence: 0.9, unknowns: [], evidence: [],
    });
    const out = await new FakeStrategyAnalyst(canned).analyze({ kind: 'article', content: 'x' });
    expect(out.direction).toBe('short');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/adapters/analyst/fake-strategy-analyst.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/ports/strategy-analyst.port.ts`**:

```ts
import type { StrategyAnalystInput } from '../domain/strategy-source.ts';
import type { AnalystProfileOutput } from '../domain/strategy-profile.ts';

export interface StrategyAnalystPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  analyze(input: StrategyAnalystInput): Promise<AnalystProfileOutput>;
}
```

- [ ] **Step 4: Create `src/adapters/analyst/fake-strategy-analyst.ts`**:

```ts
import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';

export class FakeStrategyAnalyst implements StrategyAnalystPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  private readonly canned: AnalystProfileOutput | undefined;

  constructor(canned?: AnalystProfileOutput) {
    this.canned = canned;
  }

  async analyze(input: StrategyAnalystInput): Promise<AnalystProfileOutput> {
    if (this.canned) return this.canned;
    return {
      direction: 'unknown',
      coreIdea: `Strategy onboarded from ${input.kind}`,
      summary: input.title ?? `Source of kind ${input.kind}`,
      requiredMarketFeatures: [],
      entryConditions: [],
      exitConditions: [],
      timeframes: [],
      indicators: [],
      parameters: [],
      watchLifecycleSummary: null,
      positionManagementSummary: null,
      riskManagementSummary: null,
      runnerOwnedAuthorities: [],
      confidence: 0.5,
      unknowns: ['fake-analyst: no real analysis performed'],
      evidence: [],
    };
  }
}
```

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run src/adapters/analyst/fake-strategy-analyst.test.ts && pnpm typecheck`
Expected: PASS (2 tests); typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/ports/strategy-analyst.port.ts src/adapters/analyst/fake-strategy-analyst.ts src/adapters/analyst/fake-strategy-analyst.test.ts
git commit -m "feat(sp2): add StrategyAnalystPort and FakeStrategyAnalyst"
```

---

### Task 6: StrategyProfileRepository port + in-memory adapter

**Files:**
- Create: `src/ports/strategy-profile.repository.ts`, `src/adapters/repository/in-memory-strategy-profile.repository.ts`, `src/adapters/repository/in-memory-strategy-profile.repository.test.ts`

- [ ] **Step 1: Write failing test** — `src/adapters/repository/in-memory-strategy-profile.repository.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryStrategyProfileRepository } from './in-memory-strategy-profile.repository.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ArtifactRef } from '../../domain/types.ts';

const ref: ArtifactRef = {
  artifact_id: 'sha256:aa', uri: 'memory://aa', content_hash: 'sha256:aa', kind: 'strategy_source',
  size_bytes: 1, mime_type: 'text/plain', created_at: '2026-06-11T00:00:00Z', producer: 'test', metadata: {},
};
const profile = (over: Partial<StrategyProfile> = {}): StrategyProfile => ({
  id: 'p1', version: 1, sourceKind: 'article', sourceFingerprint: 'sha256:fp1', direction: 'long',
  coreIdea: 'idea', requiredMarketFeatures: [], confidence: 0.5, unknowns: [],
  profile: {} as StrategyProfile['profile'], sourceArtifactRef: ref, contractVersion: 'strategy-profile-v1',
  createdAt: '2026-06-11T00:00:00Z', updatedAt: '2026-06-11T00:00:00Z', ...over,
});

describe('InMemoryStrategyProfileRepository', () => {
  it('creates and finds by id and fingerprint', async () => {
    const repo = new InMemoryStrategyProfileRepository();
    await repo.create(profile({ id: 'a', sourceFingerprint: 'sha256:x' }));
    expect((await repo.findById('a'))?.id).toBe('a');
    expect((await repo.findByFingerprint('sha256:x'))?.id).toBe('a');
    expect(await repo.findById('missing')).toBeNull();
    expect(await repo.findByFingerprint('nope')).toBeNull();
  });
  it('throws on duplicate id', async () => {
    const repo = new InMemoryStrategyProfileRepository();
    await repo.create(profile({ id: 'a' }));
    await expect(repo.create(profile({ id: 'a' }))).rejects.toThrow(/already exists/);
  });
  it('throws on duplicate sourceFingerprint (mirrors the DB unique index)', async () => {
    const repo = new InMemoryStrategyProfileRepository();
    await repo.create(profile({ id: 'a', sourceFingerprint: 'sha256:dup' }));
    await expect(repo.create(profile({ id: 'b', sourceFingerprint: 'sha256:dup' }))).rejects.toThrow(/fingerprint/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/adapters/repository/in-memory-strategy-profile.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/ports/strategy-profile.repository.ts`**:

```ts
import type { StrategyProfile } from '../domain/strategy-profile.ts';

export interface StrategyProfileRepository {
  create(profile: StrategyProfile): Promise<void>;
  findById(id: string): Promise<StrategyProfile | null>;
  findByFingerprint(sourceFingerprint: string): Promise<StrategyProfile | null>;
}
```

- [ ] **Step 4: Create `src/adapters/repository/in-memory-strategy-profile.repository.ts`**:

```ts
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { StrategyProfileRepository } from '../../ports/strategy-profile.repository.ts';

export class InMemoryStrategyProfileRepository implements StrategyProfileRepository {
  private readonly byId = new Map<string, StrategyProfile>();

  async create(profile: StrategyProfile): Promise<void> {
    if (this.byId.has(profile.id)) throw new Error(`strategy_profile already exists: ${profile.id}`);
    for (const p of this.byId.values()) {
      if (p.sourceFingerprint === profile.sourceFingerprint) {
        throw new Error(`strategy_profile already exists for fingerprint: ${profile.sourceFingerprint}`);
      }
    }
    this.byId.set(profile.id, { ...profile });
  }

  async findById(id: string): Promise<StrategyProfile | null> {
    return this.byId.get(id) ?? null;
  }

  async findByFingerprint(sourceFingerprint: string): Promise<StrategyProfile | null> {
    for (const p of this.byId.values()) {
      if (p.sourceFingerprint === sourceFingerprint) return p;
    }
    return null;
  }
}
```

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run src/adapters/repository/in-memory-strategy-profile.repository.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ports/strategy-profile.repository.ts src/adapters/repository/in-memory-strategy-profile.repository.ts src/adapters/repository/in-memory-strategy-profile.repository.test.ts
git commit -m "feat(sp2): add StrategyProfileRepository port + in-memory adapter"
```

---

### Task 7: AgentEventRepository port + in-memory adapter

**Files:**
- Create: `src/ports/agent-event.repository.ts`, `src/adapters/repository/in-memory-agent-event.repository.ts`, `src/adapters/repository/in-memory-agent-event.repository.test.ts`

- [ ] **Step 1: Write failing test** — `src/adapters/repository/in-memory-agent-event.repository.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryAgentEventRepository } from './in-memory-agent-event.repository.ts';
import type { AgentEvent } from '../../ports/agent-event.repository.ts';

const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({
  id: 'e1', taskId: 't1', type: 'strategy_analyst.started', payload: { model: 'fake' },
  createdAt: '2026-06-11T00:00:00Z', ...over,
});

describe('InMemoryAgentEventRepository', () => {
  it('appends and lists events by task in insertion order', async () => {
    const repo = new InMemoryAgentEventRepository();
    await repo.append(ev({ id: 'a', taskId: 't1', type: 'strategy_analyst.started' }));
    await repo.append(ev({ id: 'b', taskId: 't1', type: 'strategy_analyst.completed' }));
    await repo.append(ev({ id: 'c', taskId: 't2', type: 'strategy_analyst.started' }));
    const t1 = await repo.listByTask('t1');
    expect(t1.map((e) => e.type)).toEqual(['strategy_analyst.started', 'strategy_analyst.completed']);
    expect(await repo.listByTask('none')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/adapters/repository/in-memory-agent-event.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/ports/agent-event.repository.ts`**:

```ts
export interface AgentEvent {
  id: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentEventRepository {
  append(event: AgentEvent): Promise<void>;
  listByTask(taskId: string): Promise<AgentEvent[]>;
}
```

- [ ] **Step 4: Create `src/adapters/repository/in-memory-agent-event.repository.ts`**:

```ts
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';

export class InMemoryAgentEventRepository implements AgentEventRepository {
  private readonly events: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    this.events.push({ ...event });
  }

  async listByTask(taskId: string): Promise<AgentEvent[]> {
    return this.events.filter((e) => e.taskId === taskId);
  }
}
```

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run src/adapters/repository/in-memory-agent-event.repository.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/ports/agent-event.repository.ts src/adapters/repository/in-memory-agent-event.repository.ts src/adapters/repository/in-memory-agent-event.repository.test.ts
git commit -m "feat(sp2): add AgentEventRepository port + in-memory adapter"
```

---

### Task 8: InMemoryArtifactStore (offline ArtifactStorePort)

**Files:**
- Create: `src/adapters/artifact/in-memory-artifact-store.ts`, `src/adapters/artifact/in-memory-artifact-store.test.ts`

- [ ] **Step 1: Write failing test** — `src/adapters/artifact/in-memory-artifact-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryArtifactStore } from './in-memory-artifact-store.ts';

describe('InMemoryArtifactStore', () => {
  it('stores content and round-trips via get; content-addressable', async () => {
    const store = new InMemoryArtifactStore();
    const ref = await store.put('hello', { kind: 'strategy_source', mime_type: 'text/plain', producer: 'test' });
    expect(ref.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref.uri.startsWith('memory://')).toBe(true);
    expect((await store.get(ref)).toString()).toBe('hello');
    const ref2 = await store.put('hello', { kind: 'strategy_source', mime_type: 'text/plain', producer: 'test' });
    expect(ref2.content_hash).toBe(ref.content_hash);
  });
  it('throws on get of a missing artifact', async () => {
    const store = new InMemoryArtifactStore();
    await expect(store.get({
      artifact_id: 'sha256:zz', uri: 'memory://zz', content_hash: 'sha256:zz', kind: 'k',
      size_bytes: 0, mime_type: 'text/plain', created_at: '2026-06-11T00:00:00Z', producer: 't', metadata: {},
    })).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/adapters/artifact/in-memory-artifact-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/adapters/artifact/in-memory-artifact-store.ts`**:

```ts
import { createHash } from 'node:crypto';
import type { ArtifactRef } from '../../domain/types.ts';
import type { ArtifactStorePort, PutArtifactMeta } from '../../ports/artifact-store.port.ts';

export class InMemoryArtifactStore implements ArtifactStorePort {
  private readonly byHash = new Map<string, Buffer>();

  async put(content: Buffer | string, meta: PutArtifactMeta): Promise<ArtifactRef> {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hex = createHash('sha256').update(buf).digest('hex');
    const contentHash = `sha256:${hex}`;
    this.byHash.set(contentHash, buf);
    return {
      artifact_id: contentHash,
      uri: `memory://${hex}`,
      content_hash: contentHash,
      kind: meta.kind,
      size_bytes: buf.byteLength,
      mime_type: meta.mime_type,
      created_at: new Date().toISOString(),
      producer: meta.producer,
      metadata: meta.metadata ?? {},
    };
  }

  async get(ref: ArtifactRef): Promise<Buffer> {
    const buf = this.byHash.get(ref.content_hash);
    if (!buf) throw new Error(`artifact not found: ${ref.content_hash}`);
    return buf;
  }

  resolveUri(ref: ArtifactRef): string {
    return ref.uri;
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run src/adapters/artifact/in-memory-artifact-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/artifact/in-memory-artifact-store.ts src/adapters/artifact/in-memory-artifact-store.test.ts
git commit -m "feat(sp2): add InMemoryArtifactStore for offline tests"
```

---

### Task 9: AppServices bag + HandlerDeps/worker refactor

**Files:**
- Create: `src/orchestrator/app-services.ts`, `test/support/make-services.ts`
- Modify: `src/orchestrator/workflow-router.ts`, `src/worker/worker.ts`, `src/orchestrator/workflow-router.test.ts`, `src/worker/worker.test.ts`

- [ ] **Step 1: Create `src/orchestrator/app-services.ts`**:

```ts
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { StrategyAnalystPort } from '../ports/strategy-analyst.port.ts';
import type { ArtifactStorePort } from '../ports/artifact-store.port.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';

export interface AppServices {
  researchTasks: ResearchTaskRepository;
  strategyProfiles: StrategyProfileRepository;
  analyst: StrategyAnalystPort;
  artifacts: ArtifactStorePort;
  events: AgentEventRepository;
}
```

- [ ] **Step 2: Update `src/orchestrator/workflow-router.ts`** — replace the `HandlerDeps` interface with a re-export of `AppServices` (keep the rest unchanged):

```ts
import type { AgentTaskType, ResearchTask } from '../domain/types.ts';
import type { AppServices } from './app-services.ts';

export type HandlerDeps = AppServices;

export type WorkflowHandler = (task: ResearchTask, deps: HandlerDeps) => Promise<void>;

export class WorkflowRouter {
  private readonly handlers = new Map<AgentTaskType, WorkflowHandler>();

  register(taskType: AgentTaskType, handler: WorkflowHandler): void {
    if (this.handlers.has(taskType)) {
      throw new Error(`handler already registered for task type: ${taskType}`);
    }
    this.handlers.set(taskType, handler);
  }

  async dispatch(task: ResearchTask, deps: HandlerDeps): Promise<void> {
    const handler = this.handlers.get(task.taskType);
    if (!handler) throw new Error(`no handler registered for task type: ${task.taskType}`);
    await handler(task, deps);
  }
}
```

- [ ] **Step 3: Update `src/worker/worker.ts`** — change `WorkerDeps` to carry `services` and use `services.researchTasks`. Replace the top of the file through `startWorker` (keep the runtime entrypoint guard at the bottom, but update its body — see Step 4):

```ts
import { pathToFileURL } from 'node:url';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { WorkflowRouter } from '../orchestrator/workflow-router.ts';
import type { AppServices } from '../orchestrator/app-services.ts';

export interface WorkerDeps {
  queue: TaskQueuePort;
  router: WorkflowRouter;
  services: AppServices;
}

export function startWorker(deps: WorkerDeps): void {
  const { queue, router, services } = deps;
  queue.process(async (envelope) => {
    const task = await services.researchTasks.findById(envelope.taskId);
    if (!task) throw new Error(`research_task not found for envelope: ${envelope.taskId}`);
    // The worker owns the generic lifecycle transition. Handlers signal success by
    // returning (failure by throwing); they do not set completed/failed themselves.
    await services.researchTasks.updateStatus(task.id, 'running');
    try {
      await router.dispatch({ ...task, status: 'running' }, services);
      await services.researchTasks.updateStatus(task.id, 'completed');
    } catch (err) {
      // Best-effort: never let a failure to record 'failed' mask the original error.
      try {
        await services.researchTasks.updateStatus(task.id, 'failed');
      } catch {
        // swallow
      }
      throw err;
    }
  });
}
```

- [ ] **Step 4: Update the worker runtime entrypoint guard** at the bottom of `src/worker/worker.ts`:

```ts
// Runtime entrypoint: `pnpm worker`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { composeRuntime } = await import('../composition.ts');
  const { queue, router, services, pool } = composeRuntime();
  startWorker({ queue, router, services });
  console.log('worker started, consuming research-tasks');

  const shutdown = async () => {
    await queue.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
```

- [ ] **Step 5: Create `test/support/make-services.ts`**:

```ts
import type { AppServices } from '../../src/orchestrator/app-services.ts';
import { InMemoryResearchTaskRepository } from '../../src/adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../../src/adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryAgentEventRepository } from '../../src/adapters/repository/in-memory-agent-event.repository.ts';
import { InMemoryArtifactStore } from '../../src/adapters/artifact/in-memory-artifact-store.ts';
import { FakeStrategyAnalyst } from '../../src/adapters/analyst/fake-strategy-analyst.ts';

export function makeServices(overrides: Partial<AppServices> = {}): AppServices {
  return {
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    analyst: new FakeStrategyAnalyst(),
    artifacts: new InMemoryArtifactStore(),
    events: new InMemoryAgentEventRepository(),
    ...overrides,
  };
}
```

- [ ] **Step 6: Rewrite `src/orchestrator/workflow-router.test.ts`** to use `makeServices()`:

```ts
import { describe, it, expect } from 'vitest';
import { WorkflowRouter, type WorkflowHandler } from './workflow-router.ts';
import { echoHandler } from './handlers/echo.handler.ts';
import { makeServices } from '../../test/support/make-services.ts';
import type { ResearchTask } from '../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'running', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});

describe('WorkflowRouter', () => {
  it('dispatches a task to its registered handler', async () => {
    const services = makeServices();
    const seen: string[] = [];
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async (t) => { seen.push(t.id); });
    await router.dispatch(task(), services);
    expect(seen).toEqual(['id-1']);
  });

  it('throws on an unregistered task type', async () => {
    const router = new WorkflowRouter();
    await expect(router.dispatch(task({ taskType: 'paper.monitor' }), makeServices())).rejects.toThrow(/no handler/i);
  });

  it('throws when the same task type is registered twice', () => {
    const router = new WorkflowRouter();
    const noop: WorkflowHandler = async () => {};
    router.register('strategy.onboard', noop);
    expect(() => router.register('strategy.onboard', noop)).toThrow(/already registered/i);
  });
});

describe('echoHandler', () => {
  it('is a no-op stub: it does NOT own the status transition (the worker does)', async () => {
    const services = makeServices();
    const t = task({ status: 'running' });
    await services.researchTasks.create(t);
    await echoHandler(t, services);
    expect((await services.researchTasks.findById('id-1'))?.status).toBe('running');
  });
});
```

- [ ] **Step 7: Rewrite `src/worker/worker.test.ts`** to use `services`:

```ts
import { describe, it, expect } from 'vitest';
import { startWorker } from './worker.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../orchestrator/workflow-router.ts';
import { echoHandler } from '../orchestrator/handlers/echo.handler.ts';
import { makeServices } from '../../test/support/make-services.ts';
import type { QueueEnvelope, ResearchTask } from '../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'queued', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});
const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 'id-1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

describe('startWorker', () => {
  it('marks task running then completed on success', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    await services.researchTasks.create(task());
    const router = new WorkflowRouter();
    router.register('strategy.onboard', echoHandler);
    startWorker({ queue, router, services });
    await queue.enqueue(env());
    await queue.drain();
    expect((await services.researchTasks.findById('id-1'))?.status).toBe('completed');
  });

  it('marks task failed when the handler throws', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    await services.researchTasks.create(task());
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async () => { throw new Error('boom'); });
    startWorker({ queue, router, services });
    await queue.enqueue(env());
    await expect(queue.drain()).rejects.toThrow('boom');
    expect((await services.researchTasks.findById('id-1'))?.status).toBe('failed');
  });

  it('rethrows the original handler error even if recording failed status throws', async () => {
    const queue = new InMemoryQueueAdapter();
    const base = makeServices();
    await base.researchTasks.create(task());
    const researchTasks = {
      findById: (id: string) => base.researchTasks.findById(id),
      findByDedupeKey: (k: string) => base.researchTasks.findByDedupeKey(k),
      create: (t: ResearchTask) => base.researchTasks.create(t),
      updateStatus: async (id: string, status: ResearchTask['status']) => {
        if (status === 'failed') throw new Error('db down');
        return base.researchTasks.updateStatus(id, status);
      },
    };
    const services = { ...base, researchTasks };
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async () => { throw new Error('boom'); });
    startWorker({ queue, router, services });
    await queue.enqueue(env());
    await expect(queue.drain()).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 7b: Update the SP-1 e2e test** `test/e2e/ingress-to-worker.test.ts` to the new services API (it uses the old `{ queue, repo, router }` worker shape and a bare `InMemoryResearchTaskRepository`). Replace its body with:

```ts
import { describe, it, expect } from 'vitest';
import { createIngressApp } from '../../src/ingress/app.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { echoHandler } from '../../src/orchestrator/handlers/echo.handler.ts';
import { makeServices } from '../support/make-services.ts';

describe('E2E: Ingress → queue → worker → router', () => {
  it('drives a task from POST to completed', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    const router = new WorkflowRouter();
    router.register('strategy.onboard', echoHandler);
    startWorker({ queue, router, services });

    const app = createIngressApp({ repo: services.researchTasks, queue });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } }),
    });
    const { taskId } = (await res.json()) as { taskId: string };
    expect((await services.researchTasks.findById(taskId))?.status).toBe('queued');

    await queue.drain();
    expect((await services.researchTasks.findById(taskId))?.status).toBe('completed');
    expect(queue.queued).toHaveLength(0); // nothing left behind or re-enqueued
  });
});
```

- [ ] **Step 8: Run, verify pass + typecheck**

Run: `pnpm vitest run src/orchestrator/workflow-router.test.ts src/worker/worker.test.ts test/e2e/ingress-to-worker.test.ts && pnpm typecheck`
Expected: PASS (router 4, worker 3); typecheck exit 0. (Note: `composition.ts` still references old shapes and is updated in Task 14 — typecheck of the whole project may surface errors there. If so, those are expected and fixed in Task 14; to keep this task green, run the scoped `pnpm vitest run ...` plus `pnpm tsc --noEmit src/orchestrator src/worker` is not granular — instead complete Step 9 to keep the tree compiling.)

- [ ] **Step 9: Keep the tree compiling — temporary composition shim**

`src/composition.ts` (rewritten fully in Task 14) currently builds the old `{ repo, router }` worker shape and registers `echoHandler`. To keep `pnpm typecheck` green now, update ONLY the worker-deps construction and the `strategy.onboard` registration minimally: build a temporary `AppServices` using the real research-task repo and **placeholder** in-memory/fake services, and keep `echoHandler` registered. Replace the body of `composeRuntime` in `src/composition.ts` with:

```ts
import { loadEnv } from './config/env.ts';
import { BullMqQueueAdapter } from './adapters/queue/bullmq-queue.adapter.ts';
import { DrizzleResearchTaskRepository } from './adapters/repository/drizzle-research-task.repository.ts';
import { LocalFileArtifactStore } from './adapters/artifact/local-file-artifact-store.adapter.ts';
import { createDbClient } from './db/client.ts';
import { WorkflowRouter } from './orchestrator/workflow-router.ts';
import { echoHandler } from './orchestrator/handlers/echo.handler.ts';
import { FakeStrategyAnalyst } from './adapters/analyst/fake-strategy-analyst.ts';
import { InMemoryStrategyProfileRepository } from './adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryAgentEventRepository } from './adapters/repository/in-memory-agent-event.repository.ts';
import type { AppServices } from './orchestrator/app-services.ts';

export function composeRuntime() {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');

  const { db, pool } = createDbClient(env.DATABASE_URL);
  const queue = new BullMqQueueAdapter(env.REDIS_URL);

  const services: AppServices = {
    researchTasks: new DrizzleResearchTaskRepository(db),
    strategyProfiles: new InMemoryStrategyProfileRepository(), // replaced with Drizzle in Task 14
    analyst: new FakeStrategyAnalyst(),                        // adapter selection added in Task 14
    artifacts: new LocalFileArtifactStore(env.ARTIFACT_DIR),
    events: new InMemoryAgentEventRepository(),                // replaced with Drizzle in Task 14
  };

  const router = new WorkflowRouter();
  router.register('strategy.onboard', echoHandler); // replaced with strategyOnboardHandler in Task 14

  return { env, db, pool, queue, router, services };
}
```

Also update `src/ingress/server.ts` to use `services.researchTasks`:

```ts
import { serve } from '@hono/node-server';
import { composeRuntime } from '../composition.ts';
import { createIngressApp } from './app.ts';

const { env, services, queue, pool } = composeRuntime();
const app = createIngressApp({ repo: services.researchTasks, queue });
serve({ fetch: app.fetch, port: env.INGRESS_PORT });
console.log(`ingress listening on :${env.INGRESS_PORT}`);

const shutdown = async () => {
  await queue.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 10: Run full typecheck + suite**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exit 0; all unit/e2e pass, integration suites skip.

- [ ] **Step 11: Commit**

```bash
git add src/orchestrator/app-services.ts src/orchestrator/workflow-router.ts src/worker/worker.ts src/composition.ts src/ingress/server.ts src/orchestrator/workflow-router.test.ts src/worker/worker.test.ts test/e2e/ingress-to-worker.test.ts test/support/make-services.ts
git commit -m "refactor(sp2): HandlerDeps -> AppServices bag; worker uses services.researchTasks"
```

---

### Task 10: strategyOnboardHandler

**Files:**
- Create: `src/orchestrator/handlers/strategy-onboard.handler.ts`, `src/orchestrator/handlers/strategy-onboard.handler.test.ts`

- [ ] **Step 1: Write failing test** — `src/orchestrator/handlers/strategy-onboard.handler.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { strategyOnboardHandler } from './strategy-onboard.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { sourceFingerprint } from '../../domain/fingerprint.ts';
import { FakeStrategyAnalyst } from '../../adapters/analyst/fake-strategy-analyst.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { ResearchTask } from '../../domain/types.ts';

const task = (payload: Record<string, unknown>): ResearchTask => ({
  id: 'task-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'running', payload, createdAt: '2026-06-11T00:00:00Z', updatedAt: '2026-06-11T00:00:00Z',
});
const validPayload = { kind: 'article', content: 'buy dips on capitulation', title: 'Dip buyer' };

describe('strategyOnboardHandler', () => {
  it('analyzes, persists a profile, and records started+completed audit events', async () => {
    const services = makeServices();
    await strategyOnboardHandler(task(validPayload), services);
    const fp = sourceFingerprint('article', validPayload.content);
    const profile = await services.strategyProfiles.findByFingerprint(fp);
    expect(profile).not.toBeNull();
    expect(profile?.contractVersion).toBe('strategy-profile-v1');
    expect(profile?.sourceArtifactRef.content_hash).toMatch(/^sha256:/);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toEqual(['strategy_analyst.started', 'strategy_analyst.completed']);
  });

  it('is idempotent: a duplicate source is deduped without calling the LLM', async () => {
    let calls = 0;
    const spy: StrategyAnalystPort = {
      adapter: 'fake', model: 'fake',
      analyze: async (input) => { calls += 1; return new FakeStrategyAnalyst().analyze(input); },
    };
    const services = makeServices({ analyst: spy });
    await strategyOnboardHandler(task(validPayload), services);
    expect(calls).toBe(1);
    await strategyOnboardHandler(task(validPayload), services);
    expect(calls).toBe(1); // not called again
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toContain('strategy.onboard.deduped');
  });

  it('throws on an invalid payload', async () => {
    const services = makeServices();
    await expect(strategyOnboardHandler(task({ kind: 'tweet' }), services)).rejects.toThrow(/invalid strategy.onboard payload/);
  });

  it('records a failed audit event and rethrows when the analyst throws', async () => {
    const analyst: StrategyAnalystPort = {
      adapter: 'fake', model: 'fake',
      analyze: async () => { throw new Error('llm exploded'); },
    };
    const services = makeServices({ analyst });
    await expect(strategyOnboardHandler(task(validPayload), services)).rejects.toThrow('llm exploded');
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toEqual(['strategy_analyst.started', 'strategy_analyst.failed']);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/orchestrator/handlers/strategy-onboard.handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/orchestrator/handlers/strategy-onboard.handler.ts`**:

```ts
import { randomUUID } from 'node:crypto';
import type { WorkflowHandler } from '../workflow-router.ts';
import { StrategyAnalystInputSchema } from '../../domain/strategy-source.ts';
import {
  AnalystProfileOutputSchema, STRATEGY_PROFILE_CONTRACT_VERSION, type StrategyProfile,
} from '../../domain/strategy-profile.ts';
import { sourceFingerprint } from '../../domain/fingerprint.ts';
import { validateWithSchema } from '../../validation/validator.ts';

export const strategyOnboardHandler: WorkflowHandler = async (task, services) => {
  const inputResult = validateWithSchema(StrategyAnalystInputSchema, task.payload);
  if (inputResult.status === 'invalid') {
    throw new Error(`invalid strategy.onboard payload: ${JSON.stringify(inputResult.issues)}`);
  }
  const input = inputResult.data;

  const fingerprint = sourceFingerprint(input.kind, input.content);

  const existing = await services.strategyProfiles.findByFingerprint(fingerprint);
  if (existing) {
    await services.events.append({
      id: randomUUID(), taskId: task.id, type: 'strategy.onboard.deduped',
      payload: { fingerprint, strategyId: existing.id }, createdAt: new Date().toISOString(),
    });
    return; // idempotent; worker marks completed; LLM not called
  }

  const sourceRef = await services.artifacts.put(input.content, {
    kind: 'strategy_source', mime_type: 'text/plain', producer: 'strategy-onboarding',
    metadata: { sourceKind: input.kind, uri: input.uri ?? null, title: input.title ?? null },
  });

  const auditBase = {
    taskId: task.id, model: services.analyst.model, adapter: services.analyst.adapter, sourceFingerprint: fingerprint,
  };
  await services.events.append({
    id: randomUUID(), taskId: task.id, type: 'strategy_analyst.started',
    payload: { ...auditBase }, createdAt: new Date().toISOString(),
  });

  let output;
  try {
    output = await services.analyst.analyze(input);
  } catch (err) {
    await services.events.append({
      id: randomUUID(), taskId: task.id, type: 'strategy_analyst.failed',
      payload: { ...auditBase, error: err instanceof Error ? err.message : String(err) },
      createdAt: new Date().toISOString(),
    });
    throw err;
  }

  await services.events.append({
    id: randomUUID(), taskId: task.id, type: 'strategy_analyst.completed',
    payload: { ...auditBase, direction: output.direction, confidence: output.confidence },
    createdAt: new Date().toISOString(),
  });

  const outputResult = validateWithSchema(AnalystProfileOutputSchema, output);
  if (outputResult.status === 'invalid') {
    throw new Error(`analyst returned invalid profile: ${JSON.stringify(outputResult.issues)}`);
  }
  const profileOut = outputResult.data;

  const now = new Date().toISOString();
  const profile: StrategyProfile = {
    id: randomUUID(),
    version: 1,
    sourceKind: input.kind,
    sourceFingerprint: fingerprint,
    direction: profileOut.direction,
    coreIdea: profileOut.coreIdea,
    requiredMarketFeatures: profileOut.requiredMarketFeatures,
    confidence: profileOut.confidence,
    unknowns: profileOut.unknowns,
    profile: profileOut,
    sourceArtifactRef: sourceRef,
    contractVersion: STRATEGY_PROFILE_CONTRACT_VERSION,
    createdAt: now,
    updatedAt: now,
  };
  await services.strategyProfiles.create(profile);
};
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run src/orchestrator/handlers/strategy-onboard.handler.test.ts && pnpm typecheck`
Expected: PASS (4 tests); typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/strategy-onboard.handler.ts src/orchestrator/handlers/strategy-onboard.handler.test.ts
git commit -m "feat(sp2): add strategyOnboardHandler (fingerprint dedupe, audit, gate, persist)"
```

---

### Task 11: Drizzle strategy_profile schema + repository + migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/adapters/repository/drizzle-strategy-profile.repository.ts`, `src/adapters/repository/drizzle-strategy-profile.repository.test.ts`
- Generate: `migrations/` (new file)

- [ ] **Step 1: Write failing test (integration, gated)** — `src/adapters/repository/drizzle-strategy-profile.repository.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleStrategyProfileRepository } from './drizzle-strategy-profile.repository.ts';
import { strategyProfile } from '../../db/schema.ts';
import { AnalystProfileOutputSchema } from '../../domain/strategy-profile.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ArtifactRef } from '../../domain/types.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const ref: ArtifactRef = {
  artifact_id: 'sha256:aa', uri: 'memory://aa', content_hash: 'sha256:aa', kind: 'strategy_source',
  size_bytes: 1, mime_type: 'text/plain', created_at: '2026-06-11T00:00:00Z', producer: 'test', metadata: {},
};
const sampleProfile = AnalystProfileOutputSchema.parse({
  direction: 'long', coreIdea: 'c', summary: 's', requiredMarketFeatures: ['oi'], entryConditions: [],
  exitConditions: [], timeframes: ['1h'], indicators: [], parameters: [], watchLifecycleSummary: null,
  positionManagementSummary: null, riskManagementSummary: null, runnerOwnedAuthorities: [],
  confidence: 0.7, unknowns: [], evidence: [],
});
const profile = (over: Partial<StrategyProfile> = {}): StrategyProfile => ({
  id: crypto.randomUUID(), version: 1, sourceKind: 'article', sourceFingerprint: `sha256:${crypto.randomUUID()}`,
  direction: 'long', coreIdea: 'c', requiredMarketFeatures: ['oi'], confidence: 0.7, unknowns: [],
  profile: sampleProfile, sourceArtifactRef: ref, contractVersion: 'strategy-profile-v1',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
});

d('DrizzleStrategyProfileRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleStrategyProfileRepository(db);
  beforeAll(async () => { await db.delete(strategyProfile); });
  afterAll(async () => { await pool.end(); });

  it('creates and finds by id and fingerprint, preserving JSONB', async () => {
    const p = profile({ sourceFingerprint: 'sha256:fp-int-1' });
    await repo.create(p);
    const byId = await repo.findById(p.id);
    expect(byId?.profile.requiredMarketFeatures).toEqual(['oi']);
    expect(byId?.sourceArtifactRef.content_hash).toBe('sha256:aa');
    expect((await repo.findByFingerprint('sha256:fp-int-1'))?.id).toBe(p.id);
  });

  it('rejects a second profile with the same fingerprint (unique index)', async () => {
    const fp = 'sha256:fp-int-dup';
    await repo.create(profile({ sourceFingerprint: fp }));
    await expect(repo.create(profile({ sourceFingerprint: fp }))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/adapters/repository/drizzle-strategy-profile.repository.test.ts`
Expected: FAIL — module `./drizzle-strategy-profile.repository.ts` not found.

- [ ] **Step 3: Add the `strategy_profile` table to `src/db/schema.ts`** (append; keep existing tables):

```ts
export const strategyProfile = pgTable('strategy_profile', {
  id: text('id').primaryKey(),
  version: integer('version').notNull().default(1),
  sourceKind: text('source_kind').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  direction: text('direction').notNull(),
  coreIdea: text('core_idea').notNull(),
  requiredMarketFeatures: jsonb('required_market_features').notNull().$type<string[]>(),
  confidence: real('confidence').notNull(),
  unknowns: jsonb('unknowns').notNull().$type<string[]>(),
  profile: jsonb('profile').notNull().$type<AnalystProfileOutput>(),
  sourceArtifactRef: jsonb('source_artifact_ref').notNull().$type<ArtifactRef>(),
  contractVersion: text('contract_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fingerprintUq: uniqueIndex('strategy_profile_fingerprint_uq').on(t.sourceFingerprint),
  kindIdx: index('strategy_profile_source_kind_idx').on(t.sourceKind),
}));
```

Add the needed imports at the top of `src/db/schema.ts`: ensure `integer` and `real` are in the `drizzle-orm/pg-core` import, and add:

```ts
import type { AnalystProfileOutput } from '../domain/strategy-profile.ts';
import type { ArtifactRef } from '../domain/types.ts';
```

(The existing import line should become: `import { pgTable, text, jsonb, timestamp, index, uniqueIndex, integer, real } from 'drizzle-orm/pg-core';`)

- [ ] **Step 4: Create `src/adapters/repository/drizzle-strategy-profile.repository.ts`**:

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { strategyProfile } from '../../db/schema.ts';
import type { StrategyProfile, AnalystProfileOutput, Direction } from '../../domain/strategy-profile.ts';
import type { SourceKind } from '../../domain/strategy-source.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import type { StrategyProfileRepository } from '../../ports/strategy-profile.repository.ts';

type Row = typeof strategyProfile.$inferSelect;

function toDomain(row: Row): StrategyProfile {
  return {
    id: row.id,
    version: row.version,
    sourceKind: row.sourceKind as SourceKind,
    sourceFingerprint: row.sourceFingerprint,
    direction: row.direction as Direction,
    coreIdea: row.coreIdea,
    requiredMarketFeatures: row.requiredMarketFeatures,
    confidence: row.confidence,
    unknowns: row.unknowns,
    profile: row.profile as AnalystProfileOutput,
    sourceArtifactRef: row.sourceArtifactRef as ArtifactRef,
    contractVersion: row.contractVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleStrategyProfileRepository implements StrategyProfileRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async create(profile: StrategyProfile): Promise<void> {
    await this.db.insert(strategyProfile).values({
      id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      sourceFingerprint: profile.sourceFingerprint, direction: profile.direction, coreIdea: profile.coreIdea,
      requiredMarketFeatures: profile.requiredMarketFeatures, confidence: profile.confidence,
      unknowns: profile.unknowns, profile: profile.profile, sourceArtifactRef: profile.sourceArtifactRef,
      contractVersion: profile.contractVersion,
      createdAt: new Date(profile.createdAt), updatedAt: new Date(profile.updatedAt),
    });
  }

  async findById(id: string): Promise<StrategyProfile | null> {
    const rows = await this.db.select().from(strategyProfile).where(eq(strategyProfile.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findByFingerprint(fp: string): Promise<StrategyProfile | null> {
    const rows = await this.db.select().from(strategyProfile).where(eq(strategyProfile.sourceFingerprint, fp)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }
}
```

- [ ] **Step 5: Generate + apply migration, run the integration test (with Postgres up)**

Run:
```bash
docker compose up -d postgres
export DATABASE_URL=postgres://lab:lab@localhost:5432/trading_lab
pnpm db:generate && pnpm db:migrate
DATABASE_URL=$DATABASE_URL pnpm vitest run src/adapters/repository/drizzle-strategy-profile.repository.test.ts
```
Expected: new migration generated under `migrations/`; integration test PASS (2 tests). Confirm the generated SQL has `CREATE UNIQUE INDEX ... "strategy_profile_fingerprint_uq"`. Without `DATABASE_URL`: suite SKIPPED.

- [ ] **Step 6: Run typecheck + full suite (no infra)**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exit 0; all pass, integration suites skip.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/adapters/repository/drizzle-strategy-profile.repository.ts src/adapters/repository/drizzle-strategy-profile.repository.test.ts migrations
git commit -m "feat(sp2): add strategy_profile table + Drizzle repository (unique fingerprint)"
```

---

### Task 12: Drizzle agent_event repository

**Files:**
- Create: `src/adapters/repository/drizzle-agent-event.repository.ts`, `src/adapters/repository/drizzle-agent-event.repository.test.ts`

(The `agent_event` table already exists from SP-1 migration `0000_*`.)

- [ ] **Step 1: Write failing test (integration, gated)** — `src/adapters/repository/drizzle-agent-event.repository.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleAgentEventRepository } from './drizzle-agent-event.repository.ts';
import { agentEvent } from '../../db/schema.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('DrizzleAgentEventRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleAgentEventRepository(db);
  beforeAll(async () => { await db.delete(agentEvent); });
  afterAll(async () => { await pool.end(); });

  it('appends and lists by task', async () => {
    await repo.append({ id: crypto.randomUUID(), taskId: 'tA', type: 'strategy_analyst.started', payload: { model: 'm' }, createdAt: new Date().toISOString() });
    await repo.append({ id: crypto.randomUUID(), taskId: 'tA', type: 'strategy_analyst.completed', payload: {}, createdAt: new Date().toISOString() });
    await repo.append({ id: crypto.randomUUID(), taskId: 'tB', type: 'strategy_analyst.started', payload: {}, createdAt: new Date().toISOString() });
    const a = await repo.listByTask('tA');
    expect(a.map((e) => e.type).sort()).toEqual(['strategy_analyst.completed', 'strategy_analyst.started']);
    expect(a[0]!.payload).toBeTypeOf('object');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run src/adapters/repository/drizzle-agent-event.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/adapters/repository/drizzle-agent-event.repository.ts`**:

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { agentEvent } from '../../db/schema.ts';
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';

type Row = typeof agentEvent.$inferSelect;

function toDomain(row: Row): AgentEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleAgentEventRepository implements AgentEventRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async append(event: AgentEvent): Promise<void> {
    await this.db.insert(agentEvent).values({
      id: event.id, taskId: event.taskId, type: event.type, payload: event.payload,
      createdAt: new Date(event.createdAt),
    });
  }

  async listByTask(taskId: string): Promise<AgentEvent[]> {
    const rows = await this.db.select().from(agentEvent).where(eq(agentEvent.taskId, taskId));
    return rows.map(toDomain);
  }
}
```

- [ ] **Step 4: Run integration (Postgres up) + typecheck**

Run:
```bash
export DATABASE_URL=postgres://lab:lab@localhost:5432/trading_lab
DATABASE_URL=$DATABASE_URL pnpm vitest run src/adapters/repository/drizzle-agent-event.repository.test.ts
pnpm typecheck
```
Expected: integration PASS (1 test); typecheck exit 0. Without `DATABASE_URL`: SKIPPED.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/repository/drizzle-agent-event.repository.ts src/adapters/repository/drizzle-agent-event.repository.test.ts
git commit -m "feat(sp2): add Drizzle agent_event repository"
```

---

### Task 13: MastraStrategyAnalyst (real LLM adapter)

**Files:**
- Modify: `package.json` (add deps)
- Create: `src/adapters/analyst/mastra-strategy-analyst.ts`, `src/adapters/analyst/mastra-strategy-analyst.test.ts`

- [ ] **Step 1: Install Mastra + Anthropic provider**

Run: `pnpm add @mastra/core @ai-sdk/anthropic`
Expected: both added to `dependencies`. Report resolved versions.

- [ ] **Step 2: Write the gated live test** — `src/adapters/analyst/mastra-strategy-analyst.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MastraStrategyAnalyst } from './mastra-strategy-analyst.ts';
import { AnalystProfileOutputSchema } from '../../domain/strategy-profile.ts';
import { loadEnv } from '../../config/env.ts';

const env = loadEnv();
const live = env.RUN_LLM_TESTS && env.ANTHROPIC_API_KEY ? describe : describe.skip;

describe('MastraStrategyAnalyst (unit)', () => {
  it('reports adapter=mastra and the configured model', () => {
    const a = new MastraStrategyAnalyst('anthropic/claude-sonnet-4-6');
    expect(a.adapter).toBe('mastra');
    expect(a.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

live('MastraStrategyAnalyst (live LLM)', () => {
  it('returns a schema-valid profile for a sample source', async () => {
    const a = new MastraStrategyAnalyst(env.STRATEGY_ANALYST_MODEL);
    const out = await a.analyze({
      kind: 'manual_description',
      content: 'Go long when open interest rises while price drops into a liquidation cluster; exit on funding flip.',
    });
    expect(AnalystProfileOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 3: Run, verify the unit test fails (module missing)**

Run: `pnpm vitest run src/adapters/analyst/mastra-strategy-analyst.test.ts`
Expected: FAIL — module not found (live suite skips without `RUN_LLM_TESTS`+key).

- [ ] **Step 4: Create `src/adapters/analyst/mastra-strategy-analyst.ts`**:

```ts
import { Agent } from '@mastra/core/agent';
import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import { AnalystProfileOutputSchema, type AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';

const INSTRUCTIONS = [
  'You are a trading-strategy analyst.',
  'Given a strategy source (code, README, article, summary, or description), extract a structured profile.',
  'Do not invent details; put anything you are unsure about in `unknowns`.',
  'Anything that belongs to risk sizing, order execution, or fills is owned by the runner/platform —',
  'list those concerns in `runnerOwnedAuthorities`, do not propose live execution.',
  'Mark tunable parameters with tunable: true.',
].join(' ');

function buildPrompt(input: StrategyAnalystInput): string {
  const header = `Source kind: ${input.kind}` + (input.title ? `\nTitle: ${input.title}` : '') + (input.uri ? `\nURI: ${input.uri}` : '');
  return `${header}\n\n--- SOURCE START ---\n${input.content}\n--- SOURCE END ---\n\nReturn the structured strategy profile.`;
}

export class MastraStrategyAnalyst implements StrategyAnalystPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(model: string) {
    this.model = model;
    this.agent = new Agent({
      id: 'strategy-analyst',
      name: 'Strategy Analyst',
      instructions: INSTRUCTIONS,
      model,
    });
  }

  async analyze(input: StrategyAnalystInput): Promise<AnalystProfileOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: AnalystProfileOutputSchema },
    });
    // Re-parse to guarantee the typed shape regardless of the SDK's inferred return type.
    return AnalystProfileOutputSchema.parse(result.object);
  }
}
```

> If `pnpm typecheck` reports that `new Agent({ model })` rejects a `string`, swap to the AI SDK provider instance: `import { anthropic } from '@ai-sdk/anthropic'` and pass `model: anthropic(model.replace(/^anthropic\//, ''))`. Keep `this.model` as the original string for audit. Report which form compiled.

- [ ] **Step 5: Run unit test + typecheck**

Run: `pnpm vitest run src/adapters/analyst/mastra-strategy-analyst.test.ts && pnpm typecheck`
Expected: unit test PASS (1); live suite SKIPPED; typecheck exit 0. (Optionally, if you have a key: `RUN_LLM_TESTS=true ANTHROPIC_API_KEY=… pnpm vitest run …` to exercise the live test — report the result, but it is not required to pass for this task.)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/adapters/analyst/mastra-strategy-analyst.ts src/adapters/analyst/mastra-strategy-analyst.test.ts
git commit -m "feat(sp2): add MastraStrategyAnalyst (structured output; live test gated)"
```

---

### Task 14: Composition — adapter selection + wire onboarding

**Files:**
- Modify: `src/composition.ts`

- [ ] **Step 1: Replace `composeRuntime` in `src/composition.ts`** with the production wiring (adapter selection + Drizzle services + onboarding handler):

```ts
import { loadEnv } from './config/env.ts';
import { BullMqQueueAdapter } from './adapters/queue/bullmq-queue.adapter.ts';
import { DrizzleResearchTaskRepository } from './adapters/repository/drizzle-research-task.repository.ts';
import { DrizzleStrategyProfileRepository } from './adapters/repository/drizzle-strategy-profile.repository.ts';
import { DrizzleAgentEventRepository } from './adapters/repository/drizzle-agent-event.repository.ts';
import { LocalFileArtifactStore } from './adapters/artifact/local-file-artifact-store.adapter.ts';
import { FakeStrategyAnalyst } from './adapters/analyst/fake-strategy-analyst.ts';
import { MastraStrategyAnalyst } from './adapters/analyst/mastra-strategy-analyst.ts';
import { createDbClient } from './db/client.ts';
import { WorkflowRouter } from './orchestrator/workflow-router.ts';
import { strategyOnboardHandler } from './orchestrator/handlers/strategy-onboard.handler.ts';
import type { AppServices } from './orchestrator/app-services.ts';
import type { StrategyAnalystPort } from './ports/strategy-analyst.port.ts';

function buildAnalyst(env: ReturnType<typeof loadEnv>): StrategyAnalystPort {
  if (env.STRATEGY_ANALYST_ADAPTER === 'mastra') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required when STRATEGY_ANALYST_ADAPTER=mastra');
    return new MastraStrategyAnalyst(env.STRATEGY_ANALYST_MODEL);
  }
  return new FakeStrategyAnalyst();
}

export function composeRuntime() {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');

  const { db, pool } = createDbClient(env.DATABASE_URL);
  const queue = new BullMqQueueAdapter(env.REDIS_URL);

  const services: AppServices = {
    researchTasks: new DrizzleResearchTaskRepository(db),
    strategyProfiles: new DrizzleStrategyProfileRepository(db),
    analyst: buildAnalyst(env),
    artifacts: new LocalFileArtifactStore(env.ARTIFACT_DIR),
    events: new DrizzleAgentEventRepository(db),
  };

  const router = new WorkflowRouter();
  router.register('strategy.onboard', strategyOnboardHandler);

  return { env, db, pool, queue, router, services };
}
```

- [ ] **Step 2: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exit 0; all unit/e2e pass, integration suites skip. (Default adapter is `fake`, so no API key needed.)

- [ ] **Step 3: Commit**

```bash
git add src/composition.ts
git commit -m "feat(sp2): wire analyst adapter selection + register strategyOnboardHandler"
```

---

### Task 15: End-to-end onboarding test

**Files:**
- Create: `test/e2e/strategy-onboard.test.ts`

- [ ] **Step 1: Write the test** — `test/e2e/strategy-onboard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createIngressApp } from '../../src/ingress/app.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { strategyOnboardHandler } from '../../src/orchestrator/handlers/strategy-onboard.handler.ts';
import { makeServices } from '../support/make-services.ts';
import { sourceFingerprint } from '../../src/domain/fingerprint.ts';

describe('E2E: strategy.onboard ingress -> worker -> profile', () => {
  it('drives an onboard task from POST to a persisted StrategyProfile', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    const router = new WorkflowRouter();
    router.register('strategy.onboard', strategyOnboardHandler);
    startWorker({ queue, router, services });

    const app = createIngressApp({ repo: services.researchTasks, queue });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskType: 'strategy.onboard', source: 'operator',
        payload: { kind: 'manual_description', content: 'long OI divergence', title: 'OI div' },
      }),
    });
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };

    await queue.drain();

    expect((await services.researchTasks.findById(taskId))?.status).toBe('completed');
    const fp = sourceFingerprint('manual_description', 'long OI divergence');
    const profile = await services.strategyProfiles.findByFingerprint(fp);
    expect(profile).not.toBeNull();
    expect(profile?.sourceKind).toBe('manual_description');
    const events = (await services.events.listByTask(taskId)).map((e) => e.type);
    expect(events).toEqual(['strategy_analyst.started', 'strategy_analyst.completed']);
  });
});
```

- [ ] **Step 2: Run, verify pass**

Run: `pnpm vitest run test/e2e/strategy-onboard.test.ts`
Expected: PASS. If it fails, fix the failing composition seam (do not weaken assertions); report what you changed.

- [ ] **Step 3: Full suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exit 0; all unit + e2e pass; Postgres/LLM integration suites skip without env vars.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/strategy-onboard.test.ts
git commit -m "test(sp2): add end-to-end strategy onboarding wiring test"
```

---

## Self-Review

**Spec coverage (spec §§ → tasks):**
- §1.1 SourceKind/StrategyAnalystInput → Task 2. ✓
- §1.2 AnalystProfileOutput (incl. parameters/summaries/runnerOwnedAuthorities/timeframes) → Task 3. ✓
- §1.3 StrategyProfile → Task 3 (type), Task 11 (table). ✓
- §2.1 StrategyAnalystPort + Fake + Mastra → Tasks 5, 13. ✓
- §2.2 StrategyProfileRepository (in-memory + Drizzle, unique fingerprint) → Tasks 6, 11. ✓
- §2.3 AgentEventRepository (in-memory + Drizzle) → Tasks 7, 12. ✓
- §3 source fingerprint (CRLF→LF, NFC, trim, no collapse, kind prefix) → Task 4. ✓
- §4 source stored via ArtifactStorePort; ref as full ArtifactRef JSONB → Task 10 (put) + Task 11 (jsonb column). ✓
- §5 strategy_profile table → Task 11. ✓
- §6 onboarding handler with audit events (started/completed/failed/deduped) → Task 10. ✓
- §7 HandlerDeps→AppServices refactor → Task 9. ✓
- §8 config (adapter/model/key/RUN_LLM_TESTS); composeRuntime adapter selection → Tasks 1, 14. ✓
- §9 validation gates (input schema, output schema re-validation) → Task 10. ✓
- §10 testing (unit offline, gated integration, gated live LLM, e2e) → Tasks 2–15. ✓
- §13 in-memory artifact store for offline tests → Task 8. ✓

**Placeholder scan:** No TBD/TODO in steps; every code step shows full code. The "temporary composition shim" (Task 9 Step 9) and its replacement (Task 14) are both fully specified — intentional, not a placeholder.

**Type consistency:** `AppServices` fields (`researchTasks`, `strategyProfiles`, `analyst`, `artifacts`, `events`) are used identically in Tasks 9–15. `StrategyAnalystPort` (`adapter`, `model`, `analyze`) consistent across Tasks 5/10/13/14. `AgentEvent` shape (`id, taskId, type, payload, createdAt`) consistent across Tasks 7/10/12. `StrategyProfile` fields consistent across Tasks 3/6/10/11. `validateWithSchema(...).data` (SP-1) used in Task 10. `sourceFingerprint(kind, content)` consistent across Tasks 4/10/15.

---

*End of SP-2 plan. Subsequent phases (SP-3 Research Cycle, …) get their own plans.*
