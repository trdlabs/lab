# Live $ Cost Accounting (Slice 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute the dollar cost of each research run live — per-call `inputTokens×inPrice + outputTokens×outPrice`, priced from OpenRouter, accumulated per `correlationId`, surfaced via an event + the completion summary.

**Architecture:** A `ModelPricingPort` (OpenRouter `/models`-backed, TTL-cached, fail-soft) prices each LLM call; the cycle adapters report a richer `AgentCallUsage` ({modelId, input, output, total}) via the existing `onUsage` hook; the cycle handlers accrue `$` into a new `cumulative_cost_usd` column on `research_token_usage`; cost-per-run is surfaced from `getCost(correlationId)`.

**Tech Stack:** TypeScript (`node --experimental-strip-types`), Vitest, drizzle-orm + drizzle-kit (Postgres), global `fetch` (FetchLike-injectable), Mastra/AI-SDK-v6 usage.

**Spec:** `docs/superpowers/specs/2026-06-24-cost-accounting-usd-design.md`

## Global Constraints

- Runtime `node --experimental-strip-types`: **no TypeScript parameter properties** (explicit field + assignment). `src/strip-types-no-param-properties.test.ts` must stay green.
- Cost = `inputTokens × inputUsdPerToken + outputTokens × outputUsdPerToken`, per call, summed per `correlationId` (a chain mixes models).
- Pricing is **fail-soft**: OpenRouter unavailable or an unknown model → `priceFor` returns `null` → that call contributes `0` cost + a warning; the run NEVER breaks.
- OpenRouter `/models` is public (no auth); `pricing.prompt`/`pricing.completion` are USD-per-token decimal strings. Lookup key = the model id with a leading `openrouter/` stripped.
- `NullModelPricing` is the default in tests/unwired flows (cost stays 0); composition wires the live OpenRouter adapter.
- The PR #86 token budget keeps recording `totalTokens` and must stay functional.
- Migrations are drizzle-kit generated (edit `src/db/schema.ts` → `pnpm db:generate`; additive).
- Gate after each code task: `pnpm typecheck` + `pnpm test` green.

---

### Task 1: `ModelPricingPort` + OpenRouter adapter + Null adapter

**Files:**
- Create: `src/ports/model-pricing.port.ts`
- Create: `src/adapters/pricing/openrouter-model-pricing.ts`
- Create: `src/adapters/pricing/null-model-pricing.ts`
- Create test: `src/adapters/pricing/openrouter-model-pricing.test.ts`

**Interfaces:**
- Produces: `interface ModelPrice { inputUsdPerToken: number; outputUsdPerToken: number }`; `interface ModelPricingPort { priceFor(modelId: string): Promise<ModelPrice | null> }`; classes `OpenRouterModelPricing` (ctor `(fetchFn?: typeof fetch, clock?: () => number, ttlMs?: number)`) and `NullModelPricing`.

- [ ] **Step 1: Write the failing test**

Create `src/adapters/pricing/openrouter-model-pricing.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { OpenRouterModelPricing } from './openrouter-model-pricing.ts';
import { NullModelPricing } from './null-model-pricing.ts';

const MODELS_BODY = {
  data: [
    { id: 'google/gemini-3.1-flash-lite', pricing: { prompt: '0.00000025', completion: '0.0000015' } },
    { id: 'anthropic/claude-sonnet-4.6', pricing: { prompt: '0.000003', completion: '0.000015' } },
  ],
};
function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
}

describe('OpenRouterModelPricing', () => {
  it('prices a model, stripping the openrouter/ prefix', async () => {
    const p = new OpenRouterModelPricing(fakeFetch(MODELS_BODY), () => 0);
    expect(await p.priceFor('openrouter/google/gemini-3.1-flash-lite'))
      .toEqual({ inputUsdPerToken: 0.00000025, outputUsdPerToken: 0.0000015 });
    expect(await p.priceFor('anthropic/claude-sonnet-4.6'))
      .toEqual({ inputUsdPerToken: 0.000003, outputUsdPerToken: 0.000015 });
  });

  it('returns null for an unknown model', async () => {
    const p = new OpenRouterModelPricing(fakeFetch(MODELS_BODY), () => 0);
    expect(await p.priceFor('made-up/model')).toBeNull();
  });

  it('caches within the TTL and re-fetches after it expires', async () => {
    const spy = vi.fn(fakeFetch(MODELS_BODY));
    let now = 0;
    const p = new OpenRouterModelPricing(spy as unknown as typeof fetch, () => now, 1000);
    await p.priceFor('google/gemini-3.1-flash-lite');
    await p.priceFor('google/gemini-3.1-flash-lite');
    expect(spy).toHaveBeenCalledTimes(1); // cached
    now = 1001;
    await p.priceFor('google/gemini-3.1-flash-lite');
    expect(spy).toHaveBeenCalledTimes(2); // TTL expired -> refetch
  });

  it('fail-soft: a non-ok response yields null and does not throw', async () => {
    const p = new OpenRouterModelPricing(fakeFetch({}, false), () => 0);
    expect(await p.priceFor('google/gemini-3.1-flash-lite')).toBeNull();
  });

  it('fail-soft: a thrown fetch yields null and does not throw', async () => {
    const throwing = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const p = new OpenRouterModelPricing(throwing, () => 0);
    expect(await p.priceFor('google/gemini-3.1-flash-lite')).toBeNull();
  });
});

describe('NullModelPricing', () => {
  it('always returns null', async () => {
    expect(await new NullModelPricing().priceFor('anything')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm test -- src/adapters/pricing/openrouter-model-pricing.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create the port**

Create `src/ports/model-pricing.port.ts`:

```ts
/** Per-token USD prices for one model. */
export interface ModelPrice {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
}

/** Resolves model pricing. priceFor returns null when the model is unknown or pricing is
 *  unavailable (fail-soft) — callers must treat null as "cost unknown", never as an error. */
export interface ModelPricingPort {
  priceFor(modelId: string): Promise<ModelPrice | null>;
}
```

- [ ] **Step 4: Create the Null adapter**

Create `src/adapters/pricing/null-model-pricing.ts`:

```ts
import type { ModelPrice, ModelPricingPort } from '../../ports/model-pricing.port.ts';

/** No-op pricing: always "unknown". The default until OpenRouter pricing is wired. */
export class NullModelPricing implements ModelPricingPort {
  async priceFor(_modelId: string): Promise<ModelPrice | null> {
    return null;
  }
}
```

- [ ] **Step 5: Create the OpenRouter adapter**

Create `src/adapters/pricing/openrouter-model-pricing.ts`:

```ts
import type { ModelPrice, ModelPricingPort } from '../../ports/model-pricing.port.ts';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

interface ModelsResponse { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> }

/**
 * Prices models from OpenRouter's public /models catalogue (no auth). Fetched once, cached
 * with a TTL, fail-soft: any fetch/parse failure or an unknown id resolves to null so a run
 * never breaks on a pricing miss. fetch + clock are injected for deterministic tests.
 */
export class OpenRouterModelPricing implements ModelPricingPort {
  private readonly fetchFn: typeof fetch;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private cache: Map<string, ModelPrice> | null = null;
  private fetchedAtMs = 0;

  constructor(fetchFn: typeof fetch = fetch, clock: () => number = () => Date.now(), ttlMs: number = DEFAULT_TTL_MS) {
    this.fetchFn = fetchFn;
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  async priceFor(modelId: string): Promise<ModelPrice | null> {
    const map = await this.#ensureCache();
    if (!map) return null;
    const key = modelId.startsWith('openrouter/') ? modelId.slice('openrouter/'.length) : modelId;
    return map.get(key) ?? null;
  }

  async #ensureCache(): Promise<Map<string, ModelPrice> | null> {
    const now = this.clock();
    if (this.cache && now - this.fetchedAtMs < this.ttlMs) return this.cache;
    try {
      const res = await this.fetchFn(OPENROUTER_MODELS_URL, { method: 'GET' });
      if (!res.ok) return this.cache; // keep any prior cache; otherwise null
      const body = (await res.json()) as ModelsResponse;
      const map = new Map<string, ModelPrice>();
      for (const m of body.data ?? []) {
        if (!m.id || !m.pricing) continue;
        const inP = Number.parseFloat(m.pricing.prompt ?? '');
        const outP = Number.parseFloat(m.pricing.completion ?? '');
        if (Number.isFinite(inP) && Number.isFinite(outP)) {
          map.set(m.id, { inputUsdPerToken: inP, outputUsdPerToken: outP });
        }
      }
      this.cache = map;
      this.fetchedAtMs = now;
      return map;
    } catch {
      return this.cache; // fail-soft: null on first failure, stale cache thereafter
    }
  }
}
```

- [ ] **Step 6: Run the test — verify it passes**

Run: `pnpm test -- src/adapters/pricing/openrouter-model-pricing.test.ts`
Expected: PASS (6 cases).

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck` → clean.

```bash
git add src/ports/model-pricing.port.ts src/adapters/pricing/null-model-pricing.ts src/adapters/pricing/openrouter-model-pricing.ts src/adapters/pricing/openrouter-model-pricing.test.ts
git commit -m "feat(cost): ModelPricingPort + OpenRouter (TTL-cached, fail-soft) + Null adapter"
```

---

### Task 2: Migrate `onUsage` to the richer `AgentCallUsage` shape (no cost yet)

**Files:**
- Modify: `src/ports/agent-call-opts.ts`
- Modify: `src/adapters/researcher/mastra-researcher.ts`, `src/adapters/builder/mastra-builder.ts`, `src/adapters/critic/mastra-critic.ts`
- Modify: `src/adapters/researcher/mastra-researcher.usage.test.ts`, `src/adapters/builder/mastra-builder.usage.test.ts`, `src/adapters/critic/mastra-critic.usage.test.ts`
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts`, `src/orchestrator/handlers/hypothesis-build.handler.ts` (callback shape only)
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (the usage test)

**Interfaces:**
- Produces: `interface AgentCallUsage { modelId: string; inputTokens: number; outputTokens: number; totalTokens: number }`; `AgentCallOpts.onUsage?: (usage: AgentCallUsage) => void | Promise<void>`. Adapters emit the full object; handler callbacks consume `u.totalTokens` (cost added in Task 4).

- [ ] **Step 1: Update the shared type**

In `src/ports/agent-call-opts.ts`, replace the contents with:

```ts
/** Token usage of one agent LLM call. inputTokens/outputTokens split enables $ pricing. */
export interface AgentCallUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Optional per-call hooks. onUsage reports the call's token usage (counts are 0 when unknown). */
export interface AgentCallOpts {
  onUsage?: (usage: AgentCallUsage) => void | Promise<void>;
}
```

- [ ] **Step 2: Update the three adapters**

In each adapter, replace the `await opts?.onUsage?.(result.usage?.totalTokens ?? 0);` line with the object form, using the adapter's `this.model`:

```ts
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
```

(Keep the placement: immediately after `generate`, before the schema `parse`.)

- [ ] **Step 3: Update the three adapter usage tests**

In each `mastra-*.usage.test.ts`, the fake agent already returns a `usage` block — extend it to include the split and assert the object. Change each fake agent's generate result to `{ object: <validObject>, usage: { inputTokens: 100, outputTokens: 23, totalTokens: 123 } }` and the assertion to capture the object:

```ts
    let recorded: { modelId: string; inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    await adapter.build(validInput, { onUsage: (u) => { recorded = u; } });
    expect(recorded).toEqual({ modelId: <the label passed to the adapter ctor>, inputTokens: 100, outputTokens: 23, totalTokens: 123 });
```

For the "missing usage → 0" case, assert `recorded` equals `{ modelId, inputTokens: 0, outputTokens: 0, totalTokens: 0 }`. Use the adapter's constructor `label` arg as the expected `modelId`.

- [ ] **Step 4: Update the handler callbacks (shape only — no cost yet)**

In `src/orchestrator/handlers/research-run-cycle.handler.ts` (researcher.propose + critic.review) and `src/orchestrator/handlers/hypothesis-build.handler.ts` (builder.build), change each `{ onUsage: (t) => services.tokenUsage.add(task.correlationId, t) }` to:

```ts
    { onUsage: (u) => services.tokenUsage.add(task.correlationId, u.totalTokens) }
```

- [ ] **Step 5: Update the handler usage test**

In `src/orchestrator/handlers/research-run-cycle.handler.test.ts`, the `reportingResearcher` fake calls `opts?.onUsage?.(777)` — change it to the object shape:

```ts
    async propose(_input, opts) {
      await opts?.onUsage?.({ modelId: 'test', inputTokens: 700, outputTokens: 77, totalTokens: 777 });
      return { researchSummary: 's', hypotheses: [] };
    },
```

The assertion `tokenUsage.get(task.correlationId) === 777` is unchanged (still totalTokens).

- [ ] **Step 6: Run focused tests + full suite + typecheck**

Run: `pnpm test -- src/adapters/builder src/adapters/researcher src/adapters/critic src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: PASS.
Run: `pnpm typecheck && pnpm test` → green. Run `pnpm test -- src/mastra/mastra-import-boundary.guard.test.ts` → green.

- [ ] **Step 7: Commit**

```bash
git add src/ports/agent-call-opts.ts src/adapters/researcher/mastra-researcher.ts src/adapters/builder/mastra-builder.ts src/adapters/critic/mastra-critic.ts src/adapters/researcher/mastra-researcher.usage.test.ts src/adapters/builder/mastra-builder.usage.test.ts src/adapters/critic/mastra-critic.usage.test.ts src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/hypothesis-build.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "refactor(cost): onUsage reports AgentCallUsage (modelId + input/output split); behavior unchanged"
```

---

### Task 3: Persist cumulative cost — `addCost`/`getCost` + column + migration

**Files:**
- Modify: `src/ports/token-usage.repository.ts`
- Modify: `src/adapters/repository/in-memory-token-usage.repository.ts`
- Modify: `src/adapters/repository/in-memory-token-usage.repository.test.ts`
- Modify: `src/adapters/repository/drizzle-token-usage.repository.ts`
- Modify: `src/db/schema.ts` (add `cumulativeCostUsd` to `researchTokenUsage`)
- Generate: `migrations/0012_*.sql` via `pnpm db:generate`

**Interfaces:**
- Produces: `TokenUsageRepository.addCost(correlationId: string, costUsd: number): Promise<void>` (upsert-increment) + `getCost(correlationId: string): Promise<number>` (0 when absent). Drizzle column `cumulative_cost_usd double precision NOT NULL DEFAULT 0`.

- [ ] **Step 1: Write the failing in-memory test**

Add to `src/adapters/repository/in-memory-token-usage.repository.test.ts`:

```ts
it('accumulates cost independently of tokens, per correlationId', async () => {
  const repo = new InMemoryTokenUsageRepository();
  await repo.add('c1', 100);
  await repo.addCost('c1', 0.0025);
  await repo.addCost('c1', 0.0011);
  await repo.addCost('c2', 0.5);
  expect(await repo.getCost('c1')).toBeCloseTo(0.0036, 10);
  expect(await repo.getCost('c2')).toBe(0.5);
  expect(await repo.getCost('absent')).toBe(0);
  expect(await repo.get('c1')).toBe(100); // tokens untouched
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm test -- src/adapters/repository/in-memory-token-usage.repository.test.ts`
Expected: FAIL — `addCost`/`getCost` do not exist.

- [ ] **Step 3: Extend the port**

In `src/ports/token-usage.repository.ts`, add to the interface:

```ts
  /** Add USD cost to the chain's cumulative total (creates the row on first call). */
  addCost(correlationId: string, costUsd: number): Promise<void>;
  /** Cumulative USD cost for the chain; 0 when none recorded yet. */
  getCost(correlationId: string): Promise<number>;
```

- [ ] **Step 4: Extend the in-memory adapter**

In `src/adapters/repository/in-memory-token-usage.repository.ts`, add a second map + the methods:

```ts
  readonly #costs = new Map<string, number>();

  async addCost(correlationId: string, costUsd: number): Promise<void> {
    this.#costs.set(correlationId, (this.#costs.get(correlationId) ?? 0) + costUsd);
  }

  async getCost(correlationId: string): Promise<number> {
    return this.#costs.get(correlationId) ?? 0;
  }
```

- [ ] **Step 5: Run the in-memory test — verify it passes**

Run: `pnpm test -- src/adapters/repository/in-memory-token-usage.repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the schema column**

In `src/db/schema.ts`, in the `researchTokenUsage` table add (after `cumulativeTokens`):

```ts
  cumulativeCostUsd: doublePrecision('cumulative_cost_usd').notNull().default(0),
```

(`doublePrecision` is already imported on line 1.)

- [ ] **Step 7: Extend the drizzle adapter**

In `src/adapters/repository/drizzle-token-usage.repository.ts` add the two methods (mirroring `add`/`get`, using `researchTokenUsage.cumulativeCostUsd`):

```ts
  async addCost(correlationId: string, costUsd: number): Promise<void> {
    await this.db
      .insert(researchTokenUsage)
      .values({ correlationId, cumulativeCostUsd: costUsd, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: researchTokenUsage.correlationId,
        set: {
          cumulativeCostUsd: sql`${researchTokenUsage.cumulativeCostUsd} + ${costUsd}`,
          updatedAt: new Date(),
        },
      });
  }

  async getCost(correlationId: string): Promise<number> {
    const rows = await this.db
      .select({ total: researchTokenUsage.cumulativeCostUsd })
      .from(researchTokenUsage)
      .where(eq(researchTokenUsage.correlationId, correlationId))
      .limit(1);
    return rows[0]?.total ?? 0;
  }
```

- [ ] **Step 8: Generate the migration + verify additive**

Run: `pnpm db:generate`
Expected: a new `migrations/0012_*.sql` containing only `ALTER TABLE "research_token_usage" ADD COLUMN "cumulative_cost_usd" double precision DEFAULT 0 NOT NULL` (additive — column add only, no drops). Inspect the file; if `db:generate` produces unexpected drift, STOP.

- [ ] **Step 9: Typecheck + commit**

Run: `pnpm typecheck` → clean.

```bash
git add src/ports/token-usage.repository.ts src/adapters/repository/in-memory-token-usage.repository.ts src/adapters/repository/in-memory-token-usage.repository.test.ts src/adapters/repository/drizzle-token-usage.repository.ts src/db/schema.ts migrations/
git commit -m "feat(cost): persist cumulative_cost_usd per correlationId (addCost/getCost + migration)"
```

---

### Task 4: Wire pricing into services + accrue cost in the cycle handlers

**Files:**
- Modify: `src/orchestrator/app-services.ts`
- Modify: `src/composition.ts`
- Modify: `test/support/make-services.ts`
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts`, `src/orchestrator/handlers/hypothesis-build.handler.ts`
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.test.ts`

**Interfaces:**
- Consumes: `ModelPricingPort` (Task 1), `AgentCallUsage` (Task 2), `addCost` (Task 3).
- Produces: `AppServices.modelPricing: ModelPricingPort`; the handler `onUsage` callbacks now also price the call and `addCost`.

- [ ] **Step 1: Add the service field**

In `src/orchestrator/app-services.ts`, import `import type { ModelPricingPort } from '../ports/model-pricing.port.ts';` and add to `interface AppServices` (after `tokenUsage`):

```ts
  modelPricing: ModelPricingPort;
```

- [ ] **Step 2: Wire production + test composition**

In `src/composition.ts`: import `import { OpenRouterModelPricing } from './adapters/pricing/openrouter-model-pricing.ts';` and add to the services object: `modelPricing: new OpenRouterModelPricing(),`.

In `test/support/make-services.ts`: add `import { NullModelPricing } from '../../src/adapters/pricing/null-model-pricing.ts';` and add `modelPricing: new NullModelPricing(),` to the returned services object.

- [ ] **Step 3: Typecheck — wiring compiles**

Run: `pnpm typecheck`
Expected: clean (every `AppServices` builder now supplies `modelPricing`).

- [ ] **Step 4: Write the failing cost-accrual test**

Add to `src/orchestrator/handlers/research-run-cycle.handler.test.ts` a test with a fake pricing returning a known price and a researcher reporting a split:

```ts
import type { ModelPricingPort } from '../../ports/model-pricing.port.ts';

it('accrues $ cost from priced researcher usage', async () => {
  const tokenUsage = new InMemoryTokenUsageRepository();
  const modelPricing: ModelPricingPort = {
    async priceFor(id) { return id === 'm-test' ? { inputUsdPerToken: 0.00001, outputUsdPerToken: 0.00003 } : null; },
  };
  const researcher: ResearcherPort = {
    adapter: 'fake', model: 'test',
    async propose(_i, opts) {
      await opts?.onUsage?.({ modelId: 'm-test', inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
      return { researchSummary: 's', hypotheses: [] };
    },
  };
  const services = makeServices({ tokenUsage, modelPricing, researcher });
  const task = makeRunCycleTask();
  await researchRunCycleHandler(task, services);
  // 1000*0.00001 + 500*0.00003 = 0.01 + 0.015 = 0.025
  expect(await tokenUsage.getCost(task.correlationId)).toBeCloseTo(0.025, 10);
  expect(await tokenUsage.get(task.correlationId)).toBe(1500); // tokens still recorded
});
```

- [ ] **Step 5: Run it — verify it fails**

Run: `pnpm test -- src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: FAIL — `getCost` is 0 (handler does not price yet).

- [ ] **Step 6: Add cost accrual to the handler callbacks**

In `src/orchestrator/handlers/research-run-cycle.handler.ts`, replace each `{ onUsage: (u) => services.tokenUsage.add(task.correlationId, u.totalTokens) }` (researcher + critic) with an async callback that also prices:

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
    }
```

Apply the identical callback to `services.builder.build(...)` in `src/orchestrator/handlers/hypothesis-build.handler.ts` (it has `task` + `services` + the `event` import; if `event` is not already imported there, import it from `./backtest-support.ts` as the other handlers do).

- [ ] **Step 7: Run the test + full suite + typecheck**

Run: `pnpm test -- src/orchestrator/handlers/research-run-cycle.handler.test.ts` → PASS.
Run: `pnpm typecheck && pnpm test` → green (existing handler tests use `NullModelPricing` → `priceFor` null → cost stays 0, `research.cost_unpriced` may be emitted but does not affect their assertions; confirm none assert an exact full event list — if one does, it will need the new event accounted for, treat as part of this task).

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/app-services.ts src/composition.ts test/support/make-services.ts src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/hypothesis-build.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(cost): price each cycle LLM call and accrue \$ per correlationId"
```

---

### Task 5: Surface cost-per-run (event + completion summary)

**Files:**
- Modify: `src/orchestrator/handlers/backtest-completed.handler.ts` (emit `research.run_cost`)
- Modify: `src/orchestrator/handlers/backtest-completed.handler.test.ts`
- Modify: `src/read-api/completion-summary.ts` (`costUsd` field + read `getCost`)
- Modify: `src/read-api/completion-summary.test.ts`
- Modify: `src/read-api/deps.ts` (add `tokenUsage` to `ReadApiDeps`) + `src/composition.ts` (wire it into the `read: ReadApiDeps` object). The completion-summary route already passes `ReadApiDeps` straight to `buildCompletionSummary`, so no route change is needed.

**Interfaces:**
- Consumes: `getCost` (Task 3).
- Produces: a `research.run_cost` `{ correlationId, costUsd, totalTokens }` event at backtest completion; `BacktestCompletedCompletionSummary.costUsd: number`.

- [ ] **Step 1: Write the failing event test**

Add to `src/orchestrator/handlers/backtest-completed.handler.test.ts`:

```ts
it('emits research.run_cost with the chain cost at completion', async () => {
  const tokenUsage = new InMemoryTokenUsageRepository();
  const task = makeBacktestCompletedTask({ decision: 'PASS', cycleDepth: 0 });
  await tokenUsage.add(task.correlationId, 1500);
  await tokenUsage.addCost(task.correlationId, 0.025);
  const services = makeServices({ tokenUsage });
  await backtestCompletedHandler(task, services);
  const ev = (await services.events.list({ taskId: task.id, limit: 50 })).find((e) => e.type === 'research.run_cost');
  expect(ev?.payload).toMatchObject({ correlationId: task.correlationId, costUsd: 0.025, totalTokens: 1500 });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm test -- src/orchestrator/handlers/backtest-completed.handler.test.ts`
Expected: FAIL — no `research.run_cost` event.

- [ ] **Step 3: Emit the event**

In `src/orchestrator/handlers/backtest-completed.handler.ts`, near the end (alongside the existing `backtest.result_ready` append), add:

```ts
  await services.events.append(event(task.id, 'research.run_cost', {
    correlationId: task.correlationId,
    costUsd: await services.tokenUsage.getCost(task.correlationId),
    totalTokens: await services.tokenUsage.get(task.correlationId),
  }));
```

- [ ] **Step 4: Run the event test — verify it passes**

Run: `pnpm test -- src/orchestrator/handlers/backtest-completed.handler.test.ts` → PASS.

- [ ] **Step 5: Write the failing completion-summary test**

Add to `src/read-api/completion-summary.test.ts` a backtest.completed case whose deps include a `tokenUsage` with `getCost` returning a known value; assert the summary's `costUsd`:

```ts
it('surfaces costUsd from tokenUsage.getCost', async () => {
  const task = { id: 't1', taskType: 'backtest.completed', status: 'completed', correlationId: 'c1',
    payload: { decision: 'PASS', cycleDepth: 0, strategyProfileId: 'p1', reasons: [] } };
  const deps = makeCompletionDeps({ task, tokenUsage: { getCost: async () => 0.042 } });
  const summary = await buildCompletionSummary(deps, 't1');
  expect((summary as { costUsd: number }).costUsd).toBe(0.042);
});
```

(Adapt to the test file's actual deps factory; the essential addition is a `tokenUsage.getCost` stub.)

- [ ] **Step 6: Run it — verify it fails**

Run: `pnpm test -- src/read-api/completion-summary.test.ts`
Expected: FAIL — `costUsd` is undefined / `tokenUsage` not in deps.

- [ ] **Step 7: Add `costUsd` to the summary**

In `src/read-api/completion-summary.ts`:
- Add to `CompletionSummaryDeps`: `tokenUsage: Pick<TokenUsageRepository, 'getCost'>;` (import the type).
- Add `costUsd: number;` to `interface BacktestCompletedCompletionSummary`.
- In `buildBacktestCompleted`, compute `const costUsd = (await safe('cost_read_failed', () => deps.tokenUsage.getCost(task.correlationId))) ?? 0;` and add `costUsd,` to the returned object.

- [ ] **Step 8: Thread `tokenUsage` into `ReadApiDeps`**

The completion-summary route passes `ReadApiDeps` (from `src/read-api/deps.ts`) directly to `buildCompletionSummary`, so `ReadApiDeps` must structurally satisfy the extended `CompletionSummaryDeps`:
- In `src/read-api/deps.ts`, import `import type { TokenUsageRepository } from '../ports/token-usage.repository.ts';` and add to `interface ReadApiDeps` (next to `researchTasks`/`strategyProfiles`): `tokenUsage: Pick<TokenUsageRepository, 'getCost'>;`
- In `src/composition.ts`, in the `const read: ReadApiDeps = { ... }` object (around line 274, where `researchTasks: services.researchTasks` is set), add `tokenUsage: services.tokenUsage,`.
- The route file needs no change.

- [ ] **Step 9: Run completion-summary tests + full suite + typecheck**

Run: `pnpm test -- src/read-api/completion-summary.test.ts` → PASS.
Run: `pnpm typecheck && pnpm test` → green.

- [ ] **Step 10: Commit**

```bash
git add src/orchestrator/handlers/backtest-completed.handler.ts src/orchestrator/handlers/backtest-completed.handler.test.ts src/read-api/completion-summary.ts src/read-api/completion-summary.test.ts src/read-api/routes/completion-summary.ts
git commit -m "feat(cost): surface cost-per-run via research.run_cost event + completion-summary costUsd"
```

---

## Self-Review

**1. Spec coverage:**
- §1 ModelPricingPort + OpenRouter (TTL cache, fail-soft, openrouter/ strip) + Null default → Task 1.
- §2 onUsage → AgentCallUsage (input/output split + modelId) → Task 2.
- §3 per-call cost accrual (price≠null → addCost; null → warning) in both cycle handlers → Task 4.
- §4 persistence: `cumulative_cost_usd` column + addCost/getCost + additive migration → Task 3.
- §5 surface: `research.run_cost` event + completion-summary `costUsd` → Task 5.
- Fail-soft (null → 0 + warning, never break) → Task 1 (adapter) + Task 4 (`research.cost_unpriced`).
- NullModelPricing default in tests / OpenRouter in composition → Tasks 1, 4.
- Token budget (PR #86) unaffected → Task 2 keeps recording totalTokens; verified by full suite each task.
- Done criteria 1–4 → Tasks 4+5 (accrual+surface), 1 (fail-soft), 4 (Null default), 3 (additive migration) + green suite each task.

**2. Placeholder scan:** No TBD/"handle errors"/"similar to". Code shown for every code step. The "adapt to the test file's actual deps factory / deps-assembly site" notes (Tasks 4–5) name the exact field to add and its role — concrete, not placeholders; they accommodate helper names this plan can't see without guessing.

**3. Type consistency:** `ModelPrice { inputUsdPerToken, outputUsdPerToken }` and `ModelPricingPort.priceFor(): Promise<ModelPrice|null>` identical across Tasks 1, 4. `AgentCallUsage { modelId, inputTokens, outputTokens, totalTokens }` identical across Tasks 2, 4. `addCost(correlationId, costUsd)` / `getCost(correlationId): Promise<number>` identical across Tasks 3, 4, 5. `AppServices.modelPricing` identical across Tasks 4. Event `research.run_cost` payload `{ correlationId, costUsd, totalTokens }` identical across Tasks 5 (emit) and its test. `research.cost_unpriced { modelId }` only in Task 4.
