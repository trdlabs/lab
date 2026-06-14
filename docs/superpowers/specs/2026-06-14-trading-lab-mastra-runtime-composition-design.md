# Mastra Runtime Composition Cleanup — Design

**Date:** 2026-06-14
**Status:** Approved (ready for implementation plan)
**Type:** Brownfield refactor / architectural cleanup
**One-liner:** Centralize Mastra `Agent` creation into a `src/mastra/**` composition layer with a single `new Mastra({ agents })` instance; adapters receive a pre-built `Agent` instead of constructing one. Behavior unchanged. Prepares (does not implement) the seam for future Langfuse / Mastra-native observability.

---

## 1. Goal & motivation

trading-lab is a research-only multi-agent system on top of trading-platform, assembled as a **deterministic orchestrator** (Hono ingress, BullMQ worker, Postgres repositories, `WorkflowRouter`, handlers, agent adapters).

Today Mastra is used *inside* adapter classes: `MastraStrategyAnalyst`, `MastraResearcher`, `MastraCritic`, `MastraBuilder`, `MastraIntentClassifier` each call `new Agent(...)` in their own constructor and invoke `agent.generate(...)`. There is **no central `new Mastra(...)` instance** anywhere in the codebase.

This works, but it is not Mastra-native: Mastra-native observability (and later Langfuse) is configured on a `Mastra` *instance* (`new Mastra({ observability/telemetry, agents })`). Without a central instance there is no seam to plug telemetry into. This feature creates that central composition boundary so a *future, separate* Langfuse / governance-telemetry feature can attach cleanly.

This is a **small, safe cleanup**, not a rewrite. It does not move orchestration onto Mastra Workflows.

## 2. Current state (as found)

- **Composition root** — `src/composition.ts::composeRuntime()` is the single composition root. It has five `buildXxx(env)` helpers (`buildAnalyst`, `buildResearcher`, `buildCritic`, `buildIntentClassifier`, `buildBuilder`). Each checks `env.XXX_ADAPTER === 'mastra'`; if so it resolves a model via `resolveLanguageModel(env, env.XXX_MODEL)` and returns `new MastraXxx(r.model, r.label)`; otherwise it logs a `console.warn` and returns the Fake adapter. `buildCritic` additionally returns `null` when `!env.ENABLE_CRITIC_AGENT` (no warn).
- **Model provider** — `src/adapters/llm/model-provider.ts::resolveLanguageModel(env, roleModelId)` returns `{ model, provider, modelId, label }`. `ProviderModel` is the ai-sdk language-model type. `parseRoleModel` supports `anthropic|openai|openrouter` override prefixes. Key-missing → throws. **Unchanged by this feature.**
- **Mastra adapters** — five files, all the same shape:
  - `readonly adapter = 'mastra' as const`
  - `readonly model: string` (set to `label`; consumed by `agent_event` audit in handlers)
  - `private readonly agent: Agent`
  - `constructor(model: ProviderModel, label: string)` → `this.agent = new Agent({ id, name, instructions: INSTRUCTIONS, model })`
  - a port method calling `this.agent.generate(prompt, { structuredOutput: { schema } })` then `Schema.parse(result.object)`
  - module-level `INSTRUCTIONS` and `buildPrompt(...)`
  - Agent ids in use: `strategy-analyst`, `researcher`, `critic`, `builder`, `intent-classifier`.
- **Ports** — `StrategyAnalystPort`, `ResearcherPort`, `CriticPort`, `BuilderPort`, `IntentClassifierPort`. **Unchanged.**
- **Adapter tests** — each adapter has a `*.test.ts` with a "construction" block (always runs; resolves a model with a `dummy` key and asserts `adapter`/`model` fields) and a "live" block gated by `RUN_LLM_TESTS === 'true' && ANTHROPIC_API_KEY`. All construct `new MastraXxx(model, label)`.
- **Test fixtures** — `test/support/make-services.ts::makeServices()` wires only Fake/in-memory adapters and never imports `src/mastra/**`. Tests run without LLM keys.

Constructor call-sites of the Mastra adapters (must be updated): `src/composition.ts` (×5) and the five `src/adapters/**/*.test.ts` files. No other callers.

## 3. Scope boundary

**In scope**
- New `src/mastra/**` layer: per-agent definition files + a `compose-mastra.ts` with the single `new Mastra({ agents })`.
- Move `Agent` construction + `id`/`name`/`INSTRUCTIONS` out of adapters into `src/mastra/agents/*.agent.ts`.
- Change the five adapter constructors to accept a pre-built `Agent`.
- Rewire `composition.ts` to delegate Mastra composition to `composeMastra(env)` and expose a `mastraRuntime` handle.
- Update adapter tests; add a `compose-mastra` test and an import-boundary guard test.

**Out of scope (explicitly)**
- Langfuse / observability / governance telemetry — only the *seam* is prepared (central instance + `mastraRuntime` handle).
- Mastra Workflows — orchestration stays on `WorkflowRouter`.
- Any change to the deterministic orchestrator: BullMQ stays the queue layer, `WorkflowRouter` the dispatch layer, handlers stay owners of task lifecycle / validation / repository writes / platform calls / `agent_event` audit, Postgres stays canonical state.
- Any change to `@trading-platform/sdk` or trading-platform. This feature does **not** depend on a fixed SDK.
- `model-provider.ts` logic, the five ports, domain schemas, handlers.

## 4. Target architecture

### 4.1 Layout

```
src/mastra/
  agents/
    strategy-analyst.agent.ts
    researcher.agent.ts
    critic.agent.ts
    builder.agent.ts
    intent-classifier.agent.ts
  compose-mastra.ts
  index.ts
```

`src/mastra/**` is the **only** place that imports the *value* `Agent` from `@mastra/core/agent` and the only place that calls `new Agent(...)` / `new Mastra(...)`.

### 4.2 Agent definition files (`src/mastra/agents/*.agent.ts`)

Each owns only the agent definition. INSTRUCTIONS text moves verbatim from the adapter.

```ts
// src/mastra/agents/researcher.agent.ts
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const RESEARCHER_AGENT_ID = 'researcher';

const INSTRUCTIONS = [ /* moved verbatim from mastra-researcher.ts */ ].join(' ');

export function createResearcherAgent(model: ProviderModel): Agent {
  return new Agent({ id: RESEARCHER_AGENT_ID, name: 'Researcher', instructions: INSTRUCTIONS, model });
}
```

Agent id constants are exported so `composeMastra` registration keys and `getAgent(...)` lookups agree. `name` values are preserved exactly (`Strategy Analyst`, `Researcher`, `Critic`, `Builder`, `Intent Classifier`).

### 4.3 `composeMastra(env)` — the single `new Mastra(...)`

```ts
// src/mastra/compose-mastra.ts
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { resolveLanguageModel, type ModelProviderEnv } from '../adapters/llm/model-provider.ts';
import { createStrategyAnalystAgent, STRATEGY_ANALYST_AGENT_ID } from './agents/strategy-analyst.agent.ts';
// ... other agent factories

export interface MastraCompositionEnv extends ModelProviderEnv {
  STRATEGY_ANALYST_ADAPTER: string;  STRATEGY_ANALYST_MODEL: string;
  RESEARCHER_ADAPTER: string;        RESEARCHER_MODEL: string;
  CRITIC_ADAPTER: string;            CRITIC_MODEL: string;   ENABLE_CRITIC_AGENT: boolean;
  INTENT_CLASSIFIER_ADAPTER: string; INTENT_CLASSIFIER_MODEL: string;
  BUILDER_ADAPTER: string;           BUILDER_MODEL: string;
}

export interface MastraAgentEntry { agent: Agent; label: string; }

export interface MastraRuntime {
  mastra: Mastra;
  agents: {
    analyst?: MastraAgentEntry;
    researcher?: MastraAgentEntry;
    critic?: MastraAgentEntry;
    builder?: MastraAgentEntry;
    intentClassifier?: MastraAgentEntry;
  };
}

export function composeMastra(env: MastraCompositionEnv): MastraRuntime { /* see below */ }
```

Behavior of `composeMastra`:
1. For each role decide mastra-mode: analyst/researcher/builder/intent when `XXX_ADAPTER === 'mastra'`; critic when `ENABLE_CRITIC_AGENT && CRITIC_ADAPTER === 'mastra'`.
2. For each mastra-mode role: `const r = resolveLanguageModel(env, env.XXX_MODEL)` (same call, same args, same key-missing throw and ordering), build the agent with the role factory, accumulate into a `Record<string, Agent>` keyed by agent id, and remember the `label` (`r.label`).
3. `const mastra = new Mastra({ agents })` (registering only the enabled agents; possibly an empty object — see Spike).
4. Build `agents` entries by retrieving each registered agent via `mastra.getAgent(id)` so the adapter holds an agent **from the runtime** (telemetry-wired at registration), paired with its `label`.
5. Return `{ mastra, agents }`.

`MastraCompositionEnv` is a narrow interface (not `ReturnType<typeof loadEnv>`) so `composeMastra` is unit-testable with a hand-built env object; the real `loadEnv()` return is assignable to it.

### 4.4 Adapter changes (×5, mechanically identical)

```ts
// src/adapters/researcher/mastra-researcher.ts
import type { Agent } from '@mastra/core/agent';   // TYPE-ONLY now
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import { ResearcherOutputSchema, type ResearcherOutput } from '../../domain/hypothesis.ts';

function buildPrompt(input: ResearcherInput): string { /* UNCHANGED — stays in adapter */ }

export class MastraResearcher implements ResearcherPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async propose(input: ResearcherInput): Promise<ResearcherOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: ResearcherOutputSchema },
    });
    return ResearcherOutputSchema.parse(result.object);
  }
}
```

- Removed from the adapter: value import of `Agent`, `new Agent(...)`, `INSTRUCTIONS`, the `ProviderModel` import.
- Kept in the adapter: `buildPrompt(...)`, the output schema, `agent.generate(...)`, `Schema.parse(...)`, and the `adapter`/`model` fields. **The port contract and `agent_event` audit fields are unchanged, so handlers are not touched.**

### 4.5 `composition.ts` changes

- `composeRuntime()` calls `const mastraRuntime = composeMastra(env)` near the top (after `loadEnv`, before `services`).
- The five `buildXxx(env)` helpers become `buildXxx(env, mastraRuntime)` and shrink to:

```ts
function buildResearcher(env, rt: MastraRuntime): ResearcherPort {
  const e = rt.agents.researcher;
  if (e) return new MastraResearcher(e.agent, e.label);
  console.warn('[composition] RESEARCHER_ADAPTER is not "mastra"; using FakeResearcher (stub hypotheses)');
  return new FakeResearcher();
}
```

- `buildCritic` keeps its disabled branch exactly: `if (!env.ENABLE_CRITIC_AGENT) return null;` (no warn) **before** consulting `rt.agents.critic`.
- All five `console.warn` strings are preserved verbatim.
- `composeRuntime` adds `mastraRuntime` to its return object: `{ env, db, pool, queue, router, services, chat, read, mastraRuntime }`. This exposes both the `Mastra` handle and the per-role agent metadata for a future Langfuse / governance feature.

## 5. Model & label flow (behavior preservation)

- Per-role model resolution still goes through `resolveLanguageModel(env, env.XXX_MODEL)` with identical arguments → provider override prefixes, per-role model ids, and key-missing `throw` behavior are byte-for-byte preserved; only the *call site* moves from `buildXxx` into `composeMastra`.
- The audit `label` (original `*_MODEL` env value) flows `resolveLanguageModel → MastraAgentEntry.label → adapter.model`. Handlers reading `services.<role>.model` / `.adapter` see the same values.

## 6. Critic special-case (must be preserved exactly)

| `ENABLE_CRITIC_AGENT` | `CRITIC_ADAPTER` | Result (today and after) |
|---|---|---|
| false | any | `buildCritic` returns `null`, **no warn**, critic not registered in Mastra |
| true | `'mastra'` | `MastraCritic` from `rt.agents.critic` |
| true | not `'mastra'` | `console.warn(... 'ENABLE_CRITIC_AGENT=true but CRITIC_ADAPTER is not "mastra"; using FakeCritic')` + `FakeCritic` |

`composeMastra` only registers a critic agent when `ENABLE_CRITIC_AGENT && CRITIC_ADAPTER === 'mastra'`. The `!ENABLE_CRITIC_AGENT → null` decision stays in `composition.ts::buildCritic` (which still receives `env`).

## 7. Testing

### 7.1 `src/mastra/compose-mastra.test.ts` (new)
With `MODEL_PROVIDER: 'anthropic'`, `ANTHROPIC_API_KEY: 'dummy'` (no network — `resolveLanguageModel` only constructs the provider) and a hand-built `MastraCompositionEnv`:
- One role mastra (e.g. `RESEARCHER_ADAPTER: 'mastra'`, `RESEARCHER_MODEL: 'anthropic/claude-sonnet-4-6'`), others fake → `agents.researcher` defined, `agents.researcher.label === 'anthropic/claude-sonnet-4-6'`, `mastra.getAgent('researcher').name === 'Researcher'`, and `agents.analyst === undefined`.
- Critic gating: `ENABLE_CRITIC_AGENT: false` + `CRITIC_ADAPTER: 'mastra'` → `agents.critic === undefined`.
- All-fake env → empty registration path (assert per Spike outcome: empty `agents` object or skipped instance).

### 7.2 Adapter `*.test.ts` (update ×5)
Construction block: resolve a model with the `dummy` key, build the agent via the role factory (`createResearcherAgent(model)`), then `new MastraResearcher(agent, label)`; assert `adapter`/`model` unchanged. Live block (`RUN_LLM_TESTS`): same one-line construction change; assertions unchanged. (Optional, low-cost enhancement: a fake-`Agent` double exercising `buildPrompt` + `Schema.parse` without an LLM — locks adapter behavior and is now possible thanks to injection. Include if cheap.)

### 7.3 Import-boundary guard (new) — `src/mastra/mastra-import-boundary.guard.test.ts`
Modeled on the existing `src/adapters/platform/sdk-import-boundary.guard.test.ts` (the `@trading-platform/*` SDK guard; `*.guard.test.ts` co-located convention). The guard asserts that **value** imports of `@mastra/core` (and `@mastra/core/agent`), `new Agent(`, and `new Mastra(` appear **only** under `src/mastra/**`. **Type-only** imports (`import type { Agent } from '@mastra/core/agent'`) in `src/adapters/**` are explicitly **allowed**. The guard must distinguish `import type` / `import { type Agent }` from value imports.

## 8. Spike (implementation Task 0 — do before touching adapters)

Verify exact semantics against the installed `@mastra/core@^1.41.0` before the mechanical refactor (mirrors the SP-7 "verify real SDK exports" spike):
1. `new Mastra({ agents })` constructs successfully with a `Record<string, Agent>`.
2. `mastra.getAgent(...)` exists and returns the registered `Agent`.
3. **Lookup key:** does `getAgent` resolve by the `agents` map **key**, or by `Agent.id`? (Determines whether map key must equal the agent id constant — design assumes key === id; confirm or adjust.)
4. **Empty agents:** is `new Mastra({ agents: {} })` supported (the all-adapters-fake path)? If not supported / noisy, the fallback is to construct the `Mastra` instance only when ≥1 agent is enabled and make `mastraRuntime.mastra` optional, or pass `agents: undefined`. Decide and record the chosen handling.

The spike's findings may refine §4.3 step 3–4 and §7.1's all-fake assertion; capture them in the plan.

## 9. Behavior-preservation guarantees

- Workflows behave identically: same model resolution, same Fake fallback, same warn strings, same audit fields, same `generate` + `parse`.
- Fakes work without LLM keys: `make-services.ts` and tests never import `src/mastra/**`; the Fake path is unchanged.
- Mastra adapters work with current model/provider settings: resolution path is identical.
- `composeRuntime` remains the composition root; it only delegates Mastra-specific composition and exposes a handle.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `getAgent` lookup semantics differ from assumption | Spike Task 0 resolves before the mechanical refactor |
| Empty `agents` object unsupported by Mastra | Spike Task 0; fallback = build instance only when ≥1 agent, optional `mastra` handle |
| Adapter constructor change misses a call-site | Call-sites enumerated (composition ×5, tests ×5); `tsc` + full Vitest run is the gate |
| Registration doesn't wire telemetry onto retrieved agent | Retrieve via `mastra.getAgent(id)` (not the pre-registration `Agent` object); confirmed in Spike |
| Guard test false-positives on `import type` | Guard explicitly allows type-only imports; unit-asserted both ways |

## 11. Out of scope / future seam

The central `Mastra` instance and the `mastraRuntime` handle (with `mastra` + per-role `agents` metadata) are the attachment point for a future **Langfuse Observability / Governance Telemetry** feature: that feature will configure `observability`/`telemetry`/exporters on the `new Mastra({...})` call and consume `mastraRuntime` from `composeRuntime`. No telemetry is added now.

## 12. File-by-file change list

**New**
- `src/mastra/agents/strategy-analyst.agent.ts`, `researcher.agent.ts`, `critic.agent.ts`, `builder.agent.ts`, `intent-classifier.agent.ts`
- `src/mastra/compose-mastra.ts`
- `src/mastra/index.ts`
- `src/mastra/compose-mastra.test.ts`
- `src/mastra/mastra-import-boundary.guard.test.ts` (modeled on `src/adapters/platform/sdk-import-boundary.guard.test.ts`)

**Modified**
- `src/adapters/analyst/mastra-strategy-analyst.ts`, `researcher/mastra-researcher.ts`, `critic/mastra-critic.ts`, `builder/mastra-builder.ts`, `intent/mastra-intent-classifier.ts` (constructor + remove Agent construction/INSTRUCTIONS; keep `buildPrompt`/schema/parse)
- the matching five `*.test.ts` (construction call updated)
- `src/composition.ts` (`composeMastra` wiring, `buildXxx` slimmed, `mastraRuntime` in return)

**Unchanged**
- `src/adapters/llm/model-provider.ts`, the five ports, `app-services.ts`, `test/support/make-services.ts`, all handlers, `workflow-router.ts`, BullMQ/Postgres adapters, domain schemas.
