# Holdout-Flow Investigation Findings

Date: 2026-07-01  
Task: Task 0 of the Research Holdout Validation plan  
Purpose: Pin three unknowns that the rest of the plan's tasks depend on before writing any production code.

---

## 0.1 — `period.to` inclusivity

**Verdict:** `period.to` is **EXCLUSIVE** (half-open window `[from, to)`).

The backtester's data layer uses a strict half-open interval: bars whose timestamp `ts >= tsTo` are **not** included in the run. A run period ending at `2024-01-15T00:30:00.000Z` includes the bar at `00:29` and excludes the bar at `00:30`.

**Evidence — canonical definition:**
- `trading-backtester/apps/backtester/src/engine/data-adapter.ts:32-33`
  - `OverlayDatasetSelector.period` JSDoc: `/** ISO-8601 half-open window [from, to); parsed via Date.parse to epoch ms. */`
  - Error message at line 75 also uses closing `)`: `[${sel.period.from}, ${sel.period.to})`
  - `queryRange` is called as `queryRange({ tsFrom, tsTo, symbols })` (lines 77–79)

**Evidence — tests:**
- `trading-backtester/apps/backtester/test/cross-repo-historical-e2e.integration.test.ts:36`
  - Comment: `// The golden spans 30 one-minute bars (00:00 → 00:29). period.to is half-open, so 00:30 includes`
- `trading-backtester/apps/backtester/test/overlay-golden.test.ts:49`
  - Test name: `'request window covers all 30 fixture bars (period.to = 00:30 → half-open includes the last bar)'`

**Implication for Task 9 (`encodeTrainPeriod`):** Because `to` is exclusive and the resolver's boundary `T` is the **entryTs of the first holdout trade** (membership rule: a trade is holdout iff `entryTs >= T`), the clean half-open split is:
- train period `{ from, to: T }` → bars `[from, T)` (every bar strictly before `T`; the last train bar is the one just before `T`, NOT dropped),
- holdout period `{ from: T, to: fullTo }` → bars `[T, fullTo)` (the bar at exactly `T` belongs to holdout only).

So `encodeTrainPeriod` passes `to = T` directly — **`PERIOD_TO_INCLUSIVE = false`** (the plan's default branch). Do **NOT** add `+1 bar`: with exclusive `to`, `to = T+1bar` would include the `T` bar in train while holdout (`from: T`) also includes it → the boundary trade is double-counted (leakage). (Correction: an earlier draft of this note suggested `trainEnd + 1 bar` — that is wrong for this boundary definition; `to = T` is correct.)

---

## 0.2 — SDK artifact paging contract

**Source files:**
- `trading-backtester/packages/sdk/src/client/client.ts`
- `trading-backtester/packages/sdk/src/artifacts/types.ts`

### `getArtifactManifest` signature (client.ts line 160)

```typescript
getArtifactManifest(runId: string): Promise<ArtifactManifest>
// GET /v1/runs/{encodeURIComponent(runId)}/artifacts
```

### `readArtifact` signature (client.ts line 164–172)

```typescript
readArtifact(
  runId: string,
  artifactId: string,
  opts: ReadArtifactOptions = {},   // { offset?: number; limit?: number }
): Promise<ArtifactPage>
// GET /v1/runs/{runId}/artifacts/{artifactId}[?offset=N&limit=N]
```

### `ArtifactManifest` shape (types.ts)

```typescript
interface ArtifactManifest {
  readonly runId: string;
  readonly contractVersion: string;
  readonly artifactContractVersion: string;
  readonly descriptors: readonly ArtifactDescriptor[];
}
```

### `ArtifactDescriptor` shape (types.ts) — one entry per artifact type

```typescript
interface ArtifactDescriptor {
  readonly artifactType: string;
  readonly contentHash: ContentHash;   // string alias (the artifactId used in readArtifact)
  readonly availability: ArtifactAvailability;  // 'available' | 'unavailable' | 'not_applicable'
  readonly approxItemCount?: number;
}
```

Note: the plan brief called this the "ArtifactManifest descriptor shape". The actual TS type is `ArtifactDescriptor`. The `contentHash` field is what you pass as `artifactId` to `readArtifact`.

### `ArtifactPage` shape (types.ts)

```typescript
interface ArtifactPage {
  readonly artifactId: ContentHash;
  readonly artifactType: string;
  readonly page: readonly unknown[];   // typed array items for the concrete artifact type
  readonly total: number;
  readonly offset: number;
  readonly nextCursor?: string;
}
```

### Concrete client injection in lab

`trading-lab/src/adapters/platform/select-research-platform.ts` (full file, ~20 lines):

```typescript
// When integration === 'backtester':
return new HttpBacktesterAdapter(
  new BacktesterClient({
    baseUrl: process.env.BACKTESTER_API_URL ?? 'http://127.0.0.1:8080',
    token: process.env.BACKTESTER_API_TOKEN ?? '',
  }),
);
```

`BacktesterClient` is imported from `@trading-backtester/sdk/client`. No `fetchImpl` is injected in production (uses `globalThis.fetch`). The `HttpBacktesterAdapter` wraps the client to implement `ResearchPlatformPort`.

---

## 0.3 — `runOverlayBacktest` / `pollOverlayRun` signatures + new-strategy discriminator

### `PlatformRunOutcome` union (src/research/run-backtest.ts lines 9–13)

```typescript
export type PlatformRunOutcome =
  | { readonly status: 'completed'; readonly runId: string; readonly summary: RunResultSummary; readonly artifactIds: readonly string[] }
  | { readonly status: 'pending'; readonly runId: string }
  | { readonly status: 'rejected'; readonly runId: string; readonly terminalCode?: string };
```

The `completed` branch carries:
- `runId: string` — the platform run ID
- `summary: RunResultSummary` — the full run result (contains `comparison`, `artifactRefs`, etc. at the port level)
- `artifactIds: readonly string[]` — extracted from `summary.artifactRefs.map(r => r.artifactId)`

### `pollOverlayRun` signature (run-backtest.ts lines 18–19)

```typescript
export async function pollOverlayRun(
  platform: ResearchPlatformPort,
  runId: string,
  poll: PollOptions,   // { maxPolls: number; pollDelayMs: number; sleep?: (ms) => Promise<void> }
): Promise<PlatformRunOutcome>
```

### `runOverlayBacktest` signature (run-backtest.ts lines 41–46)

```typescript
export async function runOverlayBacktest(
  platform: ResearchPlatformPort,
  bundle: ModuleBundle,
  opts: SubmitOverlayRunOptions,
  poll: PollOptions,
): Promise<PlatformRunOutcome>
```

### Discriminator: initial new-strategy validation vs. hypothesis-retry / Cycle-2

**Field:** `payload.cycleDepth` in the `hypothesis.build` task payload.

**Location:**
- `trading-lab/src/orchestrator/handlers/hypothesis-build.handler.ts:26`
  - `HypothesisBuildPayloadSchema`: `cycleDepth: z.number().int().min(0).default(0)`
- `trading-lab/src/orchestrator/handlers/backtest-completed.handler.ts:43`
  - Retries enqueue `research.run_cycle` with `cycleDepth: nextCycleDepth` (`= cycleDepth + 1`)

**Rule:**
- `payload.cycleDepth === 0` → **initial new-strategy validation** build (Task 13 must reroute to holdout path here)
- `payload.cycleDepth >= 1` → **hypothesis-retry / Cycle-2** build (existing path, no holdout reroute)

The discriminator is set by the enqueueing caller: the initial `research.run_cycle` task always uses `cycleDepth: 0` (default); `backtestCompletedHandler` increments to 1, 2, ... up to `MAX_CYCLE_DEPTH = 2`.

### `BacktestRunRepository` method signatures (src/ports/backtest-run.repository.ts)

```typescript
export interface BacktestRunRepository {
  createSubmitted(run: BacktestRun): Promise<void>;
  markCompleted(id: string, completion: BacktestCompletion): Promise<void>;
  markRejected(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
  markEvaluated(id: string): Promise<void>;
  findById(id: string): Promise<BacktestRun | null>;
  /** Lookup by platform/backtester run id (webhook callback + resume). */
  findByPlatformRunId(platformRunId: string): Promise<BacktestRun | null>;
  /** Identity lookup powering pre-submit idempotency (matches the DB unique key). */
  findByIdentity(hypothesisId: string, paramsHash: string, bundleHash: string): Promise<BacktestRun | null>;
  listByHypothesis(hypothesisId: string): Promise<BacktestRun[]>;
  /** Pending platform-backed runs eligible for resume: status='submitted' AND backend='research_platform'. */
  listResumablePlatformRuns(): Promise<BacktestRun[]>;
}
```

---

## 0.4 — Extras: `computeParamsHash` + `SDK_CONTRACT_VERSION`

### `computeParamsHash` exact signature (src/orchestrator/handlers/backtest-support.ts lines 38–49)

```typescript
export function computeParamsHash(
  params: Record<string, unknown>,
  ctx: { platformRun: PlatformRunConfig; baselineRef: Ref },
): string
```

The hash is `sha256(stableStringify({ backend, params, baseline, platformRun }))` where:
- `platformRun` is normalized: `{ datasetId, symbols: [...sorted], timeframe, period: { from, to }, seed }`
- `baseline` is `{ id: baselineRef.id, version: baselineRef.version }`

Called in `hypothesis-build.handler.ts` as:
```typescript
const paramsHash = computeParamsHash(params, { platformRun: payload.platformRun!, baselineRef });
```

### `SDK_CONTRACT_VERSION` location

**File:** `trading-lab/src/domain/module-bundle.ts` (confirmed — matches the plan's assumption)

```typescript
export const MODULE_BUNDLE_CONTRACT_VERSION = 'module-bundle-v1';
export const SDK_CONTRACT_VERSION = 'builder-sdk-v0';
```

Both constants are exported from `src/domain/module-bundle.ts` and imported in `hypothesis-build.handler.ts`:
```typescript
import { assembleBundle, SDK_CONTRACT_VERSION, MODULE_BUNDLE_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
```
