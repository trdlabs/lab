# SP-4.5 Multi-provider LLM Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared `ModelProvider` factory lets the four Mastra agents run on `anthropic | openai | openrouter` via a global `MODEL_PROVIDER` + per-role prefix override, with zero domain/orchestrator changes.

**Architecture:** A pure `resolveLanguageModel(env, roleModelId)` factory parses the role model id (prefix-override → global `MODEL_PROVIDER`), builds the matching AI SDK model with an explicit API key, and returns `{ model, provider, modelId, label }`. The four `Mastra*` adapters become provider-agnostic: their constructors take `(model, label)`; composition resolves per role. Fake adapters stay the default so `docker compose up` needs no LLM key.

**Tech Stack:** TypeScript (ESM/NodeNext, `node --experimental-strip-types`), Mastra `@mastra/core@1.41`, `@ai-sdk/anthropic@3.0.82` (installed) + NEW `@ai-sdk/openai` + `@openrouter/ai-sdk-provider` (pinned to the `@ai-sdk/provider@^3` line), Vitest.

**Conventions (follow exactly):**
- NO TypeScript parameter properties (`constructor(private x)` throws under type-stripping) — explicit field + body assignment.
- All relative imports use explicit `.ts` extensions.
- `strict` + `noUncheckedIndexedAccess` ON.
- Run `pnpm typecheck` (must stay green) and the targeted `pnpm vitest run` after each task before committing.
- Branch: `sp4.5-multi-provider-llm` (already created, stacked on SP-4). Work here.

---

## File Structure

**Create:**
- `src/adapters/llm/model-provider.ts` — `ModelProvider`, `ModelProviderEnv`, `ProviderModel` type, `parseRoleModel`, `ResolvedModel`, `resolveLanguageModel`.
- `src/adapters/llm/model-provider.test.ts` — `parseRoleModel` table-test + `resolveLanguageModel` contract tests.
- `src/adapters/llm/provider-probe.test.ts` — offline smoke test that the three providers construct + are Mastra-`Agent`-assignable (regression guard from Task 1).

**Modify:**
- `package.json` — add the two deps (Task 1).
- `src/config/env.ts` + `src/config/env.test.ts` — `MODEL_PROVIDER`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`.
- `src/adapters/analyst/mastra-strategy-analyst.ts`, `src/adapters/researcher/mastra-researcher.ts`, `src/adapters/critic/mastra-critic.ts`, `src/adapters/builder/mastra-builder.ts` — constructors → `(model, label)`, drop `@ai-sdk/anthropic` import + prefix/throw logic.
- The four matching `*.test.ts` construction tests.
- `src/composition.ts` — `buildAnalyst/buildResearcher/buildCritic/buildBuilder` resolve via the factory.
- `.env.example` — three demo blocks.

---

## Task 1: Install providers + verify exports/API/assignability (PROBE — do this FIRST)

This task resolves the version-compat + exact-API uncertainty BEFORE any adapter is touched. Its findings (working export names, call shape, and the return type to use for `ProviderModel`) are consumed by Tasks 2–5.

**Files:**
- Modify: `package.json` (via the install command)
- Create: `src/adapters/llm/provider-probe.test.ts`

- [ ] **Step 1: Install the two providers on the @ai-sdk/provider@^3 line**

The installed `@ai-sdk/anthropic@3.0.82` depends on `@ai-sdk/provider@3.0.10` + `@ai-sdk/provider-utils@4.0.27`. The new providers must resolve a compatible `@ai-sdk/provider@^3`.

Run:
```bash
pnpm add @ai-sdk/openai @openrouter/ai-sdk-provider
```
Then verify the dependency line is consistent:
```bash
node -e "for (const p of ['@ai-sdk/openai','@openrouter/ai-sdk-provider']) { const d=require(p+'/package.json'); console.log(p, d.version, '-> @ai-sdk/provider', (d.dependencies||{})['@ai-sdk/provider'] || (d.peerDependencies||{})['@ai-sdk/provider'] || (d.peerDependencies||{})['ai'] || '(check)'); }"
```
Expected: each provider declares a dependency/peer on `@ai-sdk/provider` (or `ai`) in the `3.x` / v5 line. If a provider only supports an older line and the probe (Step 3) fails to typecheck, pin it: inspect `npm view <pkg> versions` + `npm view <pkg>@<ver> dependencies` and install the newest version whose `@ai-sdk/provider` is `3.x`. **Record the exact versions you settled on** (you will report them).

- [ ] **Step 2: Write the probe test**

```typescript
// src/adapters/llm/provider-probe.test.ts
import { describe, it, expect } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

// Offline: building a provider model + a Mastra Agent does NOT hit the network.
// This proves the three providers construct and are assignable to Agent's `model`.
describe('provider probe (offline)', () => {
  it('anthropic model constructs and is Agent-assignable', () => {
    const model = createAnthropic({ apiKey: 'dummy' })('claude-sonnet-4-6');
    const agent = new Agent({ id: 'p-anthropic', name: 'p', instructions: 'x', model });
    expect(agent).toBeDefined();
  });

  it('openai model constructs and is Agent-assignable', () => {
    const model = createOpenAI({ apiKey: 'dummy' })('gpt-4o');
    const agent = new Agent({ id: 'p-openai', name: 'p', instructions: 'x', model });
    expect(agent).toBeDefined();
  });

  it('openrouter model constructs and is Agent-assignable', () => {
    const model = createOpenRouter({ apiKey: 'dummy' })('meta-llama/llama-3.1-70b-instruct');
    const agent = new Agent({ id: 'p-openrouter', name: 'p', instructions: 'x', model });
    expect(agent).toBeDefined();
  });
});
```

- [ ] **Step 3: Run probe test + typecheck — THIS resolves the API/type questions**

Run: `pnpm vitest run src/adapters/llm/provider-probe.test.ts && pnpm typecheck`
Expected: 3 passing, typecheck clean.

If a provider's call shape differs (e.g. `createOpenRouter(...)` needs `.chat(modelId)` instead of `(modelId)`, or an export name differs), ADJUST the probe to the working shape and note it — Tasks 3 & 5 must use the SAME working shape. If typecheck fails because `openai`/`openrouter` model types are NOT mutually assignable with anthropic's (provider-version skew), that is the signal to re-pin versions (Step 1) until all three construct and are Agent-assignable.

**Decision to record for later tasks:**
- The exact working call shape for each provider (e.g. `createOpenRouter({apiKey})(modelId)` vs `.chat(modelId)`).
- Whether `type ProviderModel = ReturnType<ReturnType<typeof createAnthropic>>` accepts all three (primary plan in Task 2). If the openai/openrouter returns are NOT assignable to that, the fallback is `import type { LanguageModelV2 } from '@ai-sdk/provider'` (a direct dep you then add) — use whichever the typecheck accepts.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/adapters/llm/provider-probe.test.ts
git commit -m "chore(sp4.5): add @ai-sdk/openai + @openrouter/ai-sdk-provider; provider probe"
```

---

## Task 2: parseRoleModel (pure, table-tested)

**Files:**
- Create: `src/adapters/llm/model-provider.ts`
- Test: `src/adapters/llm/model-provider.test.ts`

- [ ] **Step 1: Write the failing table-test**

```typescript
// src/adapters/llm/model-provider.test.ts
import { describe, it, expect } from 'vitest';
import { parseRoleModel, type ModelProviderEnv } from './model-provider.ts';

function env(MODEL_PROVIDER: ModelProviderEnv['MODEL_PROVIDER']): ModelProviderEnv {
  return { MODEL_PROVIDER };
}

describe('parseRoleModel', () => {
  const cases: Array<[string, ModelProviderEnv['MODEL_PROVIDER'], string, string]> = [
    // roleModelId,                              MODEL_PROVIDER, provider,     modelId
    ['claude-sonnet-4-6',                        'anthropic',  'anthropic',  'claude-sonnet-4-6'],
    ['anthropic/claude-sonnet-4-6',              'openai',     'anthropic',  'claude-sonnet-4-6'],
    ['openai/gpt-4o',                            'anthropic',  'openai',     'gpt-4o'],
    ['gpt-4o',                                   'openai',     'openai',     'gpt-4o'],
    ['meta-llama/llama-3.1-70b',                 'openrouter', 'openrouter', 'meta-llama/llama-3.1-70b'],
    ['openrouter/anthropic/claude-3.5-sonnet',   'anthropic',  'openrouter', 'anthropic/claude-3.5-sonnet'],
    ['google/gemini-flash-1.5',                  'anthropic',  'anthropic',  'google/gemini-flash-1.5'],
  ];

  for (const [roleModelId, provider, expProvider, expModelId] of cases) {
    it(`${roleModelId} @ ${provider} -> ${expProvider}:${expModelId}`, () => {
      const r = parseRoleModel(env(provider), roleModelId);
      expect(r.provider).toBe(expProvider);
      expect(r.modelId).toBe(expModelId);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/llm/model-provider.test.ts`
Expected: FAIL — `Cannot find module './model-provider.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/adapters/llm/model-provider.ts
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelProviderEnv {
  MODEL_PROVIDER: ModelProvider;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

const OVERRIDE_PREFIXES = new Set<string>(MODEL_PROVIDERS);

/** First path segment is a provider override ONLY when it's exactly anthropic|openai|openrouter;
 *  otherwise the whole id falls through to the global MODEL_PROVIDER. */
export function parseRoleModel(env: ModelProviderEnv, roleModelId: string): { provider: ModelProvider; modelId: string } {
  const slash = roleModelId.indexOf('/');
  if (slash > 0) {
    const head = roleModelId.slice(0, slash);
    if (OVERRIDE_PREFIXES.has(head)) {
      return { provider: head as ModelProvider, modelId: roleModelId.slice(slash + 1) };
    }
  }
  return { provider: env.MODEL_PROVIDER, modelId: roleModelId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/llm/model-provider.test.ts && pnpm typecheck`
Expected: PASS (7 cases), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/llm/model-provider.ts src/adapters/llm/model-provider.test.ts
git commit -m "feat(sp4.5): parseRoleModel (global provider + per-role prefix override)"
```

---

## Task 3: resolveLanguageModel + ResolvedModel (factory)

**Files:**
- Modify: `src/adapters/llm/model-provider.ts`
- Test: `src/adapters/llm/model-provider.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to the existing file)

```typescript
// append to src/adapters/llm/model-provider.test.ts
import { resolveLanguageModel } from './model-provider.ts';

describe('resolveLanguageModel', () => {
  it('resolves provider/modelId/label and returns an opaque model (openai)', () => {
    const r = resolveLanguageModel({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'dummy' }, 'gpt-4o');
    expect(r.provider).toBe('openai');
    expect(r.modelId).toBe('gpt-4o');
    expect(r.label).toBe('gpt-4o');
    expect(r.model).toBeDefined(); // model is opaque — do NOT assert provider-internal fields
  });

  it('per-role prefix overrides the global provider, label keeps the original id', () => {
    const r = resolveLanguageModel({ MODEL_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, 'anthropic/claude-sonnet-4-6');
    expect(r.provider).toBe('anthropic');
    expect(r.modelId).toBe('claude-sonnet-4-6');
    expect(r.label).toBe('anthropic/claude-sonnet-4-6');
  });

  it('openrouter vendor id falls through to global MODEL_PROVIDER=openrouter', () => {
    const r = resolveLanguageModel({ MODEL_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' }, 'meta-llama/llama-3.1-70b-instruct');
    expect(r.provider).toBe('openrouter');
    expect(r.modelId).toBe('meta-llama/llama-3.1-70b-instruct');
  });

  it('throws a clear error when the selected provider key is missing', () => {
    expect(() => resolveLanguageModel({ MODEL_PROVIDER: 'anthropic' }, 'claude-sonnet-4-6')).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolveLanguageModel({ MODEL_PROVIDER: 'openai' }, 'gpt-4o')).toThrow(/OPENAI_API_KEY/);
    expect(() => resolveLanguageModel({ MODEL_PROVIDER: 'openrouter' }, 'x/y')).toThrow(/OPENROUTER_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/llm/model-provider.test.ts`
Expected: FAIL — `resolveLanguageModel` is not exported.

- [ ] **Step 3: Write minimal implementation** (add to `model-provider.ts`)

Add imports at the top of the file and the `ProviderModel` type + `ResolvedModel` + `resolveLanguageModel`. Use the call shape Task 1 confirmed working:

```typescript
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

// Canonical model type. Task 1 confirmed all three providers' returns are assignable to this.
// FALLBACK (only if Task 1's typecheck rejected it): `import type { LanguageModelV2 } from '@ai-sdk/provider'`
// (add @ai-sdk/provider as a direct dep) and use that here + below.
export type ProviderModel = ReturnType<ReturnType<typeof createAnthropic>>;

export interface ResolvedModel {
  model: ProviderModel;
  provider: ModelProvider;
  modelId: string;
  label: string; // original role model env value, for audit
}

export function resolveLanguageModel(env: ModelProviderEnv, roleModelId: string): ResolvedModel {
  const { provider, modelId } = parseRoleModel(env, roleModelId);
  let model: ProviderModel;
  switch (provider) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for MODEL provider "anthropic"');
      model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId);
      break;
    case 'openai':
      if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for MODEL provider "openai"');
      model = createOpenAI({ apiKey: env.OPENAI_API_KEY })(modelId);
      break;
    case 'openrouter':
      if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for MODEL provider "openrouter"');
      model = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(modelId);
      break;
  }
  return { model, provider, modelId, label: roleModelId };
}
```

> If Task 1 found `createOpenRouter({apiKey})(modelId)` is not the right call (e.g. needs `.chat(modelId)`), use that exact form here. If TS complains the `switch` may leave `model` unassigned, the three cases are exhaustive over `ModelProvider`; if needed add `default: { const _x: never = provider; throw new Error(\`unknown provider: ${String(_x)}\`); }`.

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run src/adapters/llm/model-provider.test.ts && pnpm typecheck`
Expected: PASS (7 parseRoleModel + 4 resolveLanguageModel), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/llm/model-provider.ts src/adapters/llm/model-provider.test.ts
git commit -m "feat(sp4.5): resolveLanguageModel factory (anthropic|openai|openrouter)"
```

---

## Task 4: env additions

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append)

```typescript
// append to src/config/env.test.ts
describe('SP-4.5 model provider env', () => {
  it('defaults MODEL_PROVIDER to anthropic, keys undefined', () => {
    const env = loadEnv({});
    expect(env.MODEL_PROVIDER).toBe('anthropic');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('reads MODEL_PROVIDER + provider keys', () => {
    const env = loadEnv({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-o', OPENROUTER_API_KEY: 'sk-or' });
    expect(env.MODEL_PROVIDER).toBe('openai');
    expect(env.OPENAI_API_KEY).toBe('sk-o');
    expect(env.OPENROUTER_API_KEY).toBe('sk-or');
  });

  it('falls back to anthropic for an unknown MODEL_PROVIDER value', () => {
    expect(loadEnv({ MODEL_PROVIDER: 'bogus' }).MODEL_PROVIDER).toBe('anthropic');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/config/env.test.ts`
Expected: FAIL — `MODEL_PROVIDER` undefined on `Env`.

- [ ] **Step 3: Write minimal implementation**

In `src/config/env.ts`, add the import at the top:
```typescript
import { MODEL_PROVIDERS, type ModelProvider } from '../adapters/llm/model-provider.ts';
```
Add to the `Env` interface:
```typescript
  MODEL_PROVIDER: ModelProvider;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
```
Add a small parser near the other helpers:
```typescript
function parseModelProvider(value: string | undefined): ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value ?? '') ? (value as ModelProvider) : 'anthropic';
}
```
And in the returned object inside `loadEnv`:
```typescript
    MODEL_PROVIDER: parseModelProvider(source.MODEL_PROVIDER),
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    OPENROUTER_API_KEY: source.OPENROUTER_API_KEY,
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run src/config/env.test.ts && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(sp4.5): env MODEL_PROVIDER + OPENAI_API_KEY + OPENROUTER_API_KEY"
```

---

## Task 5: Make the four Mastra adapters provider-agnostic + rewire composition

This is one atomic task (4 adapters + 4 construction tests + composition's 4 build functions) so `pnpm typecheck` stays green within the commit — changing an adapter constructor breaks its composition call site until both move together.

**Files:**
- Modify: `src/adapters/analyst/mastra-strategy-analyst.ts`, `src/adapters/researcher/mastra-researcher.ts`, `src/adapters/critic/mastra-critic.ts`, `src/adapters/builder/mastra-builder.ts`
- Modify: the four matching `*.test.ts`
- Modify: `src/composition.ts`

- [ ] **Step 1: Apply the SAME constructor transformation to all four adapters**

Each `Mastra*` adapter currently has this shape (worked example: `MastraResearcher`):
```typescript
// BEFORE (in each adapter)
import { anthropic } from '@ai-sdk/anthropic';
// ...
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
    this.agent = new Agent({ id: 'researcher', name: 'Researcher', instructions: INSTRUCTIONS, model: anthropic(bareModelId) });
  }
  // ... methods unchanged
}
```
Transform EACH of the four to (worked example shown; apply the identical change, keeping each class's own `id`/`name`/`INSTRUCTIONS`/methods):
```typescript
// AFTER
import type { ProviderModel } from '../llm/model-provider.ts'; // path: '../llm/...' from analyst|researcher|critic|builder dirs
// REMOVE: import { anthropic } from '@ai-sdk/anthropic';
// ...
export class MastraResearcher implements ResearcherPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(model: ProviderModel, label: string) {
    this.model = label;
    this.agent = new Agent({ id: 'researcher', name: 'Researcher', instructions: INSTRUCTIONS, model });
  }
  // ... methods unchanged
}
```
The four files + their class names / Agent ids (leave `id`/`name`/`INSTRUCTIONS` exactly as they are):
1. `src/adapters/analyst/mastra-strategy-analyst.ts` — `MastraStrategyAnalyst`
2. `src/adapters/researcher/mastra-researcher.ts` — `MastraResearcher`
3. `src/adapters/critic/mastra-critic.ts` — `MastraCritic`
4. `src/adapters/builder/mastra-builder.ts` — `MastraBuilder`

The relative import path from each adapter dir to `src/adapters/llm/model-provider.ts` is `../llm/model-provider.ts`. Remove the now-unused `@ai-sdk/anthropic` import in each.

- [ ] **Step 2: Update the four construction tests**

Each `mastra-*.test.ts` currently constructs with a string and asserts the Anthropic-only throw. Replace that block (worked example for `mastra-researcher.test.ts`) — the "rejects non-Anthropic" assertion is GONE (it now lives in `model-provider.test.ts`):
```typescript
// mastra-researcher.test.ts — construction describe block
import { describe, it, expect } from 'vitest';
import { MastraResearcher } from './mastra-researcher.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';

describe('MastraResearcher (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const r = new MastraResearcher(model, label);
    expect(r.adapter).toBe('mastra');
    expect(r.model).toBe('anthropic/claude-sonnet-4-6');
  });
});
```
Apply the analogous change to the other three (`MastraStrategyAnalyst`, `MastraCritic`, `MastraBuilder`) — same import of `resolveLanguageModel` from `../llm/model-provider.ts`, construct `new MastraX(model, label)`, assert `adapter === 'mastra'` and `model === label`. Keep any existing live (`describe.skip`) blocks in those files unchanged.

- [ ] **Step 3: Rewire composition's four build functions**

In `src/composition.ts`:
- Add `import { resolveLanguageModel } from './adapters/llm/model-provider.ts';`
- The four `build*` functions resolve via the factory. The per-builder `ANTHROPIC_API_KEY` checks are REMOVED (the factory throws on a missing key for the selected provider). Worked examples:
```typescript
function buildAnalyst(env: ReturnType<typeof loadEnv>): StrategyAnalystPort {
  if (env.STRATEGY_ANALYST_ADAPTER === 'mastra') {
    const r = resolveLanguageModel(env, env.STRATEGY_ANALYST_MODEL);
    return new MastraStrategyAnalyst(r.model, r.label);
  }
  console.warn('[composition] STRATEGY_ANALYST_ADAPTER is not "mastra"; using FakeStrategyAnalyst (stub analysis)');
  return new FakeStrategyAnalyst();
}

function buildResearcher(env: ReturnType<typeof loadEnv>): ResearcherPort {
  if (env.RESEARCHER_ADAPTER === 'mastra') {
    const r = resolveLanguageModel(env, env.RESEARCHER_MODEL);
    return new MastraResearcher(r.model, r.label);
  }
  console.warn('[composition] RESEARCHER_ADAPTER is not "mastra"; using FakeResearcher (stub hypotheses)');
  return new FakeResearcher();
}

function buildCritic(env: ReturnType<typeof loadEnv>): CriticPort | null {
  if (!env.ENABLE_CRITIC_AGENT) return null;
  if (env.CRITIC_ADAPTER === 'mastra') {
    const r = resolveLanguageModel(env, env.CRITIC_MODEL);
    return new MastraCritic(r.model, r.label);
  }
  console.warn('[composition] ENABLE_CRITIC_AGENT=true but CRITIC_ADAPTER is not "mastra"; using FakeCritic');
  return new FakeCritic();
}

function buildBuilder(env: ReturnType<typeof loadEnv>): BuilderPort {
  if (env.BUILDER_ADAPTER === 'mastra') {
    const r = resolveLanguageModel(env, env.BUILDER_MODEL);
    return new MastraBuilder(r.model, r.label);
  }
  console.warn('[composition] BUILDER_ADAPTER is not "mastra"; using FakeBuilder (template bundles)');
  return new FakeBuilder();
}
```
Leave the rest of `composition.ts` (handlers, repos, registration) untouched.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; full suite green (the 4 construction tests now build via the factory; integration/live tests skip without env). Default adapters are still `fake` — composition's fake paths are unchanged, so a key-free `docker compose up` still works.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/analyst/mastra-strategy-analyst.ts src/adapters/researcher/mastra-researcher.ts src/adapters/critic/mastra-critic.ts src/adapters/builder/mastra-builder.ts src/adapters/analyst/mastra-strategy-analyst.test.ts src/adapters/researcher/mastra-researcher.test.ts src/adapters/critic/mastra-critic.test.ts src/adapters/builder/mastra-builder.test.ts src/composition.ts
git commit -m "feat(sp4.5): provider-agnostic Mastra adapters (inject resolved model) + composition wiring"
```

---

## Task 6: .env.example demos + final verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append the three demo blocks to `.env.example`**

Read the current `.env.example` (use `mcp__gortex__read_file` if `Read` is denied), keep the existing keys, and append:
```dotenv

# === LLM provider configuration (SP-4.5) ===
# MODEL_PROVIDER selects the default provider for "mastra" adapters: anthropic | openai | openrouter
# Per-role override: prefix a role model id, e.g. RESEARCHER_MODEL=openai/gpt-4o
# OpenRouter ids whose vendor is anthropic/openai need the openrouter/ prefix:
#   RESEARCHER_MODEL=openrouter/anthropic/claude-3.5-sonnet

# --- Demo A: no-key fake (DEFAULT) — docker compose up works with NO LLM key ---
# Leave *_ADAPTER unset (they default to "fake"). MODEL_PROVIDER/keys are then irrelevant.

# --- Demo B: OpenAI ---
# MODEL_PROVIDER=openai
# OPENAI_API_KEY=sk-...
# RESEARCHER_ADAPTER=mastra
# RESEARCHER_MODEL=gpt-4o

# --- Demo C: OpenRouter ---
# MODEL_PROVIDER=openrouter
# OPENROUTER_API_KEY=sk-or-...
# RESEARCHER_ADAPTER=mastra
# RESEARCHER_MODEL=meta-llama/llama-3.1-70b-instruct
```

- [ ] **Step 2: Final verification — fake defaults are key-free**

Run:
```bash
pnpm typecheck && pnpm test
```
Expected: typecheck clean; full suite green / live tests skipped.

Then confirm composition does not require an LLM key with default (fake) adapters:
```bash
DATABASE_URL=x REDIS_URL=x node --experimental-strip-types -e "import('./src/composition.ts').then(m => { try { m.composeRuntime(); } catch (e) { console.log('compose error:', e.message); } console.log('composed with fake adapters, no LLM key needed'); })" 2>&1 | tail -3
```
Expected: prints the "composed with fake adapters" line WITHOUT throwing an LLM-key error (a DB/Redis connection error is fine — we only assert no `*_API_KEY is required` throw, since default adapters are fake).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(sp4.5): .env.example demos (fake / OpenAI / OpenRouter)"
```

---

## Self-Review (completed during planning)

**Spec coverage:** §3 factory → Task 2 (`parseRoleModel`) + Task 3 (`resolveLanguageModel`, `ResolvedModel`). §3.1 table → Task 2 table-test (incl. `anthropic/…` direct, `openrouter/anthropic/…`, `meta-llama/…` fall-through). §4 adapters → Task 5. §5 composition → Task 5. §6 env + deps → Task 4 (env) + Task 1 (deps). §6 `.env.example` → Task 6. §7 probe-first → Task 1. §8 testing → Tasks 2/3/4/5 (offline) + preserved live `describe.skip`. ✔ All four plan emphases: probe-first (Task 1), `parseRoleModel` table-test incl. the 3 key cases (Task 2), `resolveLanguageModel` asserts provider/modelId/label with `model` opaque-but-defined (Task 3), fake defaults stay key-free (Task 5 Step 4 + Task 6 Step 2).

**Placeholder scan:** no TBD/TODO; the one "if the probe found a different call shape" note in Task 3 is a documented contingency tied to Task 1's recorded decision, not a gap.

**Type consistency:** `ModelProviderEnv` / `ModelProvider` / `ProviderModel` / `ResolvedModel` / `parseRoleModel` / `resolveLanguageModel` names identical across Tasks 2–5. `ResolvedModel` fields `{ model, provider, modelId, label }` consumed identically in composition (Task 5) and tests (Task 3). The `(model: ProviderModel, label: string)` constructor signature matches between Task 5 adapters and the Task 5 composition call sites. `Env` gains `MODEL_PROVIDER`/`OPENAI_API_KEY`/`OPENROUTER_API_KEY` (Task 4) which `resolveLanguageModel(env, …)` consumes via structural `ModelProviderEnv` (Task 5 passes `env` directly).

**Green-typecheck ordering:** Tasks 1–4 add files / optional fields only. Task 5 changes the 4 adapter constructors AND their composition call sites in one commit (no red window). Task 6 is docs + verification.

**Resolved-by-Task-1 uncertainties (not open questions):** exact provider export/call shape and the `ProviderModel` type source are discovered + locked by the Task 1 probe before any adapter changes; Task 3/5 consume the recorded decision with a documented fallback.
