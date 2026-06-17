# Wire BotResultsReadPort into the research-run-cycle — Implementation Plan

> **For agentic workers:** implement task-by-task with fresh context per task or inline, per the installed workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the (currently unconsumed) `BotResultsReadPort` actually feed the Researcher: `researchRunCycleHandler` gathers live bot-results (raw SDK DTOs — runs + summary + trades, capped + filtered, fail-soft) and passes them to `researcher.propose(...)` as advisory context.

**Architecture:** Hexagonal — add a raw-DTO composite `BotRunResultDetail` to the existing bot-results port, an optional `ResearcherInput.botResults` field, wire `selectBotResults(process.env)` into `AppServices`/`composeRuntime` (and the test `makeServices` factory in the same change), add a fail-soft gather step in the one handler that runs the Researcher, and surface the data in both Researcher implementations' prompts.

**Tech Stack:** TypeScript (NodeNext ESM, `.ts` import specifiers, `noUncheckedIndexedAccess`), Vitest. Verification = `pnpm typecheck` + `pnpm test`. Run one test file with `pnpm exec vitest run <path>`.

**Repo & branch:** `/home/alexxxnikolskiy/projects/trading-lab`, branch `006-bot-results-researcher` (already created).

**Resolved facts (from planning research — do not re-derive):**
- The Researcher's only production call site is `researchRunCycleHandler` (`src/orchestrator/handlers/research-run-cycle.handler.ts`); it gathers context at lines 53-58 (`symbol`/`ts`/`getMarketContext`/`getMarketRegime`/`similarHypotheses`) and calls `services.researcher.propose({ profile, marketContext, marketRegime, similarHypotheses, maxHypotheses: effectiveMax })` at lines 63-65, inside a `try/catch` that emits `researcher.failed`. The local `event(taskId, type, payload)` helper (lines 26-28) + `errMsg(err)` (lines 22-24) are the house style for events.
- `AppServices` (`src/orchestrator/app-services.ts`) and `ResearcherInput` (`src/ports/researcher.port.ts`) use **plain (non-`readonly`) fields**; `bot-results-read.port.ts` uses `readonly` fields.
- `selectBotResults(source: NodeJS.ProcessEnv)` + the `LAB_BOT_RESULTS_INTEGRATION` / `LAB_OPS_READ_*` axis already exist (feature 005) and are NOT surfaced by `loadEnv` — so wire `selectBotResults(process.env)`, not the parsed `env`.
- `test/support/make-services.ts` is the fake-`AppServices` factory used by every handler test; it constructs a full `AppServices` literal then spreads `...overrides`. Adding a **required** `botResults` to `AppServices` breaks this factory's type until it also gains a `botResults` entry — must change in the same task.
- `MockBotResultsAdapter` (005) returns one canned run `mock_run_001` (`mode: 'paper'`, `status: 'finished'`, `symbols: ['BTCUSDT']`) + a matching `RunSummary` + one `ClosedTrade` — usable directly as the happy-path fake.

## File structure
- Modify `src/ports/bot-results-read.port.ts` — add `BotRunResultDetail`.
- Modify `src/ports/researcher.port.ts` — add optional `botResults` field + import.
- Modify `src/orchestrator/app-services.ts` — add `botResults: BotResultsReadPort` + import.
- Modify `src/composition.ts` — import + wire `botResults: selectBotResults(process.env)`.
- Modify `test/support/make-services.ts` — add `botResults: new MockBotResultsAdapter()` + import.
- Modify `src/orchestrator/handlers/research-run-cycle.handler.ts` — `BOT_RESULTS_MAX` const, the fail-soft gather, `botResults` in the propose literal, import.
- Modify `src/orchestrator/handlers/research-run-cycle.handler.test.ts` — happy + fail-soft tests.
- Modify `src/adapters/researcher/mastra-researcher.ts` — export `buildPrompt`, add the bot-results block.
- Create `src/adapters/researcher/mastra-researcher.test.ts` — buildPrompt block present/omitted.
- Modify `src/adapters/researcher/fake-researcher.ts` — fold `botResults?.length` into `researchSummary`.
- Create `src/adapters/researcher/fake-researcher.test.ts` — deterministic botResults count.

---

## Task 1: Types — `BotRunResultDetail` + `ResearcherInput.botResults`

**Files:** modify `src/ports/bot-results-read.port.ts`, `src/ports/researcher.port.ts`.

- [ ] **Step 1: Add the raw-DTO composite to the bot-results port**

In `src/ports/bot-results-read.port.ts`, append after the `BotResultsReadPort` interface (the `run`/`summary`/`trades` types are already imported + re-exported at the top of this file — no new import):

```typescript
/** A single live bot run paired with its raw summary + closed trades (raw SDK DTOs, not a derived
 *  summary). The advisory shape the Researcher receives via ResearcherInput.botResults. */
export interface BotRunResultDetail {
  readonly run: BotRunRecord;
  readonly summary: RunSummary;
  readonly trades: readonly ClosedTrade[];
}
```

- [ ] **Step 2: Add the optional field to `ResearcherInput`**

In `src/ports/researcher.port.ts`, add the import (after the existing `./platform-gateway.port.ts` import):

```typescript
import type { BotRunResultDetail } from './bot-results-read.port.ts';
```

and add the field to `ResearcherInput` (after `similarHypotheses`, matching the file's non-`readonly` field style; the array itself is `readonly`):

```typescript
  similarHypotheses: SimilarHypothesisSummary[];
  botResults?: readonly BotRunResultDetail[];
  maxHypotheses: number;
```

- [ ] **Step 3: Typecheck (optional field → non-breaking)**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm typecheck
```
Expected: exit 0. The new field is optional, so existing `propose({...})` call sites and tests that omit it still compile.

- [ ] **Step 4: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/ports/bot-results-read.port.ts src/ports/researcher.port.ts
git commit -m "feat(006): BotRunResultDetail composite + optional ResearcherInput.botResults"
```

---

## Task 2: Wiring — `AppServices` + `composeRuntime` + `makeServices`

**Files:** modify `src/orchestrator/app-services.ts`, `src/composition.ts`, `test/support/make-services.ts`. These MUST change together (a required `AppServices.botResults` breaks the factory + composition until all three are updated).

- [ ] **Step 1: Add `botResults` to `AppServices`**

In `src/orchestrator/app-services.ts`, add the import (with the other `../ports/*` imports):

```typescript
import type { BotResultsReadPort } from '../ports/bot-results-read.port.ts';
```

and add the field to the `AppServices` interface (after `researchPlatform`, matching the non-`readonly` style):

```typescript
  researchPlatform: ResearchPlatformPort;
  botResults: BotResultsReadPort;
  researcher: ResearcherPort;
```

- [ ] **Step 2: Wire it in `composeRuntime`**

In `src/composition.ts`, add the import (next to the other `./adapters/platform/select-*` imports):

```typescript
import { selectBotResults } from './adapters/platform/select-bot-results.ts';
```

and add to the `services: AppServices` literal (after the `researchPlatform:` line; `selectBotResults` takes raw `process.env`, NOT the parsed `env`, because it owns its own `LAB_*` namespace):

```typescript
    researchPlatform: selectResearchPlatform(env.TRADING_PLATFORM_INTEGRATION),
    botResults: selectBotResults(process.env),
    researcher: buildResearcher(mastraRuntime),
```

- [ ] **Step 3: Add `botResults` to the test fake-services factory**

In `test/support/make-services.ts`, add the import (with the other `../../src/adapters/platform/*` imports):

```typescript
import { MockBotResultsAdapter } from '../../src/adapters/platform/mock-bot-results.adapter.ts';
```

and add to the returned literal (before `...overrides`, after `researchPlatform:`):

```typescript
    researchPlatform: new MockResearchPlatformAdapter(),
    botResults: new MockBotResultsAdapter(),
    researcher: new FakeResearcher(),
```

- [ ] **Step 4: Typecheck + full test (wiring only — nothing consumes `botResults` yet)**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm typecheck
pnpm test
```
Expected: typecheck exit 0; full suite green (the factory now supplies `botResults`; no behavior changed yet — no regressions). If `make-services.ts` was missed, typecheck fails with `Property 'botResults' is missing` — that confirms the coupling, add Step 3.

- [ ] **Step 5: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/orchestrator/app-services.ts src/composition.ts test/support/make-services.ts
git commit -m "feat(006): wire botResults (selectBotResults) into AppServices + composeRuntime + makeServices"
```

---

## Task 3: Fail-soft gather in `researchRunCycleHandler`

**Files:** modify `src/orchestrator/handlers/research-run-cycle.handler.ts`, `src/orchestrator/handlers/research-run-cycle.handler.test.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/orchestrator/handlers/research-run-cycle.handler.test.ts`, add a capturing-researcher helper (after the existing `stubResearcher` function) and two tests (inside the `describe('researchRunCycleHandler', ...)` block). Add the needed imports at the top: `import { BotResultsReadPort } from '../../ports/bot-results-read.port.ts';` is NOT needed for the throwing stub if you type it inline; but add `import type { BotResultsReadPort } from '../../ports/bot-results-read.port.ts';`.

```typescript
function capturingResearcher(out: ResearcherOutput): { port: ResearcherPort; captured: () => ResearcherInput | undefined } {
  let cap: ResearcherInput | undefined;
  return {
    port: { adapter: 'fake', model: 'stub', async propose(inp: ResearcherInput) { cap = inp; return out; } },
    captured: () => cap,
  };
}
```

```typescript
  it('gathers live bot-results (status=finished, symbol-filtered) and passes them to the researcher', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis BR')], researchSummary: 's' });
    // default makeServices wires MockBotResultsAdapter -> one finished run on BTCUSDT
    const services = makeServices({ researcher: cap.port });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);

    const input = cap.captured();
    expect(input?.botResults?.length).toBe(1);
    expect(input?.botResults?.[0]?.run.symbols).toContain('BTCUSDT');
    expect(typeof input?.botResults?.[0]?.summary.pnlUsd).toBe('string');
    expect(Array.isArray(input?.botResults?.[0]?.trades)).toBe(true);
  });

  it('filters out runs whose symbols do not include the cycle symbol', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis BR2')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port }); // mock run is BTCUSDT only
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'ETHUSDT' }), services);
    expect(cap.captured()?.botResults).toEqual([]);
  });

  it('is fail-soft: a throwing bot-results port yields [] + a researcher.bot_results_unavailable event', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis BR3')], researchSummary: 's' });
    const throwing: BotResultsReadPort = {
      async listBotRuns() { throw new Error('ops-read down'); },
      async getClosedTrades() { return []; },
      async getRunSummary() { throw new Error('ops-read down'); },
    };
    const services = makeServices({ researcher: cap.port, botResults: throwing });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);

    expect(cap.captured()?.botResults).toEqual([]);
    expect(await types(services)).toContain('researcher.bot_results_unavailable');
  });
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts
```
Expected: the 3 new tests FAIL — `cap.captured()?.botResults` is `undefined` (the handler does not gather or pass `botResults` yet), and no `researcher.bot_results_unavailable` event exists.

- [ ] **Step 3: Implement the gather + thread it into propose**

In `src/orchestrator/handlers/research-run-cycle.handler.ts`:

(a) Add the import (after the existing imports):
```typescript
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
```

(b) Add the cap constant near `RESEARCH_DEFAULT_SYMBOL` (line 13):
```typescript
export const RESEARCH_DEFAULT_SYMBOL = 'BTCUSDT';
export const BOT_RESULTS_MAX = 10;
```

(c) Insert the fail-soft gather immediately after the `similarHypotheses` line (line 58), before the `researcher.started` event:
```typescript
    const similarHypotheses = await services.similarHypotheses.search(profile.id, profile.coreIdea, 5);

    let botResults: readonly BotRunResultDetail[] = [];
    try {
      const runs = (await services.botResults.listBotRuns({ status: 'finished' }))
        .filter((r) => r.symbols.includes(symbol))
        .slice()
        .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
        .slice(0, BOT_RESULTS_MAX);
      botResults = await Promise.all(runs.map(async (run) => ({
        run,
        summary: await services.botResults.getRunSummary(run.runId),
        trades: await services.botResults.getClosedTrades(run.runId),
      })));
    } catch (err) {
      await services.events.append(event(task.id, 'researcher.bot_results_unavailable', { error: errMsg(err) }));
    }
```
(Note: `.slice()` before `.sort()` copies the `readonly` array so the in-place sort does not mutate the port's returned value.)

(d) Add `botResults` to the propose literal (lines 63-65):
```typescript
      output = await services.researcher.propose({
        profile, marketContext, marketRegime, similarHypotheses, botResults, maxHypotheses: effectiveMax,
      });
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm typecheck
pnpm exec vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts
```
Expected: typecheck exit 0; all handler tests pass (the 3 new + all pre-existing).

- [ ] **Step 5: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(006): fail-soft bot-results gather in research-run-cycle; threaded into researcher.propose"
```

---

## Task 4: Surface bot-results in both Researcher implementations + final green

**Files:** modify `src/adapters/researcher/mastra-researcher.ts`, `src/adapters/researcher/fake-researcher.ts`; create `mastra-researcher.test.ts`, `fake-researcher.test.ts`.

- [ ] **Step 1: Write the failing Researcher tests**

Create `src/adapters/researcher/mastra-researcher.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildPrompt } from './mastra-researcher.ts';
import type { ResearcherInput } from '../../ports/researcher.port.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const baseInput: ResearcherInput = {
  profile: { coreIdea: 'idea', direction: 'long', requiredMarketFeatures: [] } as StrategyProfile,
  marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: {} },
  marketRegime: 'ranging',
  similarHypotheses: [],
  maxHypotheses: 2,
};

const detail: BotRunResultDetail = {
  run: { runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] },
  summary: { runId: 'r1', excludesReconcile: true, asOf: 2, closedTrades: 1, wins: 1, losses: 0, breakeven: 0, winratePct: 100, pnlUsd: '12.5', avgPnl: '12.5', exitReasons: { tp: 1 } },
  trades: [],
};

describe('buildPrompt bot-results block', () => {
  it('includes a bot-results block when botResults is non-empty', () => {
    const out = buildPrompt({ ...baseInput, botResults: [detail] });
    expect(out).toContain('Live/paper bot performance');
    expect(out).toContain('pnlUsd=12.5');
  });
  it('omits the block when botResults is empty or undefined', () => {
    expect(buildPrompt(baseInput)).not.toContain('Live/paper bot performance');
    expect(buildPrompt({ ...baseInput, botResults: [] })).not.toContain('Live/paper bot performance');
  });
});
```

Create `src/adapters/researcher/fake-researcher.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { FakeResearcher } from './fake-researcher.ts';
import type { ResearcherInput } from '../../ports/researcher.port.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const input = (botResults?: readonly BotRunResultDetail[]): ResearcherInput => ({
  profile: { coreIdea: 'idea', direction: 'long', requiredMarketFeatures: [] } as StrategyProfile,
  marketContext: { symbol: 'BTCUSDT', ts: 't', features: {} },
  marketRegime: 'ranging',
  similarHypotheses: [],
  ...(botResults ? { botResults } : {}),
  maxHypotheses: 2,
});

const detail = { run: {} as never, summary: {} as never, trades: [] } as unknown as BotRunResultDetail;

describe('FakeResearcher botResults reflection', () => {
  it('reflects botResults count in researchSummary, deterministically (no count branch)', async () => {
    const fr = new FakeResearcher();
    const out0 = await fr.propose(input(undefined));
    const out2 = await fr.propose(input([detail, detail]));
    expect(out0.researchSummary).toContain('botResults: 0');
    expect(out2.researchSummary).toContain('botResults: 2');
    expect(out0.hypotheses.length).toBe(out2.hypotheses.length); // count not branched on botResults
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/researcher/mastra-researcher.test.ts src/adapters/researcher/fake-researcher.test.ts
```
Expected: FAIL — `buildPrompt` is not exported (import error) / the block + `researchSummary` count do not exist yet.

- [ ] **Step 3: Implement the Mastra prompt block**

In `src/adapters/researcher/mastra-researcher.ts`, change `function buildPrompt` to `export function buildPrompt` and add the bot-results sub-string + line (mirroring the `similar` pattern; conditionally spread so it is omitted when empty):

```typescript
export function buildPrompt(input: ResearcherInput): string {
  const similar = input.similarHypotheses.length > 0
    ? input.similarHypotheses.map((s) => `- [${s.status}] ${s.thesis}`).join('\n')
    : '(none)';
  const botPerf = input.botResults && input.botResults.length > 0
    ? input.botResults.map((d) =>
        `- ${d.run.strategy.name}@${d.run.strategy.version} [${d.run.mode}/${d.run.status}]`
        + ` pnlUsd=${d.summary.pnlUsd} winratePct=${d.summary.winratePct} trades=${d.summary.closedTrades}`
        + ` (closed sample: ${d.trades.length})`).join('\n')
    : null;
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Direction: ${input.profile.direction}`,
    `Profile required features: ${input.profile.requiredMarketFeatures.join(', ') || '(none)'}`,
    `Market regime: ${input.marketRegime}`,
    `Market context features: ${JSON.stringify(input.marketContext.features)}`,
    `Similar past hypotheses (advisory, avoid duplicating):\n${similar}`,
    ...(botPerf ? [`Live/paper bot performance (advisory):\n${botPerf}`] : []),
    `Produce at most ${input.maxHypotheses} hypotheses.`,
  ].join('\n');
}
```

- [ ] **Step 4: Implement the Fake reflection**

In `src/adapters/researcher/fake-researcher.ts`, change ONLY the `researchSummary` return value (do NOT branch `n` on botResults — tests assert exact stored counts elsewhere):

```typescript
    return { hypotheses, researchSummary: `Fake researcher produced ${n} hypotheses (botResults: ${input.botResults?.length ?? 0})` };
```

- [ ] **Step 5: Run the Researcher tests, then the full suite**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/researcher/mastra-researcher.test.ts src/adapters/researcher/fake-researcher.test.ts
pnpm typecheck
pnpm test
```
Expected: the new Researcher tests pass; `pnpm typecheck` exit 0; full `pnpm test` green (all pre-existing suites + the new handler/researcher tests). If a pre-existing fake-researcher assertion checked the old `researchSummary` literal exactly, update it to the new string — report if so.

- [ ] **Step 6: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/adapters/researcher/mastra-researcher.ts src/adapters/researcher/fake-researcher.ts \
  src/adapters/researcher/mastra-researcher.test.ts src/adapters/researcher/fake-researcher.test.ts
git commit -m "feat(006): surface bot-results in Mastra prompt + Fake researchSummary (advisory, omitted when empty)"
```

---

## Self-review checklist (planner)

- **Spec coverage:** composite + input field (T1) ✓; wiring AppServices/composeRuntime + the makeServices coupling (T2) ✓; fail-soft gather with status=finished + symbol filter + cap N + `researcher.bot_results_unavailable` event, threaded into propose (T3) ✓; both Researcher impls surface it, omitted-when-empty (T4) ✓; raw DTOs, no derived type ✓; fail-soft ✓; out-of-scope respected (only this handler + the two researchers + wiring; backtest/Analyst/Builder/Critic untouched) ✓.
- **No placeholders:** every step has full code + exact command + expected output.
- **Type/name consistency:** `BotRunResultDetail` (run/summary/trades), `ResearcherInput.botResults`, `AppServices.botResults`, `BOT_RESULTS_MAX`, `researcher.bot_results_unavailable`, `buildPrompt` (exported) used identically across tasks. `botResults?: readonly BotRunResultDetail[]` optional everywhere it appears. `selectBotResults(process.env)` (not `env`). `MockBotResultsAdapter` reused in `makeServices` + the happy test.
- **Ordering:** T1 (types, non-breaking) → T2 (wiring; the one place that breaks the build if `makeServices` is missed) → T3 (handler behavior, TDD) → T4 (prompts, TDD + final full green).
