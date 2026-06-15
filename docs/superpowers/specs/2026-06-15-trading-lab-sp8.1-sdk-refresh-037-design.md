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
2. **trading-platform bump lands as a direct tiny commit on `main`** (chosen): fast-forward the local
   trading-platform `main` checkout to `origin/main` (`da4aae3`, the 037 PR #2 merge — a clean
   fast-forward, 0 local-only commits), bump **both** `packages/sdk/package.json` `version` and the
   hardcoded `SDK_VERSION` constant (`packages/sdk/src/index.ts:22`) to `0.2.0`, rebuild
   `packages/sdk/dist`, commit directly (`chore(sdk): bump @trading-platform/sdk to 0.2.0`). The SP-8.1
   trading-lab PR records that commit SHA in the vendor README.
3. **Pack source is pinned and clean.** Pack from local `main` at the bump commit — which is
   `origin/main` (`da4aae3`, includes both feature 035 and 037) + the version bump, carrying nothing
   from the in-flight `036` branch. Record the exact SHA in `vendor/.../README.md`.
   `SDK_VERSION` is a hardcoded constant, not derived from `package.json`, so both must move together.
4. **The SP-8 standalone invariant is re-asserted.** The packed `package.json` must declare no
   `trading-platform`, `trading-bot-platform`, or `workspace:*` dependency (`dependencies: decimal.js`;
   `@modelcontextprotocol/sdk` optional peer). If it does, fix trading-platform feature 034 — never work
   around it in trading-lab.

## Plan of record (two repos, in order)

### Part A — trading-platform (`main`)

1. `git -C ../trading-platform fetch`; fast-forward local `main` to `origin/main` (`da4aae3`). The
   working checkout is on `036`; do this without disturbing it (operate on `main` via a worktree or a
   stash-free branch switch — the `036` package.json is the only dirty file and is unrelated).
2. Verify the fast-forwarded `main`'s `packages/sdk/src/agent/dto.ts` has the `submitted_overlay`
   `ModuleSelector` variant (feature 037 present) and the subtree carries nothing from `036`.
3. Bump `packages/sdk/package.json` `version` **and** the hardcoded `SDK_VERSION` constant
   (`packages/sdk/src/index.ts:22`) to `0.2.0`. (`BUILDER_SDK_VERSION` in `src/builder/_vendor/version.ts`
   tracks the vendored builder-template snapshot, not the agent SDK — leave it untouched.) Rebuild
   `packages/sdk/dist`.
4. Confirm the standalone invariant on the built package (`dependencies` / `peerDependencies` declare no
   `trading-platform` / `trading-bot-platform` / `workspace:*`).
5. Commit to `main`; capture the SHA. (Pushing `main` to origin is outward-facing — confirm before push;
   not required for trading-lab to pack from the local build.)

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

- **Local trading-platform `main` checkout was stale**, not regressed: it sat at `1fa3c68` (feature 035),
  7 commits behind `origin/main` (`da4aae3`, the 037 PR #2 merge), 0 local-only — a clean fast-forward.
  Feature 037 (SDK dto + gateway wiring + verify scripts) is fully intact on `origin/main`. (An earlier
  "037 looks reverted" read was a reverse-direction diff artifact.) Mitigation: Part A fast-forwards
  local `main` to `origin/main` and verifies `submitted_overlay` is present before packing; the README
  records the SHA.
- **Accidentally packing `036` SDK changes.** Mitigation: pack from a clean `main` worktree, never the
  `036` working checkout; verify the subtree.
- **`pnpm install` pulls an unexpected transitive change.** Mitigation: review the lockfile diff —
  expect only the SDK tarball path/integrity (and `decimal.js` if unchanged). No new runtime deps.
- **Same-version-different-content trap** (the reason we bump): avoided by the `0.2.0` bump — the
  filename, internal manifest version, and `file:` path all change together.
