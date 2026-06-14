# SP-7.1 — Platform `validate_module` Dry-Run Integration

**Date:** 2026-06-15
**Status:** design (approved scope: standalone probe + CLI)
**Predecessors:** SP-4 (build → bundle → local validation → mock backtest → evaluation), SP-7 (read-only platform discovery via `ResearchPlatformPort`), SP-8 (standalone `@trading-platform/sdk`)
**Successors:** SP-7.2 (submit / status / result / artifacts), SP-7.3 (callback resume)

## 1. Goal

Let `trading-lab` send an assembled `ModuleBundle` to the `trading-platform` `validate_module` dry-run through the existing `ResearchPlatformPort` / SDK gateway boundary and receive a typed `ValidationReport` — **without** backtest/run, submit, status, result, artifacts, or any execution authority.

This is the next safe platform-integration step after read-only discovery: it exercises the gateway with a real payload (our bundle) but stays side-effect-free.

## 2. Non-goals (explicitly deferred)

- No `submitRun` / `getRunStatus` / `getRunResult` / `readArtifact` / `cancelRun` (→ SP-7.2).
- No callback resume wiring (→ SP-7.3).
- No change to `PlatformGatewayPort` or the SP-4 mock backtest flow.
- No wiring into `hypothesisBuildHandler` / the worker pipeline.
- No new DB entity / migration; the report is not persisted in this slice.

## 3. Boundary & invariants

- **Port:** lives on `ResearchPlatformPort` only (`src/ports/research-platform.port.ts`, whose own doc-comment already reserves `validate` for SP-7.1+). `PlatformGatewayPort` (SP-4, `submitBacktest`/`getBacktestResult`) is untouched — the two ports do not intersect; `hypothesisBuildHandler` reaches the platform exclusively via `PlatformGatewayPort`.
- **No execution authority — type-enforced.** The SDK's `ValidationReport.executed` is the literal `false`; the dry-run cannot return an executed result by construction. The probe additionally makes zero other gateway calls.
- **Boot-safe.** Reuse the SP-7 lazy pattern (`LazyMcpResearchPlatformAdapter` opens a session per call, closes it; `composeRuntime` never spawns the gateway, never depends on `trading-platform`). No credentials/network at boot.
- **Fail-closed contract gate.** The probe runs `discover()` → `assertContractCompatible(...)` before `validateModule`, reusing the SP-7 gate. A contract mismatch fails closed (throws `ContractIncompatibleError`, emits `platform.contract.incompatible`) and never sends the bundle.
- **Standalone, like SP-7.** Mirrors `runDiscoveryProbe` + `scripts/platform-discover.ts`; the probe is not invoked from the worker.

## 4. SDK contract (already available — no platform changes)

`@trading-platform/sdk/agent` exports `validateModule(transport, request): Promise<ValidateModuleResult>`:

```ts
ValidateModuleRequest = { module: ModuleSelector; dataNeeds?: object }
ModuleSelector =
  | { kind: 'ref'; moduleRef: Ref }
  | { kind: 'submitted'; bundle: SubmittedBundle }
SubmittedBundle = { manifest: object; files: { path: string; contentBase64: string }[]; descriptor: object }
ValidateModuleResult =
  | { ok: true;  report: ValidationReport }
  | { ok: false; error: GatewayError }            // 6 categories
ValidationReport = {
  status: 'accepted' | 'accepted_with_warnings' | 'rejected'
  issues: ValidationIssueDTO[]                     // { severity:'error'|'warning'; code; message; path }
  executed: false
}
```

A freshly-built hypothesis bundle is in **no** trusted registry, so the `ref` path is impossible — SP-7.1 must use **`{ kind: 'submitted' }`**.

## 5. Contract mapping `ModuleBundle` → `SubmittedBundle` (the core new logic)

Lab's `ModuleBundle` = `{ manifest: ModuleManifest; files: Record<string,string>; bundleHash; bundleContractVersion }`.

The platform's submitted path (`materializeAndLoadBundle` → `materializeBundleDir` → `loadBundle`) writes `bundle.json` = `JSON.stringify(descriptor)`, writes each `files[]` entry from base64 (with a path-traversal guard), then re-loads and re-validates the descriptor. So `SubmittedBundle.descriptor` is a semantically-required **`BundleDescriptor`**:

```ts
BundleDescriptor = {
  contractVersion: string                 // platform 017 set
  kind: 'strategy' | 'overlay'            // from manifest.moduleKind ('hypothesis_overlay' → 'overlay')
  entryPoint: string                      // from manifest.entry (relative within module/)
  files: { path: string; sha256: string }[]   // ALL payload files (manifest.json + module/**), sorted by path
  bundleHash: 'sha256:<hex>'
}
```

The SDK ships **no** packing helper (`contentBase64` ⇒ 0 hits in `packages/sdk`), so lab owns a `toSubmittedBundle(bundle)` mapper:
1. emit `files[]` = base64 of each payload file, including `manifest.json`, sorted by `path`;
2. synthesize `descriptor` with per-file `sha256`, `entryPoint`, `kind`, `contractVersion`, `bundleHash`.

**Confirmed (planning findings):**
- `loadBundle(bundleDir)` only parses `manifest.json` + `bundle.json`. Integrity is enforced by the platform acceptance-gate `validateBundle` (`src/research/sandbox/acceptance-gate.ts`): every `descriptor.files[]` must exist on disk, `descriptor.entryPoint` must resolve **inside `module/`**, `descriptor.contractVersion ∈ supportedContractVersions`, and the recomputed `bundleHash` must equal `descriptor.bundleHash`.
- The platform `bundleHash` (`src/research/sandbox/bundle-hash.ts`) is **not** lab's `assembleBundle` hash: `manifestSha256 = sha256(bytes("manifest.json"))`, `files = sorted([{path, sha256(bytes(file))}])`, `bundleHash = "sha256:" + sha256(canonicalJson({ manifestSha256, files }))`. The mapper must replicate this exactly (incl. the 018 `canonicalJson` byte-form).
- **Layout gap:** lab files are keyed by bare path (`'index.ts'`); the platform expects code under `module/` with `manifest.json` at root. The mapper re-roots files under `module/` and sets `descriptor.entryPoint = "module/" + manifest.entry`.
- **Manifest gap:** lab's `ModuleManifest` ≠ the platform 017 overlay manifest (`OverlayManifestInput`: `id, version, name, summary, rationale, author, paramsSchema, targetStrategyRef, interceptionPoint, dataNeeds?, contractVersion?`). Lab does not yet hold `interceptionPoint` / `paramsSchema`. Building a fully **`accepted`** 017 overlay manifest is **out of scope for SP-7.1** (follow-up).

**Structurally-valid invariant (the SP-7.1 guarantee).** As long as the `SubmittedBundle` materializes and loads (valid base64, path-safe entries, `manifest.json` + `bundle.json` parse), 017 manifest shortfalls surface as a **`rejected` `ValidationReport` (`ok:true`)**, never an `ok:false` gateway error. SP-7.1 guarantees that structural correctness; the report's `status` (`accepted` / `accepted_with_warnings` / `rejected`) is platform-domain and may legitimately be `rejected` until the 017 overlay manifest is built in a follow-up.

**Resolved by Task 1 (verify spike):** `descriptor.files` lists **`manifest.json` + all `module/**`** (sorted, per-file `sha256`), per the 019 `BundleDescriptor` contract; `manifestSha256` is *also* hashed separately, so the platform formula counts the manifest in two places and stays self-consistent. The acceptance-gate recomputes `bundleHash` over exactly the declared `descriptor.files`, so the mapper is correct as long as its own `descriptor.bundleHash` is computed over the same set. `CONTRACT_VERSION` is `"017.2"` (use it for `descriptor.contractVersion`). The remaining `canonicalJson` byte-equivalence is pinned by Task 7's real-gateway round-trip; treat any `bundle_integrity_violation` as a finding, not a silent workaround.

## 6. Files

| File | Change |
|------|--------|
| `src/ports/research-platform.port.ts` | `+ validateModule(bundle: ModuleBundle, opts?: { dataNeeds?: object }): Promise<ValidationReport>`; re-export `ValidationReport`, `ValidationIssueDTO`. Port takes lab-domain `ModuleBundle`; SDK request types do not leak (report type is re-exported, as `discover` already re-exports its descriptor). |
| `src/adapters/platform/submitted-bundle.ts` *(new)* | `toSubmittedBundle(bundle): SubmittedBundle` + `BundleDescriptor` synthesis. |
| `src/adapters/platform/mcp-research-platform.adapter.ts` | implement `validateModule` in **both** `McpResearchPlatformAdapter` and `LazyMcpResearchPlatformAdapter`: map bundle → call SDK `validateModule` → unwrap envelope (`ok` → `report`; `!ok` → throw typed `GatewayValidationError`). |
| `src/adapters/platform/mock-research-platform.adapter.ts` | implement `validateModule` → deterministic `accepted` report. |
| `src/adapters/platform/research-contract.ts` *(or new `gateway-errors.ts`)* | `GatewayValidationError` wrapping `{ category, code, message }` from the `ok:false` envelope. |
| `src/adapters/platform/validate-probe.ts` *(new)* | `runValidateProbe(deps)` — orchestrates `discover` (contract gate) → `validateModule`, emits ordered `AgentEvent`s. Mirror of `runDiscoveryProbe`. |
| `scripts/platform-validate.ts` *(new)* | CLI: read a `ModuleBundle` JSON from a file-path arg (or stdin) → run probe → print the `ValidationReport`. No runtime boot, no DB (consistent with `platform-discover.ts`). Artifact-ref resolution is deferred to SP-7.2 (needs DB/runtime). |
| `package.json` | `+ "platform:validate"` script. |
| `src/adapters/platform/*.test.ts`, `submitted-bundle.test.ts`, `validate-probe.test.ts` | tests (see §8). |

## 7. Audit events (new — SP-7 naming)

Ordered, via `AgentEventRepository` / `ConsoleAgentEventSink`:

1. `platform.validate.started` — `{ integration, bundleHash, moduleId }`
2. on success: `platform.validate.completed` — `{ status, errorCount, warningCount }`
   - additionally `platform.validate.rejected` when `status === 'rejected'`
3. on failure: `platform.validate.failed` — `{ error }` (transport or `GatewayError`)
4. reuse `platform.contract.incompatible` on the discover gate.

## 8. Tests

- **`submitted-bundle.test.ts`** — round-trip: base64 fidelity, files sorted by path, per-file `sha256`, `bundleHash`, `kind` mapping (`hypothesis_overlay` → `overlay`), `entryPoint` from `manifest.entry`, path-safety, and `loadBundle`-acceptance (the gateway round-trip pin from §5).
- **`validate-probe.test.ts`** — ordered events for `accepted`, `accepted_with_warnings`, `rejected`, gateway-error (`ok:false`), transport failure, and contract mismatch; mirrors `discovery-probe.test.ts` (mock platform + `ConsoleAgentEventSink`).
- **adapter test** — envelope unwrap: `ok` → report; `!ok` → `GatewayValidationError` thrown with category/code/message.
- **mock adapter** — `validateModule` returns `accepted`, `executed:false`.

## 9. Acceptance criteria

1. `ResearchPlatformPort.validateModule` returns a typed `ValidationReport` (status `accepted` / `accepted_with_warnings` / `rejected` are all valid successes); the probe makes zero submit/run/status/result/artifact calls (`executed:false` holds).
2. `pnpm platform:validate <bundle.json>` against the real MCP gateway returns a real `ValidationReport` for a structurally-valid bundle (a `rejected` status from 017 manifest shortfalls is an accepted SP-7.1 outcome — see §5); against `mock` returns `accepted`. An `ok:false` gateway error occurs only on transport / contract / bundle-load failure, not on manifest content.
3. `AgentEvent`s are emitted in the deterministic order of §7.
4. Contract incompatibility fails closed (bundle never sent).
5. **Zero diff** in `PlatformGatewayPort`, the SP-4 mock backtest flow, and `hypothesisBuildHandler`.
6. All existing tests stay green; new unit tests (§8) pass.

## 10. Forward links

- **SP-7.2** — submit/status/result/artifacts: replaces the mock backtest path in `hypothesisBuildHandler`; promotes `validateModule` to a **pre-submit gate**; introduces persistence of the `ValidationReport` linked to the build (the DB entity intentionally not added here).
- **SP-7.3** — callback resume: wires the async completion callback (the pending real-resume noted in SP-6.2 follow-up).
