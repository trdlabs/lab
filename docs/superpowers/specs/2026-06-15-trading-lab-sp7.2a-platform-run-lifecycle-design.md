# SP-7.2a — Platform-backed Backtest Lifecycle Capability

- **Date:** 2026-06-15
- **Slice:** SP-7.2a (first half of SP-7.2; capability before wiring)
- **Branch:** `sp7.2a-platform-run-lifecycle` (off `main`)
- **Builds on:** SP-7 (discovery), SP-7.1/7.1b (`validateModule` + `toSubmittedBundle` + 017 overlay manifest), SP-8.2 (vendored SDK `0.3.0`), trading-platform 037 (submitted_overlay topology) + 038 (7-metric coverage)
- **Followed by:** SP-7.2b (wire into `hypothesisBuildHandler` + persistence + evaluation)

## Problem

trading-lab can build a hypothesis overlay `ModuleBundle` and validate it (SP-7.1b), but cannot yet **run** it against the platform: submit a `submitted_overlay` run, await completion, fetch the baseline-vs-variant result, and turn the platform's comparison into the lab's `ComparisonSummary` shape. SP-7.2a delivers that lifecycle as a standalone, offline-testable capability behind `ResearchPlatformPort` — no orchestrator/persistence wiring yet (that is SP-7.2b). This mirrors how SP-7 (discovery) and SP-7.1 (`validateModule`) landed as standalone capabilities + a CLI probe before any handler used them.

## Goal

Add the platform run lifecycle to `ResearchPlatformPort` (`submitOverlayRun` / `getRunStatus` / `getRunResult`), a `submitted_overlay` request mapper, a bounded-poll orchestration, and a pure lab mapper from the platform `RunResultSummary` to the lab `ComparisonSummary` — exercised by a standalone `platform:run` CLI probe. The SP-4 mock backtest path (`PlatformGatewayPort`), `hypothesisBuildHandler`, and persistence are untouched.

## Non-goals (→ SP-7.2b)

- No `hypothesisBuildHandler` fork, no `BACKTEST_BACKEND` selector, no backend-aware `paramsHash`.
- No `BacktestRun` persistence / Drizzle migration, no `Evaluation` flow, no `backtest.pending` status handling.
- No callback/resume (SP-7.3). No reading raw artifacts (IDs/metadata only).
- No change to `BacktestMetricBlock` / `ComparisonSummary` shapes or the evaluator.

## Key facts (verified)

- SDK `0.3.0` (vendored) exports the lifecycle: `submitRun(transport, ControlledRunRequest)→SubmitRunResult`, `getRunStatus(transport, runId)→RunStatusResult`, `getRunResult(transport, runId)→RunResultResult` (`kind:'summary'|'status'` | error), `awaitCompletion(transport, runId, {maxPolls, pollDelayMs, sleep})→RunStatusView` (polls to terminal; throws on poll-budget exhaustion / status error), `isTerminal`. `ModuleSelector` has the `submitted_overlay` variant.
- The platform `RunResultSummary` carries `metrics` (baseline) + `comparison: { baseline, variant, deltas }` (`Record<string,number>`), over the **7-metric** set (`pnl`, `sharpe`, `max_drawdown`, `win_rate`, `total_trades`, `profit_factor`, `top_trade_contribution_pct`) — 038. `comparison` keys are the baseline∩variant intersection (038 omit-safe); `profit_factor` is dropped when either side has no losing trades. `evidence.contractVersion` = `'017.2'`.
- Lab `ComparisonSummary` (`src/ports/platform-gateway.port.ts`) = `{ baseline: BacktestMetricBlock; variant: BacktestMetricBlock; sampleSize: { baselineTrades; variantTrades }; platformContractVersion: string }`. `BacktestMetricBlock` = `netPnlUsd, netPnlPct, totalTrades, winRate, profitFactor, maxDrawdownPct, expectancyUsd, sharpe, topTradeContributionPct` (all `number`).
- `ResearchPlatformPort` is a thin SDK boundary (returns SDK `ValidationReport`); the mcp adapter is stateless-over-transport, lazy variant opens a session per call (runtime boot spawns nothing). `toSubmittedBundle` (SP-7.1b) already maps `ModuleBundle`→`SubmittedBundle` with the 017 overlay manifest.

## Design

### Port surface (`src/ports/research-platform.port.ts`)

Grow `ResearchPlatformPort` (re-export SDK lifecycle types):

```ts
export interface PlatformRunConfig {
  readonly datasetId: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly seed: number;
}
export interface SubmitOverlayRunOptions {
  readonly baselineModuleRef: Ref;      // strategy:<profileId>@<version>, trusted catalog-resident
  readonly run: PlatformRunConfig;
  readonly correlationId?: string;
}
export interface ResearchPlatformPort {
  // ...existing discover / listDatasets / validateModule...
  submitOverlayRun(bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle>;
  getRunStatus(runId: string): Promise<RunStatusView>;
  getRunResult(runId: string): Promise<RunResultResult>;   // SDK union: {kind:'summary',summary} | {kind:'status',view}
}
```

The methods return SDK types; the `{ok,...}` envelope is unwrapped in the adapter and `ok:false` throws a typed `GatewayRunError` (new, mirrors `GatewayValidationError` in `gateway-errors.ts`).

### Request assembly (mcp adapter)

`submitOverlayRun` builds a `ControlledRunRequest`:
- `module: { kind: 'submitted_overlay', bundle: toSubmittedBundle(bundle), baselineModuleRef }`
- `datasetRef: { datasetId }`, `symbols`, `timeframe`, `period`, `seed`, `mode: 'research'`
- `metrics: ['pnl','sharpe','max_drawdown','win_rate','total_trades','profit_factor','top_trade_contribution_pct']` (so the platform computes the full set)
- `runId` generated by the adapter; `correlationId` passed through.
Comparison is overlay-driven (not `runMode`-driven) — `runMode` left unset.

### Orchestration (`src/research/run-backtest.ts` or similar, pure lab logic)

`runOverlayBacktest(port, bundle, opts, pollOpts)` → `PlatformRunOutcome`:
1. `handle = await port.submitOverlayRun(bundle, opts)` → emit `platform.run.submitted`.
2. `view = await awaitCompletion(...)` via the port's transport-less helper — **bounded** (`maxPolls`, `pollDelayMs`); on budget-exhaustion → outcome `{ status: 'pending', runId }` (emit `platform.run.pending`). NOTE: `awaitCompletion` needs the transport; to keep the port the boundary, the bounded poll is implemented in the adapter as a 4th concern OR the orchestration loops `getRunStatus` + `isTerminal` itself (preferred — keeps `awaitCompletion`/transport inside the adapter, orchestration uses the port's `getRunStatus`). The orchestration loops `getRunStatus` up to `maxPolls` with `pollDelayMs`, using SDK `isTerminal`.
3. On terminal: `res = await port.getRunResult(runId)`. If `res.kind==='summary'` and `summary.status==='completed'` and `summary.comparison` present → `comparison = mapPlatformComparison(summary)`; outcome `{ status:'completed', runId, comparison, artifactIds }` (emit `platform.run.completed`). Else (terminal non-completed / no comparison) → `{ status:'rejected', runId, terminalCode }` (emit `platform.run.rejected`).
- `artifactIds = summary.artifactRefs.map(r => r.artifactId)` (IDs only; no artifact reads).

### Mapper (`src/domain/platform-comparison.ts`, pure)

`mapPlatformComparison(summary: RunResultSummary): ComparisonSummary`:
- For each side (`comparison.baseline`, `comparison.variant`) build a `BacktestMetricBlock`:
  - `netPnlUsd = pnl`
  - `maxDrawdownPct = max_drawdown * 100` (platform fraction → lab percent)
  - `winRate = win_rate`; `sharpe = sharpe`; `totalTrades = total_trades`; `topTradeContributionPct = top_trade_contribution_pct`
  - `profitFactor = profit_factor` if present, else `NO_LOSS_PROFIT_FACTOR` (documented sentinel = a high finite constant that passes the evaluator PF gate; "no losing trades" is a strong edge)
  - `netPnlPct = pnl / INITIAL_EQUITY * 100` where `INITIAL_EQUITY = 10_000` (documented coupling to the platform constant)
  - `expectancyUsd = totalTrades > 0 ? netPnlUsd / totalTrades : 0`
- `sampleSize = { baselineTrades: baseline.total_trades, variantTrades: variant.total_trades }`
- `platformContractVersion = summary.evidence.contractVersion`
- A required metric (`pnl`/`max_drawdown`/`win_rate`/`sharpe`/`total_trades`/`top_trade_contribution_pct`) missing from a side → `MetricMappingError` (only `profit_factor` is legitimately omittable). Constants (`NO_LOSS_PROFIT_FACTOR`, `INITIAL_EQUITY`) + the 7 metric names live here.

### Adapters

- `MockResearchPlatformAdapter`: canned `RunJobHandle` + a completed `RunResultSummary` with a baseline-vs-variant comparison over the 7 metrics (configurable), so the probe + tests run fully offline.
- `McpResearchPlatformAdapter` / `LazyMcpResearchPlatformAdapter`: wrap the SDK `submitRun`/`getRunStatus`/`getRunResult` + `awaitCompletion` over the live transport; lazy opens a session per call.

### Probe + CLI

`runBacktestProbe(deps)` + `scripts/platform-run.ts` (`platform:run`): reads a bundle JSON (file/stdin) + run config (flags/JSON), runs the lifecycle through the selected adapter (mock default; mcp via `TRADING_PLATFORM_INTEGRATION`), prints the ordered `platform.run.*` AgentEvents + the mapped `ComparisonSummary`. DB-free (`ConsoleAgentEventSink`), mandatory contract-version handshake (reuse `assertContractCompatible`).

### Events (additive)

`platform.run.started | submitted | completed | pending | rejected | failed`.

## Acceptance

- **Offline (mock):** `platform:run` against the mock adapter produces a `completed` outcome with a mapped `ComparisonSummary` (9-field `BacktestMetricBlock` baseline+variant, `sampleSize`, `platformContractVersion`); the 7→9 mapping + sentinel/derive verified by unit tests (incl. the `profit_factor`-omitted case → `NO_LOSS_PROFIT_FACTOR`, and `max_drawdown`×100).
- **Bounded poll:** poll-budget exhaustion → `pending` outcome (no throw); terminal-non-completed → `rejected`.
- **Errors:** `ok:false` envelopes → `GatewayRunError`; a missing required metric → `MetricMappingError`.
- **Boundary:** `sdk-import-boundary.guard.test.ts` still passes (SDK import confined to `ports/research-platform.port.ts` + `adapters/platform/`). SP-4 path, `hypothesisBuildHandler`, evaluator, DB — zero diff.
- **Suite + typecheck green** (≥ current baseline + new tests).
- **Live round-trip = gateway-pending** (like SP-7.1): real `platform:run` against a 037/038 gateway + a trusted catalog-resident baseline strategy is recorded as pending (dev env has no `TRADING_PLATFORM_GATEWAY_COMMAND` / canonical Postgres); the offline-faithful mock acceptance is the bar for this slice.

**Definition of Done:** a bundle + run config can be driven through submit → bounded poll → result → `mapPlatformComparison` to yield a lab `ComparisonSummary`, end-to-end via the `platform:run` probe on the mock adapter, with the SP-4 path untouched and the SDK boundary intact.

## Risks

- `awaitCompletion` needs the transport → the bounded poll loop lives in the adapter (or orchestration loops `getRunStatus`+`isTerminal`); keep the transport out of the orchestration layer. Decided: orchestration loops `getRunStatus` via the port.
- Sentinel `NO_LOSS_PROFIT_FACTOR` is a magic value → name + document it; it only appears in the rare no-losing-trades case.
- `INITIAL_EQUITY=10000` couples the lab to a platform constant → documented; `netPnlPct` is unused by the evaluator, so low risk.
- Trusted baseline precondition (`strategy:<profileId>` catalog-resident) is a live-gateway concern → surfaces only on the live round-trip (gateway-pending).
