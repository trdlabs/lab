# Analyst Prompt + max_tokens Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap every `agent.generate(...)` call in the codebase at `maxOutputTokens: 16384` to fix OpenRouter 402 over-reservation, and extend the `StrategyAnalyst` agent `INSTRUCTIONS` with exhaustive structured-extraction guidance to improve grok-analyst completeness.

**Architecture:** A new `src/adapters/llm/generate-defaults.ts` exports `MAX_OUTPUT_TOKENS = 16384`; every adapter and experiment judge imports it and passes `modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS }` alongside the existing `structuredOutput` in every `agent.generate(...)` options object. The `INSTRUCTIONS` constant in `strategy-analyst.agent.ts` is extended with five numbered extraction sections (entry conditions, exit & invalidation, required market-data features, position management, tunable params) while preserving the no-invent and runner-owned guardrails; `INSTRUCTIONS` is exported so tests can assert on content markers. The analyst domain schema (`AnalystProfileOutput`) is NOT changed.

**Tech Stack:** TypeScript (`@mastra/core@1.41.0`, `node --experimental-strip-types`), Vitest 2.1, pnpm.

## Global Constraints

- **NO TypeScript parameter properties** — `constructor(private x)` is a runtime crash under `node --experimental-strip-types`. Use plain field declaration + assignment.
- **`.ts` import extensions** — all local imports must use `.ts` suffix (e.g. `from './generate-defaults.ts'`).
- **Test gate** — `pnpm typecheck` (tsc, covers `src/`) then `pnpm test` (vitest run) must both be green before every commit.
- **`maxOutputTokens` option name confirmed** — Mastra 1.41 official docs (https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/agents/generate.mdx) confirm the output-token limit is `opts.modelSettings.maxOutputTokens`, nested inside a `modelSettings` sub-object. The full call shape is `agent.generate(prompt, { structuredOutput: { schema }, modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS } })`. This is NOT a top-level key — it is inside `modelSettings`.
- **Schema unchanged** — `AnalystProfileOutput` / `AnalystProfileOutputSchema` are untouched; this plan only changes instructions and generate options.
- **16384 is safe** — well above any real profile/critique/verdict/builder output; no truncation of existing outputs.
- **RED phase** — under `pnpm vitest run` (strips types, no tsc), RED means unresolved import at module load time or a runtime assertion failure. It is NEVER a TypeScript type error.

---

### Task 1: MAX_OUTPUT_TOKENS shared constant and generate-call cap

**Files:**
- Create: `src/adapters/llm/generate-defaults.ts`
- Create: `src/adapters/llm/generate-defaults.test.ts`
- Modify: `src/adapters/strategy-critic/single-stage-strategy-critic.ts`
- Modify: `src/adapters/strategy-critic/single-stage-strategy-critic.test.ts`
- Modify: `src/adapters/strategy-critic/two-stage-strategy-critic.ts`
- Modify: `src/adapters/strategy-critic/two-stage-strategy-critic.test.ts`
- Modify: `src/adapters/analyst/mastra-strategy-analyst.ts`
- Modify: `src/adapters/critic/mastra-critic.ts`
- Modify: `src/adapters/researcher/mastra-researcher.ts`
- Modify: `src/adapters/builder/mastra-builder.ts`
- Modify: `src/adapters/intent/mastra-turn-interpreter.ts`
- Modify: `src/experiments/strategy-analyst/judge.ts`
- Modify: `src/experiments/strategy-critic/judge.ts`
- Modify: `src/experiments/researcher/judge.ts`
- Modify: `src/experiments/builder/judge.ts`

**Interfaces:**
- Produces: `export const MAX_OUTPUT_TOKENS: number` from `src/adapters/llm/generate-defaults.ts`

---

- [ ] **Step 1: Write the failing constant test**

Create `src/adapters/llm/generate-defaults.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MAX_OUTPUT_TOKENS } from './generate-defaults.ts';

describe('generate-defaults', () => {
  it('MAX_OUTPUT_TOKENS equals 16384', () => {
    expect(MAX_OUTPUT_TOKENS).toBe(16384);
  });
});
```

- [ ] **Step 2: Run to verify RED**

```
pnpm vitest run src/adapters/llm/generate-defaults.test.ts
```

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/generate-defaults.ts'` — the file does not exist yet.

- [ ] **Step 3: Create the constant file**

Create `src/adapters/llm/generate-defaults.ts`:

```typescript
/**
 * Global cap on LLM output tokens for every agent.generate() call.
 * Passed as modelSettings.maxOutputTokens in Mastra 1.41.
 *
 * 16384 is well above any real profile / critique / verdict / builder output.
 * It cuts the default 65536 reservation 4× and fixes OpenRouter 402 errors
 * caused by over-reserving credits on expensive models.
 */
export const MAX_OUTPUT_TOKENS = 16384;
```

- [ ] **Step 4: Run to verify GREEN**

```
pnpm vitest run src/adapters/llm/generate-defaults.test.ts
```

Expected: PASS — 1 test.

---

- [ ] **Step 5: Add options-capture assertion to the single-stage critic test**

Replace the full content of `src/adapters/strategy-critic/single-stage-strategy-critic.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { SingleStageStrategyCritic } from './single-stage-strategy-critic.ts';
import type { AgentCallUsage } from '../../ports/agent-call-opts.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

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

describe('SingleStageStrategyCritic', () => {
  it('reports adapter/mode/model', () => {
    const agent = {
      generate: async () => ({ object: refinement, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }),
    } as unknown as Agent;
    const a = new SingleStageStrategyCritic(agent, 'anthropic/claude-sonnet-4-6');
    expect(a.adapter).toBe('mastra');
    expect(a.mode).toBe('single');
    expect(a.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('calls the agent once, accrues onUsage once, returns the parsed refinement, and passes modelSettings.maxOutputTokens', async () => {
    const seen: AgentCallUsage[] = [];
    let calls = 0;
    let capturedOpts: unknown;
    const agent = {
      generate: async (_prompt: string, opts: unknown) => {
        calls += 1;
        capturedOpts = opts;
        return { object: refinement, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
      },
    } as unknown as Agent;
    const a = new SingleStageStrategyCritic(agent, 'anthropic/claude-sonnet-4-6');
    const out = await a.refine(
      { kind: 'manual_description', content: 'short after a pump' },
      { onUsage: (u) => { seen.push(u); } },
    );
    expect(calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ modelId: 'anthropic/claude-sonnet-4-6', inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    expect(out.improvedStrategyText).toBe('IMPROVED');
    expect(out.verdict.severity).toBe('medium');
    // maxOutputTokens cap must be forwarded
    const opts = capturedOpts as { modelSettings?: { maxOutputTokens?: number } };
    expect(opts.modelSettings?.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });
});
```

- [ ] **Step 6: Run to verify RED**

```
pnpm vitest run src/adapters/strategy-critic/single-stage-strategy-critic.test.ts
```

Expected: the last assertion fails — `expect(received).toBe(expected)` where received is `undefined` and expected is `16384`.

- [ ] **Step 7: Update single-stage critic to pass modelSettings**

Replace the full content of `src/adapters/strategy-critic/single-stage-strategy-critic.ts`:

```typescript
import type { Agent } from '@mastra/core/agent';
import type { StrategyCriticPort, AgentCallOpts } from '../../ports/strategy-critic.port.ts';
import {
  StrategyRefinementSchema,
  type StrategyCriticInput,
  type StrategyRefinement,
} from '../../domain/strategy-critic.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

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
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
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

- [ ] **Step 8: Run to verify GREEN**

```
pnpm vitest run src/adapters/strategy-critic/single-stage-strategy-critic.test.ts
```

Expected: PASS — 2 tests.

---

- [ ] **Step 9: Add options-capture assertions to the two-stage critic test**

Replace the full content of `src/adapters/strategy-critic/two-stage-strategy-critic.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { TwoStageStrategyCritic } from './two-stage-strategy-critic.ts';
import type { AgentCallUsage } from '../../ports/agent-call-opts.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

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
  it('calls BOTH agents, accrues onUsage twice, assembles the refinement, and passes modelSettings.maxOutputTokens to each stage', async () => {
    const seen: AgentCallUsage[] = [];
    let criticCalls = 0;
    let refinerCalls = 0;
    let criticOpts: unknown;
    let refinerOpts: unknown;

    const criticAgent = {
      generate: async (_prompt: string, opts: unknown) => {
        criticCalls += 1;
        criticOpts = opts;
        return { object: critique, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      },
    } as unknown as Agent;

    const refinerAgent = {
      generate: async (_prompt: string, opts: unknown) => {
        refinerCalls += 1;
        refinerOpts = opts;
        return { object: delta, usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } };
      },
    } as unknown as Agent;

    const a = new TwoStageStrategyCritic(criticAgent, refinerAgent, 'critic-model', 'refiner-model');
    expect(a.mode).toBe('two_stage');
    const out = await a.refine(
      { kind: 'manual_description', content: 'short after a pump' },
      { onUsage: (u) => { seen.push(u); } },
    );

    expect(criticCalls).toBe(1);
    expect(refinerCalls).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.totalTokens).toBe(15);
    expect(seen[1]?.totalTokens).toBe(12);
    // each stage must report its own model id
    expect(seen[0]?.modelId).toBe('critic-model');
    expect(seen[1]?.modelId).toBe('refiner-model');
    expect(out.verdict.mainVulnerability).toBe('no stop');
    expect(out.improvedStrategyText).toBe('IMPROVED TEXT');
    expect(out.changeLog).toEqual(['added regime filter', 'added invalidation']);
    // maxOutputTokens cap must be forwarded to BOTH stages
    const cOpts = criticOpts as { modelSettings?: { maxOutputTokens?: number } };
    const rOpts = refinerOpts as { modelSettings?: { maxOutputTokens?: number } };
    expect(cOpts.modelSettings?.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(rOpts.modelSettings?.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });
});
```

- [ ] **Step 10: Run to verify RED**

```
pnpm vitest run src/adapters/strategy-critic/two-stage-strategy-critic.test.ts
```

Expected: the last two assertions fail — both `cOpts.modelSettings?.maxOutputTokens` and `rOpts.modelSettings?.maxOutputTokens` are `undefined`.

- [ ] **Step 11: Update two-stage critic to pass modelSettings to both stages**

Replace the full content of `src/adapters/strategy-critic/two-stage-strategy-critic.ts`:

```typescript
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
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

const RefinementDeltaSchema = z.object({
  improvedStrategyText: z.string(),
  changeLog: z.array(z.string()),
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
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
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
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
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
      changeLog: delta.changeLog,
    });
  }
}
```

- [ ] **Step 12: Run to verify GREEN**

```
pnpm vitest run src/adapters/strategy-critic/two-stage-strategy-critic.test.ts
```

Expected: PASS — 1 test.

---

- [ ] **Step 13: Update the remaining 9 files**

For each file below, the change is identical in structure: add one import line at the top and add `modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS }` to the existing `agent.generate(...)` options object. Exact relative paths vary by directory.

**`src/adapters/analyst/mastra-strategy-analyst.ts`** — import: `'../llm/generate-defaults.ts'`

Replace the full file:

```typescript
import type { Agent } from '@mastra/core/agent';
import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import { AnalystProfileOutputSchema, type AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

function buildPrompt(input: StrategyAnalystInput): string {
  const header =
    `Source kind: ${input.kind}` +
    (input.title ? `\nTitle: ${input.title}` : '') +
    (input.uri ? `\nURI: ${input.uri}` : '');
  return `${header}\n\n--- SOURCE START ---\n${input.content}\n--- SOURCE END ---\n\nReturn the structured strategy profile.`;
}

export class MastraStrategyAnalyst implements StrategyAnalystPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async analyze(input: StrategyAnalystInput): Promise<AnalystProfileOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: AnalystProfileOutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    // Re-parse to guarantee the typed shape regardless of the SDK's inferred return type.
    return AnalystProfileOutputSchema.parse(result.object);
  }
}
```

**`src/adapters/critic/mastra-critic.ts`** — import: `'../llm/generate-defaults.ts'`

Replace the full file:

```typescript
import type { Agent } from '@mastra/core/agent';
import type { CriticPort, AgentCallOpts } from '../../ports/critic.port.ts';
import { CriticOutputSchema, type CriticInput, type CriticOutput } from '../../domain/critic.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

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

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async review(input: CriticInput, opts?: AgentCallOpts): Promise<CriticOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: CriticOutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
    return CriticOutputSchema.parse(result.object);
  }
}
```

**`src/adapters/researcher/mastra-researcher.ts`** — import: `'../llm/generate-defaults.ts'`

Add `import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';` after the last existing import line. Then change the generate call in `MastraResearcher.propose()` from:

```typescript
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: LlmResearcherOutputSchema },
    });
```

to:

```typescript
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: LlmResearcherOutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
```

**`src/adapters/builder/mastra-builder.ts`** — import: `'../llm/generate-defaults.ts'`

Add `import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';` after the last existing import line. Then change the generate call in `MastraBuilder.build()` from:

```typescript
    const result = await this.agent.generate(buildPromptFor(input), {
      structuredOutput: { schema: LlmBuilderOutputSchema },
    });
```

to:

```typescript
    const result = await this.agent.generate(buildPromptFor(input), {
      structuredOutput: { schema: LlmBuilderOutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
```

**`src/adapters/intent/mastra-turn-interpreter.ts`** — import: `'../llm/generate-defaults.ts'`

Replace the full file:

```typescript
import type { Agent } from '@mastra/core/agent';
import type { TurnInterpreterPort } from '../../ports/turn-interpreter.port.ts';
import { TurnProviderSchema } from '../../chat/turn-provider-schema.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

function buildPrompt(message: string): string {
  return `Interpret the following user message and extract structured turn information.\n\n--- USER MESSAGE START ---\n${message}\n--- USER MESSAGE END ---\n\nReturn the structured turn interpretation.`;
}

/**
 * Production turn interpreter using Mastra structured output.
 * ONE prompt + ONE structured-output request, NO tools.
 * Returns raw provider output (may contain nulls for absent optionals).
 * Callers must run normalizeTurnOutput then TurnInterpretationSchema.parse.
 */
export class MastraTurnInterpreter implements TurnInterpreterPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;

  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async interpret(message: string): Promise<unknown> {
    const result = await this.agent.generate(buildPrompt(message), {
      structuredOutput: { schema: TurnProviderSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    return result.object;
  }
}
```

**`src/experiments/strategy-analyst/judge.ts`** — import: `'../../adapters/llm/generate-defaults.ts'`

Add `import { MAX_OUTPUT_TOKENS } from '../../adapters/llm/generate-defaults.ts';` after the last existing import. Then change the generate call in `runJudge()` from:

```typescript
  const result = await agent.generate(buildJudgePrompt(input), { structuredOutput: { schema: JudgeVerdictSchema } });
```

to:

```typescript
  const result = await agent.generate(buildJudgePrompt(input), {
    structuredOutput: { schema: JudgeVerdictSchema },
    modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
  });
```

**`src/experiments/strategy-critic/judge.ts`** — import: `'../../adapters/llm/generate-defaults.ts'`

Add `import { MAX_OUTPUT_TOKENS } from '../../adapters/llm/generate-defaults.ts';` after the last existing import. Then change the generate call in `runJudge()` from:

```typescript
  const result = await agent.generate(buildJudgePrompt(input), { structuredOutput: { schema: JudgeVerdictSchema } });
```

to:

```typescript
  const result = await agent.generate(buildJudgePrompt(input), {
    structuredOutput: { schema: JudgeVerdictSchema },
    modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
  });
```

**`src/experiments/researcher/judge.ts`** — import: `'../../adapters/llm/generate-defaults.ts'`

Add `import { MAX_OUTPUT_TOKENS } from '../../adapters/llm/generate-defaults.ts';` after the last existing import. Then change the generate call in `runJudge()` from:

```typescript
  const result = await agent.generate(buildJudgePrompt(input), { structuredOutput: { schema: JudgeVerdictSchema } });
```

to:

```typescript
  const result = await agent.generate(buildJudgePrompt(input), {
    structuredOutput: { schema: JudgeVerdictSchema },
    modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
  });
```

**`src/experiments/builder/judge.ts`** — import: `'../../adapters/llm/generate-defaults.ts'`

Add `import { MAX_OUTPUT_TOKENS } from '../../adapters/llm/generate-defaults.ts';` after the last existing import. Then change the generate call in `runBuilderJudge()` from:

```typescript
  const result = await agent.generate(buildBuilderJudgePrompt(input), {
    structuredOutput: { schema: BuilderJudgeVerdictSchema },
  });
```

to:

```typescript
  const result = await agent.generate(buildBuilderJudgePrompt(input), {
    structuredOutput: { schema: BuilderJudgeVerdictSchema },
    modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
  });
```

- [ ] **Step 14: Run full suite**

```
pnpm typecheck && pnpm test
```

Expected: typecheck clean; all tests pass.

- [ ] **Step 15: Commit**

```bash
git add \
  src/adapters/llm/generate-defaults.ts \
  src/adapters/llm/generate-defaults.test.ts \
  src/adapters/analyst/mastra-strategy-analyst.ts \
  src/adapters/critic/mastra-critic.ts \
  src/adapters/strategy-critic/single-stage-strategy-critic.ts \
  src/adapters/strategy-critic/single-stage-strategy-critic.test.ts \
  src/adapters/strategy-critic/two-stage-strategy-critic.ts \
  src/adapters/strategy-critic/two-stage-strategy-critic.test.ts \
  src/adapters/researcher/mastra-researcher.ts \
  src/adapters/builder/mastra-builder.ts \
  src/adapters/intent/mastra-turn-interpreter.ts \
  src/experiments/strategy-analyst/judge.ts \
  src/experiments/strategy-critic/judge.ts \
  src/experiments/researcher/judge.ts \
  src/experiments/builder/judge.ts
git commit -m "feat: cap all agent.generate() calls at maxOutputTokens=16384 via shared const (fixes OpenRouter 402)"
```

---

### Task 2: Structured analyst prompt with exported INSTRUCTIONS

**Files:**
- Modify: `src/mastra/agents/strategy-analyst.agent.ts`
- Modify: `src/adapters/analyst/mastra-strategy-analyst.test.ts`

**Interfaces:**
- Produces: `export const INSTRUCTIONS: string` from `src/mastra/agents/strategy-analyst.agent.ts`

---

- [ ] **Step 1: Write failing INSTRUCTIONS assertions**

Replace the full content of `src/adapters/analyst/mastra-strategy-analyst.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MastraStrategyAnalyst } from './mastra-strategy-analyst.ts';
import { AnalystProfileOutputSchema } from '../../domain/strategy-profile.ts';
import { loadEnv } from '../../config/env.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createStrategyAnalystAgent, INSTRUCTIONS } from '../../mastra/agents/strategy-analyst.agent.ts';

describe('MastraStrategyAnalyst (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const a = new MastraStrategyAnalyst(createStrategyAnalystAgent(model), label);
    expect(a.adapter).toBe('mastra');
    expect(a.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('strategy-analyst INSTRUCTIONS', () => {
  it('contains the five structured extraction section markers', () => {
    expect(INSTRUCTIONS).toContain('Entry conditions');
    expect(INSTRUCTIONS).toContain('Exit &');
    expect(INSTRUCTIONS).toContain('invalidation');
    expect(INSTRUCTIONS).toContain('OHLCV');
    expect(INSTRUCTIONS).toContain('Position management');
  });

  it('retains the no-invent guardrail', () => {
    expect(INSTRUCTIONS).toContain('unknowns');
  });

  it('retains the runner-owned guardrail', () => {
    expect(INSTRUCTIONS).toContain('runnerOwnedAuthorities');
  });
});

const env = loadEnv();
const live = env.RUN_LLM_TESTS && env.ANTHROPIC_API_KEY ? describe : describe.skip;

live('MastraStrategyAnalyst (live LLM)', () => {
  it('returns a schema-valid profile for a sample source', async () => {
    const { model, label } = resolveLanguageModel(env, env.STRATEGY_ANALYST_MODEL);
    const a = new MastraStrategyAnalyst(createStrategyAnalystAgent(model), label);
    const out = await a.analyze({
      kind: 'manual_description',
      content: 'Go long when open interest rises while price drops into a liquidation cluster; exit on funding flip.',
    });
    expect(AnalystProfileOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run to verify RED**

```
pnpm vitest run src/adapters/analyst/mastra-strategy-analyst.test.ts
```

Expected: `SyntaxError: The requested module '…/strategy-analyst.agent.ts' does not provide an export named 'INSTRUCTIONS'` — `INSTRUCTIONS` is not yet exported.

- [ ] **Step 3: Export INSTRUCTIONS and extend with structured extraction sections**

Replace the full content of `src/mastra/agents/strategy-analyst.agent.ts`:

```typescript
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_ANALYST_AGENT_ID = 'strategy-analyst';

export const INSTRUCTIONS = [
  'You are a trading-strategy analyst.',
  'Given a strategy source (code, README, article, summary, or description), extract a structured profile.',
  'Extract EXHAUSTIVELY — populate each field as completely as the source supports.',
  'Entry conditions: list every trigger and condition explicitly stated (price level, indicator threshold, candle pattern, time filter, confluence, required concurrent signal).',
  'Exit & invalidation: extract every take-profit target, stop-loss level, time-based exit, and explicit invalidation criteria that would prevent or abort a trade.',
  'Required market-data features: enumerate every signal the strategy needs — OHLCV, open interest, funding rate, liquidations, taker buy/sell volume, delta, CVD — include ONLY those the source actually references.',
  'Position management: extract DCA rules, breakeven-move logic, scaling in/out, and any position-sizing guidance if stated.',
  'Tunable parameters: mark every numeric threshold, window length, multiplier, or user-configurable value with tunable: true.',
  'Do not invent details; put anything you are unsure about in `unknowns`.',
  'Anything that belongs to risk sizing, order execution, or fills is owned by the runner/platform —',
  'list those concerns in `runnerOwnedAuthorities`, do not propose live execution.',
].join('\n');

export function createStrategyAnalystAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_ANALYST_AGENT_ID, name: 'Strategy Analyst', instructions: INSTRUCTIONS, model });
}
```

- [ ] **Step 4: Run to verify GREEN**

```
pnpm vitest run src/adapters/analyst/mastra-strategy-analyst.test.ts
```

Expected: PASS — 4 tests (1 construction + 3 INSTRUCTIONS assertions; live LLM test skipped).

- [ ] **Step 5: Run full suite**

```
pnpm typecheck && pnpm test
```

Expected: typecheck clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add \
  src/mastra/agents/strategy-analyst.agent.ts \
  src/adapters/analyst/mastra-strategy-analyst.test.ts
git commit -m "feat(analyst): structured extraction prompt (entry/exit/data/position/tunable) + export INSTRUCTIONS"
```
