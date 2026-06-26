# Pre-flight Strategy Critic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a pre-flight "ruthless market opponent" critic that, before the analyst sees a new strategy's text, critiques the raw idea and returns an **improved strategy text** the analyst turns into a profile. The critique is stored + surfaced; a critic failure never blocks onboarding (fail-soft). Ships **both** modes (`single`, `two_stage`) behind flags. **Default OFF** (`STRATEGY_PREFLIGHT_CRITIQUE=false`) → zero behavior change.

**Architecture:** New `strategy-critic` module namespace, deliberately distinct from the post-hypothesis `critic` (`CriticPort`). Mirrors the analyst/critic seams end-to-end: domain schemas (`src/domain/strategy-critic.ts`) → port (`src/ports/strategy-critic.port.ts`) → adapters (`src/adapters/strategy-critic/{fake,single-stage,two-stage}`) → Mastra agents (`src/mastra/agents/strategy-{critic,refiner,critic-combined}.agent.ts`) → composition (`buildStrategyCritic`) → handler integration (`strategy-onboard.handler.ts`) → read surface (`completion-summary.ts`). Cost accrual is factored into a shared `makeOnUsage(task, services)` (extracted from the research-run-cycle / hypothesis-build handlers).

**Tech Stack:** TypeScript ESM under `node --experimental-strip-types` (NO TS parameter-properties), Vitest, zod, hexagonal ports/adapters, Mastra (`@mastra/core/agent`; agent construction only under `src/mastra/**`).

**Spec:** `docs/superpowers/specs/2026-06-26-preflight-strategy-critic-design.md`

---

## Global Constraints

- **NO TS parameter-properties.** Runtime boots via `node --experimental-strip-types`; `constructor(private x: T)` throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at load. Use explicit field declarations + assignment in the constructor body. Guarded by `src/strip-types-no-param-properties.test.ts` (scans `src` + `scripts`).
- **Mastra import-boundary.** `@mastra/core`/`@mastra/arize`/`@mastra/observability` VALUE imports and `new Agent(` / `new Mastra(` may appear ONLY under `src/mastra/**`. Everywhere else (adapters, tests) imports the Agent **type** only: `import type { Agent } from '@mastra/core/agent'`. Guarded by `src/mastra/mastra-import-boundary.guard.test.ts`.
- **`.ts` extension on every relative import** (e.g. `import { X } from './foo.ts'`).
- **Test gate:** `pnpm typecheck` + `pnpm test` (full suite) must be green before the slice is done.
- **Default OFF.** `STRATEGY_PREFLIGHT_CRITIQUE=false` ⇒ `buildStrategyCritic` returns `null` ⇒ handler skips the critic entirely ⇒ zero behavior change.
- **Provenance on ORIGINAL content.** `sourceFingerprint` and the `strategy_source` artifact stay on `input.content` (the raw user text). The improved text is an intermediate captured only in the `strategy_critique` artifact + `strategy_critic.completed` event. Resubmitting the same raw text still dedups.
- **`two_stage` accrues `onUsage` per stage** — both the critic `generate` and the refiner `generate` call `opts.onUsage`, so token/cost accrual sums across both LLM calls.

---

## Verified facts (gortex-extracted)

- **Analyst input shape** (`src/domain/strategy-source.ts`): `StrategyAnalystInputSchema = z.object({ kind: z.enum(SOURCE_KINDS), content: z.string().min(1), uri?: optional, title?: optional })`.
- **`AgentCallOpts`** (`src/ports/agent-call-opts.ts`): `{ onUsage?: (usage: AgentCallUsage) => void | Promise<void> }`; `AgentCallUsage = { modelId; inputTokens; outputTokens; totalTokens }`.
- **Mastra adapter usage extraction** (verbatim from `MastraResearcher`/`MastraCritic`): `await opts?.onUsage?.({ modelId: this.model, inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0, totalTokens: result.usage?.totalTokens ?? 0 })`; output via `agent.generate(prompt, { structuredOutput: { schema } })` then `Schema.parse(result.object)`.
- **Agent factory pattern** (`strategy-analyst.agent.ts`): `export const *_AGENT_ID = '...'; const INSTRUCTIONS = [...].join(' '); export function create*Agent(model: ProviderModel): Agent { return new Agent({ id, name, instructions: INSTRUCTIONS, model }); }`.
- **`composeMastra`** (`src/mastra/compose-mastra.ts`): `build(id, modelId, make)` resolves the model via `resolveLanguageModel(env, modelId)` and registers into a `registry`; `entry(id)` wraps as `{ agent, label }`; `MastraRuntime.agents` is the typed map. `MastraCompositionEnv` carries the adapter/model fields.
- **`onUsage` block duplicated ×3**: `research-run-cycle.handler.ts` (researcher.propose + critic.review) and `hypothesis-build.handler.ts` (builder.build). The block: `tokenUsage.add(correlationId, totalTokens)` → `modelPricing.priceFor(modelId)` → if price `tokenUsage.addCost(correlationId, in*inUsd + out*outUsd)` else append a `research.cost_unpriced` event `{ modelId }`.
- **Event shape** (`AgentEventRepository.append`): `{ id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() }`.
- **Artifact** (`ArtifactStorePort.put(content, { kind, mime_type, producer, metadata? })`) returns `ArtifactRef` with `artifact_id` + `content_hash`.
- **`AppServices`** (`src/orchestrator/app-services.ts`): `critic: CriticPort | null` is the precedent for the new `strategyCritic: StrategyCriticPort | null`. Test default in `test/support/make-services.ts`.
- **`OnboardCompletionSummary`** (`src/read-api/completion-summary.ts`): `buildOnboard` reads `deps.agentEvents.list({ taskId, limit: 50 })`; `AgentEventReadPort.list(q)` returns `AgentEventRow[]` (`{ id, taskId, type, payload, createdAt }`).
- **`ResearchTask`** type: `'../domain/types.ts'` (used by `WorkflowHandler = (task: ResearchTask, deps: HandlerDeps) => Promise<void>`).

---

### Task 1: Domain schemas — `strategy-critic.ts`

**Files:**
- Create `src/domain/strategy-critic.ts`
- Test `src/domain/strategy-critic.test.ts`

**Interfaces:**
- Consumes: `StrategyAnalystInputSchema` from `./strategy-source.ts`; `z` from `zod`.
- Produces:
  - `StrategyCriticInputSchema` (alias of `StrategyAnalystInputSchema`) + `type StrategyCriticInput`
  - `StrategyCritiqueSchema` + `type StrategyCritique`
  - `StrategyRefinementSchema` (= critique extended with `improvedStrategyText: string; changeLog?: string[]`) + `type StrategyRefinement`

- [ ] **Step 1: Write the failing test** — `src/domain/strategy-critic.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  StrategyCriticInputSchema,
  StrategyCritiqueSchema,
  StrategyRefinementSchema,
} from './strategy-critic.ts';

const validCritique = {
  vulnerabilities: ['thesis assumes liquidity that may not exist'],
  selfDeception: ['treats a lagging signal as leading'],
  risks: { market: 'trend reversal', timing: 'too early', news: 'unscheduled CPI', liquidity: 'thin book', btcRegime: 'BTC-led selloff', exhaustion: 'momentum fading' },
  earlyBreakSigns: ['funding flips positive'],
  preEntryChecks: ['confirm OI rising'],
  verdict: { mainVulnerability: 'no invalidation', severity: 'high', badIdeaOrBadTiming: 'bad_timing', whatWouldStrengthen: 'add a regime filter' },
};

describe('strategy-critic schemas', () => {
  it('accepts a valid critic input (reuses the analyst input shape)', () => {
    const r = StrategyCriticInputSchema.safeParse({ kind: 'manual_description', content: 'short after a pump' });
    expect(r.success).toBe(true);
  });

  it('rejects a critic input with empty content', () => {
    expect(StrategyCriticInputSchema.safeParse({ kind: 'article', content: '' }).success).toBe(false);
  });

  it('round-trips a valid critique', () => {
    expect(StrategyCritiqueSchema.safeParse(validCritique).success).toBe(true);
  });

  it('rejects a critique with an out-of-enum severity', () => {
    const bad = { ...validCritique, verdict: { ...validCritique.verdict, severity: 'extreme' } };
    expect(StrategyCritiqueSchema.safeParse(bad).success).toBe(false);
  });

  it('refinement extends the critique with improvedStrategyText + optional changeLog', () => {
    const ok = StrategyRefinementSchema.safeParse({ ...validCritique, improvedStrategyText: 'short after a >10% pump in 20m, only when BTC is range-bound; invalidate if funding flips', changeLog: ['added BTC-regime filter'] });
    expect(ok.success).toBe(true);
    const noLog = StrategyRefinementSchema.safeParse({ ...validCritique, improvedStrategyText: 'x' });
    expect(noLog.success).toBe(true); // changeLog optional
    const missing = StrategyRefinementSchema.safeParse(validCritique); // no improvedStrategyText
    expect(missing.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/domain/strategy-critic.test.ts`
  Expected: `Failed to resolve import "./strategy-critic.ts"` (module does not exist yet).

- [ ] **Step 3: Minimal implementation** — `src/domain/strategy-critic.ts`

```ts
import { z } from 'zod';
import { StrategyAnalystInputSchema } from './strategy-source.ts';

/** The critic sees exactly what the analyst would — reuse the analyst input shape. */
export const StrategyCriticInputSchema = StrategyAnalystInputSchema;
export type StrategyCriticInput = z.infer<typeof StrategyCriticInputSchema>;

/** The 6-section human-facing critique, mirroring the ruthless-market-opponent prompt. */
export const StrategyCritiqueSchema = z.object({
  vulnerabilities: z.array(z.string()),
  selfDeception: z.array(z.string()),
  risks: z.object({
    market: z.string(),
    timing: z.string(),
    news: z.string(),
    liquidity: z.string(),
    btcRegime: z.string(),
    exhaustion: z.string(),
  }),
  earlyBreakSigns: z.array(z.string()),
  preEntryChecks: z.array(z.string()),
  verdict: z.object({
    mainVulnerability: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    badIdeaOrBadTiming: z.enum(['bad_idea', 'bad_timing', 'neither']),
    whatWouldStrengthen: z.string(),
  }),
});
export type StrategyCritique = z.infer<typeof StrategyCritiqueSchema>;

/** The port's return type — `improvedStrategyText` is what the analyst receives. */
export const StrategyRefinementSchema = StrategyCritiqueSchema.extend({
  improvedStrategyText: z.string(),
  changeLog: z.array(z.string()).optional(),
});
export type StrategyRefinement = z.infer<typeof StrategyRefinementSchema>;
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/domain/strategy-critic.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): domain schemas (input/critique/refinement)"`

---

### Task 2: Port + Fake adapter

**Files:**
- Create `src/ports/strategy-critic.port.ts`
- Create `src/adapters/strategy-critic/fake-strategy-critic.ts`
- Test `src/adapters/strategy-critic/fake-strategy-critic.test.ts`

**Interfaces:**
- Consumes: `StrategyCriticInput`, `StrategyRefinement` from `../domain/strategy-critic.ts`; `AgentCallOpts` from `./agent-call-opts.ts`.
- Produces:
  - `interface StrategyCriticPort { readonly adapter: 'fake' | 'mastra'; readonly mode: 'single' | 'two_stage'; readonly model: string; refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement> }`
  - `class FakeStrategyCritic implements StrategyCriticPort` (ctor `(mode?: 'single' | 'two_stage')`, default `'two_stage'`).

- [ ] **Step 1: Write the failing test** — `src/adapters/strategy-critic/fake-strategy-critic.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { FakeStrategyCritic } from './fake-strategy-critic.ts';
import { StrategyRefinementSchema } from '../../domain/strategy-critic.ts';
import type { AgentCallUsage } from '../../ports/agent-call-opts.ts';

describe('FakeStrategyCritic', () => {
  it('reports adapter/model and the mode from its ctor', () => {
    expect(new FakeStrategyCritic().mode).toBe('two_stage');
    expect(new FakeStrategyCritic('single').mode).toBe('single');
    const f = new FakeStrategyCritic();
    expect(f.adapter).toBe('fake');
    expect(f.model).toBe('fake');
  });

  it('echoes input.content as improvedStrategyText and returns a schema-valid refinement', async () => {
    const f = new FakeStrategyCritic();
    const out = await f.refine({ kind: 'manual_description', content: 'short after a pump' });
    expect(StrategyRefinementSchema.safeParse(out).success).toBe(true);
    expect(out.improvedStrategyText).toBe('short after a pump');
  });

  it('forwards a zero-usage call to opts.onUsage', async () => {
    const seen: AgentCallUsage[] = [];
    const f = new FakeStrategyCritic();
    await f.refine({ kind: 'article', content: 'x' }, { onUsage: (u) => { seen.push(u); } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.totalTokens).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/adapters/strategy-critic/fake-strategy-critic.test.ts`
  Expected: `Failed to resolve import "./fake-strategy-critic.ts"`.

- [ ] **Step 3: Minimal implementation**

`src/ports/strategy-critic.port.ts`:

```ts
import type { StrategyCriticInput, StrategyRefinement } from '../domain/strategy-critic.ts';
import type { AgentCallOpts } from './agent-call-opts.ts';
export type { AgentCallOpts };

export interface StrategyCriticPort {
  readonly adapter: 'fake' | 'mastra';
  readonly mode: 'single' | 'two_stage';
  readonly model: string;
  refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement>;
}
```

`src/adapters/strategy-critic/fake-strategy-critic.ts`:

```ts
import type { StrategyCriticPort, AgentCallOpts } from '../../ports/strategy-critic.port.ts';
import type { StrategyCriticInput, StrategyRefinement } from '../../domain/strategy-critic.ts';

export class FakeStrategyCritic implements StrategyCriticPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  readonly mode: 'single' | 'two_stage';

  constructor(mode: 'single' | 'two_stage' = 'two_stage') {
    this.mode = mode;
  }

  async refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement> {
    await opts?.onUsage?.({ modelId: 'fake', inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    return {
      vulnerabilities: ['fake-critic: no real critique performed'],
      selfDeception: [],
      risks: { market: 'n/a', timing: 'n/a', news: 'n/a', liquidity: 'n/a', btcRegime: 'n/a', exhaustion: 'n/a' },
      earlyBreakSigns: [],
      preEntryChecks: [],
      verdict: { mainVulnerability: 'none (fake)', severity: 'low', badIdeaOrBadTiming: 'neither', whatWouldStrengthen: 'n/a' },
      improvedStrategyText: input.content,
      changeLog: [],
    };
  }
}
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/adapters/strategy-critic/fake-strategy-critic.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): port + FakeStrategyCritic adapter"`

---

### Task 3: Mastra agents (critic / refiner / combined)

**Files:**
- Create `src/mastra/agents/strategy-critic.agent.ts`
- Create `src/mastra/agents/strategy-refiner.agent.ts`
- Create `src/mastra/agents/strategy-critic-combined.agent.ts`
- Test `src/mastra/agents/strategy-critic.agent.test.ts`

**Interfaces:**
- Consumes: `Agent` (value) from `@mastra/core/agent` (allowed under `src/mastra/**`); `ProviderModel` (type) from `../../adapters/llm/model-provider.ts`.
- Produces: `STRATEGY_CRITIC_AGENT_ID` + `createStrategyCriticAgent`; `STRATEGY_REFINER_AGENT_ID` + `createStrategyRefinerAgent`; `STRATEGY_CRITIC_COMBINED_AGENT_ID` + `createStrategyCriticCombinedAgent`.

- [ ] **Step 1: Write the failing test** — `src/mastra/agents/strategy-critic.agent.test.ts` (mirrors the analyst construction case)

```ts
import { describe, it, expect } from 'vitest';
import { resolveLanguageModel } from '../../adapters/llm/model-provider.ts';
import { createStrategyCriticAgent, STRATEGY_CRITIC_AGENT_ID } from './strategy-critic.agent.ts';
import { createStrategyRefinerAgent, STRATEGY_REFINER_AGENT_ID } from './strategy-refiner.agent.ts';
import { createStrategyCriticCombinedAgent, STRATEGY_CRITIC_COMBINED_AGENT_ID } from './strategy-critic-combined.agent.ts';

const { model } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');

describe('strategy-critic agents (construction)', () => {
  it('builds the critic agent with its id + name', () => {
    expect(STRATEGY_CRITIC_AGENT_ID).toBe('strategy-critic');
    expect(createStrategyCriticAgent(model).name).toBe('Strategy Critic');
  });
  it('builds the refiner agent with its id + name', () => {
    expect(STRATEGY_REFINER_AGENT_ID).toBe('strategy-refiner');
    expect(createStrategyRefinerAgent(model).name).toBe('Strategy Refiner');
  });
  it('builds the combined agent with its id + name', () => {
    expect(STRATEGY_CRITIC_COMBINED_AGENT_ID).toBe('strategy-critic-combined');
    expect(createStrategyCriticCombinedAgent(model).name).toBe('Strategy Critic (combined)');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/mastra/agents/strategy-critic.agent.test.ts`
  Expected: `Failed to resolve import "./strategy-critic.agent.ts"`.

- [ ] **Step 3: Minimal implementation**

`src/mastra/agents/strategy-critic.agent.ts` (critique-only "ruthless market opponent"):

```ts
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_CRITIC_AGENT_ID = 'strategy-critic';

const INSTRUCTIONS = [
  'You are a ruthless market opponent reviewing a trading-strategy idea. Your only job is to ATTACK the idea —',
  'never to rewrite it, never to give trade advice, never to invent facts.',
  'Find 5 to 10 concrete weak points in the thesis (the `vulnerabilities`).',
  'Separate fact from interpretation: call out FOMO, an already-priced-in catalyst, and unconfirmed conviction (`selfDeception`).',
  'Categorize the risk into market, timing, news, liquidity, BTC-regime dependence, and exhaustion (`risks`).',
  'Name at most 3 earliest signs the idea is breaking (`earlyBreakSigns`).',
  'List at most 5 things to verify before entry (`preEntryChecks`).',
  'Give a terse verdict: the single main vulnerability, a severity (low/medium/high),',
  'whether this is a bad_idea or just bad_timing (or neither), and what would strengthen it (`verdict`).',
  'When data is missing, say so explicitly inside the relevant section — do not fabricate numbers.',
].join(' ');

export function createStrategyCriticAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_CRITIC_AGENT_ID, name: 'Strategy Critic', instructions: INSTRUCTIONS, model });
}
```

`src/mastra/agents/strategy-refiner.agent.ts`:

```ts
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_REFINER_AGENT_ID = 'strategy-refiner';

const INSTRUCTIONS = [
  'You are a trading-strategy refiner. You are given an original strategy description and a critic\'s findings.',
  'Rewrite the strategy DESCRIPTION so it addresses the findings — add the missing regime filter, an explicit',
  'invalidation condition, and the liquidity / BTC-dependence caveats the critic raised.',
  'Write `improvedStrategyText` in the SAME language as the input. Keep risk sizing, order execution, and fills',
  'OUT of scope — those are owned by the runner/platform; do not propose live execution.',
  'Also emit a short `changeLog` listing each change you made. Do not invent facts; if the critic flagged missing',
  'data, reflect that as an explicit caveat rather than a fabricated value.',
].join(' ');

export function createStrategyRefinerAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_REFINER_AGENT_ID, name: 'Strategy Refiner', instructions: INSTRUCTIONS, model });
}
```

`src/mastra/agents/strategy-critic-combined.agent.ts`:

```ts
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_CRITIC_COMBINED_AGENT_ID = 'strategy-critic-combined';

const INSTRUCTIONS = [
  'You are a ruthless market opponent who, in a single pass, critiques a trading-strategy idea AND produces an',
  'improved version of it. First attack the idea: find 5 to 10 weak points (`vulnerabilities`), separate fact from',
  'interpretation (`selfDeception`), categorize risk into market / timing / news / liquidity / BTC-regime / exhaustion',
  '(`risks`), name at most 3 earliest break signs (`earlyBreakSigns`), and list at most 5 pre-entry checks (`preEntryChecks`).',
  'Give a terse verdict (`verdict`): main vulnerability, severity (low/medium/high), bad_idea vs bad_timing (or neither),',
  'and what would strengthen it. Then write `improvedStrategyText` in the SAME language as the input — addressing your',
  'own findings (regime filter, invalidation condition, liquidity / BTC caveats) — plus a short `changeLog`.',
  'Risk sizing, order execution, and fills stay runner-owned. Never invent facts; flag missing data explicitly.',
].join(' ');

export function createStrategyCriticCombinedAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_CRITIC_COMBINED_AGENT_ID, name: 'Strategy Critic (combined)', instructions: INSTRUCTIONS, model });
}
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/mastra/agents/strategy-critic.agent.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): mastra critic/refiner/combined agents"`

---

### Task 4: Single-stage adapter

**Files:**
- Create `src/adapters/strategy-critic/single-stage-strategy-critic.ts`
- Test `src/adapters/strategy-critic/single-stage-strategy-critic.test.ts`

**Interfaces:**
- Consumes: `Agent` (TYPE only) from `@mastra/core/agent`; `StrategyCriticPort`, `AgentCallOpts` from `../../ports/strategy-critic.port.ts`; `StrategyRefinementSchema`, `StrategyCriticInput`, `StrategyRefinement` from `../../domain/strategy-critic.ts`.
- Produces: `class SingleStageStrategyCritic implements StrategyCriticPort` (`mode = 'single'`), ctor `(agent: Agent, model: string)`; one `agent.generate(...)` + one `onUsage`.

- [ ] **Step 1: Write the failing test** — `src/adapters/strategy-critic/single-stage-strategy-critic.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { SingleStageStrategyCritic } from './single-stage-strategy-critic.ts';
import type { AgentCallUsage } from '../../ports/agent-call-opts.ts';

const refinement = {
  vulnerabilities: ['no invalidation'],
  selfDeception: [],
  risks: { market: 'm', timing: 't', news: 'n', liquidity: 'l', btcRegime: 'b', exhaustion: 'e' },
  earlyBreakSigns: [],
  preEntryChecks: [],
  verdict: { mainVulnerability: 'v', severity: 'medium', badIdeaOrBadTiming: 'bad_timing', whatWouldStrengthen: 'add filter' },
  improvedStrategyText: 'IMPROVED',
  changeLog: ['added filter'],
};

function stubAgent(): Agent {
  return {
    generate: async () => ({ object: refinement, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }),
  } as unknown as Agent;
}

describe('SingleStageStrategyCritic', () => {
  it('reports adapter/mode/model', () => {
    const a = new SingleStageStrategyCritic(stubAgent(), 'anthropic/claude-sonnet-4-6');
    expect(a.adapter).toBe('mastra');
    expect(a.mode).toBe('single');
    expect(a.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('calls the agent once, accrues onUsage once, and returns the parsed refinement', async () => {
    const seen: AgentCallUsage[] = [];
    let calls = 0;
    const agent = {
      generate: async () => { calls += 1; return { object: refinement, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }; },
    } as unknown as Agent;
    const a = new SingleStageStrategyCritic(agent, 'anthropic/claude-sonnet-4-6');
    const out = await a.refine({ kind: 'manual_description', content: 'short after a pump' }, { onUsage: (u) => { seen.push(u); } });
    expect(calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ modelId: 'anthropic/claude-sonnet-4-6', inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    expect(out.improvedStrategyText).toBe('IMPROVED');
    expect(out.verdict.severity).toBe('medium');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/adapters/strategy-critic/single-stage-strategy-critic.test.ts`
  Expected: `Failed to resolve import "./single-stage-strategy-critic.ts"`.

- [ ] **Step 3: Minimal implementation** — `src/adapters/strategy-critic/single-stage-strategy-critic.ts`

```ts
import type { Agent } from '@mastra/core/agent';
import type { StrategyCriticPort, AgentCallOpts } from '../../ports/strategy-critic.port.ts';
import {
  StrategyRefinementSchema,
  type StrategyCriticInput,
  type StrategyRefinement,
} from '../../domain/strategy-critic.ts';

function buildPrompt(input: StrategyCriticInput): string {
  const header =
    `Source kind: ${input.kind}` +
    (input.title ? `\nTitle: ${input.title}` : '') +
    (input.uri ? `\nURI: ${input.uri}` : '');
  return `${header}\n\n--- STRATEGY START ---\n${input.content}\n--- STRATEGY END ---\n\nCritique this strategy AND return an improved version.`;
}

export class SingleStageStrategyCritic implements StrategyCriticPort {
  readonly adapter = 'mastra' as const;
  readonly mode = 'single' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, model: string) {
    this.agent = agent;
    this.model = model;
  }

  async refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: StrategyRefinementSchema },
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
    return StrategyRefinementSchema.parse(result.object);
  }
}
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/adapters/strategy-critic/single-stage-strategy-critic.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): single-stage mastra adapter"`

---

### Task 5: Two-stage adapter

**Files:**
- Create `src/adapters/strategy-critic/two-stage-strategy-critic.ts`
- Test `src/adapters/strategy-critic/two-stage-strategy-critic.test.ts`

**Interfaces:**
- Consumes: `Agent` (TYPE only) from `@mastra/core/agent`; `StrategyCriticPort`, `AgentCallOpts`; `StrategyCritiqueSchema`, `StrategyRefinementSchema`, `StrategyCriticInput`, `StrategyCritique`, `StrategyRefinement` from `../../domain/strategy-critic.ts`; `z` from `zod`.
- Produces: `class TwoStageStrategyCritic implements StrategyCriticPort` (`mode = 'two_stage'`), ctor `(criticAgent: Agent, refinerAgent: Agent, criticModel: string, refinerModel: string)`. critic.generate → onUsage (critic model) → refiner.generate → onUsage (refiner model) → assemble.

- [ ] **Step 1: Write the failing test** — `src/adapters/strategy-critic/two-stage-strategy-critic.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { TwoStageStrategyCritic } from './two-stage-strategy-critic.ts';
import type { AgentCallUsage } from '../../ports/agent-call-opts.ts';

const critique = {
  vulnerabilities: ['no invalidation'],
  selfDeception: ['FOMO'],
  risks: { market: 'm', timing: 't', news: 'n', liquidity: 'l', btcRegime: 'b', exhaustion: 'e' },
  earlyBreakSigns: ['funding flip'],
  preEntryChecks: ['confirm OI'],
  verdict: { mainVulnerability: 'no stop', severity: 'high', badIdeaOrBadTiming: 'bad_timing', whatWouldStrengthen: 'add a regime filter' },
};
const delta = { improvedStrategyText: 'IMPROVED TEXT', changeLog: ['added regime filter', 'added invalidation'] };

describe('TwoStageStrategyCritic', () => {
  it('calls BOTH agents, accrues onUsage twice, and assembles the refinement', async () => {
    const seen: AgentCallUsage[] = [];
    let criticCalls = 0;
    let refinerCalls = 0;
    const criticAgent = {
      generate: async () => { criticCalls += 1; return { object: critique, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; },
    } as unknown as Agent;
    const refinerAgent = {
      generate: async () => { refinerCalls += 1; return { object: delta, usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } }; },
    } as unknown as Agent;

    const a = new TwoStageStrategyCritic(criticAgent, refinerAgent, 'critic-model', 'refiner-model');
    expect(a.mode).toBe('two_stage');
    const out = await a.refine({ kind: 'manual_description', content: 'short after a pump' }, { onUsage: (u) => { seen.push(u); } });

    expect(criticCalls).toBe(1);
    expect(refinerCalls).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.totalTokens).toBe(15);
    expect(seen[1]?.totalTokens).toBe(12);
    // each stage must report its OWN model id (refiner tokens must NOT be billed to the critic model)
    expect(seen[0]?.modelId).toBe('critic-model');
    expect(seen[1]?.modelId).toBe('refiner-model');
    expect(out.verdict.mainVulnerability).toBe('no stop'); // from the critique stage
    expect(out.improvedStrategyText).toBe('IMPROVED TEXT'); // from the refiner stage
    expect(out.changeLog).toEqual(['added regime filter', 'added invalidation']);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/adapters/strategy-critic/two-stage-strategy-critic.test.ts`
  Expected: `Failed to resolve import "./two-stage-strategy-critic.ts"`.

- [ ] **Step 3: Minimal implementation** — `src/adapters/strategy-critic/two-stage-strategy-critic.ts`

```ts
import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import type { StrategyCriticPort, AgentCallOpts } from '../../ports/strategy-critic.port.ts';
import {
  StrategyCritiqueSchema,
  StrategyRefinementSchema,
  type StrategyCriticInput,
  type StrategyCritique,
  type StrategyRefinement,
} from '../../domain/strategy-critic.ts';

const RefinementDeltaSchema = z.object({
  improvedStrategyText: z.string(),
  changeLog: z.array(z.string()).optional(),
});

function buildCritiquePrompt(input: StrategyCriticInput): string {
  const header =
    `Source kind: ${input.kind}` +
    (input.title ? `\nTitle: ${input.title}` : '') +
    (input.uri ? `\nURI: ${input.uri}` : '');
  return `${header}\n\n--- STRATEGY START ---\n${input.content}\n--- STRATEGY END ---\n\nCritique this strategy. Do not rewrite it.`;
}

function buildRefinePrompt(input: StrategyCriticInput, critique: StrategyCritique): string {
  return [
    '--- ORIGINAL STRATEGY START ---',
    input.content,
    '--- ORIGINAL STRATEGY END ---',
    '',
    '--- CRITIC FINDINGS (JSON) ---',
    JSON.stringify(critique),
    '--- END FINDINGS ---',
    '',
    'Rewrite the strategy description to address the findings and return improvedStrategyText + changeLog.',
  ].join('\n');
}

export class TwoStageStrategyCritic implements StrategyCriticPort {
  readonly adapter = 'mastra' as const;
  readonly mode = 'two_stage' as const;
  readonly model: string;
  private readonly criticAgent: Agent;
  private readonly refinerAgent: Agent;
  private readonly refinerModel: string;

  constructor(criticAgent: Agent, refinerAgent: Agent, criticModel: string, refinerModel: string) {
    this.criticAgent = criticAgent;
    this.refinerAgent = refinerAgent;
    this.model = criticModel;
    this.refinerModel = refinerModel;
  }

  async refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement> {
    const critiqueResult = await this.criticAgent.generate(buildCritiquePrompt(input), {
      structuredOutput: { schema: StrategyCritiqueSchema },
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: critiqueResult.usage?.inputTokens ?? 0,
      outputTokens: critiqueResult.usage?.outputTokens ?? 0,
      totalTokens: critiqueResult.usage?.totalTokens ?? 0,
    });
    const critique = StrategyCritiqueSchema.parse(critiqueResult.object);

    const refineResult = await this.refinerAgent.generate(buildRefinePrompt(input, critique), {
      structuredOutput: { schema: RefinementDeltaSchema },
    });
    await opts?.onUsage?.({
      modelId: this.refinerModel,
      inputTokens: refineResult.usage?.inputTokens ?? 0,
      outputTokens: refineResult.usage?.outputTokens ?? 0,
      totalTokens: refineResult.usage?.totalTokens ?? 0,
    });
    const delta = RefinementDeltaSchema.parse(refineResult.object);

    return StrategyRefinementSchema.parse({
      ...critique,
      improvedStrategyText: delta.improvedStrategyText,
      ...(delta.changeLog !== undefined ? { changeLog: delta.changeLog } : {}),
    });
  }
}
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/adapters/strategy-critic/two-stage-strategy-critic.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): two-stage mastra adapter (critic → refiner)"`

---

### Task 6: env wiring

**Files:**
- Modify `src/config/env.ts`
- Modify `.env.example`
- Modify `docker-compose.yml` (ingress + worker)
- Test `src/config/env.test.ts` (append)

**Interfaces:**
- Produces (on `Env`): `STRATEGY_PREFLIGHT_CRITIQUE: boolean`, `STRATEGY_CRITIC_ADAPTER: 'fake' | 'mastra'`, `STRATEGY_CRITIC_MODE: 'single' | 'two_stage'`, `STRATEGY_CRITIC_MODEL: string`, `STRATEGY_REFINER_MODEL: string`.
- Defaults: `false`, `'fake'`, `'two_stage'`, `'anthropic/claude-sonnet-4-6'`, `STRATEGY_REFINER_MODEL ?? STRATEGY_CRITIC_MODEL`.

- [ ] **Step 1: Write the failing test** — append to `src/config/env.test.ts`

```ts
describe('pre-flight strategy critic env', () => {
  it('defaults the critic OFF with fake adapter + two_stage mode + sane models', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.STRATEGY_PREFLIGHT_CRITIQUE).toBe(false);
    expect(env.STRATEGY_CRITIC_ADAPTER).toBe('fake');
    expect(env.STRATEGY_CRITIC_MODE).toBe('two_stage');
    expect(env.STRATEGY_CRITIC_MODEL).toBe('anthropic/claude-sonnet-4-6');
    expect(env.STRATEGY_REFINER_MODEL).toBe('anthropic/claude-sonnet-4-6'); // defaults to critic model
  });

  it('reads overrides; refiner model defaults to the critic model when unset', () => {
    const env = loadEnv({
      STRATEGY_PREFLIGHT_CRITIQUE: 'true',
      STRATEGY_CRITIC_ADAPTER: 'mastra',
      STRATEGY_CRITIC_MODE: 'single',
      STRATEGY_CRITIC_MODEL: 'openrouter/x-ai/grok-4.3',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.STRATEGY_PREFLIGHT_CRITIQUE).toBe(true);
    expect(env.STRATEGY_CRITIC_ADAPTER).toBe('mastra');
    expect(env.STRATEGY_CRITIC_MODE).toBe('single');
    expect(env.STRATEGY_CRITIC_MODEL).toBe('openrouter/x-ai/grok-4.3');
    expect(env.STRATEGY_REFINER_MODEL).toBe('openrouter/x-ai/grok-4.3'); // inherits critic model
  });

  it('reads an explicit refiner model and treats non-true / non-enum values as defaults', () => {
    const env = loadEnv({
      STRATEGY_PREFLIGHT_CRITIQUE: '1',
      STRATEGY_CRITIC_ADAPTER: 'bogus',
      STRATEGY_CRITIC_MODE: 'bogus',
      STRATEGY_REFINER_MODEL: 'openrouter/google/gemini-3.5-flash',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.STRATEGY_PREFLIGHT_CRITIQUE).toBe(false); // only 'true' enables
    expect(env.STRATEGY_CRITIC_ADAPTER).toBe('fake'); // non-'mastra' -> fake
    expect(env.STRATEGY_CRITIC_MODE).toBe('two_stage'); // non-'single' -> two_stage
    expect(env.STRATEGY_REFINER_MODEL).toBe('openrouter/google/gemini-3.5-flash');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/config/env.test.ts`
  Expected: `expected undefined to be false` (the new `Env` keys are not populated yet).

- [ ] **Step 3: Minimal implementation**

In `src/config/env.ts`, add to the `Env` interface (e.g. just after `RESEARCH_TASK_TOKEN_BUDGET: number;`):

```ts
  /** Feature flag: run the pre-flight strategy critic before the analyst (default: false). */
  STRATEGY_PREFLIGHT_CRITIQUE: boolean;
  /** Strategy-critic adapter: 'fake' (default, key-free) or 'mastra' (real LLM). */
  STRATEGY_CRITIC_ADAPTER: 'fake' | 'mastra';
  /** Critic mode: 'two_stage' (default; critic agent → refiner agent) or 'single' (one combined agent). */
  STRATEGY_CRITIC_MODE: 'single' | 'two_stage';
  /** Model for the critic / combined agent. */
  STRATEGY_CRITIC_MODEL: string;
  /** Model for the two_stage refiner agent; defaults to STRATEGY_CRITIC_MODEL when unset. */
  STRATEGY_REFINER_MODEL: string;
```

In `loadEnv`, add a `const` before the `return` (alongside `agentsDefault` / `resolveAdapter`):

```ts
  const strategyCriticModel = source.STRATEGY_CRITIC_MODEL ?? 'anthropic/claude-sonnet-4-6';
```

and add to the returned object literal (e.g. just after `RESEARCH_TASK_TOKEN_BUDGET: ...,`):

```ts
    STRATEGY_PREFLIGHT_CRITIQUE: source.STRATEGY_PREFLIGHT_CRITIQUE === 'true',
    STRATEGY_CRITIC_ADAPTER: source.STRATEGY_CRITIC_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    STRATEGY_CRITIC_MODE: source.STRATEGY_CRITIC_MODE === 'single' ? 'single' : 'two_stage',
    STRATEGY_CRITIC_MODEL: strategyCriticModel,
    STRATEGY_REFINER_MODEL: source.STRATEGY_REFINER_MODEL ?? strategyCriticModel,
```

In `.env.example`, append a section (mirrors the PHOENIX_* block):

```
# --- Pre-flight Strategy Critic (off by default; zero behavior change) ---
# When enabled, a "ruthless market opponent" critiques a NEW strategy's raw text and the analyst
# then profiles the IMPROVED text. A critic failure never blocks onboarding (fail-soft).
STRATEGY_PREFLIGHT_CRITIQUE=false
STRATEGY_CRITIC_ADAPTER=fake          # fake | mastra
STRATEGY_CRITIC_MODE=two_stage        # two_stage (critic→refiner, 2 LLM calls) | single (1 combined call)
STRATEGY_CRITIC_MODEL=anthropic/claude-sonnet-4-6
# Refiner model (two_stage only); defaults to STRATEGY_CRITIC_MODEL when left blank.
STRATEGY_REFINER_MODEL=
```

In `docker-compose.yml`, add the passthrough block to BOTH the `ingress` and `worker` `environment:` maps (next to the PHOENIX_* lines):

```yaml
      # Pre-flight strategy critic (off by default; zero behavior change).
      STRATEGY_PREFLIGHT_CRITIQUE: ${STRATEGY_PREFLIGHT_CRITIQUE:-false}
      STRATEGY_CRITIC_ADAPTER: ${STRATEGY_CRITIC_ADAPTER:-fake}
      STRATEGY_CRITIC_MODE: ${STRATEGY_CRITIC_MODE:-two_stage}
      STRATEGY_CRITIC_MODEL: ${STRATEGY_CRITIC_MODEL:-anthropic/claude-sonnet-4-6}
      STRATEGY_REFINER_MODEL: ${STRATEGY_REFINER_MODEL:-}
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/config/env.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): env flags + .env.example + docker-compose passthrough"`

---

### Task 7: compose-mastra registration

**Files:**
- Modify `src/mastra/compose-mastra.ts`
- Test `src/mastra/compose-mastra.test.ts` (extend `base` + add cases)

**Interfaces:**
- Consumes: the three `create*Agent` factories + `*_AGENT_ID` consts from Task 3.
- Produces (on `MastraCompositionEnv`): `STRATEGY_CRITIC_ADAPTER: 'fake' | 'mastra'`, `STRATEGY_CRITIC_MODE: 'single' | 'two_stage'`, `STRATEGY_CRITIC_MODEL: string`, `STRATEGY_REFINER_MODEL: string`. On `MastraRuntime.agents`: optional `strategyCritic`, `strategyRefiner`, `strategyCriticCombined: MastraAgentEntry`.

- [ ] **Step 1: Write the failing test** — extend `src/mastra/compose-mastra.test.ts`

Add the four fields to the existing `base` const:

```ts
  STRATEGY_CRITIC_ADAPTER: 'fake', STRATEGY_CRITIC_MODE: 'two_stage',
  STRATEGY_CRITIC_MODEL: 'anthropic/claude-sonnet-4-6', STRATEGY_REFINER_MODEL: 'anthropic/claude-sonnet-4-6',
```

Add a new describe block:

```ts
describe('composeMastra — strategy critic agents', () => {
  it('registers no strategy-critic agents when the adapter is fake', () => {
    const rt = composeMastra(base);
    expect(rt.agents.strategyCritic).toBeUndefined();
    expect(rt.agents.strategyRefiner).toBeUndefined();
    expect(rt.agents.strategyCriticCombined).toBeUndefined();
  });

  it('two_stage + mastra builds the critic + refiner (not the combined)', () => {
    const rt = composeMastra({ ...base, STRATEGY_CRITIC_ADAPTER: 'mastra', STRATEGY_CRITIC_MODE: 'two_stage',
      STRATEGY_REFINER_MODEL: 'openrouter/google/gemini-3.5-flash' });
    expect(rt.agents.strategyCritic?.agent.name).toBe('Strategy Critic');
    expect(rt.agents.strategyRefiner?.agent.name).toBe('Strategy Refiner');
    expect(rt.agents.strategyRefiner?.label).toContain('gemini-3.5-flash');
    expect(rt.agents.strategyCriticCombined).toBeUndefined();
  });

  it('single + mastra builds only the combined agent', () => {
    const rt = composeMastra({ ...base, STRATEGY_CRITIC_ADAPTER: 'mastra', STRATEGY_CRITIC_MODE: 'single' });
    expect(rt.agents.strategyCriticCombined?.agent.name).toBe('Strategy Critic (combined)');
    expect(rt.agents.strategyCritic).toBeUndefined();
    expect(rt.agents.strategyRefiner).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/mastra/compose-mastra.test.ts`
  Expected: FAIL — `expected undefined to be 'Strategy Critic'` (the two_stage test; `rt.agents.strategyCritic` is undefined until the agent is registered).

- [ ] **Step 3: Minimal implementation** — `src/mastra/compose-mastra.ts`

Add imports near the other agent factory imports:

```ts
import { createStrategyCriticAgent, STRATEGY_CRITIC_AGENT_ID } from './agents/strategy-critic.agent.ts';
import { createStrategyRefinerAgent, STRATEGY_REFINER_AGENT_ID } from './agents/strategy-refiner.agent.ts';
import { createStrategyCriticCombinedAgent, STRATEGY_CRITIC_COMBINED_AGENT_ID } from './agents/strategy-critic-combined.agent.ts';
```

Extend `MastraCompositionEnv` (add after `BUILDER_MODEL: string;`):

```ts
  STRATEGY_CRITIC_ADAPTER: 'fake' | 'mastra';
  STRATEGY_CRITIC_MODE: 'single' | 'two_stage';
  STRATEGY_CRITIC_MODEL: string;
  STRATEGY_REFINER_MODEL: string;
```

Extend `MastraRuntime.agents` (add after `turnInterpreter?: MastraAgentEntry;`):

```ts
    strategyCritic?: MastraAgentEntry;
    strategyRefiner?: MastraAgentEntry;
    strategyCriticCombined?: MastraAgentEntry;
```

In `composeMastra`, after the existing `build(...)` calls and before `const observability = ...`:

```ts
  if (env.STRATEGY_CRITIC_ADAPTER === 'mastra') {
    if (env.STRATEGY_CRITIC_MODE === 'two_stage') {
      build(STRATEGY_CRITIC_AGENT_ID, env.STRATEGY_CRITIC_MODEL, createStrategyCriticAgent);
      build(STRATEGY_REFINER_AGENT_ID, env.STRATEGY_REFINER_MODEL, createStrategyRefinerAgent);
    } else {
      build(STRATEGY_CRITIC_COMBINED_AGENT_ID, env.STRATEGY_CRITIC_MODEL, createStrategyCriticCombinedAgent);
    }
  }
```

In the returned `agents` map (add after `turnInterpreter: entry(TURN_INTERPRETER_AGENT_ID),`):

```ts
      strategyCritic: entry(STRATEGY_CRITIC_AGENT_ID),
      strategyRefiner: entry(STRATEGY_REFINER_AGENT_ID),
      strategyCriticCombined: entry(STRATEGY_CRITIC_COMBINED_AGENT_ID),
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/mastra/compose-mastra.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): register critic/refiner/combined agents in composeMastra"`

---

### Task 8: makeOnUsage extraction (behavior-preserving)

**Files:**
- Create `src/orchestrator/make-on-usage.ts`
- Modify `src/orchestrator/handlers/research-run-cycle.handler.ts` (2 call sites)
- Modify `src/orchestrator/handlers/hypothesis-build.handler.ts` (1 call site)
- Test `src/orchestrator/make-on-usage.test.ts`
- Regression: `research-run-cycle.handler.test.ts`, `hypothesis-build.handler.test.ts` (must stay green)

**Interfaces:**
- Consumes: `ResearchTask` from `../domain/types.ts`; `AppServices` from `./app-services.ts`; `AgentCallOpts` from `../ports/agent-call-opts.ts`.
- Produces: `function makeOnUsage(task: ResearchTask, services: AppServices): AgentCallOpts` — the verbatim-equivalent of the inline `onUsage` block (price lookup → `addCost`, null price → `research.cost_unpriced` event, plus `add` for tokens).

- [ ] **Step 1: Write the failing test** — `src/orchestrator/make-on-usage.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { makeOnUsage } from './make-on-usage.ts';
import { makeServices } from '../../test/support/make-services.ts';
import type { ResearchTask } from '../domain/types.ts';
import type { ModelPricingPort } from '../ports/model-pricing.port.ts';

const task = (): ResearchTask => ({
  id: 'task-1', taskType: 'research.run_cycle', source: 'web', correlationId: 'corr-1',
  status: 'running', payload: {}, createdAt: '2026-06-26T00:00:00Z', updatedAt: '2026-06-26T00:00:00Z',
});

describe('makeOnUsage', () => {
  it('adds tokens and accrues $ cost when the model is priced', async () => {
    const pricing: ModelPricingPort = { priceFor: async () => ({ inputUsdPerToken: 0.001, outputUsdPerToken: 0.002 }) };
    const services = makeServices({ modelPricing: pricing });
    const opts = makeOnUsage(task(), services);
    await opts.onUsage?.({ modelId: 'm1', inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(await services.tokenUsage.get('corr-1')).toBe(15);
    expect(await services.tokenUsage.getCost('corr-1')).toBeCloseTo(10 * 0.001 + 5 * 0.002, 10);
  });

  it('emits research.cost_unpriced when the model has no price', async () => {
    const pricing: ModelPricingPort = { priceFor: async () => null };
    const services = makeServices({ modelPricing: pricing });
    const opts = makeOnUsage(task(), services);
    await opts.onUsage?.({ modelId: 'unpriced-model', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toContain('research.cost_unpriced');
    expect(await services.tokenUsage.get('corr-1')).toBe(2);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/orchestrator/make-on-usage.test.ts`
  Expected: `Failed to resolve import "./make-on-usage.ts"`.

- [ ] **Step 3: Minimal implementation** — `src/orchestrator/make-on-usage.ts`

```ts
import { randomUUID } from 'node:crypto';
import type { AgentCallOpts } from '../ports/agent-call-opts.ts';
import type { AppServices } from './app-services.ts';
import type { ResearchTask } from '../domain/types.ts';

/**
 * Shared per-call cost/token accrual hook. Extracted verbatim-equivalent from the inline
 * onUsage blocks in research-run-cycle / hypothesis-build: add tokens, look up the model
 * price, accrue $ cost when priced, else emit a research.cost_unpriced audit event.
 */
export function makeOnUsage(task: ResearchTask, services: AppServices): AgentCallOpts {
  return {
    onUsage: async (u) => {
      await services.tokenUsage.add(task.correlationId, u.totalTokens);
      const price = await services.modelPricing.priceFor(u.modelId);
      if (price) {
        await services.tokenUsage.addCost(
          task.correlationId,
          u.inputTokens * price.inputUsdPerToken + u.outputTokens * price.outputUsdPerToken,
        );
      } else {
        await services.events.append({
          id: randomUUID(), taskId: task.id, type: 'research.cost_unpriced',
          payload: { modelId: u.modelId }, createdAt: new Date().toISOString(),
        });
      }
    },
  };
}
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/orchestrator/make-on-usage.test.ts`

- [ ] **Step 5: Refactor the existing call sites onto `makeOnUsage`**

In `src/orchestrator/handlers/research-run-cycle.handler.ts`, add the import:

```ts
import { makeOnUsage } from '../make-on-usage.ts';
```

Replace the `researcher.propose` options argument — change:

```ts
    }, {
      onUsage: async (u) => {
        await services.tokenUsage.add(task.correlationId, u.totalTokens);
        const price = await services.modelPricing.priceFor(u.modelId);
        if (price) {
          await services.tokenUsage.addCost(
            task.correlationId,
            u.inputTokens * price.inputUsdPerToken + u.outputTokens * price.outputUsdPerToken,
          );
        } else {
          await services.events.append(event(task.id, 'research.cost_unpriced', { modelId: u.modelId }));
        }
      },
    });
```

to:

```ts
    }, makeOnUsage(task, services));
```

Replace the `critic.review` options argument — change:

```ts
            {
              onUsage: async (u) => {
                await services.tokenUsage.add(task.correlationId, u.totalTokens);
                const price = await services.modelPricing.priceFor(u.modelId);
                if (price) {
                  await services.tokenUsage.addCost(
                    task.correlationId,
                    u.inputTokens * price.inputUsdPerToken + u.outputTokens * price.outputUsdPerToken,
                  );
                } else {
                  await services.events.append(event(task.id, 'research.cost_unpriced', { modelId: u.modelId }));
                }
              },
            },
          );
```

to:

```ts
            makeOnUsage(task, services),
          );
```

In `src/orchestrator/handlers/hypothesis-build.handler.ts`, add the import:

```ts
import { makeOnUsage } from '../make-on-usage.ts';
```

Replace the `builder.build` options argument — change:

```ts
      {
        onUsage: async (u) => {
          await services.tokenUsage.add(task.correlationId, u.totalTokens);
          const price = await services.modelPricing.priceFor(u.modelId);
          if (price) {
            await services.tokenUsage.addCost(
              task.correlationId,
              u.inputTokens * price.inputUsdPerToken + u.outputTokens * price.outputUsdPerToken,
            );
          } else {
            await services.events.append(event(task.id, 'research.cost_unpriced', { modelId: u.modelId }));
          }
        },
      },
    );
```

to:

```ts
      makeOnUsage(task, services),
    );
```

- [ ] **Step 6: Run regression, expect PASS** — `pnpm vitest run src/orchestrator/make-on-usage.test.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts src/orchestrator/handlers/hypothesis-build.handler.test.ts`
- [ ] **Step 7: Commit** — `git commit -m "refactor(cost): extract makeOnUsage; research-run-cycle + hypothesis-build onto it (behavior-preserving)"`

---

### Task 9: composition `buildStrategyCritic` + AppServices

**Files:**
- Modify `src/orchestrator/app-services.ts`
- Modify `test/support/make-services.ts`
- Modify `src/composition.ts`
- Test `src/composition.strategy-critic.test.ts`

**Interfaces:**
- Consumes: `StrategyCriticPort`; the three adapters; `loadEnv` env; `MastraRuntime`.
- Produces: `AppServices.strategyCritic: StrategyCriticPort | null`; `function buildStrategyCritic(env: ReturnType<typeof loadEnv>, rt: MastraRuntime): StrategyCriticPort | null`.

- [ ] **Step 1: Write the failing test** — `src/composition.strategy-critic.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildStrategyCritic } from './composition.ts';
import { loadEnv } from './config/env.ts';
import { composeMastra } from './mastra/compose-mastra.ts';

function envWith(over: Record<string, string>) {
  return loadEnv({ ...over } as unknown as NodeJS.ProcessEnv);
}

describe('buildStrategyCritic', () => {
  it('returns null when STRATEGY_PREFLIGHT_CRITIQUE is false (default)', () => {
    const env = envWith({});
    expect(buildStrategyCritic(env, composeMastra(env))).toBeNull();
  });

  it('returns a fake critic carrying the configured mode when enabled with the fake adapter', () => {
    const env = envWith({ STRATEGY_PREFLIGHT_CRITIQUE: 'true', STRATEGY_CRITIC_ADAPTER: 'fake', STRATEGY_CRITIC_MODE: 'single' });
    const c = buildStrategyCritic(env, composeMastra(env));
    expect(c?.adapter).toBe('fake');
    expect(c?.mode).toBe('single');
  });

  it('builds a two-stage mastra critic when enabled with adapter=mastra + two_stage', () => {
    const env = envWith({
      STRATEGY_PREFLIGHT_CRITIQUE: 'true', STRATEGY_CRITIC_ADAPTER: 'mastra', STRATEGY_CRITIC_MODE: 'two_stage',
      MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy',
    });
    const c = buildStrategyCritic(env, composeMastra(env));
    expect(c?.adapter).toBe('mastra');
    expect(c?.mode).toBe('two_stage');
  });

  it('builds a single-stage mastra critic when enabled with adapter=mastra + single', () => {
    const env = envWith({
      STRATEGY_PREFLIGHT_CRITIQUE: 'true', STRATEGY_CRITIC_ADAPTER: 'mastra', STRATEGY_CRITIC_MODE: 'single',
      MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy',
    });
    const c = buildStrategyCritic(env, composeMastra(env));
    expect(c?.adapter).toBe('mastra');
    expect(c?.mode).toBe('single');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/composition.strategy-critic.test.ts`
  Expected: `buildStrategyCritic is not a function` / no matching export.

- [ ] **Step 3: Minimal implementation**

In `src/orchestrator/app-services.ts`, add the import:

```ts
import type { StrategyCriticPort } from '../ports/strategy-critic.port.ts';
```

and add to the `AppServices` interface (next to `critic: CriticPort | null;`):

```ts
  /** Pre-flight strategy critic; null when STRATEGY_PREFLIGHT_CRITIQUE=false. */
  strategyCritic: StrategyCriticPort | null;
```

In `test/support/make-services.ts`, add to the returned object (next to `critic: null,`):

```ts
    strategyCritic: null, // base happy-path skips the pre-flight critic; tests opt in via overrides
```

In `src/composition.ts`, add the imports:

```ts
import type { StrategyCriticPort } from './ports/strategy-critic.port.ts';
import { FakeStrategyCritic } from './adapters/strategy-critic/fake-strategy-critic.ts';
import { SingleStageStrategyCritic } from './adapters/strategy-critic/single-stage-strategy-critic.ts';
import { TwoStageStrategyCritic } from './adapters/strategy-critic/two-stage-strategy-critic.ts';
```

Add the builder (export it; near `buildCritic`):

```ts
export function buildStrategyCritic(env: ReturnType<typeof loadEnv>, rt: MastraRuntime): StrategyCriticPort | null {
  if (!env.STRATEGY_PREFLIGHT_CRITIQUE) return null;
  if (env.STRATEGY_CRITIC_ADAPTER === 'mastra') {
    if (env.STRATEGY_CRITIC_MODE === 'two_stage') {
      const critic = rt.agents.strategyCritic;
      const refiner = rt.agents.strategyRefiner;
      if (critic && refiner) return new TwoStageStrategyCritic(critic.agent, refiner.agent, critic.label, refiner.label);
      console.warn('[composition] STRATEGY_CRITIC_ADAPTER=mastra (two_stage) but agents missing; using FakeStrategyCritic');
      return new FakeStrategyCritic('two_stage');
    }
    const combined = rt.agents.strategyCriticCombined;
    if (combined) return new SingleStageStrategyCritic(combined.agent, combined.label);
    console.warn('[composition] STRATEGY_CRITIC_ADAPTER=mastra (single) but agent missing; using FakeStrategyCritic');
    return new FakeStrategyCritic('single');
  }
  return new FakeStrategyCritic(env.STRATEGY_CRITIC_MODE);
}
```

Wire it into `composeRuntime`'s `services` object (next to `critic: buildCritic(env, mastraRuntime),`):

```ts
    strategyCritic: buildStrategyCritic(env, mastraRuntime),
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/composition.strategy-critic.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): buildStrategyCritic + AppServices.strategyCritic wiring"`

---

### Task 10: handler integration (strategy-onboard pre-flight step)

**Files:**
- Modify `src/orchestrator/handlers/strategy-onboard.handler.ts`
- Test `src/orchestrator/handlers/strategy-onboard.handler.test.ts` (append cases)

**Interfaces:**
- Consumes: `services.strategyCritic` (`StrategyCriticPort | null`); `makeOnUsage`; `services.artifacts.put`; `services.events.append`.
- Produces (events): `strategy_critic.started { mode, model }`; `strategy_critic.completed { mode, severity, badIdeaOrBadTiming, mainVulnerability, critiqueRef }`; `strategy_critic.failed { error }`. Side effect: `strategy_critique` artifact. The analyst receives `improvedStrategyText` on success, the ORIGINAL `input` on skip/failure.

- [ ] **Step 1: Write the failing tests** — append to `src/orchestrator/handlers/strategy-onboard.handler.test.ts`

```ts
import type { StrategyCriticPort } from '../../ports/strategy-critic.port.ts';
import type { StrategyRefinement } from '../../domain/strategy-critic.ts';

const cannedRefinement = (improved: string): StrategyRefinement => ({
  vulnerabilities: ['no invalidation'],
  selfDeception: [],
  risks: { market: 'm', timing: 't', news: 'n', liquidity: 'l', btcRegime: 'b', exhaustion: 'e' },
  earlyBreakSigns: [],
  preEntryChecks: [],
  verdict: { mainVulnerability: 'no stop', severity: 'high', badIdeaOrBadTiming: 'bad_timing', whatWouldStrengthen: 'add a filter' },
  improvedStrategyText: improved,
  changeLog: ['added a regime filter'],
});

function spyAnalyst(): { analyst: StrategyAnalystPort; seen: string[] } {
  const seen: string[] = [];
  const analyst: StrategyAnalystPort = {
    adapter: 'fake', model: 'fake',
    analyze: async (input) => { seen.push(input.content); return new FakeStrategyAnalyst().analyze(input); },
  };
  return { analyst, seen };
}

describe('strategyOnboardHandler — pre-flight critic', () => {
  it('flag off (strategyCritic null): no critic events, analyst sees the original text', async () => {
    const { analyst, seen } = spyAnalyst();
    const services = makeServices({ analyst }); // strategyCritic defaults to null
    await strategyOnboardHandler(task(validPayload), services);
    expect(seen).toEqual([validPayload.content]);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).not.toContain('strategy_critic.started');
    expect(types).not.toContain('strategy_critic.completed');
  });

  it('flag on: emits started+completed, stores the critique artifact, analyst sees improvedStrategyText', async () => {
    const { analyst, seen } = spyAnalyst();
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async (input) => cannedRefinement(`IMPROVED: ${input.content}`),
    };
    const services = makeServices({ analyst, strategyCritic: critic });
    await strategyOnboardHandler(task(validPayload), services);
    expect(seen).toEqual([`IMPROVED: ${validPayload.content}`]);
    const evts = await services.events.listByTask('task-1');
    const types = evts.map((e) => e.type);
    expect(types).toContain('strategy_critic.started');
    expect(types).toContain('strategy_critic.completed');
    const completed = evts.find((e) => e.type === 'strategy_critic.completed');
    const pl = completed?.payload as Record<string, unknown>;
    expect(pl.mode).toBe('two_stage');
    expect(pl.severity).toBe('high');
    expect(pl.badIdeaOrBadTiming).toBe('bad_timing');
    expect(pl.mainVulnerability).toBe('no stop');
    expect(typeof pl.critiqueRef).toBe('string');
  });

  it('critic throws: emits strategy_critic.failed and the analyst sees the ORIGINAL text (fail-soft)', async () => {
    const { analyst, seen } = spyAnalyst();
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async () => { throw new Error('critic exploded'); },
    };
    const services = makeServices({ analyst, strategyCritic: critic });
    await strategyOnboardHandler(task(validPayload), services);
    expect(seen).toEqual([validPayload.content]); // original, not improved
    const evts = await services.events.listByTask('task-1');
    const types = evts.map((e) => e.type);
    expect(types).toContain('strategy_critic.failed');
    expect(types).not.toContain('strategy_critic.completed');
    const failed = evts.find((e) => e.type === 'strategy_critic.failed');
    expect((failed?.payload as Record<string, unknown>).error).toBe('critic exploded');
  });

  it('dedup short-circuit still skips the critic (fingerprint on the original content)', async () => {
    let refineCalls = 0;
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async (input) => { refineCalls += 1; return cannedRefinement(input.content); },
    };
    const services = makeServices({ strategyCritic: critic });
    await strategyOnboardHandler(task(validPayload), services); // first onboard
    expect(refineCalls).toBe(1);
    await strategyOnboardHandler(task(validPayload), services); // duplicate → deduped before critic
    expect(refineCalls).toBe(1);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toContain('strategy.onboard.deduped');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/orchestrator/handlers/strategy-onboard.handler.test.ts`
  Expected: the "flag on" case fails — `seen` is `['buy dips on capitulation']` not the IMPROVED text (the handler does not yet call the critic).

- [ ] **Step 3: Minimal implementation** — `src/orchestrator/handlers/strategy-onboard.handler.ts`

Add the import:

```ts
import { makeOnUsage } from '../make-on-usage.ts';
```

Insert the pre-flight block AFTER the `sourceRef` `put` and BEFORE the `auditBase` / `strategy_analyst.started` event — and feed `analyzeInput` to `analyze`:

```ts
  let analyzeInput = input;
  if (services.strategyCritic) {
    await services.events.append({
      id: randomUUID(), taskId: task.id, type: 'strategy_critic.started',
      payload: { mode: services.strategyCritic.mode, model: services.strategyCritic.model },
      createdAt: new Date().toISOString(),
    });
    try {
      const refinement = await services.strategyCritic.refine(input, makeOnUsage(task, services));
      const critiqueRef = await services.artifacts.put(JSON.stringify(refinement), {
        kind: 'strategy_critique', mime_type: 'application/json', producer: 'strategy-critic',
        metadata: { sourceKind: input.kind, mode: services.strategyCritic.mode },
      });
      await services.events.append({
        id: randomUUID(), taskId: task.id, type: 'strategy_critic.completed',
        payload: {
          mode: services.strategyCritic.mode,
          severity: refinement.verdict.severity,
          badIdeaOrBadTiming: refinement.verdict.badIdeaOrBadTiming,
          mainVulnerability: refinement.verdict.mainVulnerability,
          critiqueRef: critiqueRef.artifact_id,
        },
        createdAt: new Date().toISOString(),
      });
      analyzeInput = { ...input, content: refinement.improvedStrategyText };
    } catch (err) {
      await services.events.append({
        id: randomUUID(), taskId: task.id, type: 'strategy_critic.failed',
        payload: { error: err instanceof Error ? err.message : String(err) },
        createdAt: new Date().toISOString(),
      });
      analyzeInput = input; // fail-soft: analyst gets the original text
    }
  }
```

Then change the analyst call from `output = await services.analyst.analyze(input);` to:

```ts
    output = await services.analyst.analyze(analyzeInput);
```

> The dedup short-circuit (`findByFingerprint` → return) already runs BEFORE this block, so a duplicate skips the critic with no extra code. `fingerprint` and the `strategy_source` artifact remain computed/stored on the ORIGINAL `input.content` (unchanged).

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/orchestrator/handlers/strategy-onboard.handler.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): pre-flight step in strategy-onboard (fail-soft, default off)"`

---

### Task 11: completion-summary surfacing

**Files:**
- Modify `src/read-api/completion-summary.ts`
- Test `src/read-api/completion-summary.test.ts` (append onboard cases)

**Interfaces:**
- Produces (on `OnboardCompletionSummary`): optional `critique?: { severity: 'low' | 'medium' | 'high'; badIdeaOrBadTiming: 'bad_idea' | 'bad_timing' | 'neither'; mainVulnerability: string }`, populated from the `strategy_critic.completed` event read via `deps.agentEvents.list`. Graceful degradation: omitted when absent.

- [ ] **Step 1: Write the failing tests** — append to `src/read-api/completion-summary.test.ts` (inside the `'buildCompletionSummary — strategy.onboard'` describe)

```ts
  it('surfaces the critique verdict triple from the strategy_critic.completed event', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => onboardTask() },
      agentEvents: { list: async () => [
        { id: 'e1', taskId: 'ob1', type: 'strategy_critic.completed', payload: { mode: 'two_stage', severity: 'high', badIdeaOrBadTiming: 'bad_timing', mainVulnerability: 'no invalidation', critiqueRef: 'art-1' }, createdAt: '2026-06-26T00:00:00.000Z' },
        { id: 'e2', taskId: 'ob1', type: 'strategy_analyst.completed', payload: { profileId: 'p9', direction: 'short' }, createdAt: '2026-06-26T00:00:01.000Z' },
      ] },
      strategyProfiles: { findById: async (id: string) => id === 'p9' ? { id: 'p9', coreIdea: 'fade pumps', direction: 'short' } : null },
    });
    const s = await buildCompletionSummary(deps, 'ob1');
    if (s?.kind !== 'strategy.onboard') throw new Error('wrong kind');
    expect(s.critique).toEqual({ severity: 'high', badIdeaOrBadTiming: 'bad_timing', mainVulnerability: 'no invalidation' });
    expect(s.profile?.id).toBe('p9');
  });

  it('omits critique when no strategy_critic.completed event exists (graceful degradation)', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => onboardTask() },
      agentEvents: { list: async () => [
        { id: 'e1', taskId: 'ob1', type: 'strategy_analyst.completed', payload: { profileId: 'p9', direction: 'long' }, createdAt: '2026-06-26T00:00:00.000Z' },
      ] },
      strategyProfiles: { findById: async () => ({ id: 'p9', coreIdea: 'breakout', direction: 'long' }) },
    });
    const s = await buildCompletionSummary(deps, 'ob1');
    if (s?.kind !== 'strategy.onboard') throw new Error('wrong kind');
    expect(s.critique).toBeUndefined();
  });
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run src/read-api/completion-summary.test.ts`
  Expected: `expected undefined to deeply equal { severity: 'high', ... }` (the `critique` field is not populated yet).

- [ ] **Step 3: Minimal implementation** — `src/read-api/completion-summary.ts`

Extend `OnboardCompletionSummary`:

```ts
export interface OnboardCompletionSummary {
  kind: 'strategy.onboard'; taskId: string; status: string;
  profile: ProfileRef | null; nextStep?: { taskType: string }; links: SummaryLinks;
  warnings: readonly string[];
  critique?: { severity: 'low' | 'medium' | 'high'; badIdeaOrBadTiming: 'bad_idea' | 'bad_timing' | 'neither'; mainVulnerability: string };
}
```

In `buildOnboard`, after `const profile = profileId ? ... : null;` and before the `return`, derive the critique from the already-fetched `events` list:

```ts
  const critiqueEvent = events.find((e) => e.type === 'strategy_critic.completed');
  const cp = critiqueEvent?.payload as { severity?: unknown; badIdeaOrBadTiming?: unknown; mainVulnerability?: unknown } | undefined;
  const critique = cp && typeof cp.severity === 'string' && typeof cp.badIdeaOrBadTiming === 'string' && typeof cp.mainVulnerability === 'string'
    ? { severity: cp.severity as 'low' | 'medium' | 'high', badIdeaOrBadTiming: cp.badIdeaOrBadTiming as 'bad_idea' | 'bad_timing' | 'neither', mainVulnerability: cp.mainVulnerability }
    : undefined;
```

and add the field to the returned object (spread conditionally so it stays absent when undefined):

```ts
  return {
    kind: 'strategy.onboard', taskId: task.id, status: task.status,
    profile: profile ? toProfileRef(profile) : null,
    nextStep: { taskType: 'research.run_cycle' },
    links: { taskId: task.id, profileId },
    warnings,
    ...(critique ? { critique } : {}),
  };
```

> The `events` list is already read once with `limit: 50` (covering both `strategy_critic.completed` and the analyst events). The `events_read_failed` graceful-degradation path still applies: when the read throws, `events` is `[]`, `critiqueEvent` is undefined, and `critique` is omitted.

- [ ] **Step 4: Run it, expect PASS** — `pnpm vitest run src/read-api/completion-summary.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy-critic): surface verdict triple in onboard completion-summary"`

---

## Final verification (after all 11 tasks)

- [ ] **Typecheck** — `pnpm typecheck` (expect clean).
- [ ] **Full suite** — `pnpm test` (expect green, including the strip-types + Mastra-import-boundary guards).
- [ ] **Compose validates** — `make config` (docker-compose parses with the new passthrough lines).
- [ ] **Default-off sanity:** with no env set, `buildStrategyCritic` returns `null`, no `strategy-critic` agents are registered, and the existing onboard tests still assert exactly `['strategy_analyst.started', 'strategy_analyst.completed']`.

---

## Spec-coverage map

| Spec section | Task(s) |
|---|---|
| §1 Domain (`StrategyCriticInputSchema`, `StrategyCritiqueSchema`, `StrategyRefinementSchema`) | 1 |
| §2 Port (`StrategyCriticPort.refine`, reuses `AgentCallOpts`) | 2 |
| §3 Adapters (`fake` / `single-stage` / `two-stage`; two_stage onUsage ×2) | 2, 4, 5 |
| §4 Mastra agents (critic / refiner / combined) | 3 |
| §5 Composition / env (3 agents registered; 5 env vars; `buildStrategyCritic`; `AppServices`) | 6, 7, 9 |
| §6 Handler (pre-flight step; events; artifact; fail-soft; dedup; provenance on original) | 10 |
| §7 Cost accrual + `makeOnUsage` extraction + refactor | 8 |
| §8 Read surface (`OnboardCompletionSummary.critique`) | 11 |
| Testing/verification (unit, handler, env, completion-summary, regression, gates) | all + Final verification |
