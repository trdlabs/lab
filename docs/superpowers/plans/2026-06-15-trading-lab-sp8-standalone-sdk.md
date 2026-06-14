# SP-8 — Standalone `@trading-platform/sdk` via vendored tarball — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make trading-lab install and typecheck with no sibling `../trading-platform` repo and no pnpm override/link, by consuming `@trading-platform/sdk` as a committed standalone tarball.

**Architecture:** trading-lab's source is already clean (public SDK subpaths confined to `src/ports/research-platform.port.ts` + `src/adapters/platform/*`, enforced by `sdk-import-boundary.guard.test.ts`). This plan touches only packaging + docs + one smoke test: pack the standalone `@trading-platform/sdk@0.1.0` from the sibling once, sanity-check it for platform leaks, commit it under `vendor/`, repoint the dependency at it, and drop the `pnpm.overrides`/lockfile coupling.

**Tech Stack:** pnpm 9.12, Node ≥22 (`node --experimental-strip-types`), TypeScript 5.6, Vitest 2, `tar`/`npm pack`.

**Spec:** `docs/superpowers/specs/2026-06-15-trading-lab-sp8-standalone-sdk-design.md`

**Pre-flight facts (verified at design time):**
- Sibling `../trading-platform/packages/sdk` is the standalone 034 build: `@trading-platform/sdk@0.1.0`, `dependencies: { decimal.js }`, `@modelcontextprotocol/sdk` optional peer, `dist/` built and self-vendored, no platform dep. Source commit `647b13bd8ebdd686660c97ef1fd2cfeaedd54aed` (trading-platform `main`).
- Confirmed public exports — root `@trading-platform/sdk`: `CONTRACT_VERSION`, `SUPPORTED_CONTRACT_VERSIONS`, `SUPPORTED_MARKET_DATA_KINDS`, `SDK_VERSION`, `SDK_CAPABILITIES`. `@trading-platform/sdk/agent`: `discover`, `listDatasets`, `validateModule`, `submitRun`, `getRunStatus`, `getRunResult`, `cancelRun`, `readArtifactPage`, `awaitCompletion`, `readArtifactPages`, plus coverage/error helpers and types.

**HARD-STOP BLOCKER (applies to Task 1):** If the packed tarball's `package.json` still declares `trading-bot-platform`, `trading-platform` (source package), a `workspace:*` reference, or platform internals, **stop and fix trading-platform feature 034**. Do NOT re-introduce an override/link, a sibling fallback, or any platform-internal shim in trading-lab.

---

### Task 1: Produce, sanity-check, and vendor the standalone SDK tarball

**Files:**
- Create: `vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz`
- Create: `vendor/trading-platform-sdk/README.md`

- [ ] **Step 1: Create the vendor directory and pack the SDK**

Run (from the trading-lab repo root):

```bash
mkdir -p vendor/trading-platform-sdk
npm pack ../trading-platform/packages/sdk --pack-destination vendor/trading-platform-sdk
ls -la vendor/trading-platform-sdk
```

Expected: `vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz` exists.
(`npm pack <folder>` tars the package's `files` — `dist` + `README.md` + `package.json`; the SDK has no `prepack`/`prepare` script, so nothing rebuilds. If npm emits a different filename, rename it to `trading-platform-sdk-0.1.0.tgz`.)

- [ ] **Step 2: Sanity-check the tarball contents (list)**

Run:

```bash
tar -tzf vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz
```

Expected: entries under `package/dist/**` (incl. `package/dist/index.js`, `package/dist/agent/index.js`, `package/dist/builder/`, `package/dist/contract/`), `package/package.json`, `package/README.md`. No `src/`, no `node_modules/`.

- [ ] **Step 3: Sanity-check the packed `package.json` for platform leaks (HARD-STOP gate)**

Run:

```bash
tar -xOf vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz package/package.json > /tmp/sp8-sdk-pkg.json
node -e '
const p = require("/tmp/sp8-sdk-pkg.json");
const all = { ...p.dependencies, ...p.devDependencies, ...p.peerDependencies, ...p.optionalDependencies };
const bad = Object.entries(all).filter(([n, v]) =>
  /^(trading-bot-platform|trading-platform)$/.test(n) ||
  /workspace:/.test(String(v)) ||
  /trading-platform\/packages/.test(String(v)));
if (bad.length) { console.error("LEAK — STOP, fix feature 034:", bad); process.exit(1); }
console.log("clean. name:", p.name, "version:", p.version, "deps:", JSON.stringify(all));
'
```

Expected: `clean. name: @trading-platform/sdk version: 0.1.0 deps: {"decimal.js":"^10.6.0","@modelcontextprotocol/sdk":"^1.29.0"}` (exit 0). If it exits 1 with `LEAK`, STOP per the blocker — do not continue.

- [ ] **Step 4: Write the vendor README**

Create `vendor/trading-platform-sdk/README.md`:

````markdown
# Vendored `@trading-platform/sdk`

A **vendored standalone build** of `@trading-platform/sdk`, consumed by trading-lab via a
`file:` dependency in the root `package.json`
(`file:./vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz`).

| Field | Value |
|-------|-------|
| Package | `@trading-platform/sdk` |
| Version | `0.1.0` |
| Tarball | `trading-platform-sdk-0.1.0.tgz` |
| Source repo | `trading-platform` |
| Source commit | `647b13bd8ebdd686660c97ef1fd2cfeaedd54aed` |

## Why this exists

The SDK is a private package with no public npm registry. Until a private registry
(e.g. GitHub Packages / Verdaccio) is available, trading-lab consumes the SDK as a committed
tarball — a **temporary delivery channel**. The SDK is a standalone consumer package
(trading-platform feature 034): it has no `trading-platform` / `trading-bot-platform` /
`workspace:*` dependency (`dependencies: decimal.js`; `@modelcontextprotocol/sdk` optional peer).

## Refreshing the tarball

From the trading-lab repo root, with a built `../trading-platform/packages/sdk/dist` present:

```bash
npm pack ../trading-platform/packages/sdk --pack-destination vendor/trading-platform-sdk
```

Then: bump the version in the filename + this README + the source commit SHA, update the `file:`
path in the root `package.json`, run `pnpm install`, and re-run the SP-8 acceptance gates
(see `docs/superpowers/specs/2026-06-15-trading-lab-sp8-standalone-sdk-design.md`).

Sanity-check before committing a new tarball:

```bash
tar -tzf vendor/trading-platform-sdk/trading-platform-sdk-<version>.tgz
tar -xOf vendor/trading-platform-sdk/trading-platform-sdk-<version>.tgz package/package.json
```

The packed `package.json` must NOT declare `trading-platform`, `trading-bot-platform`, or
`workspace:*` dependencies. If it does, fix trading-platform feature 034 — do not work around it
in trading-lab.
````

- [ ] **Step 5: Commit**

```bash
git add vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz vendor/trading-platform-sdk/README.md
git commit -m "build(sp8): vendor standalone @trading-platform/sdk 0.1.0 tarball"
```

---

### Task 2: Repoint the dependency and drop the sibling/override coupling

**Files:**
- Modify: `package.json` (dependency line + remove `pnpm.overrides`)
- Modify: `pnpm-lock.yaml` (regenerated)

- [ ] **Step 1: Repoint the SDK dependency**

In `package.json`, change the `@trading-platform/sdk` dependency:

```diff
-    "@trading-platform/sdk": "file:../trading-platform/packages/sdk",
+    "@trading-platform/sdk": "file:./vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz",
```

- [ ] **Step 2: Remove the `pnpm.overrides` block**

Delete the entire block from `package.json`:

```json
  "pnpm": {
    "overrides": {
      "trading-bot-platform@workspace:*": "link:../trading-platform"
    }
  },
```

(`@modelcontextprotocol/sdk` stays a direct dependency. Do NOT add `decimal.js` — it arrives transitively via the tarball.)

- [ ] **Step 3: Regenerate the lockfile**

Run:

```bash
pnpm install
```

Expected: install completes; `pnpm-lock.yaml` updates. `@trading-platform/sdk` now resolves from `file:vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz` with `decimal.js` + optional `@modelcontextprotocol/sdk`.

- [ ] **Step 4: Assert lockfile cleanliness (acceptance gate 7)**

Run:

```bash
grep -nE "link:\.\./trading-platform|file:\.\./trading-platform|trading-bot-platform@workspace:\*|workspace:\*" pnpm-lock.yaml
```

Expected: **no output** (exit 1). Any match is a failure — investigate before continuing.

Also confirm the new resolution is present:

```bash
grep -nE "trading-platform-sdk-0.1.0.tgz|@trading-platform/sdk" pnpm-lock.yaml | head
```

Expected: the SDK importer entry references the in-repo `vendor/.../trading-platform-sdk-0.1.0.tgz` tarball; no `directory: ../trading-platform/...`.

- [ ] **Step 5: Confirm the platform source package is gone from the dep graph (acceptance gate 5)**

Run:

```bash
pnpm why trading-bot-platform; echo "exit: $?"
pnpm why trading-platform; echo "exit: $?"
```

Expected: both report no dependents / "No packages found" and a non-zero exit. Neither platform source package appears.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build(sp8): consume vendored SDK tarball; drop sibling file: dep + pnpm overrides"
```

---

### Task 3: Add the standalone SDK smoke test

**Files:**
- Create: `src/adapters/platform/sdk-smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

Create `src/adapters/platform/sdk-smoke.test.ts` (inside `src/adapters/platform/` so `sdk-import-boundary.guard.test.ts` still passes). It imports ONLY confirmed public exports:

```typescript
import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION, SDK_VERSION, SDK_CAPABILITIES } from '@trading-platform/sdk';
import { discover, listDatasets } from '@trading-platform/sdk/agent';

// SP-8 smoke test: proves the standalone @trading-platform/sdk resolves by name (from the
// vendored tarball, no sibling repo) and exposes its documented public surface — no gateway needed.
// Imports ONLY confirmed public exports; if the standalone SDK renames any, adjust to the real API.
describe('@trading-platform/sdk standalone package', () => {
  it('exposes the root contract + version surface', () => {
    expect(typeof CONTRACT_VERSION).toBe('string');
    expect(CONTRACT_VERSION.length).toBeGreaterThan(0);
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('declares all capabilities absent by construction', () => {
    expect(SDK_CAPABILITIES).toMatchObject({
      live: false,
      execution: false,
      credentials: false,
      ingestion: false,
      rawStorage: false,
    });
  });

  it('exposes the agent workflow functions', () => {
    expect(typeof discover).toBe('function');
    expect(typeof listDatasets).toBe('function');
  });
});
```

- [ ] **Step 2: Run the smoke test**

Run:

```bash
pnpm test -- src/adapters/platform/sdk-smoke.test.ts
```

Expected: PASS (3 tests). This proves the vendored package resolves by name at runtime. (There is no "fail-first" step here — the test asserts that the already-published public surface resolves; passing is the acceptance signal. If it fails to resolve, the tarball or rewire is wrong — fix that before continuing.)

- [ ] **Step 3: Confirm the import-boundary guard still passes**

Run:

```bash
pnpm test -- src/adapters/platform/sdk-import-boundary.guard.test.ts
```

Expected: PASS (the new file lives in the allowed adapter dir).

- [ ] **Step 4: Commit**

```bash
git add src/adapters/platform/sdk-smoke.test.ts
git commit -m "test(sp8): add standalone @trading-platform/sdk smoke test"
```

---

### Task 4: Update docs (README + .env.example)

**Files:**
- Modify: `README.md` (dependency note + gateway example)
- Modify: `.env.example` (one-line clarifying comment)

- [ ] **Step 1: Replace the dependency-note section in `README.md`**

Replace this block:

```markdown
### Dependency note (temporary local-integration workaround)

`@trading-platform/sdk` is consumed via a `file:` dependency plus a `pnpm.overrides` entry
(`"trading-bot-platform@workspace:*": "link:../trading-platform"`) in `package.json`, because the
SDK currently declares a `workspace:*` dependency on the platform that trading-lab is not part of.
This is a **temporary local-integration workaround**: it requires the sibling `trading-platform`
checked out next to this repo with its build output present (`packages/sdk/dist` and the root
`dist`, both gitignored), and it pulls the platform's runtime tree into `node_modules`. A follow-up
on the `trading-platform` side should make the SDK independently published/workspace-consumable so
this override can be removed.
```

with:

```markdown
### Dependency note (vendored standalone SDK)

`@trading-platform/sdk` is consumed as a **vendored standalone tarball**, committed at
`vendor/trading-platform-sdk/`. The root `package.json` depends on it via
`file:./vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz`. No sibling
`../trading-platform` checkout, pnpm override, or workspace link is needed to install, typecheck,
or test trading-lab — the SDK is a self-contained consumer package (`dependencies: decimal.js`;
`@modelcontextprotocol/sdk` optional peer). See `vendor/trading-platform-sdk/README.md` for the
SDK version, source commit, and the command to refresh the tarball. This vendored channel is
temporary until the SDK is published to a private registry.
```

- [ ] **Step 2: Soften the `platform:discover` gateway example in `README.md`**

Replace this block:

```markdown
```bash
TRADING_PLATFORM_GATEWAY_COMMAND=node \
TRADING_PLATFORM_GATEWAY_ARGS="--experimental-strip-types ../trading-platform/src/research/mcp-gateway/bin/start-gateway.ts" \
pnpm platform:discover
```
```

with:

```markdown
The research gateway is a **separate trading-platform service**, reached only through runtime env
(`TRADING_PLATFORM_GATEWAY_COMMAND` / `TRADING_PLATFORM_GATEWAY_ARGS`) — it is not an install or
build dependency of trading-lab. For a local dev run you can point it at a checked-out platform
gateway, e.g.:

```bash
TRADING_PLATFORM_GATEWAY_COMMAND=node \
TRADING_PLATFORM_GATEWAY_ARGS="--experimental-strip-types /path/to/trading-platform/src/research/mcp-gateway/bin/start-gateway.ts" \
pnpm platform:discover
```
```

- [ ] **Step 3: Add a clarifying comment to `.env.example`**

In `.env.example`, change the SP-7 header block from:

```bash
# --- SP-7: trading-platform research gateway (read-only capability discovery) ---
# Default is mock; runtime boot never contacts trading-platform.
TRADING_PLATFORM_INTEGRATION=mock
```

to:

```bash
# --- SP-7: trading-platform research gateway (read-only capability discovery) ---
# Default is mock; runtime boot never contacts trading-platform.
# The @trading-platform/sdk client is a vendored standalone package (vendor/trading-platform-sdk/) —
# no sibling ../trading-platform checkout is required. The gateway below is a separate service.
TRADING_PLATFORM_INTEGRATION=mock
```

- [ ] **Step 4: Commit**

```bash
git add README.md .env.example
git commit -m "docs(sp8): document vendored standalone SDK; gateway is runtime-only"
```

---

### Task 5: Full acceptance verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck (acceptance gate 3)**

Run:

```bash
pnpm typecheck
```

Expected: exit 0, no errors. (If it fails on SDK types, the sibling `dist` may be stale: rebuild it — `npm --prefix ../trading-platform/packages/sdk run build` — re-pack per Task 1, then `pnpm install` and retry.)

- [ ] **Step 2: Full test suite (acceptance gate 4)**

Run:

```bash
pnpm test
```

Expected: PASS, including `sdk-smoke.test.ts` and `sdk-import-boundary.guard.test.ts`; any skips are the same pre-existing gates (e.g. `discovery.integration.test.ts` skipped unless `RUN_PLATFORM_INTEGRATION=true`).

- [ ] **Step 3: No platform-internal imports in source (acceptance gate 6)**

Run:

```bash
git grep -nE "from ['\"](trading-bot-platform|trading-platform)(/|['\"])" -- src scripts
```

Expected: **no output**. (`@trading-platform/sdk` starts with `@`, so it does not match — only bare platform specifiers would.)

- [ ] **Step 4: Gold-standard no-sibling clean-install proof (acceptance gate 2)**

Export the committed tree to a temp dir *outside* the workspace (no `../trading-platform` reachable) and install + typecheck there:

```bash
WORK=$(mktemp -d)
git archive sp8-standalone-sdk | tar -x -C "$WORK"
( cd "$WORK" && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test -- src/adapters/platform/sdk-smoke.test.ts )
echo "clean-room exit: $?"
rm -rf "$WORK"
```

Expected: `pnpm install --frozen-lockfile` resolves the in-repo vendored tarball (the temp dir has no sibling repo), `pnpm typecheck` passes, the smoke test passes, `clean-room exit: 0`. This proves trading-lab no longer depends on `../trading-platform`.

- [ ] **Step 5: Final confirmation summary**

Confirm all acceptance gates from the spec are green:
1. `pnpm install` clean — Task 2.3 ✓
2. No-sibling temp-dir proof — Step 4 ✓
3. `pnpm typecheck` — Step 1 ✓
4. `pnpm test` (same skip gates) + smoke test — Step 2 ✓
5. `pnpm why trading-bot-platform` / `trading-platform` not found — Task 2.5 ✓
6. `git grep` no platform internals — Step 3 ✓
7. lockfile has no `link:../trading-platform` / `file:../trading-platform` / `trading-bot-platform@workspace:*` / `workspace:*` — Task 2.4 ✓
8. `sdk-import-boundary.guard.test.ts` passes — Task 3.3 ✓

No new commit (verification only). The branch `sp8-standalone-sdk` is ready for PR.

---

## Self-Review

- **Spec coverage:** D1–D9, the hard-stop blocker, the tarball sanity check (full-SHA vendor README, `tar -tzf` + `tar -xOf package/package.json`), all 8 acceptance gates, and the out-of-scope boundary are each mapped to a task/step.
- **Placeholders:** none — every step has exact paths, commands, expected output, and full file content.
- **Type consistency:** smoke test imports only exports verified against `dist/index.d.ts` / `dist/agent/index.d.ts` (`CONTRACT_VERSION`, `SDK_VERSION`, `SDK_CAPABILITIES`, `discover`, `listDatasets`); `SDK_VERSION` asserted by semver shape (refresh-safe), `SDK_CAPABILITIES` by its five `false` flags.
- **Leak-grep safety:** the packed-`package.json` check parses dependency fields with node (not a bare `grep`), so the SDK `description` string containing "trading-platform" cannot false-positive.
