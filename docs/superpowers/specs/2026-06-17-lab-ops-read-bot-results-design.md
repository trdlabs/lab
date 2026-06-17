# Feature 005 — Connect trading-lab to `@trading-platform/sdk/ops-read` (live bot-results read-port)

- **Date:** 2026-06-17
- **Repo:** `trading-lab` (consumer only)
- **Branch:** `005-lab-ops-read-bot-results`
- **Status:** design approved; plan pending.

## 1. Goal

Give `trading-lab` a **new read surface** for **live bot-results** (`BotRunRecord` / `ClosedTrade` / `RunSummary` …) sourced from `@trading-platform/sdk/ops-read` — the contract that feature 004 lifted into the SDK as the source of truth (doctrine A3). The lab reads these through a new hexagonal port, `BotResultsReadPort`, that abstracts the source (live HTTP vs mock vs fixture).

This is a **seam-only** increment: it ships the port + adapters + selector + tests + the re-vendored SDK tarball. **Consumer integration is deferred** — the Researcher / orchestrator do not call the new port in this feature, so their logic is literally unchanged (mirrors how the mock's Surface B shipped the seam without integration).

### Established facts (do not re-open)
- Lab gets backtest results today through `@trading-platform/sdk/agent` (`getRunResult` = **backtest**, behind `ResearchPlatformPort`). This path is **untouched**.
- The live bot-results contract now exists in the SDK as `@trading-platform/sdk/ops-read` (lifted in 004 from `operations/dto.ts`): `BotRunRecord`, `ClosedTrade`, `ClosedTradesAggregate`, `RunSummary`, `OperationalEvent`, `DecisionLogEntry` + closed unions; own axis `OPS_READ_CONTRACT_VERSION='ops.3'`.

### Findings from exploration that shaped this design
- **Lab has no live-bot-results consumer today.** Backtest results flow through `ResearchPlatformPort`; the lab-local synthetic `ResearchRunEnvelope` (under `PlatformGatewayPort`) is a narrowed mirror of research **contract 022** — a different shape, NOT live bot-results. `Researcher` is a strategy-proposal agent, not a results consumer. So `BotResultsReadPort` is a genuinely new surface.
- **Live bot-results live on the mock's Surface A (HTTP `ops.3`), not Surface B (MCP).** The mock's Surface B (stdio MCP, MCP-031 `017.2`) serves the backtest research contract (`discover` / `list_datasets` / `get_run_result`); it carries **no** bot-results. So lab reads live bot-results over **HTTP against Surface A** — the same surface trading-office consumes via `TRADING_PLATFORM_READ_URL`. The mock is untouched.
- **The SDK `/ops-read` is types-only** (no transport functions, unlike `/agent`). The HTTP wire contract of Surface A (endpoint paths, page envelope, auth header) is therefore **not** in the SDK — the lab HTTP adapter encodes it, mirroring Surface A.
- **Lab currently vendors a stale `@trading-platform/sdk@0.3.0` WITHOUT `/ops-read`** (`node_modules/@trading-platform/sdk` has no `./ops-read` export; `dist/ops-read/` absent). The mock's `0.3.0` (post-004) *has* `/ops-read` — same version string, two builds. 005 re-packs the current SDK and re-vendors lab.
- **Import-boundary guard:** `@trading-platform/*` may be imported only from `src/ports/research-platform.port.ts` and `src/adapters/platform/**` (`sdk-import-boundary.guard.test.ts`). The new port file must be added to its allowlist.

## 2. Four approved decisions
1. **Scope = seam-only.** New `BotResultsReadPort` + live/mock/fixture adapters + selector + tests + re-vendored tgz. No Researcher/orchestrator integration this feature.
2. **Live transport = HTTP against Surface A (`ops.3`).** A new lab HTTP adapter GETs the ops-read endpoints and parses JSON into SDK `/ops-read` types. Mock untouched; on prod the same read-URL of the platform.
3. **Port core = runs + trades + summary.** `listBotRuns` / `getClosedTrades` / `getRunSummary` over `BotRunRecord` / `ClosedTrade` / `RunSummary`. Events/decisions deferred.
4. **Re-pack current SDK, stay `0.3.0`.** `npm pack` the post-004 SDK (already carrying `/ops-read`) → replace lab's vendored tgz → `pnpm install`. SDK `package.json` version is **not** bumped (re-pack is a build artifact, not a source edit); the version collision is resolved by re-vendoring (lab and mock then share `0.3.0-with-ops-read`).

## 3. Architecture (hexagonal — follows lab's existing convention)

```
src/ports/bot-results-read.port.ts        — interface BotResultsReadPort + re-export of the SDK /ops-read DTOs
        ▲ implements
src/adapters/platform/
  ├─ http-ops-read.adapter.ts             — LIVE: HTTP GET → Surface A (ops.3) → parse → SDK types
  ├─ mock-bot-results.adapter.ts          — canned SDK-typed values (boot-safe, no I/O)
  ├─ fixture-bot-results.adapter.ts       — reads local JSON fixtures → SDK types
  └─ select-bot-results.ts                — env-gated selector (mock | fixture | http)
```

The port owns the SDK import (per the import-boundary guard) and re-exports the DTOs, so adapters depend on lab-local port types. The port returns clean SDK types; the HTTP adapter encapsulates Surface A's wire contract (paths, cursor pagination, auth) internally — none of that HTTP specificity leaks into the port or the other two adapters.

## 4. The port — `src/ports/bot-results-read.port.ts`

```ts
// Re-exports the SDK /ops-read DTOs (the port owns the SDK import per the boundary guard),
// so adapters import lab-local port types rather than the SDK directly.
export type {
  BotRunRecord, ClosedTrade, ClosedTradesAggregate, RunSummary,
  TradeSide, BotMode, BotRunStatus,
} from '@trading-platform/sdk/ops-read';

export interface BotRunsFilter {
  readonly mode?: BotMode;
  readonly status?: BotRunStatus;
}

export interface BotResultsReadPort {
  listBotRuns(filter?: BotRunsFilter): Promise<readonly BotRunRecord[]>; // adapter walks cursor pages internally
  getClosedTrades(runId: string): Promise<readonly ClosedTrade[]>;
  getRunSummary(runId: string): Promise<RunSummary>;
}
```

**Pagination does not leak.** `listBotRuns` returns `readonly BotRunRecord[]`; the HTTP adapter walks Surface A's cursor pages internally. Cursor is a Surface A transport detail — exposing it would leak HTTP specificity into the contract that all three adapters (mock/fixture have no cursor) must honor. A cursor-bearing paginated API is **out of scope** until a consumer asks for paging (YAGNI).

## 5. Adapters, selector, env

- **`HttpOpsReadAdapter`** (live) — `implements BotResultsReadPort`. `fetch` GET to the ops-read endpoints (`/ops/runs` with cursor pagination via the page envelope, `/ops/trades?runId=…`, `/ops/runs/:id/summary`); bearer token (sha256 allowlist, as office uses); parses JSON → SDK types; fail-closed on non-2xx / parse error / timeout. Config from env: a **dedicated** `LAB_OPS_READ_URL` / `LAB_OPS_READ_TOKEN` (exact names a plan-time lookup). **Do not reuse the research-transport env** (`TRADING_PLATFORM_GATEWAY_*` / research URL) — research and bot-results are separate channels.
- **`MockBotResultsAdapter`** — canned SDK-typed values, no I/O (boot-safe, like `MockResearchPlatformAdapter`).
- **`FixtureBotResultsAdapter`** — reads local JSON fixtures (shaped like Surface A responses) → SDK types.
- **`selectBotResults(integration)`** — env-gated (`'mock' | 'fixture' | 'http'`), following the `selectResearchPlatform` convention but on a **separate axis** — a dedicated enum/env (e.g. `LAB_BOT_RESULTS_INTEGRATION`), NOT `TRADING_PLATFORM_INTEGRATION`. Unknown value → fail-closed.

## 6. Re-vendor the SDK tarball (stay `0.3.0`)

`npm run build:sdk` in `trading-platform` → `npm pack` in `packages/sdk` (produces `trading-platform-sdk-0.3.0.tgz` **with** `/ops-read`) → replace `trading-lab/vendor/trading-platform-sdk/trading-platform-sdk-0.3.0.tgz` → `pnpm install` (updates the lock integrity for the new byte content). The SDK `package.json` is **not** edited. After this, lab and mock vendor an identical `0.3.0-with-ops-read`.

## 7. Import-boundary guard

`src/adapters/platform/sdk-import-boundary.guard.test.ts` currently allowlists only `research-platform.port.ts` as a permitted SDK importer (besides `src/adapters/platform/**`). Add `src/ports/bot-results-read.port.ts` to its `ALLOWED_FILES`. The three adapters already live under `src/adapters/platform/**`, so they are within the boundary.

## 8. Testing

- **Adapter unit tests:** `HttpOpsReadAdapter` parses fixture Surface A JSON (including a multi-page cursor walk) into SDK types; non-2xx / parse error / timeout fail closed. `Mock` / `Fixture` adapters return valid SDK-typed values.
- **Selector test:** env → correct adapter; unknown value → fail-closed.
- **Boundary guard:** passes with the new port file in the allowlist; a contrived SDK import outside the allowlist is rejected.
- **Golden / contract test:** the fixtures structurally conform to the SDK `/ops-read` shapes (type-level, as done in the mock).
- **Vendored-tgz verify (machine guarantee — `verify:vendored-sdk` analogue):** a check that asserts (a) the `@trading-platform/sdk` dependency specifier is the vendored `file:` tarball, and (b) the **installed/vendored SDK actually exposes `/ops-read`** AND carries `OPS_READ_CONTRACT_VERSION === 'ops.3'`. This catches **silent stale-vendoring** — without it, the type tests only pass on a good build and nothing flags a regressed-to-stale `0.3.0`-without-ops-read. Wired into the lab CI/check command.
- A live integration test against a running mock Surface A is **optional / deferred** (seam-only; the adapter is proven with fixtures).

## 9. Out of scope (strict)
- The backtest `ResearchPlatformPort` / `getRunResult` path (live and backtest coexist).
- The `PlatformGatewayPort` / `ResearchRunEnvelope` (contract 022) synthetic path.
- Researcher / orchestrator logic (no consumer integration this feature).
- `trading-mock-platform` and `trading-platform`/SDK source (only an SDK re-pack as a build artifact).
- Events / decisions / health / coverage read methods.
- Any backtesting (`backtesting_moved_to_trading_backtester`).
- A cursor-bearing paginated port API (deferred until a consumer needs paging).
- Mixing the research-transport env/selector with the bot-results channel.

## 10. Plan-time lookups (resolve during planning — not placeholders)
1. The exact Surface A ops-read HTTP contract from the mock (`src/ops/handlers` + `src/http`): endpoint paths (`/ops/runs` + query params, `/ops/trades?runId=…`, `/ops/runs/:id/summary`), the page-envelope shape, and the auth-header name.
2. The exact env var names — **confirm office's real convention** (`TRADING_PLATFORM_READ_URL` / `TRADING_PLATFORM_READ_TOKEN`). If lab already has a similar research-transport env, do **not** reuse it for ops-read; introduce dedicated `LAB_OPS_READ_*` (per lab convention). Keep research and bot-results channels separate.
3. The exact SDK re-pack command + the lab `vendor/` path (`vendor/trading-platform-sdk/trading-platform-sdk-0.3.0.tgz`).
4. The lab selector/env-enum convention (how `TRADING_PLATFORM_INTEGRATION` is read) — mirror it on a **separate axis** (`LAB_BOT_RESULTS_INTEGRATION`), not the research integration.
