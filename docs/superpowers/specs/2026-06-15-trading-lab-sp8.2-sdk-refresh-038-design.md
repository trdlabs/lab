# SP-8.2 — Refresh vendored `@trading-platform/sdk` to feature 038 (7-metric catalog)

- **Date:** 2026-06-15
- **Slice:** SP-8.2 (prerequisite for SP-7.2; second SDK refresh after [[SP-8.1]])
- **Branch:** `sp8.2-sdk-refresh-038` (off `main`)
- **Builds on:** SP-8.1 (vendored SDK 0.2.0 + the refresh recipe), trading-platform feature 038
- **Unblocks:** SP-7.2 — Platform-backed Run Lifecycle

## Problem

trading-lab vendors `@trading-platform/sdk@0.2.0` (`vendor/trading-platform-sdk/trading-platform-sdk-0.2.0.tgz`), packed pre-feature-038. That build's `METRIC_CATALOG` carries only the 4 MVP metrics (`pnl`, `sharpe`, `max_drawdown`, `win_rate`). trading-platform feature 038 (merged to `main`, PR #3) added `total_trades`, `profit_factor`, `top_trade_contribution_pct` to the catalog + the runner, and the SDK was bumped `0.2.0 → 0.3.0` and pushed to `main` (`21d95ce`). SP-7.2 needs the lab's vendored SDK to carry the 7-metric surface (so a `discover()` against a 038 gateway returns the full catalog and the contract types/version line up). Pure packaging refresh.

## Goal

Refresh the vendored SDK `0.2.0 → 0.3.0` (the feature-038 build). **Existing runtime behavior unchanged; expected diffs are limited to the vendored tarball, the dependency path/lockfile, the vendor README, and SDK surface-proof tests** (including bumping SP-8.1's `SDK_VERSION` assertion). SP-4 mock path and SP-7/7.1/7.1b code untouched.

## Decisions (locked)

1. **TP-side bump already shipped.** `@trading-platform/sdk` `0.2.0 → 0.3.0` (both `package.json` and the hardcoded `SDK_VERSION` const) committed + pushed to trading-platform `main` (`21d95ce`); SDK snapshot is version-agnostic (no snapshot diff). Standalone invariant holds.
2. **Vendor from the pushed, remote-visible SHA** (`21d95ce`), per the SP-8.1 rule (no unpublished local commit).
3. **Proof of the 7-metric catalog.** `METRIC_CATALOG` is NOT in the SDK's public `exports` map (it reaches the lab at runtime via `discover().metricCatalog`). So the static proof asserts the vendored build's compiled catalog (`dist/contract/research/catalogs.js`) carries the 7 names — read the installed file by absolute path (fs read or absolute dynamic import; the package-specifier import is exports-gated). Plus the public `SDK_VERSION === '0.3.0'`.
4. **Update SP-8.1's version assertion.** `src/adapters/platform/sdk-overlay-surface.test.ts` asserts `SDK_VERSION === '0.2.0'` → bump to `'0.3.0'`; the `submitted_overlay` surface assertions stay (still valid in 0.3.0).

## Non-goals

- Any SP-7.2 lifecycle code, port/handler changes, metric mapping.
- Consuming `metricCatalog` at runtime (that's SP-7.2's `discover()` path).

## Plan of record (tasks)

- **T1 (DONE):** trading-platform `main` SDK bumped to `0.3.0` and pushed (`21d95ce`). Documented; no trading-lab action.
- **T2 (RED):** Update `src/adapters/platform/sdk-overlay-surface.test.ts` `SDK_VERSION` assertion `'0.2.0' → '0.3.0'`; add a proof (same file or new `sdk-metric-catalog.test.ts`) that the installed SDK's compiled `METRIC_CATALOG` contains all 7 names (`pnl`, `sharpe`, `max_drawdown`, `win_rate`, `total_trades`, `profit_factor`, `top_trade_contribution_pct`). `pnpm test` → FAIL against the still-`0.2.0` vendored tarball (version `0.2.0`, 4-name catalog).
- **T3 (GREEN):** `npm pack <tp>/packages/sdk --pack-destination vendor/trading-platform-sdk` → `trading-platform-sdk-0.3.0.tgz`; remove `0.2.0.tgz`; point `package.json` `file:` dep at `0.3.0.tgz`; update `vendor/.../README.md` (version `0.3.0`, source SHA `21d95ce`, "feature 038 — 7-metric METRIC_CATALOG"); `pnpm install`. Verify tarball internals (version `0.3.0`, `dist/contract/research/catalogs.js` has 7 names, `SDK_VERSION = '0.3.0'`, no `trading-platform`/`workspace:*` deps). `pnpm test` + `pnpm typecheck` → GREEN.
- **T4 (Gates):** full `pnpm test` (≥ baseline + the proof) + `pnpm typecheck` clean; SP-8 gold no-sibling archive gate (`git archive | tar -x` to temp dir with no `../trading-platform`, then `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`).

## Acceptance / Definition of Done

- Vendored tarball internal version, `SDK_VERSION`, and `file:` path all `0.3.0`; compiled `METRIC_CATALOG` carries the 7 names; standalone invariant holds.
- `sdk-overlay-surface.test.ts` green at `0.3.0` (`submitted_overlay` still importable); the 7-metric catalog proof green.
- Full lab suite + typecheck green; no-sibling archive gate green.
- Vendored from the pushed `main` SHA `21d95ce` (recorded in the README).
- One PR off `main`.

## Risks

- `METRIC_CATALOG` not publicly exported → proof must read the compiled file by absolute path (not a package import). Mitigation: documented in Decision 3.
- Lockfile diff should be limited to the SDK tarball path/integrity; review it.
