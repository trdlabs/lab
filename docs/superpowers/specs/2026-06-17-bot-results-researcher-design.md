# Feature 006 — Wire `BotResultsReadPort` into the research-run-cycle (Researcher consumer)

- **Date:** 2026-06-17
- **Repo:** `trading-lab`
- **Branch:** `006-bot-results-researcher`
- **Status:** design approved; plan pending.

## 1. Goal

Make the `BotResultsReadPort` (added in feature 005, currently with **zero consumers**) actually consumed: the `researchRunCycleHandler` gathers live bot-results and passes them to the Researcher as **advisory context**, so strategy proposals can be informed by how live/paper bots actually performed.

This is a narrow **consumer-integration** increment. The bot-results are fed as **raw SDK DTOs** (no derived/computed evidence type), the fetch is **fail-soft** (the research cycle never breaks because live ops-read is unavailable), and the change is confined to the one handler + the `ResearcherInput` shape + the two Researcher implementations + the runtime wiring.

### Established facts (from exploration — do not re-open)
- The Researcher is invoked at exactly ONE production call site: `researchRunCycleHandler` in `src/orchestrator/handlers/research-run-cycle.handler.ts`, which assembles `ResearcherInput` and calls `services.researcher.propose({...})`. Immediately before that it already gathers context: `services.platform.getMarketContext(symbol, ts)` and `getMarketRegime(symbol, ts)` — the precedent template for a bot-results gather step.
- `ResearcherInput = { profile, marketContext, marketRegime, similarHypotheses, maxHypotheses }` — there is **no** free-form context slot; a new optional field must be added. Both Researcher implementations (`MastraResearcher`, `FakeResearcher`) read the input positionally in their prompt/stub, so a new **optional** field is non-breaking.
- Wiring: `AppServices` (= the `HandlerDeps` passed to every `WorkflowHandler`) is the single deps object. Adding a field to it makes it available as `services.<field>` in every handler. The env-selected-port precedent is `researchPlatform: selectResearchPlatform(env.TRADING_PLATFORM_INTEGRATION)` in `composeRuntime` (`src/composition.ts`).
- `BotResultsReadPort` (005): `listBotRuns(filter?: {mode?,status?})` → `readonly BotRunRecord[]`; `getRunSummary(runId)` → `RunSummary`; `getClosedTrades(runId)` → `readonly ClosedTrade[]`. `selectBotResults(source: NodeJS.ProcessEnv)` reads its OWN env namespace (`LAB_BOT_RESULTS_INTEGRATION` / `LAB_OPS_READ_*`). Zero current consumers (confirmed).

### Three approved decisions
1. **Raw SDK DTOs** into the Researcher (no derived/computed evidence type). The Researcher layer depends on the bot-results DTO types via the port's lab-local re-exports (the import-boundary guard still holds — only `bot-results-read.port.ts` imports the SDK).
2. **runs + RunSummary + ClosedTrades**, capped to N and filtered: the gather step takes the N most-recent matching runs and fetches each run's summary and closed trades.
3. **Fail-soft**: if the port errors or returns empty, log a warning event and proceed with an empty set; the Researcher still runs.

## 2. Architecture / wiring

Mirrors the `selectResearchPlatform` precedent:
- `src/orchestrator/app-services.ts`: add `readonly botResults: BotResultsReadPort;` to `AppServices`.
- `src/composition.ts` (`composeRuntime`): add `botResults: selectBotResults(process.env),` to the `services` literal. `selectBotResults` is synchronous (no change to composition control flow) and reads its own `LAB_*` env namespace — so it takes `process.env`, NOT the parsed `env` object that `selectResearchPlatform` uses.

## 3. The raw-DTO composite + the `ResearcherInput` field

A small lab-local composite that pairs the three raw DTOs per run (a container of raw DTOs — NOT a computed summary). Declared in `src/ports/bot-results-read.port.ts` (the bot-results domain), so `researcher.port.ts` imports it from there (keeping the SDK import confined to the one seam file):

```ts
export interface BotRunResultDetail {
  readonly run: BotRunRecord;
  readonly summary: RunSummary;
  readonly trades: readonly ClosedTrade[];
}
```

`src/ports/researcher.port.ts` — `ResearcherInput` gains an **optional** field:

```ts
readonly botResults?: readonly BotRunResultDetail[];
```

Optional → fail-soft and non-breaking (existing callers/tests that omit it still compile). The type is imported from `./bot-results-read.port.ts`.

## 4. Gather step (fail-soft) in `researchRunCycleHandler`

Inserted immediately before the `researcher.propose({...})` call, after the existing `getMarketContext` / `getMarketRegime` / `similarHypotheses` gathers. Pattern:

```ts
let botResults: readonly BotRunResultDetail[] = [];
try {
  const runs = (await services.botResults.listBotRuns({ status: 'finished' }))
    .filter((r) => r.symbols.includes(symbol))
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
    .slice(0, BOT_RESULTS_MAX);
  botResults = await Promise.all(runs.map(async (run) => ({
    run,
    summary: await services.botResults.getRunSummary(run.runId),
    trades: await services.botResults.getClosedTrades(run.runId),
  })));
} catch (err) {
  await services.events.append(event(task.id, 'researcher.bot_results_unavailable', { reason: String(err) }));
}
// then: services.researcher.propose({ profile, marketContext, marketRegime, similarHypotheses, botResults, maxHypotheses: effectiveMax })
```

- **Scoping:** `status: 'finished'` (closed runs carry meaningful summaries/trades); client-side `symbols.includes(symbol)` (the port filter has no symbol axis); most-recent by `lastSeenMs`; capped at `BOT_RESULTS_MAX` (a named constant; proposed value **10**). The cap bounds the N×2 per-run summary/trade fetches.
- **Fail-soft:** any error from the port (HTTP down, parse error) is caught → empty `botResults` + a `researcher.bot_results_unavailable` warning event; the cycle proceeds. An empty result (no matching runs) is simply an empty array (no event needed).

## 5. The two Researcher implementations

- `src/adapters/researcher/mastra-researcher.ts` — `buildPrompt` adds a compact bot-results block (per run: strategy, mode, status, the `RunSummary` metrics, and the closed-trades). When `botResults` is empty/undefined the block is omitted (no empty noise in the prompt).
- `src/adapters/researcher/fake-researcher.ts` — the deterministic stub accounts for `botResults?.length` without breaking on `undefined`/empty.

## 6. Error handling / fail-soft posture
- Bot-results are advisory: the research cycle is never blocked by their unavailability. Only the bot-results gather is wrapped in try/catch; the existing `getMarketContext` / `similarHypotheses` gathers keep their current (fail-hard) behavior — out of scope to change.
- The warning event (`researcher.bot_results_unavailable`) records the reason for observability.

## 7. Testing
- **Handler test** (`research-run-cycle.handler.test.ts`, extend): with a fake `BotResultsReadPort` returning runs/summaries/trades → the `propose` input carries the expected `botResults` (cap N + symbol filter honored); when the fake port throws → `propose` receives `[]` AND a `researcher.bot_results_unavailable` event is emitted (fail-soft).
- **`buildPrompt` test:** non-empty `botResults` → the bot-results block appears in the prompt; empty/undefined → omitted.
- **Wiring:** `AppServices` has `botResults`; `composeRuntime` wires it via `selectBotResults` (the selector itself is already unit-tested in 005).

## 8. Out of scope (strict)
- The backtest `ResearchPlatformPort` / `getRunResult` path and the synthetic `PlatformGatewayPort` path.
- The Analyst / Builder / Critic / echo handlers.
- events/decisions/health read methods on the port (005-deferred).
- A derived/computed bot-results evidence type (decision 1: raw DTOs).
- A cursor-bearing paginated port API.
- Any mock/SDK source edits.

## 9. Plan-time lookups (resolve during planning — not placeholders)
1. The exact `research-run-cycle.handler.ts` internals: the `event(...)` helper + `services.events.append` signature, the `symbol`/`ts`/`effectiveMax` variables, and the exact position of the `propose({...})` literal.
2. The exact `AppServices` interface + `composeRuntime` `services` literal shape, and how `env` is loaded (confirm `loadEnv` does not already surface `LAB_BOT_RESULTS_INTEGRATION`; if it does, thread that consistently instead of `process.env`).
3. The exact `MastraResearcher.buildPrompt` structure and `FakeResearcher` body, for a minimal, on-style insertion.
