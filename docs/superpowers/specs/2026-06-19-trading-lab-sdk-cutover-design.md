# `trading-lab` → `@trading-backtester/sdk` Cutover Design (Phase 2)

**Status:** approved design

**Date:** 2026-06-19

**Owning repository:** `trading-lab`

**Depends on:** `@trading-backtester/sdk@0.1.0` (published GitHub Release, `trading-backtester`)

## 1. Context

`trading-lab` consumes the standalone backtester through a sibling path dependency:

```json
"@trading-backtester/client": "file:../trading-backtester/packages/client"
```

`trading-backtester` has shipped Phase 1: a public, standalone `@trading-backtester/sdk@0.1.0`,
published as a GitHub Release tarball
(`https://github.com/alexnikolskiy/trading-backtester/releases/download/sdk-v0.1.0/trading-backtester-sdk-0.1.0.tgz`).
The SDK exposes four subpaths — `/contracts`, `/builder`, `/client`, `/artifacts` — and its public
wire types are structurally identical to the frozen `@trading-backtester/client` (a compile-time
parity test in the backtester guards this).

This design is **Phase 2** of the SDK initiative: migrate `trading-lab`'s backtester integration
off the sibling client path dependency and onto the published SDK, so a clean `trading-lab` clone
no longer needs a sibling `trading-backtester` checkout to install.

## 2. Goal

Replace the sibling `@trading-backtester/client` dependency with the published
`@trading-backtester/sdk@0.1.0`, retarget the backtester-path modules to the SDK's explicit
subpaths, build the submitted backtester bundle through the SDK builder, and keep every test
(including the opt-in cross-repo E2E) green — with no behavioral change to the lab→backtester flow.

## 3. Scope

### In scope (`trading-lab`, branch `feat/sdk-cutover`)

The **backtester path** only — the six files that import `@trading-backtester/client`:

- `package.json` — dependency swap.
- `src/adapters/platform/backtester-bundle.ts` — `toBacktesterBundle`.
- `src/adapters/platform/http-backtester.adapter.ts` — `HttpBacktesterAdapter`.
- `src/adapters/platform/select-research-platform.ts` — backtester branch (constructs the client).
- `src/adapters/platform/http-backtester.adapter.test.ts` — unit test.
- `src/adapters/platform/http-backtester.integration.test.ts` — in-process integration test.
- `src/adapters/platform/cross-repo-e2e.integration.test.ts` — opt-in cross-repo E2E.

### Out of scope

- The **platform / MCP path**: `src/adapters/platform/submitted-bundle.ts` and all
  `@trading-platform/sdk` imports (`createOverlayManifest`, `SubmittedBundle`, platform
  `CONTRACT_VERSION`). That path targets the platform gateway, not the backtester, and is a future
  `trading-platform-sdk` concern.
- **Phase 3** in `trading-backtester` (removing `packages/client`, `wire.ts`, the client-parity
  test, and adding a `file:../` guard). Per the SDK spec, Phase 3 runs **after** this cutover merges
  and is a separate PR in `trading-backtester`.
- LLM/builder/orchestrator logic, agent roadmap work (reranker, Operator-RAG, completion replies)
  — untouched.

## 4. Decisions

1. **Pin the exact GitHub Release tarball URL.** `package.json` depends on
   `@trading-backtester/sdk` via the immutable `sdk-v0.1.0` asset URL — no npm registry, no sibling
   checkout. `pnpm install` fetches it (cached); a correction would be a new SDK semver.
2. **Build the bundle through the SDK builder.** `toBacktesterBundle` keeps the lab-specific
   taxonomy mapping (`hypothesis_overlay → overlay`, version default) but constructs the result via
   `createModuleManifest` + `createModuleBundle` from `@trading-backtester/sdk/builder`, rather than
   hand-assembling the object literal. This guarantees the exact inline bundle the service accepts
   (canonical file ordering + frozen) and keeps the lab on the SDK's authoring surface.
3. **Backtester path only.** The platform/MCP path and `@trading-platform/sdk` stay exactly as they
   are. The SDK spec's "stop using `@trading-platform/sdk/builder` on the backtester path" is
   already true for the backtester path (it never used the platform builder); this cutover only
   ensures the backtester path is fully SDK-driven.
4. **No behavioral change.** Imports + bundle-construction mechanism change; routes, polling,
   type-bridging (`toSdkStatusView` / `toSdkSummary` / `toSdkValidationReport`), error mapping, and
   the submitted bundle's content hash are unchanged. The SDK wire types are structurally identical
   to the old client, so the adapter's bridging typechecks without rework.
5. **Cross-repo E2E stays opt-in.** The `cross-repo-e2e.integration.test.ts` gate keeps its
   `RUN_CROSS_REPO_E2E=true` + `BACKTESTER_API_URL` guard and Docker demo-stack prerequisite. The
   cutover changes only its import source.

## 5. Import retargeting

| Symbol(s) used in `trading-lab` | Old source | New source |
|---|---|---|
| `BacktesterClient` | `@trading-backtester/client` | `@trading-backtester/sdk/client` |
| `BacktesterError`, `BacktesterConflictError` | `@trading-backtester/client` | `@trading-backtester/sdk/client` |
| wire DTOs (`ModuleBundle`, `CapabilityDescriptor`, `DatasetDescriptor`, `RunResultSummary`, `RunStatusView`, `RunSubmitRequest`, `ValidationReport`, `ComparisonSummary`, `MetricDelta`) | `@trading-backtester/client` | `@trading-backtester/sdk/contracts` |
| `BUNDLE_CONTRACT_VERSION` | `@trading-backtester/client` | (no longer imported — `createModuleManifest` pins it) |
| `createModuleManifest`, `createModuleBundle` | — (new) | `@trading-backtester/sdk/builder` |

Artifact references are consumed structurally through `RunResultSummary.artifactRefs`, so no direct
`@trading-backtester/sdk/artifacts` import is required; add one only if a file names an artifact type
directly.

## 6. `toBacktesterBundle` after cutover

The lab domain `ModuleBundle` (`manifest.moduleId`, `manifest.moduleKind`, `manifest.entry`,
`files`, optional `overlayMeta.version`) maps to the canonical executable bundle as:

```text
kind     = moduleKind === 'hypothesis_overlay' ? 'overlay' : 'strategy'
version  = overlayMeta?.version ?? '1.0.0'
manifest = createModuleManifest({ id: moduleId, version, kind })   // pins bundleContractVersion
bundle   = createModuleBundle({ manifest, entry, files })           // canonical-sorted, frozen
```

The returned value is the SDK `ModuleBundle`. Because the backtester hashes a bundle over its
canonical (sorted-key) JSON, switching from a hand-built literal to `createModuleBundle` does not
change the submitted bundle's content hash — submission behavior is identical.

## 7. Verification

- **Install:** `pnpm install` resolves `@trading-backtester/sdk` from the release URL and updates
  the lockfile; no `file:../trading-backtester` resolution remains for the backtester dependency.
- **Typecheck:** `pnpm typecheck` (catches any wire-shape divergence between the old client and the
  SDK — expected none, since Phase 1 verified structural parity).
- **Unit/integration:** `pnpm test` — the adapter unit test, the in-process integration test, and
  all non-gated suites pass unchanged; the cross-repo E2E skips without opt-in.
- **Cross-repo acceptance (manual gate):** with the demo Docker stack up,
  `RUN_CROSS_REPO_E2E=true BACKTESTER_API_URL=… pnpm vitest run …cross-repo-e2e…` proves the
  three-system path `trading-lab → trading-backtester (via SDK) → trading-mock-platform` still
  produces a deterministic result and bounded artifacts.

## 8. Risks

- **Network at install time.** Pinning the release URL means `pnpm install` fetches from GitHub.
  CI and dev have network; the tarball is cached after first fetch.
- **Wire divergence.** If any SDK wire field differs from the old client, `pnpm typecheck` fails on
  the adapter bridging — fixed pointwise (not expected, given verified parity).
- **`createModuleBundle` shape.** The SDK manifest/bundle must match what the service accepts; the
  backtester's own `bundle.test.ts` golden parity (Phase 1) guarantees the shape, and the lab maps
  onto it 1:1.

## 9. Acceptance criteria

1. `trading-lab` installs with `@trading-backtester/sdk@0.1.0` from the release URL and **no**
   `file:../trading-backtester/packages/client` dependency.
2. The six backtester-path files import from `@trading-backtester/sdk/{contracts,client,builder}`,
   not from `@trading-backtester/client`.
3. `toBacktesterBundle` produces its result via the SDK builder.
4. `pnpm typecheck` and `pnpm test` pass; the cross-repo E2E remains opt-in and, when run against
   the demo stack, stays green.
5. The platform/MCP path (`submitted-bundle.ts`, `@trading-platform/sdk`) is unchanged.
6. No behavioral change to the lab→backtester submit/poll/result/validate flow.
