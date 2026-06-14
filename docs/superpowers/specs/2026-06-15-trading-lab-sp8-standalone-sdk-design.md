# SP-8 — Replace the temporary SDK workspace workaround with a standalone `@trading-platform/sdk`

**Date:** 2026-06-15
**Status:** Design (approved for plan)
**Depends on:** SP-7 (platform discovery; the port/adapter SDK boundary), `trading-platform` feature 034 (SDK Packaging Cleanup — standalone consumer package + `trading-bot-platform` → `trading-platform` rename)
**Branch:** `sp8-standalone-sdk`

## Problem

trading-lab currently consumes `@trading-platform/sdk` through a **sibling-source workaround**:

- `package.json` → `"@trading-platform/sdk": "file:../trading-platform/packages/sdk"`
- `package.json` → `"pnpm": { "overrides": { "trading-bot-platform@workspace:*": "link:../trading-platform" } }`
- `pnpm-lock.yaml` → a top-level `overrides:` block and an SDK importer entry that resolves `trading-bot-platform: link:../trading-platform` as a transitive dependency of the SDK
- `README.md` → a "Dependency note (temporary local-integration workaround)" section

This requires the sibling `../trading-platform` repo checked out next to trading-lab with its build output present, and it pulls the platform's runtime tree into `node_modules`. It is the only remaining coupling: trading-lab's **source is already clean** — every `@trading-platform/*` import is a public subpath (`@trading-platform/sdk`, `@trading-platform/sdk/agent`) confined to `src/ports/research-platform.port.ts` and `src/adapters/platform/*`, enforced by `src/adapters/platform/sdk-import-boundary.guard.test.ts`. No platform internals, no `trading-bot-platform`, no `@trading-platform/sdk/agent/mcp-transport` are imported anywhere in `src/`.

Feature 034 in trading-platform makes `@trading-platform/sdk` a **standalone consumer package**: `@trading-platform/sdk@0.1.0`, `dependencies: { decimal.js }` only, `@modelcontextprotocol/sdk` as an *optional* peer, fully self-vendored `dist/` (only relative internal imports, no bare platform specifiers), and the root package renamed `trading-bot-platform` → `trading-platform`. The standalone artifact exists and is packable today.

## Goal

trading-lab installs and typechecks with **no** local sibling `../trading-platform` repo and **no** pnpm override/link on the platform source package. trading-lab knows only the public SDK API and runtime gateway config; trading-platform stays a separate service/package, not a sibling source dependency.

## Decision: delivery channel — **vendored standalone tarball** (artifact vendoring)

There is no public npm registry for this private SDK. The chosen delivery channel is a **vendored tarball**: `pnpm pack` the standalone SDK once, commit the `.tgz` into trading-lab, and depend on it via `file:`.

| # | Decision | Choice |
|---|----------|--------|
| D1 | Delivery channel | Vendored standalone tarball committed to the repo (**artifact** vendoring, not source vendoring) |
| D2 | Tarball location | `vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz` (version pinned in filename) |
| D3 | Vendor docs | `vendor/trading-platform-sdk/README.md` records SDK version, source commit, refresh command, and that this is a temporary delivery channel until a private registry exists |
| D4 | Dependency form | `"@trading-platform/sdk": "file:./vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz"` |
| D5 | pnpm overrides | **Removed entirely** — the standalone SDK has no platform dependency to override |
| D6 | `@modelcontextprotocol/sdk` | Kept as a direct dependency (used directly by `mcp-research-transport.ts`; also the SDK's optional peer) |
| D7 | `decimal.js` | Transitive via the SDK tarball — **not** added directly (YAGNI) |
| D8 | Private npm registry | Out of scope — recorded as a future improvement |
| D9 | Local tarball outside repo | Rejected — not self-contained; same class of problem as the sibling repo |

## Changes

### 1. Vendor the artifact
- Run `pnpm pack` in `../trading-platform/packages/sdk` → `trading-platform-sdk-0.1.0.tgz`.
- Place it at `trading-lab/vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz` and commit it (`.gitignore` ignores `dist`/`node_modules`/`.artifacts` but not `*.tgz` or `vendor/`).
- Add `vendor/trading-platform-sdk/README.md` recording: SDK version (`0.1.0`), source commit (`647b13b`, trading-platform `main`), the refresh command, and that this is a temporary delivery channel until a private registry exists.

### 2. `package.json`
- `"@trading-platform/sdk": "file:./vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz"` (was `file:../trading-platform/packages/sdk`).
- **Delete** the `"pnpm": { "overrides": { "trading-bot-platform@workspace:*": ... } }` block.
- Keep `@modelcontextprotocol/sdk` (direct dep). Do not add `decimal.js`.

### 3. `pnpm-lock.yaml`
- Regenerate via `pnpm install`. The new lock must have no top-level `overrides:`, no `trading-bot-platform: link:...`, and resolve `@trading-platform/sdk` from the in-repo tarball with `decimal.js` + optional mcp peer.

### 4. Docs
- `README.md`: replace the "temporary local-integration workaround" section with a "standalone SDK (vendored)" note — how the tarball is produced/refreshed, that no sibling checkout is needed to install/typecheck/test, and a pointer to `vendor/trading-platform-sdk/README.md`. Soften the `pnpm platform:discover` example so the gateway reads as a separate service reached via `TRADING_PLATFORM_GATEWAY_COMMAND`/`TRADING_PLATFORM_GATEWAY_ARGS` env; the local-sibling gateway command is one optional dev convenience, not an install assumption.
- `.env.example`: already clean (gateway command/args/contract are runtime config). Add a one-line comment clarifying the SDK is a standalone vendored package; no structural change.

### 5. Minimal SDK smoke test
- Add `src/adapters/platform/sdk-smoke.test.ts` (inside the allowed import boundary so the guard test still passes). It imports **only confirmed public exports** of the standalone SDK and asserts they resolve:
  - root `@trading-platform/sdk`: `CONTRACT_VERSION`, `SDK_VERSION` (`'0.1.0'`), `SDK_CAPABILITIES` (all flags `false`)
  - `@trading-platform/sdk/agent`: `discover`, `listDatasets` (functions)
- Confirmed against `dist/index.d.ts` / `dist/agent/index.d.ts` of `0.1.0`. If the final standalone SDK renames any of these, the smoke test is adjusted to the actual public API. Always-on (no gateway required) — proves package-by-name resolution at typecheck and runtime.

## Blocker (hard stop — do not work around in trading-lab)

If the packed SDK tarball still pulls `trading-bot-platform`, the `trading-platform` source package, a `workspace:*` reference, or any platform internals, **stop**. The fix belongs in trading-platform feature 034, not in trading-lab. Do **not** re-introduce an override/link, a sibling fallback, or any platform-internal shim here.

## Verification (acceptance gates)

1. `pnpm install` (clean, no overrides/link) succeeds.
2. **No-sibling proof (mandatory, gold-standard):** copy the repo to a temp dir *outside* the workspace (no `../trading-platform` present), then `pnpm install --frozen-lockfile` + `pnpm typecheck` there succeed.
3. `pnpm typecheck` passes.
4. `pnpm test` passes (or remains at the same pre-existing skip gates) — including the new `sdk-smoke.test.ts`.
5. `pnpm why trading-bot-platform` and `pnpm why trading-platform` report no platform source package as a dependency.
6. `git grep` finds no imports of platform internals.
7. **Lockfile cleanliness — `pnpm-lock.yaml` must NOT contain any of:**
   - `link:../trading-platform`
   - `file:../trading-platform`
   - `trading-bot-platform@workspace:*`
   - `workspace:*` platform references
8. `sdk-import-boundary.guard.test.ts` still passes (source boundary unchanged).

## Out of scope (unchanged)

Deterministic orchestrator, `WorkflowRouter`, BullMQ, Postgres, ingress/handlers, fake/mock modes, the source-level SDK import boundary (already correct), observability/Phoenix/Langfuse, and trading-platform itself. No private-SDK-internals coupling is introduced.

## Architectural cleanliness criterion

trading-lab depends only on the public SDK API and runtime gateway config. The SDK arrives as a self-contained published artifact (here, a vendored tarball); trading-platform remains a separate service/package, never a sibling source dependency.
