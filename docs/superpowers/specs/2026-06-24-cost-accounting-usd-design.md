# Live $ Cost Accounting (Slice 1a) — Design

**Date:** 2026-06-24
**Status:** Approved (design); ready for implementation plan
**Roadmap:** diploma metrics 🟡 "cost per run"; foundation for the $-budget economy (Slices 2–4)
**Builds on:** token counting per `correlationId` (`research_token_usage`, shipped PR #86) + Phoenix tracing (PR #85).

## Goal

Compute the **dollar cost of each research run** live, from the LLM token usage we already
capture, priced via OpenRouter. This closes the "cost per run" diploma 🟡 and produces the
`$` primitive the budget economy (later slices) needs. Cost is observability/accounting only
— it does not gate anything in this slice (the token kill-switch from PR #86 still guards
runaway loops).

## Scope decisions (settled with user, 2026-06-24)

This is **Slice 1a** of a two-part metrics effort:
- **1a (this spec):** live per-run `$` cost accounting.
- **1b (next):** publish the diploma metrics — add p95 + cost to the eval aggregates, run the
  benchmark (≥10 cases), fill README 🟡 (latency p95, cost per run, success rate). Out of scope here.

Settled for 1a:
1. **Accuracy:** input/output token split — `cost = inputTokens × inPrice + outputTokens × outPrice`. Extend the usage capture from `totalTokens` to `{inputTokens, outputTokens, totalTokens}` + the model id.
2. **Price source:** **OpenRouter `/models` API** (live), cached with TTL, **fail-soft** (unavailable / unknown model → cost contribution 0 + a warning code; the run never breaks).
3. **Surface:** live per-research-run `$` (persisted per `correlationId`, surfaced in an event + completion-summary + a Phoenix span attribute). Benchmark-time cost is 1b.

## Verified facts (OpenRouter contract, checked live 2026-06-24)

`GET https://openrouter.ai/api/v1/models` is public (no auth), returns `{ data: [{ id, pricing: { prompt, completion, ... }, ... }] }`. `pricing.prompt` / `pricing.completion` are **USD-per-token** decimal strings (e.g. `google/gemini-3.1-flash-lite` → prompt `0.00000025`, completion `0.0000015`). Our models are present: `google/gemini-3.1-flash-lite`, `anthropic/claude-sonnet-4.6`, `x-ai/grok-4.3`, `openai/gpt-5.5-pro`.

**Model-id mapping:** our model ids carry a provider-override prefix (`openrouter/google/gemini-3.1-flash-lite`); the OpenRouter lookup key is the id with a leading `openrouter/` stripped (`google/gemini-3.1-flash-lite`) — which matches OpenRouter's `id` exactly when routed through OpenRouter. A direct, non-OpenRouter id (e.g. `anthropic/claude-sonnet-4-6`, note `-6` vs OpenRouter's `.6`) may not match → fail-soft null + warning. Since the live operator/research path routes via OpenRouter, the common case matches; mismatches degrade gracefully.

## Architecture

### 1. `ModelPricingPort` + OpenRouter adapter

```ts
// src/ports/model-pricing.port.ts
export interface ModelPrice { inputUsdPerToken: number; outputUsdPerToken: number; }
export interface ModelPricingPort {
  /** Price for a model id, or null when unknown / pricing is unavailable (fail-soft). */
  priceFor(modelId: string): Promise<ModelPrice | null>;
}
```

`OpenRouterModelPricing` (`src/adapters/pricing/openrouter-model-pricing.ts`):
- Fetches `/models` once, builds `Map<openrouterId, ModelPrice>` from `pricing.prompt`/`pricing.completion` (parseFloat). Caches with a TTL (default ~6h); a background staleness refresh is out of scope — a TTL miss re-fetches on the next call.
- `priceFor(modelId)`: normalize (strip a leading `openrouter/`), look up the map. On fetch failure or a missing key → return `null` (never throw). Injected `fetch` + `clock` for deterministic tests.
- A `NullModelPricing` (always `null`) is the default when no pricing is wired (mirrors the `Disabled*`/no-op pattern), so existing flows are untouched until pricing is enabled.

### 2. Extend usage capture (`AgentCallOpts`)

`onUsage` changes from `(totalTokens: number)` to carry the split + model:

```ts
// src/ports/agent-call-opts.ts
export interface AgentCallUsage { modelId: string; inputTokens: number; outputTokens: number; totalTokens: number; }
export interface AgentCallOpts { onUsage?: (usage: AgentCallUsage) => void | Promise<void>; }
```

The three Mastra adapters (researcher/builder/critic) call
`await opts?.onUsage?.({ modelId: this.model, inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0, totalTokens: result.usage?.totalTokens ?? 0 })`
immediately after `generate`, before schema parse (unchanged ordering). Fakes ignore it.

> This re-touches the PR #86 `onUsage`/token-budget plumbing. It is an extension: the
> token-budget gate keeps recording `totalTokens` (input+output) and is unaffected.

### 3. Per-call cost accrual (in the cycle handlers)

Cost must be summed **per call** (a chain mixes models with different prices — researcher,
builder, critic may differ), so it cannot be derived from chain token totals. The handler
`onUsage` callback now does both:

```ts
onUsage: async (u) => {
  await services.tokenUsage.add(task.correlationId, u.totalTokens);          // existing budget counter
  const price = await services.modelPricing.priceFor(u.modelId);
  if (price) {
    const costUsd = u.inputTokens * price.inputUsdPerToken + u.outputTokens * price.outputUsdPerToken;
    await services.tokenUsage.addCost(task.correlationId, costUsd);
  } else {
    // fail-soft: cost unknown for this model — record nothing, emit a warning event/log
  }
}
```

Wired at all three call sites (researcher.propose + critic.review in `research-run-cycle.handler`, builder.build in `hypothesis-build.handler`).

### 4. Persistence

Extend `research_token_usage`: add `cumulative_cost_usd double precision NOT NULL DEFAULT 0`
(additive migration). `TokenUsageRepository` gains `addCost(correlationId, usd)` (upsert-increment)
+ `getCost(correlationId): Promise<number>`. `cost per run = getCost(correlationId)`.

### 5. Surface cost-per-run

On run completion, emit `research.run_cost` `{ correlationId, costUsd, totalTokens }` (ids/numbers
only — privacy invariant holds). `buildBacktestCompleted` (completion-summary) gains a `costUsd`
field read from `getCost`. The Phoenix span carries `costUsd` as an attribute (best-effort; absence
never breaks). Where exactly the event fires (cycle vs backtest completion) follows the existing
event-emission points; the value is always `getCost(correlationId)` at that moment.

## Testing (TDD)

- `OpenRouterModelPricing` (injected fake `fetch`): parses `/models` into prices; `priceFor`
  strips the `openrouter/` prefix and matches; cache hit avoids a second fetch within TTL; a
  TTL-expired call re-fetches; fetch failure → `null` (no throw); unknown id → `null`.
- Cost math: `in×inPrice + out×outPrice`; `price=null` → contributes 0 + a warning is recorded.
- `TokenUsageRepository` (in-memory): `addCost` accumulates; `getCost` 0 when absent; per-correlationId isolation; tokens and cost tracked independently.
- Cycle handlers: with a fake reporting `AgentCallUsage` and a fake pricing returning a known price, `getCost(correlationId)` equals the expected `$`; with `NullModelPricing`, cost stays 0 and the token budget still records.
- `completion-summary`: `costUsd` field reflects `getCost`.
- Existing token-budget + adapter tests stay green (the `onUsage` shape change is updated at all call sites; `NullModelPricing` is the default so cost is 0 unless wired).

## Out of scope

- **1b:** p95 + cost in the eval aggregates, the benchmark run, README 🟡 fill-in.
- **Slice 2+:** the $-budget cap (`RESEARCH_TASK_BUDGET_USD`), ledger, P&L crediting, paid subscriptions.
- Prompt-caching discount accounting (`input_cache_read` pricing), web-search pricing.
- A persisted price snapshot / historical price table (the in-memory TTL cache suffices here).

## Done criteria

1. A research run accrues a `$` cost per `correlationId` = Σ per-call `(in×inPrice + out×outPrice)`, priced from OpenRouter, surfaced via `research.run_cost` + the completion-summary `costUsd` field.
2. OpenRouter unavailable or an unpriced model → cost degrades to 0 for that call + a warning; the run never breaks; the token budget is unaffected.
3. `NullModelPricing` default keeps existing behavior (cost 0) until pricing is wired in composition.
4. Full suite green; migration additive; the token-budget gate (PR #86) still works.
