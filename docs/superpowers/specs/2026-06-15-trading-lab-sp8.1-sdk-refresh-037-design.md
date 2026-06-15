# SP-8.1 — Refresh vendored `@trading-platform/sdk` to feature 037 (`submitted_overlay`)

- **Date:** 2026-06-15
- **Slice:** SP-8.1 (prerequisite for SP-7.2)
- **Branch:** `sp8.1-sdk-refresh-037` (off `main`)
- **Builds on:** SP-8 (vendored standalone SDK tarball), SP-7.1b, SP-7
- **Unblocks:** SP-7.2 — Platform-backed Run Lifecycle

## Problem

trading-lab consumes `@trading-platform/sdk` as a vendored `file:` tarball
(`vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz`, packed from trading-platform
`647b13b`, **feature 034**). That tarball predates trading-platform **feature 037**
(submitted-overlay run topology, merged to trading-platform `main` via PR #2, `da4aae3`).

The vendored `0.1.0` tarball contains **no** `submitted_overlay` `ModuleSelector` variant — verified by
extracting the tarball and grepping `submitted_overlay` / `baselineModuleRef` / `ModuleSelector`
(zero hits). SP-7.2 must compile a platform-backed backtest path against exactly that DTO:

```ts
// @trading-platform/sdk/agent (feature 037 source — NOT yet in the vendored tarball)
export type ModuleSelector =
  | { readonly kind: 'ref'; readonly moduleRef: Ref }
  | { readonly kind: 'submitted'; readonly bundle: SubmittedBundle }
  | { readonly kind: 'submitted_overlay'; readonly bundle: SubmittedBundle; readonly baselineModuleRef: Ref };
```

So SP-7.2 is blocked on packaging, not on platform availability. This slice closes that gap and
nothing else.

## Goal

Bring the feature-037 SDK surface (the `submitted_overlay` variant + the run-lifecycle DTOs/workflow
functions: `submitRun`, `getRunStatus`, `getRunResult`, `awaitCompletion`, `cancelRun`,
`readArtifactPage`, `isTerminal`, plus `ControlledRunRequest` / `RunJobHandle` / `RunStatusView` /
`RunResultSummary` / `ComparisonSummaryDTO`) into trading-lab's vendored SDK via a clean version bump.

**Pure packaging change.** Existing runtime behavior remains unchanged; expected diffs are limited to
the vendored SDK tarball, the dependency path/lockfile, the vendor README, and the SDK surface proof
tests. The SP-4 mock backtest path and the SP-7/7.1/7.1b code are not modified.

## Non-goals

- No SP-7.2 lifecycle code: no `ResearchPlatformPort` growth, no handler fork, no new adapters,
  no `submitRun` wiring. This slice only makes the new SDK surface **importable**.
- No move to a private npm registry (still the recorded future improvement from SP-8).
- No consumption of feature-036 (paper-candidate-intake) SDK changes — the pack source is pinned to
  trading-platform `main` at/after the 037 merge, never the in-flight `036` branch.

## Decisions (locked)

1. **Version bump path (chosen):** bump `@trading-platform/sdk` `0.1.0 → 0.2.0` in trading-platform
   **source first**, then vendor `trading-platform-sdk-0.2.0.tgz`. Semver minor is correct: feature 037
   adds a `ModuleSelector` union member (additive, non-breaking). The vendored tarball's internal
   manifest version then matches its filename and the root `package.json` `file:` path — no cosmetic
   mismatch.
2. **trading-platform bump lands as a direct commit on `main`, then is pushed** (chosen): on the
   already-current, clean local `main` (== `origin/main`, which now includes features 035 + 036 + 037),
   bump **both** `packages/sdk/package.json` `version` and the hardcoded `SDK_VERSION` constant
   (`packages/sdk/src/index.ts:22`) to `0.2.0`, rebuild `packages/sdk/dist`, commit
   (`chore(sdk): bump @trading-platform/sdk to 0.2.0`), and **push to `origin/main`** (user-authorized for
   this SDK bump). The SP-8.1 trading-lab PR records that pushed SHA in the vendor README.
3. **Pack source is a pushed, remote-visible `main` SHA.** Pack from the local `main` checkout at the
   pushed bump commit — `origin/main` (includes 035 + 036 + 037) + the version bump. Record the exact
   SHA in `vendor/.../README.md`. Vendoring from a pushed SHA (not an unpublished local commit) keeps the
   tarball traceable to remote history. `SDK_VERSION` is a hardcoded constant, not derived from
   `package.json`, so both must move together. 036 added a `./intake` SDK surface (incidentally vendored,
   not consumed in this slice); its only `package.json` change is two export entries — no new deps.
4. **The SP-8 standalone invariant is re-asserted.** The packed `package.json` must declare no
   `trading-platform`, `trading-bot-platform`, or `workspace:*` dependency (`dependencies: decimal.js`;
   `@modelcontextprotocol/sdk` optional peer). If it does, fix trading-platform feature 034 — never work
   around it in trading-lab.

## Plan of record (two repos, in order)

### Part A — trading-platform (`main`)

1. `git -C ../trading-platform fetch`; confirm the working checkout is on `main`, clean, and `main` ==
   `origin/main` (`0 0` divergence). It currently is (`3b53293`, post-036 merge); if behind, `merge
   --ff-only origin/main`. No worktree needed.
2. Verify `main`'s `packages/sdk/src/agent/dto.ts` has the `submitted_overlay` `ModuleSelector` variant
   (037 present), the `src/intake/**` surface exists (036 present), and the `packages/sdk` subtree is
   clean (no unintended dirty changes).
3. Bump `packages/sdk/package.json` `version` **and** the hardcoded `SDK_VERSION` constant
   (`packages/sdk/src/index.ts:22`) to `0.2.0`. (`BUILDER_SDK_VERSION` in `src/builder/_vendor/version.ts`
   tracks the vendored builder-template snapshot, not the agent SDK — leave it untouched.) Rebuild
   `packages/sdk/dist`.
4. Confirm the standalone invariant on the built package (`dependencies` / `peerDependencies` declare no
   `trading-platform` / `trading-bot-platform` / `workspace:*`).
5. Commit to `main` and **push to `origin/main`** (user-authorized); capture the pushed SHA; checkpoint
   the SHA + diff summary to the user before Part B.

### Part B — trading-lab (`sp8.1-sdk-refresh-037`, the PR)

1. `npm pack <tp-main-worktree>/packages/sdk --pack-destination vendor/trading-platform-sdk` →
   `trading-platform-sdk-0.2.0.tgz`. Remove `trading-platform-sdk-0.1.0.tgz`.
2. Sanity-check the new tarball: `tar -tzf …` and `tar -xOf … package/package.json` — assert version
   `0.2.0`, the standalone-dependency invariant, and that `submitted_overlay` appears in
   `package/dist/agent/dto.d.ts`.
3. Update `vendor/trading-platform-sdk/README.md`: version `0.2.0`, new source SHA, a line noting
   "feature 037 — adds the `submitted_overlay` ModuleSelector variant + run-lifecycle DTOs".
4. Point the root `package.json` dependency `file:` path at `…0.2.0.tgz`; `pnpm install` to regenerate
   the lockfile (integrity-pinned to the new tarball).
5. Add the importability proof (see Acceptance).

## Acceptance

All of the following must be green:

- **Existing SDK smoke unchanged:** `src/adapters/platform/sdk-smoke.test.ts` still passes
  (`CONTRACT_VERSION`, `SDK_VERSION`, `SDK_CAPABILITIES`, `discover`, `listDatasets`).
- **New surface proof (the gap this slice closes):**
  - *Type-level:* a `tsc`-checked construction of `{ kind: 'submitted_overlay', bundle, baselineModuleRef }`
    typed as `ModuleSelector` from `@trading-platform/sdk/agent` — fails to compile against the old
    `0.1.0` tarball, compiles against `0.2.0`. Lives in a new
    `src/adapters/platform/sdk-overlay-surface.test.ts` (type usage exercised under `pnpm test` + `tsc`).
  - *Runtime:* assert `submitRun`, `getRunStatus`, `getRunResult`, `awaitCompletion`, `cancelRun`,
    `readArtifactPage`, `isTerminal` are exported as functions from `@trading-platform/sdk/agent`.
- **Version proof:** assert the vendored tarball's internal `package/package.json` version is `0.2.0`
  and `SDK_VERSION` reflects it.
- **Full suite + typecheck:** `pnpm test` (≥ the current 993 passing) and `pnpm typecheck` clean.
- **Gold-standard no-sibling gate (from SP-8):**
  `git archive sp8.1-sdk-refresh-037 | tar -x -C $(mktemp -d)` then, in that temp dir with **no**
  `../trading-platform` present, `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` all green.

**Definition of done:** a trading-lab module can
`import type { ModuleSelector } from '@trading-platform/sdk/agent'` and narrow to `submitted_overlay`
with `tsc` passing, the version/standalone invariants hold, and the no-sibling archive gate is green.

## Risks / mitigations

- **An earlier investigation briefly read `main` as having "reverted 037"** — that was a
  reverse-direction `git diff` artifact against a then-stale local checkout. Resolved: 037 (and now 036)
  are intact on `origin/main`; local `main` is current (`3b53293`). Mitigation: Part A re-verifies
  `submitted_overlay` is present at the pack source before packing.
- **036's SDK additions are now part of `main`** and are intentionally vendored. Mitigation: pack from
  the pushed `main` SHA; the surface proof targets only `submitted_overlay` (037, the SP-7.2
  prerequisite), and trading-lab does not consume the `./intake` (036) surface in this slice.
- **`pnpm install` pulls an unexpected transitive change.** Mitigation: review the lockfile diff —
  expect only the SDK tarball path/integrity (and `decimal.js` if unchanged). No new runtime deps.
- **Same-version-different-content trap** (the reason we bump): avoided by the `0.2.0` bump — the
  filename, internal manifest version, and `file:` path all change together.
