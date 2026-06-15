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

- SDK `0.3.0` (vendored) exports the lifecycle: `submitRun(transport, ControlledRunRequest)→SubmitRunResult`, `getRunStatus(transport, runId)→RunStatusResult`, `getRunResult(transport, runId)→RunResultResult` (`{ok:true,kind:'summary',summary}` | `{ok:true,kind:'status',view}` | `{ok:false,error}`), `isTerminal(status)`, and `awaitCompletion` (transport-based; **not** used by 7.2a — see Design). `ModuleSelector` has the `submitted_overlay` variant. `ControlledRunRequest` has **no** `runId` field; `RunJobHandle.runId` is returned by the gateway.
- The platform `RunResultSummary` carries `metrics` (the **baseline's full** metric set) + `comparison: { baseline, variant, deltas }` (`Record<string,number>`), over the **7-metric** set (`pnl`, `sharpe`, `max_drawdown`, `win_rate`, `total_trades`, `profit_factor`, `top_trade_contribution_pct`) — 038. `comparison` keys are the **baseline∩variant intersection** (038 omit-safe `computeComparison`); `profit_factor` is dropped from `comparison` when either side has no losing trades. `evidence.contractVersion` = `'017.2'`.
- Lab `ComparisonSummary` (`src/ports/platform-gateway.port.ts`) = `{ baseline: BacktestMetricBlock; variant: BacktestMetricBlock; sampleSize: { baselineTrades; variantTrades }; platformContractVersion: string }`. `BacktestMetricBlock` = `netPnlUsd, netPnlPct, totalTrades, winRate, profitFactor, maxDrawdownPct, expectancyUsd, sharpe, topTradeContributionPct` (all `number`).
- `ResearchPlatformPort` is a thin SDK boundary (returns SDK `ValidationReport`); the mcp adapter is stateless-over-transport, lazy variant opens a session per call (runtime boot spawns nothing). `toSubmittedBundle` (SP-7.1b) already maps `ModuleBundle`→`SubmittedBundle` with the 017 overlay manifest. SDK imports are confined to `ports/research-platform.port.ts` + `adapters/platform/` (guard-tested).

## Design

### Port surface (`src/ports/research-platform.port.ts`)

Grow `ResearchPlatformPort` (re-export the SDK lifecycle types **and** `isTerminal`, so non-adapter lab code uses them through the port boundary, not via a direct SDK import):

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
  readonly resumeToken?: string;        // passed through to ControlledRunRequest (idempotent replay; SP-7.2b/7.3)
  readonly workflowId?: string;         // passed through to ControlledRunRequest
}
export interface ResearchPlatformPort {
  // ...existing discover / listDatasets / validateModule...
  submitOverlayRun(bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle>;
  getRunStatus(runId: string): Promise<RunStatusView>;
  getRunResult(runId: string): Promise<RunResultView>;   // RunResultView = {kind:'summary',summary} | {kind:'status',view} (ok:true union)
}
// re-export: RunJobHandle, RunStatusView, RunResultView, Ref, isTerminal
```

The methods return SDK types; the `{ok,...}` envelope is unwrapped in the adapter and `ok:false` throws a typed `GatewayRunError` (new, mirrors `GatewayValidationError` in `gateway-errors.ts`). `getRunResult` returns the `ok:true` union (`summary` | `status`).

### Request assembly (mcp adapter)

`submitOverlayRun` builds a `ControlledRunRequest`:
- `module: { kind: 'submitted_overlay', bundle: toSubmittedBundle(bundle), baselineModuleRef }`
- `datasetRef: { datasetId }`, `symbols`, `timeframe`, `period`, `seed`, `mode: 'research'`
- `metrics: ['pnl','sharpe','max_drawdown','win_rate','total_trades','profit_factor','top_trade_contribution_pct']` (so the platform computes the full set)
- `correlationId`, optional `resumeToken`, optional `workflowId` passed through.
- The adapter does **NOT** set `runId` — `ControlledRunRequest` has no `runId` field; the gateway assigns it and returns `handle.runId` (`RunJobHandle.runId`).
Comparison is overlay-driven (not `runMode`-driven) — `runMode` left unset.

### Orchestration (`src/research/run-backtest.ts`, pure lab logic)

`runOverlayBacktest(port, bundle, opts, pollOpts)` → `PlatformRunOutcome`:
1. `handle = await port.submitOverlayRun(bundle, opts)` → emit `platform.run.submitted` (carry `handle.runId`, `handle.idempotentReplay`).
2. **Bounded poll:** loop `port.getRunStatus(handle.runId)` up to `maxPolls` times (waiting `pollDelayMs` between calls), checking terminal-ness via `isTerminal` (re-exported from `research-platform.port.ts`). The orchestration does NOT import the SDK and does NOT call `awaitCompletion` (it needs the transport, which stays inside adapters). On poll-budget exhaustion (no terminal status reached) → outcome `{ status: 'pending', runId }` (emit `platform.run.pending`).
3. On terminal status: `res = await port.getRunResult(runId)`. If `res.kind==='summary'` && `res.summary.status==='completed'` && `res.summary.comparison` present → `comparison = mapPlatformComparison(res.summary)`; outcome `{ status:'completed', runId, comparison, artifactIds }` (emit `platform.run.completed`). Else (terminal non-completed / `kind:'status'` / no comparison) → `{ status:'rejected', runId, terminalCode }` (emit `platform.run.rejected`).
- `artifactIds = summary.artifactRefs.map(r => r.artifactId)` (IDs only; no artifact reads).

### Mapper (`src/domain/platform-comparison.ts`, pure)

`mapPlatformComparison(summary: RunResultSummary): ComparisonSummary` builds a `BacktestMetricBlock` for each side from `summary.comparison.baseline` / `summary.comparison.variant`:
- `netPnlUsd = pnl`
- `maxDrawdownPct = max_drawdown * 100` (platform fraction → lab percent)
- `winRate = win_rate`; `sharpe = sharpe`; `totalTrades = total_trades`; `topTradeContributionPct = top_trade_contribution_pct`
- `netPnlPct = pnl / INITIAL_EQUITY * 100` where `INITIAL_EQUITY = 10_000` (documented coupling to the platform constant; unused by the evaluator)
- `expectancyUsd = totalTrades > 0 ? netPnlUsd / totalTrades : 0`
- **`profitFactor` — three-case rule** (do NOT blind-sentinel both sides; `comparison` carries only the baseline∩variant intersection, while `summary.metrics` is the **baseline's full** metric set):
  1. `comparison.baseline.profit_factor` AND `comparison.variant.profit_factor` both present → map both directly.
  2. `comparison` lacks `profit_factor` but `summary.metrics.profit_factor` present → `baseline.profitFactor = summary.metrics.profit_factor` (baseline had losses → finite PF); `variant.profitFactor = NO_LOSS_PROFIT_FACTOR` (variant omitted PF → no losing trades).
  3. `comparison` lacks `profit_factor` AND `summary.metrics.profit_factor` absent → **fail-closed** `MetricMappingError` code `ambiguous_profit_factor` (baseline had no losses; the current surface cannot tell whether the variant also had no losses or has a finite PF hidden by the common-key intersection).

`sampleSize = { baselineTrades: comparison.baseline.total_trades, variantTrades: comparison.variant.total_trades }`. `platformContractVersion = summary.evidence.contractVersion`.

Any of the other 6 metrics (`pnl`/`max_drawdown`/`win_rate`/`sharpe`/`total_trades`/`top_trade_contribution_pct`) missing from a side → `MetricMappingError` code `missing_metric`. `NO_LOSS_PROFIT_FACTOR` (a documented high finite sentinel that passes the evaluator PF gate), `INITIAL_EQUITY`, the error codes, and the 7 metric names live in this module.

### Adapters

- `MockResearchPlatformAdapter`: canned `RunJobHandle` + a completed `RunResultSummary` with a baseline-vs-variant comparison over the 7 metrics (configurable, incl. the `profit_factor`-omitted shapes), so the probe + tests run fully offline.
- `McpResearchPlatformAdapter` / `LazyMcpResearchPlatformAdapter`: wrap the SDK `submitRun`/`getRunStatus`/`getRunResult` over the live transport (unwrap `{ok,...}`, throw `GatewayRunError`); lazy opens a session per call.

### Probe + CLI

`runBacktestProbe(deps)` + `scripts/platform-run.ts` (`platform:run`): reads a bundle JSON (file/stdin) + run config (flags/JSON), runs the lifecycle through the selected adapter (mock default; mcp via `TRADING_PLATFORM_INTEGRATION`), prints the ordered `platform.run.*` AgentEvents + the mapped `ComparisonSummary`. DB-free (`ConsoleAgentEventSink`), mandatory contract-version handshake (reuse `assertContractCompatible`).

### Events (additive)

`platform.run.started | submitted | completed | pending | rejected | failed`.

## Acceptance

- **Offline (mock):** `platform:run` against the mock adapter produces a `completed` outcome with a mapped `ComparisonSummary` (9-field `BacktestMetricBlock` baseline+variant, `sampleSize`, `platformContractVersion`); the 7→9 mapping + derivations + the three `profit_factor` cases verified by unit tests:
  - both-present → both mapped; `comparison`-omitted-but-`summary.metrics.profit_factor`-present → baseline real / variant `NO_LOSS_PROFIT_FACTOR`; both-absent → `MetricMappingError` `ambiguous_profit_factor`; and `max_drawdown`×100.
- **Bounded poll:** `getRunStatus` loop reaching `maxPolls` without a terminal status → `pending` (no throw); terminal-non-completed → `rejected`.
- **Errors:** `ok:false` envelopes → `GatewayRunError`; a missing required metric → `MetricMappingError` (`missing_metric` / `ambiguous_profit_factor`).
- **Boundary:** `sdk-import-boundary.guard.test.ts` still passes (SDK import — incl. `isTerminal` — confined to `ports/research-platform.port.ts` + `adapters/platform/`). SP-4 path, `hypothesisBuildHandler`, evaluator, DB — zero diff.
- **Suite + typecheck green** (≥ current baseline + new tests).
- **Live round-trip = gateway-pending** (like SP-7.1): real `platform:run` against a 037/038 gateway + a trusted catalog-resident baseline strategy is recorded as pending (dev env has no `TRADING_PLATFORM_GATEWAY_COMMAND` / canonical Postgres); the offline-faithful mock acceptance is the bar for this slice.

**Definition of Done:** a bundle + run config can be driven through submit → bounded poll → result → `mapPlatformComparison` to yield a lab `ComparisonSummary`, end-to-end via the `platform:run` probe on the mock adapter, with the SP-4 path untouched and the SDK boundary intact.

## Risks

- **Bounded poll:** orchestration loops `port.getRunStatus()` + `isTerminal` (re-exported from the port); it does NOT call SDK `awaitCompletion` (transport stays inside adapters). Keeps SDK imports confined to the port file + adapters (guard-tested).
- **`profit_factor` ambiguity:** the common-key `comparison` can hide a finite variant PF; the three-case rule fails closed (`ambiguous_profit_factor`) rather than guess. Surfaces only in the rare no-losing-trades edge.
- Sentinel `NO_LOSS_PROFIT_FACTOR` + `INITIAL_EQUITY=10000` are documented constants; `netPnlPct` is unused by the evaluator, so the coupling is low-risk.
- Trusted baseline precondition (`strategy:<profileId>` catalog-resident) is a live-gateway concern → surfaces only on the live round-trip (gateway-pending).
