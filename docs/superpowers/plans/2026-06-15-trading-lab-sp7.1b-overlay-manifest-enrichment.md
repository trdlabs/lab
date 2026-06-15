# SP-7.1b — Validation-ready 017 Overlay Manifest Enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `toSubmittedBundle` emit a real 017 overlay manifest as `manifest.json` (built from a deterministically-derived, lab-native `OverlayManifestMeta` via the vendored SDK's `createOverlayManifest`) so `validate_module` stops failing on missing rich 017 fields — while the lab `ModuleManifest`, `bundleHash`, and SP-4 backtest path stay unchanged.

**Architecture:** Lazy wire projection. The lab keeps two cleanly-separated manifests: the lab-native `ModuleManifest` (source of truth for the code module) and the 017 overlay manifest (semantic envelope), materialized **only** at the `SubmittedBundle` boundary. A pure lab mapper `deriveOverlayManifestMeta(hypothesis, profile, labManifest)` supplies the rich fields; the handler attaches the result to the bundle; `toSubmittedBundle` projects it with `createOverlayManifest`. The platform/SDK import stays confined to `submitted-bundle.ts`.

**Tech Stack:** TypeScript (ESM, `node --experimental-strip-types`), Vitest, vendored `@trading-platform/sdk` (tarball; `./builder` + `./agent` subpaths). Test runner: `pnpm vitest run`. Typecheck: `pnpm typecheck`. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-06-15-trading-lab-sp7.1b-overlay-manifest-enrichment-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/domain/overlay-manifest-meta.ts` | Lab-native `OverlayManifestMeta` type + pure `deriveOverlayManifestMeta` mapper + the two deterministic constants. **No `@trading-platform` import.** | Create |
| `src/domain/overlay-manifest-meta.test.ts` | Mapper unit tests incl. determinism + no-platform-import guard. | Create |
| `src/domain/module-bundle.ts` | Add optional `overlayMeta?` to `ModuleBundle`; optional 3rd param on `assembleBundle`. Hash unchanged. | Modify |
| `src/domain/module-bundle.test.ts` | `overlayMeta` attach + bundleHash-invariance tests. | Create |
| `src/adapters/platform/submitted-bundle.ts` | Project the 017 manifest via `createOverlayManifest`; `MissingOverlayMetaError`; fail-closed. | Modify |
| `src/adapters/platform/submitted-bundle.test.ts` | Rewrite SP-7.1 assertions to the 017 `manifest.json`; add fail-closed + deep-equal tests; pass `meta` in path-safety tests. | Modify |
| `src/adapters/platform/mcp-research-platform.adapter.test.ts` | Add an `OverlayManifestMeta` fixture; build the shared `bundle` via `assembleBundle(manifest, files, meta)` so `validateModule(bundle)` no longer fails closed. Existing assertions preserved. | Modify |
| `src/adapters/platform/submitted-bundle.preflight.test.ts` | Acceptance smoke: materialize → `preflightValidate({ bundleDir })`. | Create |
| `src/orchestrator/handlers/hypothesis-build.handler.ts` | One pure-lab line: derive + attach `overlayMeta`. SP-4 logic untouched. | Modify |
| `src/orchestrator/handlers/hypothesis-build.handler.test.ts` | Add one test: built bundle artifact carries the derived `overlayMeta`. | Modify |

**Import-collision warning:** `@trading-platform/sdk/builder` also exports its own `assembleBundle` and `ModuleBundle`. Always import `assembleBundle` / `ModuleBundle` from `../../domain/module-bundle.ts` (lab) and import **only** `createOverlayManifest`, `OverlayManifestInput`, `preflightValidate`, `ValidateAuthoringInput` from the SDK builder surface.

---

## Task 1: Lab-native `OverlayManifestMeta` + `deriveOverlayManifestMeta`

**Files:**
- Create: `src/domain/overlay-manifest-meta.ts`
- Test: `src/domain/overlay-manifest-meta.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/domain/overlay-manifest-meta.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deriveOverlayManifestMeta,
  OVERLAY_MANIFEST_VERSION,
  OVERLAY_INTERCEPTION_POINT,
  type OverlayManifestMeta,
} from './overlay-manifest-meta.ts';
import type { HypothesisProposal } from './hypothesis.ts';
import type { StrategyProfile } from './strategy-profile.ts';
import type { ModuleManifest } from './module-bundle.ts';

const labManifest: ModuleManifest = {
  moduleId: 'overlay-h1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: 'builder-sdk-v0',
};
// Only the fields the mapper reads are populated; cast keeps the unit test focused.
const hypothesis = { id: 'h1', thesis: 'Skip entries when oi trend persists', targetBehavior: 'filter entries' } as unknown as HypothesisProposal;
const profile = { id: 'p1', coreIdea: 'oi-based entry filter' } as unknown as StrategyProfile;

describe('deriveOverlayManifestMeta', () => {
  it('maps hypothesis + profile + lab manifest into the rich 017 overlay fields', () => {
    const meta = deriveOverlayManifestMeta(hypothesis, profile, labManifest);
    expect(meta).toEqual({
      id: 'overlay-h1',
      version: OVERLAY_MANIFEST_VERSION,
      name: 'filter entries',
      summary: 'Skip entries when oi trend persists',
      rationale: 'oi-based entry filter',
      author: 'agent',
      targetStrategyRef: 'strategy:p1',
      interceptionPoint: OVERLAY_INTERCEPTION_POINT,
      paramsSchema: { type: 'object', additionalProperties: false },
    } satisfies OverlayManifestMeta);
  });

  it('uses the agreed deterministic constants', () => {
    expect(OVERLAY_MANIFEST_VERSION).toBe('0.1.0');
    expect(OVERLAY_INTERCEPTION_POINT).toBe('post_entry_management');
  });

  it('is deterministic: identical inputs produce a deep-equal result', () => {
    expect(deriveOverlayManifestMeta(hypothesis, profile, labManifest))
      .toEqual(deriveOverlayManifestMeta(hypothesis, profile, labManifest));
  });

  it('does not import the platform SDK (lab-native, no contract mixing)', () => {
    const src = readFileSync(fileURLToPath(new URL('./overlay-manifest-meta.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('@trading-platform');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/domain/overlay-manifest-meta.test.ts`
Expected: FAIL — `Failed to resolve import "./overlay-manifest-meta.ts"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/domain/overlay-manifest-meta.ts
// Lab-native carrier for the rich 017 overlay-manifest fields. Deliberately NO @trading-platform
// import: the lab builder SDK contract and the platform 017 manifest contract stay separate. The
// platform projection (createOverlayManifest) happens only at the toSubmittedBundle wire boundary.
import type { HypothesisProposal } from './hypothesis.ts';
import type { StrategyProfile } from './strategy-profile.ts';
import type { ModuleManifest } from './module-bundle.ts';

/** Deterministic module version for SP-7.1b overlay manifests (platform requires only a non-empty string). */
export const OVERLAY_MANIFEST_VERSION = '0.1.0';
/** Canonical overlay interception point — matches the SDK overlay templates + 017 valid fixtures. */
export const OVERLAY_INTERCEPTION_POINT = 'post_entry_management';

/** Lab-native projection of the platform 017 OverlayManifestInput rich fields. */
export interface OverlayManifestMeta {
  id: string;
  version: string;
  name: string;
  summary: string;
  rationale: string;
  author: 'human' | 'agent';
  targetStrategyRef: string;
  interceptionPoint: string;
  paramsSchema: Record<string, unknown>;
}

/**
 * Deterministically derive the rich 017 overlay fields from research context. Pure: same inputs →
 * byte-identical output. Reads only labManifest.moduleId, hypothesis.targetBehavior/thesis,
 * profile.coreIdea/id; everything else is a deterministic constant / safe default.
 */
export function deriveOverlayManifestMeta(
  hypothesis: HypothesisProposal,
  profile: StrategyProfile,
  labManifest: ModuleManifest,
): OverlayManifestMeta {
  return {
    id: labManifest.moduleId,
    version: OVERLAY_MANIFEST_VERSION,
    name: hypothesis.targetBehavior,
    summary: hypothesis.thesis,
    rationale: profile.coreIdea,
    author: 'agent',
    targetStrategyRef: `strategy:${profile.id}`,
    interceptionPoint: OVERLAY_INTERCEPTION_POINT,
    paramsSchema: { type: 'object', additionalProperties: false },
  };
}
```

> Note: `overlay-manifest-meta.ts` and `module-bundle.ts` reference each other's **types only** (`import type`). Type-only cycles are erased at runtime by strip-types/esbuild and accepted by `tsc` — no runtime cycle.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/domain/overlay-manifest-meta.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/overlay-manifest-meta.ts src/domain/overlay-manifest-meta.test.ts
git commit -m "feat(sp7.1b): lab-native OverlayManifestMeta + deterministic deriveOverlayManifestMeta mapper"
```

---

## Task 2: `ModuleBundle.overlayMeta?` + `assembleBundle` optional param (hash unchanged)

**Files:**
- Modify: `src/domain/module-bundle.ts`
- Test: `src/domain/module-bundle.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/domain/module-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { assembleBundle, type ModuleManifest } from './module-bundle.ts';
import type { OverlayManifestMeta } from './overlay-manifest-meta.ts';

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: 'builder-sdk-v0',
};
const files = { 'index.ts': 'export const overlay = {};' };
const meta: OverlayManifestMeta = {
  id: 'm1', version: '0.1.0', name: 'n', summary: 's', rationale: 'r', author: 'agent',
  targetStrategyRef: 'strategy:p1', interceptionPoint: 'post_entry_management',
  paramsSchema: { type: 'object', additionalProperties: false },
};

describe('assembleBundle overlayMeta', () => {
  it('attaches overlayMeta when provided', () => {
    expect(assembleBundle(manifest, files, meta).overlayMeta).toEqual(meta);
  });

  it('omits overlayMeta when not provided', () => {
    expect(assembleBundle(manifest, files).overlayMeta).toBeUndefined();
  });

  it('does not change bundleHash when overlayMeta is attached (hash covers manifest+files only)', () => {
    expect(assembleBundle(manifest, files, meta).bundleHash).toBe(assembleBundle(manifest, files).bundleHash);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/domain/module-bundle.test.ts`
Expected: FAIL — TypeScript error `Expected 2 arguments, but got 3` (and `overlayMeta` not on `ModuleBundle`).

- [ ] **Step 3: Write minimal implementation**

In `src/domain/module-bundle.ts`, add the import near the top (after the existing imports):

```typescript
import type { OverlayManifestMeta } from './overlay-manifest-meta.ts';
```

Add the optional field to the `ModuleBundle` interface:

```typescript
export interface ModuleBundle {
  manifest: ModuleManifest;
  files: Record<string, string>;
  bundleHash: string;
  bundleContractVersion: string;
  overlayMeta?: OverlayManifestMeta;
}
```

Replace `assembleBundle` with:

```typescript
/** Lab computes the hash over {manifest, files} only; overlayMeta is additive and excluded from the hash. */
export function assembleBundle(
  manifest: ModuleManifest,
  files: Record<string, string>,
  overlayMeta?: OverlayManifestMeta,
): ModuleBundle {
  const canonical = stableStringify({ manifest, files });
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    manifest,
    files,
    bundleHash: `sha256:${hex}`,
    bundleContractVersion: MODULE_BUNDLE_CONTRACT_VERSION,
    ...(overlayMeta !== undefined ? { overlayMeta } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/domain/module-bundle.test.ts && pnpm typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/module-bundle.ts src/domain/module-bundle.test.ts
git commit -m "feat(sp7.1b): carry optional overlayMeta on ModuleBundle (bundleHash unchanged)"
```

---

## Task 3: `toSubmittedBundle` → 017 projection + `MissingOverlayMetaError`

**Files:**
- Modify: `src/adapters/platform/submitted-bundle.ts`
- Test: `src/adapters/platform/submitted-bundle.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test (failing)**

Replace the entire contents of `src/adapters/platform/submitted-bundle.test.ts` with:

```typescript
// src/adapters/platform/submitted-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createOverlayManifest, type OverlayManifestInput } from '@trading-platform/sdk/builder';
import { toSubmittedBundle, MissingOverlayMetaError } from './submitted-bundle.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';
import type { OverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';

function sha256Hex(s: string): string { return createHash('sha256').update(s).digest('hex'); }
function serializeCanon(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanon).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${serializeCanon(o[k])}`).join(',')}}`;
}
// MUST match the platform: sorted-key + trailing "\n" (the newline is load-bearing for bundleHash parity).
function canon(value: unknown): string { return `${serializeCanon(value)}\n`; }

const manifest: ModuleManifest = {
  moduleId: 'overlay-m1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const files = { 'index.ts': 'export const overlay = { rules: [] };', 'helpers/util.ts': 'export const u = 1;' };
const meta: OverlayManifestMeta = {
  id: 'overlay-m1', version: '0.1.0', name: 'filter entries', summary: 'skip on oi trend',
  rationale: 'oi-based entry filter', author: 'agent', targetStrategyRef: 'strategy:p1',
  interceptionPoint: 'post_entry_management', paramsSchema: { type: 'object', additionalProperties: false },
};
// Same 1:1 mapping toSubmittedBundle uses internally → the projected manifest must equal this.
const expectedInput: OverlayManifestInput = {
  id: meta.id, version: meta.version, name: meta.name, summary: meta.summary, rationale: meta.rationale,
  author: meta.author, paramsSchema: meta.paramsSchema, targetStrategyRef: meta.targetStrategyRef,
  interceptionPoint: meta.interceptionPoint,
};
const expectedManifest = createOverlayManifest(expectedInput);
const expectedManifestJson = JSON.stringify(expectedManifest);

describe('toSubmittedBundle', () => {
  const sub = toSubmittedBundle(assembleBundle(manifest, files, meta));

  it('emits manifest.json as the 017 overlay manifest from createOverlayManifest (not the lab manifest)', () => {
    const man = sub.files.find((f) => f.path === 'manifest.json')!;
    const decoded = JSON.parse(Buffer.from(man.contentBase64, 'base64').toString('utf8'));
    expect(decoded).toEqual(expectedManifest);
    expect(decoded.kind).toBe('overlay');
    expect(decoded.hooks).toEqual(['apply']);
    expect(decoded.status).toBe('research_only');
    expect(decoded.targetStrategyRef).toBe('strategy:p1');
    expect(decoded.interceptionPoint).toBe('post_entry_management');
    expect(decoded.moduleId).toBeUndefined(); // lab-native field must NOT leak into the 017 manifest
  });

  it('sets submitted.manifest to the same 017 overlay manifest', () => {
    expect(sub.manifest).toEqual(expectedManifest);
  });

  it('re-roots code files under module/ and adds manifest.json at root, all base64', () => {
    const paths = sub.files.map((f) => f.path).sort();
    expect(paths).toEqual(['manifest.json', 'module/helpers/util.ts', 'module/index.ts']);
    const idx = sub.files.find((f) => f.path === 'module/index.ts')!;
    expect(Buffer.from(idx.contentBase64, 'base64').toString('utf8')).toBe(files['index.ts']);
  });

  it('descriptor.files lists manifest.json + module/** entries, sorted, with per-file sha256', () => {
    const d = sub.descriptor as { files: { path: string; sha256: string }[]; entryPoint: string; kind: string; contractVersion: string; bundleHash: string };
    expect(d.files.map((f) => f.path)).toEqual(['manifest.json', 'module/helpers/util.ts', 'module/index.ts']);
    expect(d.files.find((f) => f.path === 'module/index.ts')!.sha256).toBe(sha256Hex(files['index.ts']));
    expect(d.files.find((f) => f.path === 'manifest.json')!.sha256).toBe(sha256Hex(expectedManifestJson));
    expect(d.kind).toBe('overlay');
    expect(d.entryPoint).toBe('module/index.ts');
    expect(typeof d.contractVersion).toBe('string');
  });

  it('bundleHash replicates the platform formula over the 017 manifest.json (self-consistent)', () => {
    const d = sub.descriptor as { files: { path: string; sha256: string }[]; bundleHash: string };
    const manifestSha256 = sha256Hex(expectedManifestJson);
    const expected = `sha256:${sha256Hex(canon({ manifestSha256, files: d.files }))}`;
    expect(d.bundleHash).toBe(expected);
  });

  it('every file path is a safe relative path (no traversal, no leading slash)', () => {
    for (const f of sub.files) {
      expect(f.path.startsWith('/')).toBe(false);
      expect(f.path.includes('..')).toBe(false);
    }
  });
});

describe('toSubmittedBundle fail-closed without overlayMeta', () => {
  it('throws MissingOverlayMetaError with code overlay_meta_missing', () => {
    const bundle = assembleBundle(manifest, files); // no overlayMeta → pre-SP-7.1b bundle
    expect(() => toSubmittedBundle(bundle)).toThrow(MissingOverlayMetaError);
    try {
      toSubmittedBundle(bundle);
      throw new Error('expected MissingOverlayMetaError');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingOverlayMetaError);
      expect((e as MissingOverlayMetaError).code).toBe('overlay_meta_missing');
    }
  });
});

describe('toSubmittedBundle path safety', () => {
  const code = 'export const overlay = {};';
  function withFileKey(key: string) {
    return assembleBundle(manifest, { [key]: code }, meta);
  }

  it.each([
    ['empty', ''],
    ['traversal', '../x.ts'],
    ['absolute', '/x.ts'],
    ['drive-letter', 'C:/x.ts'],
    ['backslash', 'dir\\x.ts'],
    ['NUL', 'dir/\0x.ts'],
  ])('rejects an unsafe file path: %s', (_label, key) => {
    expect(() => toSubmittedBundle(withFileKey(key))).toThrow();
  });

  it('rejects an unsafe manifest.entry', () => {
    const b = assembleBundle({ ...manifest, entry: '../index.ts' }, { 'index.ts': code }, meta);
    expect(() => toSubmittedBundle(b)).toThrow();
  });

  it('still accepts a safe nested path', () => {
    expect(() => toSubmittedBundle(assembleBundle(manifest, { 'index.ts': code, 'helpers/util.ts': 'export const u = 1;' }, meta))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/submitted-bundle.test.ts`
Expected: FAIL — `MissingOverlayMetaError` is not exported; `manifest.json` still decodes to the lab manifest (`decoded.kind`/`hooks`/`moduleId` assertions fail).

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `src/adapters/platform/submitted-bundle.ts` with:

```typescript
// src/adapters/platform/submitted-bundle.ts
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import { createOverlayManifest } from '@trading-platform/sdk/builder';
import type { OverlayManifestInput } from '@trading-platform/sdk/builder';
import type { SubmittedBundle } from '@trading-platform/sdk/agent';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import type { OverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';

const MODULE_DIR = 'module';

/** Thrown when a bundle reaches the platform wire boundary without SP-7.1b overlayMeta (not validation-ready). */
export class MissingOverlayMetaError extends Error {
  readonly code = 'overlay_meta_missing';
  constructor() {
    super('toSubmittedBundle: bundle is missing overlayMeta (pre-SP-7.1b bundle is not validation-ready) [overlay_meta_missing]');
    this.name = 'MissingOverlayMetaError';
  }
}

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Recursive sorted-key serializer (strings via JSON.stringify) — matches the platform's `serialize`. */
function serializeCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${serializeCanonical(obj[k])}`).join(',')}}`;
}

/**
 * Canonical JSON — MUST byte-match trading-platform `src/research/backtest/canonical-json.ts`:
 * sorted-key + a TRAILING "\n". The newline is load-bearing for bundleHash parity; omitting it
 * makes the gateway recompute a different hash → bundle_integrity_violation.
 */
function canonicalJson(value: unknown): string {
  return `${serializeCanonical(value)}\n`;
}

/**
 * Reject unsafe relative bundle paths locally so SP-7.1 guarantees structural correctness
 * before the gateway materializes the bundle (mirrors the platform's isSafeBundlePath guard).
 */
function assertSafeBundlePath(path: string, kind: string): void {
  if (path.length === 0) throw new Error(`toSubmittedBundle: empty ${kind} path`);
  if (path.includes('\0')) throw new Error(`toSubmittedBundle: NUL in ${kind} path: ${JSON.stringify(path)}`);
  if (path.includes('\\')) throw new Error(`toSubmittedBundle: backslash in ${kind} path: ${path}`);
  if (path.startsWith('/')) throw new Error(`toSubmittedBundle: absolute ${kind} path: ${path}`);
  if (/^[A-Za-z]:/.test(path)) throw new Error(`toSubmittedBundle: drive-letter ${kind} path: ${path}`);
  if (path.split('/').some((seg) => seg === '..')) throw new Error(`toSubmittedBundle: path traversal in ${kind} path: ${path}`);
}

/** Map the lab-native OverlayManifestMeta onto the SDK's OverlayManifestInput (1:1; SDK fills the rest). */
function mapMetaToOverlayInput(meta: OverlayManifestMeta): OverlayManifestInput {
  return {
    id: meta.id,
    version: meta.version,
    name: meta.name,
    summary: meta.summary,
    rationale: meta.rationale,
    author: meta.author,
    paramsSchema: meta.paramsSchema,
    targetStrategyRef: meta.targetStrategyRef,
    interceptionPoint: meta.interceptionPoint,
  };
}

/**
 * Map a lab ModuleBundle to the platform's submitted-bundle wire shape (SP-7.1b §3).
 *  - `manifest.json` = a real 017 overlay manifest built from `bundle.overlayMeta` via the SDK's
 *    `createOverlayManifest` (NOT the lab-native manifest) — this is what the gateway validates.
 *  - lab `files` keys are re-rooted under `module/`; `descriptor.entryPoint` still comes from the
 *    lab manifest's `entry`.
 *  - `descriptor.files` = `manifest.json` + all `module/**` payload entries (sorted, per-file sha256).
 *  - `bundleHash` replicates `trading-platform/.../bundle-hash.ts::computeBundleHash`.
 */
export function toSubmittedBundle(bundle: ModuleBundle): SubmittedBundle {
  if (bundle.overlayMeta === undefined) throw new MissingOverlayMetaError();
  for (const key of Object.keys(bundle.files)) assertSafeBundlePath(key, 'file');
  assertSafeBundlePath(bundle.manifest.entry, 'entry');

  const manifest017 = createOverlayManifest(mapMetaToOverlayInput(bundle.overlayMeta));
  const manifestJson = JSON.stringify(manifest017);
  const manifestSha256 = sha256Hex(manifestJson);

  // One sorted payload list (manifest.json + module/**) drives both descriptor.files and files[].
  const payload = [
    { path: 'manifest.json', source: manifestJson },
    ...Object.entries(bundle.files).map(([rel, source]) => ({ path: `${MODULE_DIR}/${rel}`, source })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const descriptorFiles = payload.map((f) => ({ path: f.path, sha256: sha256Hex(f.source) }));
  const bundleHash = `sha256:${sha256Hex(canonicalJson({ manifestSha256, files: descriptorFiles }))}`;

  const descriptor = {
    contractVersion: CONTRACT_VERSION,
    kind: 'overlay' as const, // lab moduleKind 'hypothesis_overlay' → platform 'overlay'
    entryPoint: `${MODULE_DIR}/${bundle.manifest.entry}`,
    files: descriptorFiles,
    bundleHash,
  };

  const files = payload.map((f) => ({ path: f.path, contentBase64: Buffer.from(f.source, 'utf8').toString('base64') }));

  return { manifest: manifest017, files, descriptor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/submitted-bundle.test.ts && pnpm typecheck`
Expected: PASS (all groups); typecheck clean.

- [ ] **Step 5: Fix the MCP adapter test fixtures (now fail-closed without overlayMeta)**

`McpResearchPlatformAdapter.validateModule(bundle)` calls `toSubmittedBundle(bundle)` internally, which now throws `MissingOverlayMetaError` unless the bundle carries `overlayMeta`. The shared `bundle` fixture in `src/adapters/platform/mcp-research-platform.adapter.test.ts` must be rebuilt with a `meta`.

In `src/adapters/platform/mcp-research-platform.adapter.test.ts`, add this import below the existing import block:

```typescript
import type { OverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';
```

Find the shared bundle fixture (the second `manifest` block, just above `transportReturning`):

```typescript
const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const bundle = assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' });
```

Replace it with:

```typescript
const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const meta: OverlayManifestMeta = {
  id: 'm1', version: '0.1.0', name: 'n', summary: 's', rationale: 'r', author: 'agent',
  targetStrategyRef: 'strategy:p1', interceptionPoint: 'post_entry_management',
  paramsSchema: { type: 'object', additionalProperties: false },
};
const bundle = assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' }, meta);
```

Leave the three existing assertions in `describe('McpResearchPlatformAdapter.validateModule', ...)` unchanged — they still hold (the fake transport returns its canned result regardless of payload):
- "sends a submitted bundle to validate_module and returns the report on ok" (asserts `calls[0].tool === 'validate_module'` and `module.kind === 'submitted'`)
- "throws GatewayValidationError on an ok:false envelope"
- "Lazy variant opens and closes a session around the call"

Run: `pnpm vitest run src/adapters/platform/mcp-research-platform.adapter.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/platform/submitted-bundle.ts src/adapters/platform/submitted-bundle.test.ts src/adapters/platform/mcp-research-platform.adapter.test.ts
git commit -m "feat(sp7.1b): project 017 overlay manifest.json via createOverlayManifest; fail-closed on missing overlayMeta"
```

---

## Task 4: Handler wiring (pure-lab; SP-4 path untouched)

**Files:**
- Modify: `src/orchestrator/handlers/hypothesis-build.handler.ts`
- Test: `src/orchestrator/handlers/hypothesis-build.handler.test.ts`

- [ ] **Step 1: Add the failing test**

In `src/orchestrator/handlers/hypothesis-build.handler.test.ts`, add these imports below the existing import block:

```typescript
import { deriveOverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
```

Add this test inside the `describe('hypothesisBuildHandler', ...)` block (e.g. right after the happy-path test):

```typescript
  it('attaches overlayMeta (derived from hypothesis+profile) to the built bundle artifact', async () => {
    const s = await seeded();
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);
    const builds = await s.builds.listByHypothesis('h1');
    const ref = builds[0]!.bundleArtifactRef!;
    const stored = JSON.parse((await s.artifacts.get(ref)).toString('utf8')) as ModuleBundle;
    expect(stored.overlayMeta).toEqual(deriveOverlayManifestMeta(hypothesis(), profile(), stored.manifest));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/orchestrator/handlers/hypothesis-build.handler.test.ts -t "attaches overlayMeta"`
Expected: FAIL — `stored.overlayMeta` is `undefined` (handler does not attach it yet).

- [ ] **Step 3: Write the implementation**

In `src/orchestrator/handlers/hypothesis-build.handler.ts`, add this import alongside the other domain imports near the top:

```typescript
import { deriveOverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';
```

Find the existing bundle-assembly line (just after the `builder.completed` event append):

```typescript
  const bundle = assembleBundle(out.manifest, out.files);
```

Replace it with:

```typescript
  const overlayMeta = deriveOverlayManifestMeta(hypothesis, profile, out.manifest);
  const bundle = assembleBundle(out.manifest, out.files, overlayMeta);
```

> `hypothesis` and `profile` are already in scope (loaded earlier in the handler). `deriveOverlayManifestMeta` is a pure lab function — **no `@trading-platform` import, no platform dependency**. The submit/backtest/evaluate logic below is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/orchestrator/handlers/hypothesis-build.handler.test.ts && pnpm typecheck`
Expected: PASS (all existing SP-4 tests stay green + the new overlayMeta test); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/hypothesis-build.handler.ts src/orchestrator/handlers/hypothesis-build.handler.test.ts
git commit -m "feat(sp7.1b): handler derives + attaches overlayMeta (pure-lab; SP-4 path untouched)"
```

---

## Task 5: Acceptance smoke — SDK `preflightValidate` over the materialized bundle

**Files:**
- Test: `src/adapters/platform/submitted-bundle.preflight.test.ts`

This is a characterization/acceptance test — `toSubmittedBundle` already exists (Task 3), so expect PASS. If it fails, the projection is wrong; fix `submitted-bundle.ts`.

- [ ] **Step 1: Write the acceptance test**

```typescript
// src/adapters/platform/submitted-bundle.preflight.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { preflightValidate } from '@trading-platform/sdk/builder';
import type { SubmittedBundle } from '@trading-platform/sdk/agent';
import { toSubmittedBundle } from './submitted-bundle.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';
import type { OverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';

const manifest: ModuleManifest = {
  moduleId: 'overlay-m1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const meta: OverlayManifestMeta = {
  id: 'overlay-m1', version: '0.1.0', name: 'filter entries', summary: 'skip on oi trend',
  rationale: 'oi-based entry filter', author: 'agent', targetStrategyRef: 'strategy:p1',
  interceptionPoint: 'post_entry_management', paramsSchema: { type: 'object', additionalProperties: false },
};

/** Materialize a projected SubmittedBundle into a temp dir: files[] → paths, descriptor → bundle.json. */
function materialize(sub: SubmittedBundle): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp71b-preflight-'));
  for (const f of sub.files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(f.contentBase64, 'base64'));
  }
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(sub.descriptor));
  return dir;
}

describe('toSubmittedBundle projected bundle passes SDK preflight (subset smoke)', () => {
  it('has no schema_invalid / forbidden_capability / unsupported_contract_version issues', () => {
    const sub = toSubmittedBundle(assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' }, meta));
    const dir = materialize(sub);
    try {
      const res = preflightValidate({ bundleDir: dir });
      const codes = res.issues.map((i) => i.code);
      expect(codes).not.toContain('schema_invalid');
      expect(codes).not.toContain('forbidden_capability');
      expect(codes).not.toContain('unsupported_contract_version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run src/adapters/platform/submitted-bundle.preflight.test.ts`
Expected: PASS. (If it reports `schema_invalid` / `forbidden_capability` / `unsupported_contract_version`, the 017 projection regressed — fix `submitted-bundle.ts`.)

- [ ] **Step 3: Full suite + typecheck (explicit gate)**

Run both, separately:

```bash
pnpm test
pnpm typecheck
```

Expected: PASS — entire suite green (including untouched SP-4 + SP-7.1 tests, and the MCP adapter test fixed in Task 3 Step 5), typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/platform/submitted-bundle.preflight.test.ts
git commit -m "test(sp7.1b): acceptance smoke — materialized bundle passes SDK preflightValidate subset"
```

---

## Acceptance criteria → task map

| Spec criterion (§7) | Covered by |
|---|---|
| #1 manifest.json deep-equals `createOverlayManifest(expectedInput)` | Task 3 (`emits manifest.json …` + `sets submitted.manifest …`) |
| #2 all 017 required fields / kind / status / hooks / no forbidden caps / valid paramsSchema | Task 3 (decoded assertions) + Task 5 (preflight subset) |
| #3 `deriveOverlayManifestMeta` pure & deterministic | Task 1 (determinism test) |
| #4 lab `bundleHash` byte-identical when overlayMeta attached | Task 2 (hash-invariance test) |
| #5 fail-closed without overlayMeta | Task 3 (`MissingOverlayMetaError` / `overlay_meta_missing`) |
| #6 no platform/SDK import in `overlay-manifest-meta.ts` | Task 1 (guard test) |
| #7 preflight subset smoke | Task 5 |
| #8 SP-4 / ports / BuilderPort unchanged | Task 4 (existing handler tests stay green) + Task 5 full suite |
| #9 (gateway-pending) live `validate_module` round-trip | Out of automated scope — manual `pnpm platform:validate` against a live gateway |

**`paramsSchema` ajv compile (spec §7 #2):** intentionally NOT asserted via a new ajv dependency. `paramsSchema` is the fixed, trivially-valid literal `{ type: 'object', additionalProperties: false }`, pinned by the Task 3 deep-equal; the authoritative ajv compile happens at the live gateway.

**`validate-probe.test.ts`:** needs NO change — the probe tests use the mock adapter / inline fakes whose `validateModule` never calls `toSubmittedBundle`, so they never hit the missing-`overlayMeta` guard. (The spec's "may change" list was conservative; leaving it untouched is correct.)

## Manual verification (gateway-pending, criterion #9)

When a live gateway is available, build an SP-7.1b bundle (one that carries `overlayMeta`) and run:

```bash
pnpm platform:validate < path/to/bundle.json
```

Expect `accepted` (catalog knows `strategy:<profileId>`) **or** a report whose only error is `unknown_strategy_ref` (no `schema_invalid` / missing-field issues). Both outcomes satisfy the manifest-shape-only acceptance bar.

## Self-review (completed during authoring)

- **Spec coverage:** every §7 criterion maps to a task (table above); §3 topology, §4 components, §5 field mapping, §6 compatibility all implemented.
- **Placeholder scan:** none — every step carries complete code/commands.
- **Type consistency:** `OverlayManifestMeta` (9 fields) is identical across Tasks 1–5; `deriveOverlayManifestMeta(hypothesis, profile, labManifest)` signature consistent; `MissingOverlayMetaError.code === 'overlay_meta_missing'` consistent between impl and test; `assembleBundle(manifest, files, overlayMeta?)` consistent.
