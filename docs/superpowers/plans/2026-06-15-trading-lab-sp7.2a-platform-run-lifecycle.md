# SP-7.2a — Platform-backed Backtest Lifecycle Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the platform run lifecycle (`submitOverlayRun`/`getRunStatus`/`getRunResult`) to `ResearchPlatformPort` + a `submitted_overlay` request mapper + a bounded-poll orchestration + a pure `RunResultSummary`→`ComparisonSummary` mapper, exercised by a standalone `platform:run` probe — offline-testable via the mock adapter; SP-4 path/handler/persistence untouched.

**Architecture:** `ResearchPlatformPort` stays the thin SDK boundary (re-exports the SDK lifecycle types + `isTerminal`). mcp adapter assembles the `submitted_overlay` `ControlledRunRequest` and unwraps `{ok,...}` (throws `GatewayRunError`). Pure lab modules — `src/domain/platform-comparison.ts` (mapper, 7→9, 3-case `profit_factor`) and `src/research/run-backtest.ts` (submit → bounded `getRunStatus` loop → result → outcome) — import SDK types only via the port re-export, keeping the SDK-import guard green.

**Tech Stack:** TypeScript (strict, ESM, `node --experimental-strip-types`), Vitest, vendored `@trading-platform/sdk@0.3.0`.

---

## Reference patterns (read these existing files first)

- Probe: `src/adapters/platform/validate-probe.ts` (`runValidateProbe`, `mkEvent`, contract gate via `platform.discover()` catching `ContractIncompatibleError`, ordered `platform.validate.*` events). Model `run-probe.ts` on it.
- CLI: `scripts/platform-validate.ts` (read bundle JSON, `loadResearchPlatformConfig`/`createGatewayTransport`/`withTimeout` from `mcp-research-transport.ts`, `ConsoleAgentEventSink`, print result). Model `scripts/platform-run.ts` on it.
- Errors: `src/adapters/platform/gateway-errors.ts` (`GatewayValidationError`). Model `GatewayRunError` on it.
- Adapter: `src/adapters/platform/mcp-research-platform.adapter.ts` (`McpResearchPlatformAdapter` + `LazyMcpResearchPlatformAdapter`, `toSubmittedBundle`, `validateModule` building a `ModuleSelector`). Extend both.
- Mock: `src/adapters/platform/mock-research-platform.adapter.ts` (`MockResearchPlatformAdapter`). Extend.
- `AgentEvent`/`AgentEventRepository`: `src/ports/agent-event.repository.ts`. `ComparisonSummary`/`BacktestMetricBlock`: `src/ports/platform-gateway.port.ts`. Guard: `src/adapters/platform/sdk-import-boundary.guard.test.ts`.

## File Structure

- Modify `src/ports/research-platform.port.ts` — `PlatformRunConfig`, `SubmitOverlayRunOptions`, `RunResultView`; lifecycle methods; re-export SDK `RunJobHandle`/`RunStatusView`/`RunResultResult`/`RunResultSummary`/`ComparisonSummaryDTO`/`Ref` + `isTerminal`.
- Modify `src/adapters/platform/gateway-errors.ts` — add `GatewayRunError`.
- Create `src/domain/platform-comparison.ts` — `mapPlatformComparison`, `MetricMappingError`, `NO_LOSS_PROFIT_FACTOR`, `INITIAL_EQUITY`, `RESEARCH_RUN_METRICS`.
- Create `src/domain/platform-comparison.test.ts`.
- Modify `src/adapters/platform/mock-research-platform.adapter.ts` — lifecycle methods (canned completed run).
- Modify `src/adapters/platform/mcp-research-platform.adapter.ts` — lifecycle methods on `McpResearchPlatformAdapter` + `LazyMcpResearchPlatformAdapter`.
- Create `src/research/run-backtest.ts` — `runOverlayBacktest`, `PlatformRunOutcome`, `PollOptions`.
- Create `src/research/run-backtest.test.ts`.
- Create `src/adapters/platform/run-probe.ts` — `runBacktestProbe`.
- Create `src/adapters/platform/run-probe.test.ts`.
- Create `scripts/platform-run.ts`; Modify `package.json` (`platform:run`).

---

## Task 1: Mapper — `mapPlatformComparison` (pure, the core)

**Files:** Create `src/domain/platform-comparison.ts`, `src/domain/platform-comparison.test.ts`; Modify `src/ports/research-platform.port.ts` (re-export `RunResultSummary`, `ComparisonSummaryDTO`).

- [ ] **Step 1: Re-export the SDK result types from the port**

In `src/ports/research-platform.port.ts`, extend the existing SDK type import + re-export block to include `RunResultSummary` and `ComparisonSummaryDTO`:

```ts
import type {
  ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult,
  ValidationReport, ValidationIssueDTO,
  RunResultSummary, ComparisonSummaryDTO,
} from '@trading-platform/sdk/agent';

export type {
  ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult,
  ValidationReport, ValidationIssueDTO,
  RunResultSummary, ComparisonSummaryDTO,
};
```

- [ ] **Step 2: Write the failing mapper test**

Create `src/domain/platform-comparison.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { RunResultSummary } from '../ports/research-platform.port.ts';
import { mapPlatformComparison, MetricMappingError, NO_LOSS_PROFIT_FACTOR } from './platform-comparison.ts';

const M = ['pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades', 'profit_factor', 'top_trade_contribution_pct'] as const;

function summary(baseline: Record<string, number>, variant: Record<string, number>, topMetrics?: Record<string, number>): RunResultSummary {
  return {
    runId: 'r1', status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
    metrics: topMetrics ?? baseline,
    comparison: {
      baseline, variant,
      deltas: Object.fromEntries(Object.keys(variant).map((k) => [k, variant[k] - (baseline[k] ?? 0)])),
    },
    coverage: [], artifactRefs: [],
    evidence: { seed: 1, contractVersion: '017.2', moduleVersions: [] },
  } as RunResultSummary;
}

const full = (pf: number) => ({ pnl: 1200, sharpe: 1.4, max_drawdown: 0.12, win_rate: 0.55, total_trades: 40, profit_factor: pf, top_trade_contribution_pct: 30 });

describe('mapPlatformComparison', () => {
  it('maps the 7 metrics into the 9-field BacktestMetricBlock (max_drawdown ×100; derives netPnlPct/expectancyUsd)', () => {
    const c = mapPlatformComparison(summary(full(1.8), full(2.2)));
    expect(c.variant.netPnlUsd).toBe(1200);
    expect(c.variant.maxDrawdownPct).toBeCloseTo(12);            // 0.12 * 100
    expect(c.variant.winRate).toBe(0.55);
    expect(c.variant.sharpe).toBe(1.4);
    expect(c.variant.totalTrades).toBe(40);
    expect(c.variant.topTradeContributionPct).toBe(30);
    expect(c.variant.profitFactor).toBe(2.2);
    expect(c.variant.netPnlPct).toBeCloseTo(12);                 // 1200 / 10000 * 100
    expect(c.variant.expectancyUsd).toBeCloseTo(30);             // 1200 / 40
    expect(c.sampleSize).toEqual({ baselineTrades: 40, variantTrades: 40 });
    expect(c.platformContractVersion).toBe('017.2');
  });

  it('profit_factor case 2: comparison omits it but summary.metrics (baseline) has it → baseline real, variant sentinel', () => {
    const b = full(1.8); const v = full(0); delete (v as Record<string, number>).profit_factor; delete (b as Record<string, number>).profit_factor;
    const c = mapPlatformComparison(summary(b, v, { ...full(1.8) }));   // top-level metrics keeps baseline profit_factor
    expect(c.baseline.profitFactor).toBe(1.8);
    expect(c.variant.profitFactor).toBe(NO_LOSS_PROFIT_FACTOR);
  });

  it('profit_factor case 3: comparison AND summary.metrics both omit it → MetricMappingError ambiguous_profit_factor', () => {
    const b = full(0); const v = full(0);
    [b, v].forEach((m) => delete (m as Record<string, number>).profit_factor);
    const top = { ...full(0) }; delete (top as Record<string, number>).profit_factor;
    expect(() => mapPlatformComparison(summary(b, v, top))).toThrowError(/ambiguous_profit_factor/);
  });

  it('a missing required metric → MetricMappingError missing_metric', () => {
    const b = full(1.8); const v = full(2.2); delete (v as Record<string, number>).sharpe;
    expect(() => mapPlatformComparison(summary(b, v))).toThrowError(/missing_metric/);
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `pnpm test -- src/domain/platform-comparison.test.ts`
Expected: FAIL — `Cannot find module './platform-comparison.ts'`.

- [ ] **Step 4: Implement the mapper**

Create `src/domain/platform-comparison.ts`:

```ts
import type { RunResultSummary } from '../ports/research-platform.port.ts';
import type { BacktestMetricBlock, ComparisonSummary } from '../ports/platform-gateway.port.ts';

/** Metric names requested from the platform (038 catalog) so the comparison carries the full set. */
export const RESEARCH_RUN_METRICS = ['pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades', 'profit_factor', 'top_trade_contribution_pct'] as const;

/** Platform initial equity (data-model §6) — used to derive netPnlPct from absolute pnl. */
export const INITIAL_EQUITY = 10_000;

/** Sentinel profit factor for "no losing trades" (platform omits profit_factor when absGrossLoss==0).
 *  High finite value that passes the evaluator's minProfitFactor gate; "no losses" is a strong edge. */
export const NO_LOSS_PROFIT_FACTOR = 1_000_000;

export class MetricMappingError extends Error {
  readonly code: 'missing_metric' | 'ambiguous_profit_factor';
  constructor(code: 'missing_metric' | 'ambiguous_profit_factor', message: string) {
    super(message);
    this.name = 'MetricMappingError';
    this.code = code;
  }
}

const REQUIRED = ['pnl', 'max_drawdown', 'win_rate', 'sharpe', 'total_trades', 'top_trade_contribution_pct'] as const;

function block(side: 'baseline' | 'variant', m: Record<string, number>, profitFactor: number): BacktestMetricBlock {
  for (const name of REQUIRED) {
    if (!(name in m)) throw new MetricMappingError('missing_metric', `${side} comparison is missing required metric '${name}'`);
  }
  const netPnlUsd = m.pnl;
  const totalTrades = m.total_trades;
  return {
    netPnlUsd,
    netPnlPct: (netPnlUsd / INITIAL_EQUITY) * 100,
    totalTrades,
    winRate: m.win_rate,
    profitFactor,
    maxDrawdownPct: m.max_drawdown * 100,
    expectancyUsd: totalTrades > 0 ? netPnlUsd / totalTrades : 0,
    sharpe: m.sharpe,
    topTradeContributionPct: m.top_trade_contribution_pct,
  };
}

/** Resolve baseline/variant profitFactor per the 3-case rule (comparison carries baseline∩variant;
 *  summary.metrics is the baseline's FULL metric set). */
function resolveProfitFactors(
  baseline: Record<string, number>,
  variant: Record<string, number>,
  topMetrics: Record<string, number>,
): { baselinePf: number; variantPf: number } {
  if ('profit_factor' in baseline && 'profit_factor' in variant) {
    return { baselinePf: baseline.profit_factor, variantPf: variant.profit_factor };
  }
  if ('profit_factor' in topMetrics) {
    // baseline had losses (finite PF in its full metrics); comparison dropped it → variant omitted (no losses).
    return { baselinePf: topMetrics.profit_factor, variantPf: NO_LOSS_PROFIT_FACTOR };
  }
  throw new MetricMappingError(
    'ambiguous_profit_factor',
    'profit_factor absent from comparison and from baseline summary.metrics; cannot disambiguate variant PF',
  );
}

export function mapPlatformComparison(summary: RunResultSummary): ComparisonSummary {
  const comparison = summary.comparison;
  if (comparison === undefined) {
    throw new MetricMappingError('missing_metric', 'RunResultSummary has no comparison (not a baseline-vs-variant run)');
  }
  const baseline = comparison.baseline as Record<string, number>;
  const variant = comparison.variant as Record<string, number>;
  const topMetrics = summary.metrics as Record<string, number>;
  const { baselinePf, variantPf } = resolveProfitFactors(baseline, variant, topMetrics);
  return {
    baseline: block('baseline', baseline, baselinePf),
    variant: block('variant', variant, variantPf),
    sampleSize: { baselineTrades: baseline.total_trades, variantTrades: variant.total_trades },
    platformContractVersion: summary.evidence.contractVersion,
  };
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm test -- src/domain/platform-comparison.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/domain/platform-comparison.ts src/domain/platform-comparison.test.ts src/ports/research-platform.port.ts
git commit -m "feat(sp7.2a): mapPlatformComparison — 7 platform metrics -> 9-field BacktestMetricBlock (3-case profit_factor)"
```

---

## Task 2: `GatewayRunError`

**Files:** Modify `src/adapters/platform/gateway-errors.ts`.

- [ ] **Step 1: Add the error class**

Append to `src/adapters/platform/gateway-errors.ts` (mirrors `GatewayValidationError`):

```ts
/** Thrown when a run-lifecycle gateway call returns an `ok:false` envelope. */
export class GatewayRunError extends Error {
  readonly category: GatewayError['category'];
  readonly code: string;
  constructor(error: GatewayError) {
    super(`gateway ${error.category}/${error.code}: ${error.message}`);
    this.name = 'GatewayRunError';
    this.category = error.category;
    this.code = error.code;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean (no usage yet; the class compiles).

- [ ] **Step 3: Commit**

```bash
git add src/adapters/platform/gateway-errors.ts
git commit -m "feat(sp7.2a): GatewayRunError for ok:false run-lifecycle envelopes"
```

---

## Task 3: Port lifecycle surface + adapter implementations

**Files:** Modify `src/ports/research-platform.port.ts`, `src/adapters/platform/mock-research-platform.adapter.ts`, `src/adapters/platform/mcp-research-platform.adapter.ts`. Test: `src/adapters/platform/mock-research-platform.lifecycle.test.ts`.

Adding methods to the `ResearchPlatformPort` interface breaks both adapters until they implement them — do the interface + both adapters in this one task so typecheck stays green.

- [ ] **Step 1: Write the failing mock-adapter lifecycle test**

Create `src/adapters/platform/mock-research-platform.lifecycle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

const bundle = { manifest: { moduleId: 'm1' }, files: { 'index.ts': '' }, bundleHash: 'sha256:x', bundleContractVersion: '1' } as unknown as ModuleBundle;
const opts = { baselineModuleRef: { id: 'strategy:p1', version: '1.0.0' }, run: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-12-31' }, seed: 7 } };

describe('MockResearchPlatformAdapter lifecycle', () => {
  it('submitOverlayRun returns a handle, getRunResult returns a completed baseline-vs-variant summary', async () => {
    const a = new MockResearchPlatformAdapter();
    const handle = await a.submitOverlayRun(bundle, opts);
    expect(handle.runId).toBeTruthy();
    const status = await a.getRunStatus(handle.runId);
    expect(status.status).toBe('completed');
    const res = await a.getRunResult(handle.runId);
    expect(res.kind).toBe('summary');
    if (res.kind === 'summary') {
      expect(res.summary.status).toBe('completed');
      expect(res.summary.comparison).toBeDefined();
      for (const k of ['pnl', 'max_drawdown', 'win_rate', 'sharpe', 'total_trades', 'profit_factor', 'top_trade_contribution_pct']) {
        expect(res.summary.comparison!.variant).toHaveProperty(k);
      }
    }
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test -- src/adapters/platform/mock-research-platform.lifecycle.test.ts`
Expected: FAIL — `submitOverlayRun` is not a function (and typecheck errors on the interface).

- [ ] **Step 3: Extend the port interface + types + re-exports**

In `src/ports/research-platform.port.ts` add (alongside the Task-1 re-exports):

```ts
import type { RunJobHandle, RunStatusView, RunResultResult, Ref } from '@trading-platform/sdk/agent';
import { isTerminal } from '@trading-platform/sdk/agent';
export type { RunJobHandle, RunStatusView, RunResultResult, Ref };
export { isTerminal };

/** ok:true subset of the SDK getRunResult union. */
export type RunResultView = Extract<RunResultResult, { ok: true }>;

export interface PlatformRunConfig {
  readonly datasetId: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly seed: number;
}
export interface SubmitOverlayRunOptions {
  readonly baselineModuleRef: Ref;
  readonly run: PlatformRunConfig;
  readonly correlationId?: string;
  readonly resumeToken?: string;
  readonly workflowId?: string;
}
```

Add the three methods to the `ResearchPlatformPort` interface:

```ts
  submitOverlayRun(bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle>;
  getRunStatus(runId: string): Promise<RunStatusView>;
  getRunResult(runId: string): Promise<RunResultView>;
```

- [ ] **Step 4: Implement the lifecycle on the mock adapter**

In `src/adapters/platform/mock-research-platform.adapter.ts`, add imports + methods. Use a single canned completed summary keyed by runId:

```ts
import { randomUUID } from 'node:crypto';
import type {
  // ...existing...
  SubmitOverlayRunOptions, RunJobHandle, RunStatusView, RunResultView, RunResultSummary,
} from '../../ports/research-platform.port.ts';

// ...inside the class:
private cannedSummary(runId: string): RunResultSummary {
  const m = { pnl: 1500, sharpe: 1.6, max_drawdown: 0.14, win_rate: 0.58, total_trades: 42, profit_factor: 2.1, top_trade_contribution_pct: 28 };
  const baseline = { ...m, pnl: 800, profit_factor: 1.5 };
  return {
    runId, status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
    metrics: baseline,
    comparison: { baseline, variant: m, deltas: Object.fromEntries(Object.keys(m).map((k) => [k, (m as Record<string, number>)[k] - (baseline as Record<string, number>)[k]])) },
    coverage: [], artifactRefs: [], evidence: { seed: opts?.run.seed ?? 0, contractVersion: CONTRACT_VERSION, moduleVersions: [] },
  } as RunResultSummary;
}
async submitOverlayRun(_bundle: ModuleBundle, _opts: SubmitOverlayRunOptions): Promise<RunJobHandle> {
  const runId = randomUUID();
  return { jobId: randomUUID(), runId, status: 'accepted', effectiveSeed: _opts.run.seed, requestFingerprint: 'mock', idempotentReplay: false };
}
async getRunStatus(runId: string): Promise<RunStatusView> {
  return { jobId: 'mock', runId, status: 'completed', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } };
}
async getRunResult(runId: string): Promise<RunResultView> {
  return { ok: true, kind: 'summary', summary: this.cannedSummary(runId) };
}
```

(Adjust the `cannedSummary` `seed`/`opts` closure to a module-level helper if simpler — it must not reference `opts` outside `submitOverlayRun`; use a fixed seed in the canned summary.)

- [ ] **Step 5: Implement the lifecycle on the mcp adapters**

In `src/adapters/platform/mcp-research-platform.adapter.ts`, import the SDK workflow fns + DTOs and `RESEARCH_RUN_METRICS`:

```ts
import { discover, listDatasets, validateModule, submitRun, getRunStatus as sdkGetRunStatus, getRunResult as sdkGetRunResult } from '@trading-platform/sdk/agent';
import type { ControlledRunRequest } from '@trading-platform/sdk/agent';
import { GatewayRunError } from './gateway-errors.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import type { SubmitOverlayRunOptions, RunJobHandle, RunStatusView, RunResultView } from '../../ports/research-platform.port.ts';
```

On `McpResearchPlatformAdapter` add:

```ts
async submitOverlayRun(bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle> {
  const request: ControlledRunRequest = {
    datasetRef: { datasetId: opts.run.datasetId },
    module: { kind: 'submitted_overlay', bundle: toSubmittedBundle(bundle), baselineModuleRef: opts.baselineModuleRef },
    symbols: opts.run.symbols,
    timeframe: opts.run.timeframe,
    period: opts.run.period,
    seed: opts.run.seed,
    mode: 'research',
    metrics: [...RESEARCH_RUN_METRICS],
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
    ...(opts.resumeToken !== undefined ? { resumeToken: opts.resumeToken } : {}),
    ...(opts.workflowId !== undefined ? { workflowId: opts.workflowId } : {}),
  };
  const result = await submitRun(this.transport, request);
  if (!result.ok) throw new GatewayRunError(result.error);
  return result.handle;
}
async getRunStatus(runId: string): Promise<RunStatusView> {
  const result = await sdkGetRunStatus(this.transport, runId);
  if (!result.ok) throw new GatewayRunError(result.error);
  return result.view;
}
async getRunResult(runId: string): Promise<RunResultView> {
  const result = await sdkGetRunResult(this.transport, runId);
  if (!result.ok) throw new GatewayRunError(result.error);
  return result;
}
```

On `LazyMcpResearchPlatformAdapter` add the three delegating methods (open session → delegate to a `McpResearchPlatformAdapter` → close), mirroring its existing `validateModule`.

- [ ] **Step 6: Run the mock lifecycle test + typecheck**

Run: `pnpm test -- src/adapters/platform/mock-research-platform.lifecycle.test.ts && pnpm typecheck`
Expected: PASS (1 test) and typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/ports/research-platform.port.ts src/adapters/platform/mock-research-platform.adapter.ts src/adapters/platform/mcp-research-platform.adapter.ts src/adapters/platform/mock-research-platform.lifecycle.test.ts
git commit -m "feat(sp7.2a): ResearchPlatformPort run lifecycle + mock/mcp/lazy adapters (submitted_overlay request assembly)"
```

---

## Task 4: Orchestration — `runOverlayBacktest`

**Files:** Create `src/research/run-backtest.ts`, `src/research/run-backtest.test.ts`.

- [ ] **Step 1: Write the failing orchestration test (fake port; completed / pending / rejected)**

Create `src/research/run-backtest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runOverlayBacktest } from './run-backtest.ts';
import type { ResearchPlatformPort, RunStatusView, RunResultView, RunJobHandle, SubmitOverlayRunOptions } from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';

const bundle = {} as ModuleBundle;
const opts = { baselineModuleRef: { id: 'strategy:p1', version: '1.0.0' }, run: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-12-31' }, seed: 7 } } satisfies SubmitOverlayRunOptions;
const noSleep = async () => {};
const handle: RunJobHandle = { jobId: 'j', runId: 'r', status: 'accepted', effectiveSeed: 7, requestFingerprint: 'f', idempotentReplay: false };

function fakePort(statuses: RunStatusView['status'][], result: RunResultView): ResearchPlatformPort {
  let i = 0;
  return {
    discover: async () => ({}) as never, listDatasets: async () => ({ datasets: [] }), validateModule: async () => ({ status: 'accepted', issues: [], executed: false }),
    submitOverlayRun: async () => handle,
    getRunStatus: async () => ({ jobId: 'j', runId: 'r', status: statuses[Math.min(i++, statuses.length - 1)], timeline: { acceptedAtMs: 0 } }),
    getRunResult: async () => result,
  } as unknown as ResearchPlatformPort;
}

const completed: RunResultView = { ok: true, kind: 'summary', summary: { runId: 'r', status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [], metrics: {}, comparison: { baseline: {}, variant: {}, deltas: {} }, coverage: [], artifactRefs: [{ artifactId: 'sha256:a', artifactType: 'metrics', availability: { status: 'available' } }], evidence: { seed: 7, contractVersion: '017.2', moduleVersions: [] } } } as unknown as RunResultView;

describe('runOverlayBacktest', () => {
  it('completed: polls to terminal then returns a completed outcome with artifact IDs', async () => {
    const out = await runOverlayBacktest(fakePort(['queued', 'running', 'completed'], completed), bundle, opts, { maxPolls: 5, pollDelayMs: 0, sleep: noSleep });
    expect(out.status).toBe('completed');
    if (out.status === 'completed') { expect(out.runId).toBe('r'); expect(out.artifactIds).toEqual(['sha256:a']); expect(out.summary.status).toBe('completed'); }
  });
  it('pending: poll budget exhausted without a terminal status', async () => {
    const out = await runOverlayBacktest(fakePort(['running'], completed), bundle, opts, { maxPolls: 3, pollDelayMs: 0, sleep: noSleep });
    expect(out.status).toBe('pending');
  });
  it('rejected: terminal non-completed status', async () => {
    const failed: RunResultView = { ok: true, kind: 'status', view: { jobId: 'j', runId: 'r', status: 'failed', timeline: { acceptedAtMs: 0 }, terminalCode: 'runner_failure' } } as unknown as RunResultView;
    const out = await runOverlayBacktest(fakePort(['failed'], failed), bundle, opts, { maxPolls: 3, pollDelayMs: 0, sleep: noSleep });
    expect(out.status).toBe('rejected');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test -- src/research/run-backtest.test.ts`
Expected: FAIL — `Cannot find module './run-backtest.ts'`.

- [ ] **Step 3: Implement the orchestration**

Create `src/research/run-backtest.ts`:

```ts
import { isTerminal } from '../ports/research-platform.port.ts';
import type { ResearchPlatformPort, SubmitOverlayRunOptions, RunResultSummary } from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';

export interface PollOptions {
  readonly maxPolls: number;
  readonly pollDelayMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type PlatformRunOutcome =
  | { readonly status: 'completed'; readonly runId: string; readonly summary: RunResultSummary; readonly artifactIds: readonly string[] }
  | { readonly status: 'pending'; readonly runId: string }
  | { readonly status: 'rejected'; readonly runId: string; readonly terminalCode?: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runOverlayBacktest(
  platform: ResearchPlatformPort,
  bundle: ModuleBundle,
  opts: SubmitOverlayRunOptions,
  poll: PollOptions,
): Promise<PlatformRunOutcome> {
  const sleep = poll.sleep ?? realSleep;
  const handle = await platform.submitOverlayRun(bundle, opts);
  const runId = handle.runId;

  let terminal = false;
  for (let i = 0; i < poll.maxPolls; i += 1) {
    const view = await platform.getRunStatus(runId);
    if (isTerminal(view.status)) { terminal = true; break; }
    if (i < poll.maxPolls - 1) await sleep(poll.pollDelayMs);
  }
  if (!terminal) return { status: 'pending', runId };

  const res = await platform.getRunResult(runId);
  if (res.kind === 'summary' && res.summary.status === 'completed' && res.summary.comparison !== undefined) {
    return { status: 'completed', runId, summary: res.summary, artifactIds: res.summary.artifactRefs.map((r) => r.artifactId) };
  }
  const terminalCode = res.kind === 'status' ? res.view.terminalCode : undefined;
  return { status: 'rejected', runId, ...(terminalCode !== undefined ? { terminalCode } : {}) };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm test -- src/research/run-backtest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/research/run-backtest.ts src/research/run-backtest.test.ts
git commit -m "feat(sp7.2a): runOverlayBacktest orchestration (submit -> bounded getRunStatus poll -> result)"
```

---

## Task 5: Probe — `runBacktestProbe`

**Files:** Create `src/adapters/platform/run-probe.ts`, `src/adapters/platform/run-probe.test.ts`.

- [ ] **Step 1: Write the failing probe test (mock adapter + in-memory event sink)**

Create `src/adapters/platform/run-probe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runBacktestProbe } from './run-probe.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

class InMemoryEvents implements AgentEventRepository {
  readonly events: AgentEvent[] = [];
  async append(e: AgentEvent): Promise<void> { this.events.push(e); }
  async listByTask(): Promise<AgentEvent[]> { return this.events; }
}

const bundle = { manifest: { moduleId: 'm1' }, files: {}, bundleHash: 'sha256:x', bundleContractVersion: '1' } as unknown as ModuleBundle;
const opts = { baselineModuleRef: { id: 'strategy:p1', version: '1.0.0' }, run: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-12-31' }, seed: 7 } };

describe('runBacktestProbe', () => {
  it('drives the mock lifecycle to a completed comparison and emits ordered platform.run.* events', async () => {
    const events = new InMemoryEvents();
    const { outcome, comparison } = await runBacktestProbe({
      platform: new MockResearchPlatformAdapter(), events, probeId: 'probe:1', integration: 'mock', bundle, opts,
      poll: { maxPolls: 3, pollDelayMs: 0, sleep: async () => {} },
    });
    expect(outcome.status).toBe('completed');
    expect(comparison).toBeDefined();
    expect(comparison!.variant.totalTrades).toBeGreaterThan(0);
    const types = events.events.map((e) => e.type);
    expect(types).toContain('platform.run.started');
    expect(types).toContain('platform.run.submitted');
    expect(types).toContain('platform.run.completed');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test -- src/adapters/platform/run-probe.test.ts`
Expected: FAIL — `Cannot find module './run-probe.ts'`.

- [ ] **Step 3: Implement the probe** (model on `validate-probe.ts`)

Create `src/adapters/platform/run-probe.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';
import type { ResearchPlatformPort, SubmitOverlayRunOptions } from '../../ports/research-platform.port.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';
import { ContractIncompatibleError } from './research-contract.ts';
import { runOverlayBacktest, type PollOptions, type PlatformRunOutcome } from '../../research/run-backtest.ts';
import { mapPlatformComparison } from '../../domain/platform-comparison.ts';

export interface RunProbeDeps {
  platform: ResearchPlatformPort;
  events: AgentEventRepository;
  probeId: string;
  integration: string;
  bundle: ModuleBundle;
  opts: SubmitOverlayRunOptions;
  poll: PollOptions;
}
export interface RunProbeResult {
  outcome: PlatformRunOutcome;
  comparison?: ComparisonSummary;
}

function mkEvent(taskId: string, type: string, payload: Record<string, unknown>): AgentEvent {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runBacktestProbe(deps: RunProbeDeps): Promise<RunProbeResult> {
  const { platform, events, probeId, integration, bundle, opts, poll } = deps;
  await events.append(mkEvent(probeId, 'platform.run.started', { integration, bundleHash: bundle.bundleHash, baselineModuleRef: opts.baselineModuleRef }));
  try {
    await platform.discover();
  } catch (err) {
    if (err instanceof ContractIncompatibleError) {
      await events.append(mkEvent(probeId, 'platform.contract.incompatible', { expected: err.expected, actual: err.actual, supported: [...err.supported] }));
    }
    await events.append(mkEvent(probeId, 'platform.run.failed', { error: errMsg(err) }));
    throw err;
  }

  let outcome: PlatformRunOutcome;
  try {
    outcome = await runOverlayBacktest(platform, bundle, opts, poll);
  } catch (err) {
    await events.append(mkEvent(probeId, 'platform.run.failed', { error: errMsg(err) }));
    throw err;
  }
  await events.append(mkEvent(probeId, 'platform.run.submitted', { runId: outcome.runId }));

  if (outcome.status === 'pending') {
    await events.append(mkEvent(probeId, 'platform.run.pending', { runId: outcome.runId }));
    return { outcome };
  }
  if (outcome.status === 'rejected') {
    await events.append(mkEvent(probeId, 'platform.run.rejected', { runId: outcome.runId, terminalCode: outcome.terminalCode }));
    return { outcome };
  }
  const comparison = mapPlatformComparison(outcome.summary);
  await events.append(mkEvent(probeId, 'platform.run.completed', {
    runId: outcome.runId, artifactIds: outcome.artifactIds,
    deltaNetPnlUsd: comparison.variant.netPnlUsd - comparison.baseline.netPnlUsd,
  }));
  return { outcome, comparison };
}
```

(Note: the `platform.run.submitted` event is emitted after `runOverlayBacktest` returns the runId; if you prefer it strictly before polling, thread the handle out — acceptable either way for the probe.)

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm test -- src/adapters/platform/run-probe.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/run-probe.ts src/adapters/platform/run-probe.test.ts
git commit -m "feat(sp7.2a): runBacktestProbe (ordered platform.run.* events + mapped ComparisonSummary)"
```

---

## Task 6: CLI + full verification

**Files:** Create `scripts/platform-run.ts`; Modify `package.json`.

- [ ] **Step 1: Create the CLI** (model on `scripts/platform-validate.ts`)

Create `scripts/platform-run.ts`:

```ts
// scripts/platform-run.ts
// platform:run — submitted_overlay run lifecycle probe. No runtime boot, no DB.
// Usage: platform:run <bundle.json|-> <runconfig.json>  (run config: {datasetId,symbols,timeframe,period,seed,baselineModuleRef})
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadResearchPlatformConfig, createGatewayTransport, withTimeout, type GatewaySession } from '../src/adapters/platform/mcp-research-transport.ts';
import { McpResearchPlatformAdapter } from '../src/adapters/platform/mcp-research-platform.adapter.ts';
import { ConsoleAgentEventSink } from '../src/adapters/platform/console-agent-event-sink.ts';
import { runBacktestProbe } from '../src/adapters/platform/run-probe.ts';
import type { ModuleBundle } from '../src/domain/module-bundle.ts';
import type { SubmitOverlayRunOptions } from '../src/ports/research-platform.port.ts';

function readJson<T>(arg: string | undefined): T {
  const raw = arg && arg !== '-' ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');
  return JSON.parse(raw) as T;
}

async function main(): Promise<void> {
  const bundle = readJson<ModuleBundle>(process.argv[2]);
  const opts = readJson<SubmitOverlayRunOptions>(process.argv[3]);
  const config = loadResearchPlatformConfig(process.env);
  const events = new ConsoleAgentEventSink();
  const probeId = `probe:${randomUUID()}`;
  let session: GatewaySession | undefined;
  try {
    const result = await withTimeout((async () => {
      session = await createGatewayTransport(config);
      const platform = new McpResearchPlatformAdapter(session.transport, config.expectedContractVersion);
      return runBacktestProbe({ platform, events, probeId, integration: 'mcp', bundle, opts, poll: { maxPolls: 30, pollDelayMs: 2000 } });
    })(), config.discoveryTimeoutMs, 'platform:run');
    process.stdout.write(`${JSON.stringify({ outcome: result.outcome.status, comparison: result.comparison }, null, 2)}\n`);
  } finally {
    if (session) await session.close();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  process.stderr.write(`platform:run failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, after `"platform:validate"`, add:

```json
    "platform:run": "node --experimental-strip-types scripts/platform-run.ts",
```

- [ ] **Step 3: Full verification**

Run: `pnpm typecheck`
Expected: clean.

Run: `pnpm test`
Expected: green — prior baseline (≈ 1002 passed) + the new mapper/lifecycle/orchestration/probe tests; `sdk-import-boundary.guard.test.ts` still passes (SDK + `isTerminal` imported only in `ports/research-platform.port.ts` + `adapters/platform/`).

- [ ] **Step 4: Commit**

```bash
git add scripts/platform-run.ts package.json
git commit -m "feat(sp7.2a): platform:run CLI probe"
```

---

## Self-Review

- **Spec coverage:** Port lifecycle + types + re-exports → Task 1 (re-exports) + Task 3. `GatewayRunError` → Task 2. `submitted_overlay` request assembly → Task 3 (mcp). Bounded `getRunStatus` poll + outcome (completed/pending/rejected) + artifact IDs → Task 4. `mapPlatformComparison` 7→9 + 3-case `profit_factor` + derivations → Task 1. mock/mcp/lazy adapters → Task 3. Probe + `platform.run.*` events → Task 5. CLI `platform:run` → Task 6. Boundary/guard + suite + typecheck → Task 6 Step 3. Live round-trip = gateway-pending (documented in the spec; no task — dev env has no gateway).
- **Placeholder scan:** none — every code step shows complete code; commands have expected output. (The mock `cannedSummary` note + the probe `submitted`-event ordering note are clarifications, not placeholders.)
- **Type consistency:** `RunResultView = Extract<RunResultResult,{ok:true}>` used consistently (port, adapters, orchestration); `PlatformRunOutcome` `{completed|pending|rejected}` used identically in Task 4 + Task 5; `SubmitOverlayRunOptions`/`PlatformRunConfig`/`RESEARCH_RUN_METRICS`/`NO_LOSS_PROFIT_FACTOR`/`MetricMappingError` names match across tasks; `isTerminal` imported from the port (not the SDK) in the orchestration to keep the guard green.
