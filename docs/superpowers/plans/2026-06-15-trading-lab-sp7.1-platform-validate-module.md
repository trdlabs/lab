# SP-7.1 — Platform `validate_module` Dry-Run Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `trading-lab` send an assembled `ModuleBundle` to the `trading-platform` `validate_module` dry-run via `ResearchPlatformPort` / the SDK gateway and return a typed `ValidationReport` — no submit/run/status/result/artifacts, no execution authority.

**Architecture:** A standalone validation probe mirroring SP-7's discovery probe. New `ResearchPlatformPort.validateModule(bundle)`; a `toSubmittedBundle` mapper converts the lab `ModuleBundle` to the platform's submitted wire shape; mock + MCP/Lazy adapters implement the method; `runValidateProbe` orchestrates a fail-closed contract gate + validate with ordered `AgentEvent`s; a `scripts/platform-validate.ts` CLI runs it from a bundle JSON. The SP-4 worker, `hypothesisBuildHandler`, `PlatformGatewayPort`, and the mock backtest flow are untouched.

**Tech Stack:** TypeScript (ESM, run via `node --experimental-strip-types`), Vitest, `@trading-platform/sdk` (vendored tarball), `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-06-15-trading-lab-sp7.1-platform-validate-module-design.md`

---

## Conventions (read once, apply to every task)

- **No TS parameter properties.** This repo runs via `node --experimental-strip-types`; `constructor(private x: T)` compiles but breaks at runtime. Declare fields explicitly and assign in the body (match the existing `McpResearchPlatformAdapter`).
- **Relative imports carry the `.ts` extension** (`from '../../ports/research-platform.port.ts'`); SDK imports use the package subpath (`from '@trading-platform/sdk/agent'`).
- **Test single file:** `pnpm exec vitest run <path>`. **Full suite:** `pnpm test`. **Typecheck:** `pnpm typecheck`.
- **Every commit must leave `pnpm typecheck` green.** `ResearchPlatformPort` has three implementors (`Mock`, `Mcp`, `Lazy`); adding a method to the interface breaks all three until each is implemented — Task 4 changes the interface and all three implementors together for that reason.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/ports/research-platform.port.ts` *(modify)* | add `validateModule(bundle, options?)` + re-export `ValidationReport`, `ValidationIssueDTO` |
| `src/adapters/platform/gateway-errors.ts` *(create)* | `GatewayValidationError` — typed wrapper for the `ok:false` `GatewayError` envelope |
| `src/adapters/platform/submitted-bundle.ts` *(create)* | `toSubmittedBundle(bundle)` — lab `ModuleBundle` → SDK `SubmittedBundle` (base64 files re-rooted under `module/`, synthesized `BundleDescriptor`, platform-format `bundleHash`) |
| `src/adapters/platform/mock-research-platform.adapter.ts` *(modify)* | `validateModule` → deterministic `accepted` report |
| `src/adapters/platform/mcp-research-platform.adapter.ts` *(modify)* | `validateModule` in `Mcp` + `Lazy`: map → SDK `validateModule` → unwrap envelope (`ok` → report, `!ok` → throw) |
| `src/adapters/platform/validate-probe.ts` *(create)* | `runValidateProbe(deps)` — contract gate + validate, ordered `AgentEvent`s |
| `scripts/platform-validate.ts` *(create)* | CLI: bundle JSON (file arg / stdin) → probe → print `ValidationReport` |
| `package.json` *(modify)* | `+ "platform:validate"` script |
| `*.test.ts` | unit tests colocated with each unit |

---

## Task 1: Confirm SDK surface + platform contract assumptions (verification spike)

**Why first:** the mapper depends on platform-side specifics (hash formula, `module/` layout, 017 manifest). Confirm the SDK exports we will call and pin the contract assumptions before writing the mapper. (Per spec §5 — treat any divergence as a finding, not a silent workaround.)

**Files:**
- Test: `src/adapters/platform/sdk-surface.spike.test.ts` (temporary; deleted at end of task)

- [ ] **Step 1: Write a runtime+type import test for the SDK agent surface**

```ts
// src/adapters/platform/sdk-surface.spike.test.ts
import { describe, it, expect } from 'vitest';
import * as agent from '@trading-platform/sdk/agent';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type {
  ValidateModuleRequest, ValidateModuleResult, SubmittedBundle,
  ValidationReport, ValidationIssueDTO, GatewayError, GatewayTransport,
} from '@trading-platform/sdk/agent';

describe('SDK agent surface (SP-7.1 spike)', () => {
  it('exports validateModule as a function', () => {
    expect(typeof agent.validateModule).toBe('function');
    expect(typeof CONTRACT_VERSION).toBe('string');
  });

  it('the request/result/report types compile against our assumed shapes', () => {
    const submitted: SubmittedBundle = { manifest: {}, files: [{ path: 'manifest.json', contentBase64: '' }], descriptor: {} };
    const req: ValidateModuleRequest = { module: { kind: 'submitted', bundle: submitted } };
    const okReport: ValidationReport = { status: 'accepted', issues: [], executed: false };
    const issue: ValidationIssueDTO = { severity: 'error', code: 'x', message: 'm', path: '/p' };
    const err: GatewayError = { category: 'validation_error', code: 'x', message: 'm' };
    const result: ValidateModuleResult = { ok: true, report: okReport };
    const transport: GatewayTransport = { call: async () => result };
    expect(req.module.kind).toBe('submitted');
    expect(issue.severity).toBe('error');
    expect(err.category).toBe('validation_error');
    expect(transport).toBeDefined();
    void okReport;
  });
});
```

- [ ] **Step 2: Run the spike test + typecheck**

Run: `pnpm exec vitest run src/adapters/platform/sdk-surface.spike.test.ts && pnpm typecheck`
Expected: PASS. If any import/type fails, the SDK surface drifted from spec §4 — **stop and record the actual shape as a finding** (update spec §4/§5) before continuing.

- [ ] **Step 3: Re-confirm the platform-side contract assumptions (read-only)**

Confirm each spec §5 "Confirmed" bullet still holds in `trading-platform` (these are the mapper's load-bearing facts):
- `src/research/sandbox/bundle-hash.ts` → `computeBundleHash` formula (`manifestSha256`, sorted `files`, `bundleHash = "sha256:" + sha256(canonicalJson({manifestSha256, files}))`).
- `src/research/sandbox/acceptance-gate.ts::validateBundle` → checks: all `descriptor.files` present, `entryPoint` resolves inside `module/`, `descriptor.contractVersion ∈ supported`, recomputed `bundleHash === descriptor.bundleHash`, then 017 manifest `validate`.
- `src/research/mcp-gateway/jobs/module-resolution.ts::materializeBundleDir` → writes `bundle.json` from `descriptor`, writes each `files[]` entry by base64 with a path-traversal guard; `loadBundle` reads `manifest.json` + `bundle.json`.

Record any divergence inline in the spec (`§5`). No production code changes in this step.

- [ ] **Step 4: Delete the spike test and commit the findings (if any)**

```bash
rm src/adapters/platform/sdk-surface.spike.test.ts
# commit only if spec §4/§5 were updated; otherwise this task produces no diff
git add -A
git commit -m "chore(sp7.1): confirm SDK surface + platform validate contract" --allow-empty
```

---

## Task 2: `GatewayValidationError`

**Files:**
- Create: `src/adapters/platform/gateway-errors.ts`
- Test: `src/adapters/platform/gateway-errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/platform/gateway-errors.test.ts
import { describe, it, expect } from 'vitest';
import { GatewayValidationError } from './gateway-errors.ts';

describe('GatewayValidationError', () => {
  it('carries category + code and a descriptive message', () => {
    const e = new GatewayValidationError({ category: 'validation_error', code: 'invalid_module', message: 'bad kind' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('GatewayValidationError');
    expect(e.category).toBe('validation_error');
    expect(e.code).toBe('invalid_module');
    expect(e.message).toContain('validation_error');
    expect(e.message).toContain('invalid_module');
    expect(e.message).toContain('bad kind');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/adapters/platform/gateway-errors.test.ts`
Expected: FAIL — `Cannot find module './gateway-errors.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapters/platform/gateway-errors.ts
import type { GatewayError } from '@trading-platform/sdk/agent';

/** Thrown when the gateway returns an `ok:false` envelope (transport-level / contract / bundle-load failure). */
export class GatewayValidationError extends Error {
  readonly category: GatewayError['category'];
  readonly code: string;

  constructor(error: GatewayError) {
    super(`gateway ${error.category}/${error.code}: ${error.message}`);
    this.name = 'GatewayValidationError';
    this.category = error.category;
    this.code = error.code;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/adapters/platform/gateway-errors.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/gateway-errors.ts src/adapters/platform/gateway-errors.test.ts
git commit -m "feat(sp7.1): GatewayValidationError for the ok:false validate envelope"
```

---

## Task 3: `toSubmittedBundle` mapper

**Files:**
- Create: `src/adapters/platform/submitted-bundle.ts`
- Test: `src/adapters/platform/submitted-bundle.test.ts`

**Contract (spec §5, confirmed by Task 1):** re-root lab files under `module/`; `manifest.json` at root; `descriptor.files` = **`manifest.json` + all `module/**`** entries (sorted, per-file `sha256`) per the 019 `BundleDescriptor` contract; `descriptor.bundleHash` replicates the platform formula (`manifestSha256` is also hashed separately — the platform counts the manifest twice and is self-consistent); `entryPoint = "module/" + manifest.entry`; `kind = 'overlay'`; `descriptor.contractVersion = CONTRACT_VERSION` (`"017.2"`). The mapper guarantees **structural validity** (decodable base64, safe relative paths, parseable `manifest.json` + `bundle.json`); semantic acceptance (`accepted` vs `rejected`) is the platform's call.

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/platform/submitted-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { toSubmittedBundle } from './submitted-bundle.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

function sha256Hex(s: string): string { return createHash('sha256').update(s).digest('hex'); }
function canon(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const files = { 'index.ts': 'export const overlay = { rules: [] };', 'helpers/util.ts': 'export const u = 1;' };

describe('toSubmittedBundle', () => {
  const sub = toSubmittedBundle(assembleBundle(manifest, files));

  it('re-roots code files under module/ and adds manifest.json at root, all base64', () => {
    const paths = sub.files.map((f) => f.path).sort();
    expect(paths).toEqual(['manifest.json', 'module/helpers/util.ts', 'module/index.ts']);
    const idx = sub.files.find((f) => f.path === 'module/index.ts')!;
    expect(Buffer.from(idx.contentBase64, 'base64').toString('utf8')).toBe(files['index.ts']);
    const man = sub.files.find((f) => f.path === 'manifest.json')!;
    expect(JSON.parse(Buffer.from(man.contentBase64, 'base64').toString('utf8')).moduleId).toBe('m1');
  });

  it('descriptor.files lists manifest.json + module/** entries, sorted, with per-file sha256', () => {
    const d = sub.descriptor as { files: { path: string; sha256: string }[]; entryPoint: string; kind: string; contractVersion: string; bundleHash: string };
    expect(d.files.map((f) => f.path)).toEqual(['manifest.json', 'module/helpers/util.ts', 'module/index.ts']);
    expect(d.files.find((f) => f.path === 'module/index.ts')!.sha256).toBe(sha256Hex(files['index.ts']));
    expect(d.files.find((f) => f.path === 'manifest.json')!.sha256).toBe(sha256Hex(JSON.stringify(manifest)));
    expect(d.kind).toBe('overlay');
    expect(d.entryPoint).toBe('module/index.ts');
    expect(typeof d.contractVersion).toBe('string');
  });

  it('bundleHash replicates the platform formula (self-consistent)', () => {
    const d = sub.descriptor as { files: { path: string; sha256: string }[]; bundleHash: string };
    const manifestSha256 = sha256Hex(JSON.stringify(manifest));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/adapters/platform/submitted-bundle.test.ts`
Expected: FAIL — `Cannot find module './submitted-bundle.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapters/platform/submitted-bundle.ts
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type { SubmittedBundle } from '@trading-platform/sdk/agent';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

const MODULE_DIR = 'module';

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Sorted-key canonical JSON (strings/arrays/objects only) — mirrors the platform's 018 canonicalJson. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * Map a lab ModuleBundle to the platform's submitted-bundle wire shape (spec §5).
 *  - lab `files` keys are bare relative paths → re-rooted under `module/`; `manifest.json` at root
 *  - `descriptor.files` = `manifest.json` + all `module/**` payload entries (sorted, per-file sha256), per the 019 contract
 *  - `bundleHash` replicates `trading-platform/.../bundle-hash.ts::computeBundleHash`
 */
export function toSubmittedBundle(bundle: ModuleBundle): SubmittedBundle {
  const manifestJson = JSON.stringify(bundle.manifest);
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

  return { manifest: bundle.manifest, files, descriptor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/adapters/platform/submitted-bundle.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/submitted-bundle.ts src/adapters/platform/submitted-bundle.test.ts
git commit -m "feat(sp7.1): toSubmittedBundle mapper (lab ModuleBundle -> platform SubmittedBundle)"
```

---

## Task 4: Extend `ResearchPlatformPort` + implement `validateModule` in all three adapters

**Files:**
- Modify: `src/ports/research-platform.port.ts`
- Modify: `src/adapters/platform/mock-research-platform.adapter.ts`
- Modify: `src/adapters/platform/mcp-research-platform.adapter.ts`
- Test: `src/adapters/platform/mock-research-platform.adapter.test.ts` (create)
- Test: `src/adapters/platform/mcp-research-platform.adapter.test.ts` (create)

> One task because the interface and its three implementors (`Mock`, `Mcp`, `Lazy`) must change together to keep `pnpm typecheck` green at the commit.

- [ ] **Step 1: Write the failing mock-adapter test**

```ts
// src/adapters/platform/mock-research-platform.adapter.test.ts
import { describe, it, expect } from 'vitest';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};

describe('MockResearchPlatformAdapter.validateModule', () => {
  it('returns an accepted, non-executed report', async () => {
    const adapter = new MockResearchPlatformAdapter();
    const report = await adapter.validateModule(assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' }));
    expect(report.status).toBe('accepted');
    expect(report.executed).toBe(false);
    expect(report.issues).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm exec vitest run src/adapters/platform/mock-research-platform.adapter.test.ts`
Expected: FAIL — `adapter.validateModule is not a function`.

- [ ] **Step 3: Extend the port interface + re-export the report types**

In `src/ports/research-platform.port.ts`, replace the imports/re-exports/interface with:

```ts
import type {
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  ValidationIssueDTO,
} from '@trading-platform/sdk/agent';
import type { ModuleBundle } from '../domain/module-bundle.ts';

export type {
  ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult,
  ValidationReport, ValidationIssueDTO,
};

export interface ValidateModuleOptions {
  readonly dataNeeds?: object;
}

/**
 * Research-platform lifecycle as seen by trading-lab research orchestration.
 * Separate from PlatformGatewayPort (market-context + the mock backtest path).
 * Grows in SP-7.2+ with submit / status / result / artifacts / cancel.
 */
export interface ResearchPlatformPort {
  discover(): Promise<ResearchCapabilityDescriptor>;
  listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult>;
  validateModule(bundle: ModuleBundle, options?: ValidateModuleOptions): Promise<ValidationReport>;
}
```

- [ ] **Step 4: Implement `validateModule` in the mock adapter**

In `src/adapters/platform/mock-research-platform.adapter.ts`, extend the imports and add the method:

```ts
// add to the existing type import from the port:
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  ValidateModuleOptions,
} from '../../ports/research-platform.port.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
```

Add inside the class (after `listDatasets`):

```ts
  async validateModule(_bundle: ModuleBundle, _options?: ValidateModuleOptions): Promise<ValidationReport> {
    return { status: 'accepted', issues: [], executed: false };
  }
```

- [ ] **Step 5: Run the mock test (should pass; mcp/lazy typecheck still red)**

Run: `pnpm exec vitest run src/adapters/platform/mock-research-platform.adapter.test.ts`
Expected: PASS. (`pnpm typecheck` is still RED — `Mcp`/`Lazy` don't implement `validateModule` yet. That is fixed in Step 8.)

- [ ] **Step 6: Write the failing MCP-adapter test**

```ts
// src/adapters/platform/mcp-research-platform.adapter.test.ts
import { describe, it, expect } from 'vitest';
import { McpResearchPlatformAdapter, LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import { GatewayValidationError } from './gateway-errors.ts';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type { GatewayTransport, ValidateModuleResult } from '@trading-platform/sdk/agent';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const bundle = assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' });

function transportReturning(result: ValidateModuleResult): { transport: GatewayTransport; calls: { tool: string; payload: unknown }[] } {
  const calls: { tool: string; payload: unknown }[] = [];
  const transport: GatewayTransport = { call: async (tool: string, payload: unknown) => { calls.push({ tool, payload }); return result; } };
  return { transport, calls };
}

describe('McpResearchPlatformAdapter.validateModule', () => {
  it('sends a submitted bundle to validate_module and returns the report on ok', async () => {
    const okReport = { status: 'accepted', issues: [], executed: false } as const;
    const { transport, calls } = transportReturning({ ok: true, report: okReport });
    const report = await new McpResearchPlatformAdapter(transport, CONTRACT_VERSION).validateModule(bundle);
    expect(report).toEqual(okReport);
    expect(calls[0]!.tool).toBe('validate_module');
    expect((calls[0]!.payload as { module: { kind: string } }).module.kind).toBe('submitted');
  });

  it('throws GatewayValidationError on an ok:false envelope', async () => {
    const { transport } = transportReturning({ ok: false, error: { category: 'validation_error', code: 'invalid_module', message: 'bad' } });
    await expect(new McpResearchPlatformAdapter(transport, CONTRACT_VERSION).validateModule(bundle))
      .rejects.toBeInstanceOf(GatewayValidationError);
  });

  it('Lazy variant opens and closes a session around the call', async () => {
    const okReport = { status: 'accepted', issues: [], executed: false } as const;
    const { transport } = transportReturning({ ok: true, report: okReport });
    let closed = false;
    const lazy = new LazyMcpResearchPlatformAdapter(
      async () => ({ transport, close: async () => { closed = true; } }),
      CONTRACT_VERSION,
    );
    const report = await lazy.validateModule(bundle);
    expect(report).toEqual(okReport);
    expect(closed).toBe(true);
  });
});
```

- [ ] **Step 7: Run it to confirm failure**

Run: `pnpm exec vitest run src/adapters/platform/mcp-research-platform.adapter.test.ts`
Expected: FAIL — `validateModule is not a function` (or a compile error).

- [ ] **Step 8: Implement `validateModule` in `Mcp` + `Lazy`**

In `src/adapters/platform/mcp-research-platform.adapter.ts`:

Extend the SDK import and add the new imports at the top:

```ts
import { discover, listDatasets, validateModule } from '@trading-platform/sdk/agent';
import type { GatewayTransport, ValidateModuleRequest } from '@trading-platform/sdk/agent';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  ValidateModuleOptions,
} from '../../ports/research-platform.port.ts';
import { assertContractCompatible } from './research-contract.ts';
import { toSubmittedBundle } from './submitted-bundle.ts';
import { GatewayValidationError } from './gateway-errors.ts';
import type { GatewaySession } from './mcp-research-transport.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
```

Add this method to `McpResearchPlatformAdapter` (after `listDatasets`):

```ts
  async validateModule(bundle: ModuleBundle, options?: ValidateModuleOptions): Promise<ValidationReport> {
    const request: ValidateModuleRequest = {
      module: { kind: 'submitted', bundle: toSubmittedBundle(bundle) },
      ...(options?.dataNeeds !== undefined ? { dataNeeds: options.dataNeeds } : {}),
    };
    const result = await validateModule(this.transport, request);
    if (!result.ok) throw new GatewayValidationError(result.error);
    return result.report;
  }
```

Add this method to `LazyMcpResearchPlatformAdapter` (after `listDatasets`):

```ts
  async validateModule(bundle: ModuleBundle, options?: ValidateModuleOptions): Promise<ValidationReport> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).validateModule(bundle, options);
    } finally {
      await session.close();
    }
  }
```

- [ ] **Step 9: Run both adapter tests + full typecheck**

Run: `pnpm exec vitest run src/adapters/platform/mock-research-platform.adapter.test.ts src/adapters/platform/mcp-research-platform.adapter.test.ts && pnpm typecheck`
Expected: PASS, and typecheck GREEN.

- [ ] **Step 10: Commit**

```bash
git add src/ports/research-platform.port.ts src/adapters/platform/mock-research-platform.adapter.ts src/adapters/platform/mcp-research-platform.adapter.ts src/adapters/platform/mock-research-platform.adapter.test.ts src/adapters/platform/mcp-research-platform.adapter.test.ts
git commit -m "feat(sp7.1): ResearchPlatformPort.validateModule + mock/mcp/lazy adapters"
```

---

## Task 5: `runValidateProbe`

**Files:**
- Create: `src/adapters/platform/validate-probe.ts`
- Test: `src/adapters/platform/validate-probe.test.ts`

**Event contract (spec §7):** happy path `[platform.validate.started, platform.validate.completed]`, plus `platform.validate.rejected` when `status==='rejected'`. The contract gate (`discover()`) is silent on success; on a contract mismatch it emits `[platform.validate.started, platform.contract.incompatible, platform.validate.failed]` and rethrows; any other discover/validate error emits `platform.validate.failed` and rethrows.

- [ ] **Step 1: Write the failing test**

```ts
// src/adapters/platform/validate-probe.test.ts
import { describe, it, expect } from 'vitest';
import { runValidateProbe } from './validate-probe.ts';
import { ContractIncompatibleError } from './research-contract.ts';
import { GatewayValidationError } from './gateway-errors.ts';
import { ConsoleAgentEventSink } from './console-agent-event-sink.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import type { ResearchPlatformPort, ResearchCapabilityDescriptor, ValidationReport } from '../../ports/research-platform.port.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const bundle = assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' });

async function typesOf(sink: ConsoleAgentEventSink, probeId: string): Promise<string[]> {
  return (await sink.listByTask(probeId)).map((e) => e.type);
}

const okDescriptor: ResearchCapabilityDescriptor = {
  contractVersion: '031', supportedContractVersions: ['031'],
  marketDataKinds: [], runModes: [], metricCatalog: [], robustnessCatalog: [],
};

describe('runValidateProbe', () => {
  it('emits started then completed on an accepted report', async () => {
    const sink = new ConsoleAgentEventSink();
    const r = await runValidateProbe({ platform: new MockResearchPlatformAdapter(), events: sink, probeId: 'p:ok', integration: 'mock', bundle });
    expect(await typesOf(sink, 'p:ok')).toEqual(['platform.validate.started', 'platform.validate.completed']);
    expect(r.report.status).toBe('accepted');
  });

  it('emits started, completed, rejected on a rejected report', async () => {
    const sink = new ConsoleAgentEventSink();
    const rejected: ValidationReport = { status: 'rejected', issues: [{ severity: 'error', code: 'x', message: 'm', path: '/p' }], executed: false };
    const platform: ResearchPlatformPort = {
      async discover() { return okDescriptor; },
      async listDatasets() { return { datasets: [] }; },
      async validateModule() { return rejected; },
    };
    await runValidateProbe({ platform, events: sink, probeId: 'p:rej', integration: 'mcp', bundle });
    expect(await typesOf(sink, 'p:rej')).toEqual(['platform.validate.started', 'platform.validate.completed', 'platform.validate.rejected']);
  });

  it('emits started then failed and rethrows on a gateway error', async () => {
    const sink = new ConsoleAgentEventSink();
    const platform: ResearchPlatformPort = {
      async discover() { return okDescriptor; },
      async listDatasets() { return { datasets: [] }; },
      async validateModule() { throw new GatewayValidationError({ category: 'sandbox_module_error', code: 'bundle_load_failed', message: 'x' }); },
    };
    await expect(runValidateProbe({ platform, events: sink, probeId: 'p:err', integration: 'mcp', bundle }))
      .rejects.toBeInstanceOf(GatewayValidationError);
    expect(await typesOf(sink, 'p:err')).toEqual(['platform.validate.started', 'platform.validate.failed']);
  });

  it('emits started, contract.incompatible, failed and rethrows on a contract mismatch', async () => {
    const sink = new ConsoleAgentEventSink();
    const platform: ResearchPlatformPort = {
      async discover() { throw new ContractIncompatibleError('031.1', '031.9', ['031.9']); },
      async listDatasets() { return { datasets: [] }; },
      async validateModule() { return { status: 'accepted', issues: [], executed: false }; },
    };
    await expect(runValidateProbe({ platform, events: sink, probeId: 'p:bad', integration: 'mcp', bundle }))
      .rejects.toBeInstanceOf(ContractIncompatibleError);
    expect(await typesOf(sink, 'p:bad')).toEqual(['platform.validate.started', 'platform.contract.incompatible', 'platform.validate.failed']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/adapters/platform/validate-probe.test.ts`
Expected: FAIL — `Cannot find module './validate-probe.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapters/platform/validate-probe.ts
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';
import type { ResearchPlatformPort, ValidationReport } from '../../ports/research-platform.port.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { ContractIncompatibleError } from './research-contract.ts';

export interface ValidateProbeDeps {
  platform: ResearchPlatformPort;
  events: AgentEventRepository;
  probeId: string;
  integration: string;
  bundle: ModuleBundle;
  dataNeeds?: object;
}

export interface ValidateProbeResult {
  report: ValidationReport;
}

function mkEvent(taskId: string, type: string, payload: Record<string, unknown>): AgentEvent {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runValidateProbe(deps: ValidateProbeDeps): Promise<ValidateProbeResult> {
  const { platform, events, probeId, integration, bundle, dataNeeds } = deps;
  await events.append(mkEvent(probeId, 'platform.validate.started', {
    integration, bundleHash: bundle.bundleHash, moduleId: bundle.manifest.moduleId,
  }));

  // Fail-closed contract gate (discover() asserts contract compatibility inside the adapter).
  try {
    await platform.discover();
  } catch (err) {
    if (err instanceof ContractIncompatibleError) {
      await events.append(mkEvent(probeId, 'platform.contract.incompatible', {
        expected: err.expected, actual: err.actual, supported: [...err.supported],
      }));
    }
    await events.append(mkEvent(probeId, 'platform.validate.failed', { error: errMsg(err) }));
    throw err;
  }

  let report: ValidationReport;
  try {
    report = await platform.validateModule(bundle, dataNeeds !== undefined ? { dataNeeds } : undefined);
  } catch (err) {
    await events.append(mkEvent(probeId, 'platform.validate.failed', { error: errMsg(err) }));
    throw err;
  }

  const errorCount = report.issues.filter((i) => i.severity === 'error').length;
  const warningCount = report.issues.filter((i) => i.severity === 'warning').length;
  await events.append(mkEvent(probeId, 'platform.validate.completed', { status: report.status, errorCount, warningCount }));
  if (report.status === 'rejected') {
    await events.append(mkEvent(probeId, 'platform.validate.rejected', { errorCount }));
  }
  return { report };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/adapters/platform/validate-probe.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/validate-probe.ts src/adapters/platform/validate-probe.test.ts
git commit -m "feat(sp7.1): runValidateProbe with ordered AgentEvent audit + contract gate"
```

---

## Task 6: `platform:validate` CLI

**Files:**
- Create: `scripts/platform-validate.ts`
- Modify: `package.json`

> No unit test (mirrors `scripts/platform-discover.ts`, which is untested); it is exercised by the real-gateway round-trip in Task 7.

- [ ] **Step 1: Write the CLI**

```ts
// scripts/platform-validate.ts
// platform:validate — narrow dry-run validation probe. No runtime boot, no DB.
// Flow: read bundle JSON (file arg or stdin) -> spawn MCP stdio gateway -> contract gate + validate_module -> print report -> close.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  loadResearchPlatformConfig, createGatewayTransport, withTimeout,
  type GatewaySession,
} from '../src/adapters/platform/mcp-research-transport.ts';
import { McpResearchPlatformAdapter } from '../src/adapters/platform/mcp-research-platform.adapter.ts';
import { ConsoleAgentEventSink } from '../src/adapters/platform/console-agent-event-sink.ts';
import { runValidateProbe } from '../src/adapters/platform/validate-probe.ts';
import type { ModuleBundle } from '../src/domain/module-bundle.ts';

function readBundle(): ModuleBundle {
  const arg = process.argv[2];
  const raw = arg && arg !== '-' ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');
  return JSON.parse(raw) as ModuleBundle;
}

async function main(): Promise<void> {
  const bundle = readBundle();
  const config = loadResearchPlatformConfig(process.env);
  const events = new ConsoleAgentEventSink();
  const probeId = `probe:${randomUUID()}`;
  let session: GatewaySession | undefined;

  try {
    const { report } = await withTimeout((async () => {
      session = await createGatewayTransport(config);
      const platform = new McpResearchPlatformAdapter(session.transport, config.expectedContractVersion);
      return runValidateProbe({ platform, events, probeId, integration: 'mcp', bundle });
    })(), config.discoveryTimeoutMs, 'platform:validate');

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (session) await session.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`platform:validate failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
```

- [ ] **Step 2: Add the package.json script**

In `package.json`, add under `scripts` (right after the `platform:discover` line):

```json
    "platform:validate": "node --experimental-strip-types scripts/platform-validate.ts",
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Smoke-test argument parsing without a gateway**

Run: `printf '{bad json' | pnpm exec node --experimental-strip-types scripts/platform-validate.ts -`
Expected: exits non-zero with `platform:validate failed:` on stderr (JSON parse error) — proves the CLI wiring/parse path before any gateway is involved.

- [ ] **Step 5: Commit**

```bash
git add scripts/platform-validate.ts package.json
git commit -m "feat(sp7.1): platform:validate CLI (bundle JSON -> typed ValidationReport)"
```

---

## Task 7: Final verification + real-gateway round-trip + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-06-15-trading-lab-sp7.1-platform-validate-module-design.md` (record round-trip outcome)

- [ ] **Step 1: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests PASS, typecheck GREEN. Confirm **no diff** to `src/orchestrator/handlers/hypothesis-build.handler.ts`, `src/ports/platform-gateway.port.ts`, and the mock backtest adapters:

Run: `git diff --name-only main... | grep -E 'platform-gateway|mock-platform-gateway|hypothesis-build.handler' || echo 'OK: backtest path untouched'`
Expected: `OK: backtest path untouched`.

- [ ] **Step 2: Real-gateway round-trip (pins the platform-side contract — spec §5)**

Produce a bundle JSON (e.g. dump one `assembleBundle(...)` result, or copy a `module_bundle` artifact body), then run the CLI against a configured MCP gateway:

Run: `pnpm platform:validate ./tmp-bundle.json`
Expected (per spec §9): a printed `ValidationReport` (`accepted` / `accepted_with_warnings` / `rejected`) — **not** a `platform:validate failed` exit. A `rejected` status from 017 manifest shortfalls is an accepted SP-7.1 outcome.

**If the gateway returns an `ok:false` error** (`bundle_load_failed`, `bundle_integrity_violation`, `unsupported_contract_version`, path-traversal rejection): that is a **structural** mapper bug → fix `toSubmittedBundle` (Task 3) to match the actual `loadBundle` / acceptance-gate behavior, record the divergence in spec §5, and re-run. If no gateway is available in this environment, note it and hand the round-trip to the user.

- [ ] **Step 3: Record the round-trip outcome in the spec**

Append the observed report (status + any divergence/fix) to spec §5, so the confirmed contract is documented.

```bash
git add docs/superpowers/specs/2026-06-15-trading-lab-sp7.1-platform-validate-module-design.md
git commit -m "docs(sp7.1): record validate_module round-trip outcome"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin sp7.1-platform-validate-module
gh pr create --fill --base main
```

---

## Self-Review (performed while writing this plan)

**Spec coverage:** §3 boundary → Task 4 (port-only) + Task 7 Step 1 (untouched-backtest assertion) + Task 5 (contract gate). §4 SDK contract → Task 1. §5 mapping → Task 3 + Task 7 round-trip. §6 files → all tasks (one file per row). §7 events → Task 5. §8 tests → Tasks 2–5. §9 acceptance → Task 7. §10 forward-links → no code (doc-only). Covered.

**Placeholder scan:** every code step has complete code; every command has an expected result; no "TBD"/"handle errors". Clear.

**Type consistency:** `toSubmittedBundle(bundle): SubmittedBundle`, `validateModule(bundle, options?): Promise<ValidationReport>`, `ValidateModuleOptions.dataNeeds`, `GatewayValidationError(error: GatewayError)`, `runValidateProbe(ValidateProbeDeps): Promise<ValidateProbeResult>`, event types `platform.validate.started|completed|rejected|failed` + reused `platform.contract.incompatible` — names are identical across tasks and match the spec.
