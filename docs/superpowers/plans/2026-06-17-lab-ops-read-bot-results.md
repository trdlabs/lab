# trading-lab ← SDK ops-read (live bot-results read-port) — Implementation Plan

> **For agentic workers:** implement task-by-task with fresh context per task or inline, per the installed workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give trading-lab a `BotResultsReadPort` over `@trading-platform/sdk/ops-read`, with a live HTTP adapter (reads the mock/platform Ops Read Surface A, `ops.3`), a mock and a fixture adapter, an env-gated selector, and a machine guarantee that lab vendors the `/ops-read`-bearing SDK. **Seam-only** — no Researcher/orchestrator integration.

**Architecture:** Hexagonal, following lab's existing `ResearchPlatformPort` convention. A new port `src/ports/bot-results-read.port.ts` owns the SDK import and re-exports the `/ops-read` DTOs; three adapters under `src/adapters/platform/` implement it (live HTTP via an injectable `OpsReadClient`, plus mock and fixture); a dedicated env axis (`LAB_BOT_RESULTS_INTEGRATION` + `LAB_OPS_READ_*`) selects one. The backtest `ResearchPlatformPort`/`getRunResult` path and the `PlatformGatewayPort` synthetic path are untouched.

**Tech Stack:** TypeScript (NodeNext ESM, `allowImportingTsExtensions` → `.ts` import specifiers; `noUncheckedIndexedAccess`; `verbatimModuleSyntax` NOT set), Vitest, pnpm `file:` vendoring, `globalThis.fetch` (injectable). Verification = `pnpm typecheck` + `pnpm test` (lab has no build/check/verify scripts and no CI workflow).

**Repos & paths:**
- Lab (this work): `/home/alexxxnikolskiy/projects/trading-lab`, branch `005-lab-ops-read-bot-results` (already created).
- Platform (re-pack source only, NOT edited): `/home/alexxxnikolskiy/projects/trading-platform` (branch `main`, post-004, SDK 0.3.0 already carries `/ops-read`).

**Resolved facts (from planning research — do not re-derive):**
- Surface A routes (mock `src/http/app.ts`): `GET /ops/runs?mode&status&symbol&cursor` → `PageEnvelope<BotRunRecord>`; `GET /ops/trades?runId=<id>&cursor` → `PageEnvelope<ClosedTrade>` (**query param, NOT** `/ops/runs/:id/trades`); `GET /ops/runs/:runId/summary` → **bare** `RunSummary` (no envelope).
- `PageEnvelope<T> = { items: readonly T[]; nextCursor: string | null; asOf: number; window: {fromMs?,toMs?}; freshness }`. Opaque base64url offset cursor; pass `nextCursor` back verbatim, stop when `null`. No page-size query param.
- Auth: `Authorization: Bearer <raw-token>`. Empty allowlist on loopback = open (no header needed). Consumer sends the raw token.
- SDK `/ops-read` types: `BotRunRecord`, `ClosedTrade`, `ClosedTradesAggregate`, `RunSummary` (extends `ClosedTradesAggregate`), `OperationalEvent`, `DecisionLogEntry` + unions `BotMode`/`BotRunStatus`/`TradeSide`/`OpsSeverity`/`BotRunStrategyRef`; `OPS_READ_CONTRACT_VERSION = 'ops.3'`. Monetary fields (`realizedPnl`/`pnlPct`/`pnlUsd`/`avgPnl`) are decimal-as-string.
- Lab vendors `@trading-platform/sdk` at `file:./vendor/trading-platform-sdk/trading-platform-sdk-0.3.0.tgz` — currently a STALE 0.3.0 WITHOUT `/ops-read`. Must re-pack the current SDK and re-vendor.
- Import-boundary guard `src/adapters/platform/sdk-import-boundary.guard.test.ts`: `@trading-platform/*` allowed only from `ALLOWED_FILES` (currently just `src/ports/research-platform.port.ts`) or under `ALLOWED_DIR = 'src/adapters/platform/'`. Regex scans `from '...'` (dynamic `import('...')` is not matched).
- Lab uses `.ts` import extensions; ports re-export SDK types; adapters import port types (not the SDK); selector uses a string-literal union (no enums); env loaders take `source: NodeJS.ProcessEnv` and throw on bad input.

## File structure
- Create `src/ports/bot-results-read.port.ts` — port interface + re-export of SDK `/ops-read` DTOs (sole SDK importer here; added to guard allowlist).
- Create `src/adapters/platform/ops-read-client.ts` — `OpsReadClient` (FetchLike-injectable HTTP GET to Surface A) + `OpsReadError`.
- Create `src/adapters/platform/http-ops-read.adapter.ts` — `HttpOpsReadAdapter implements BotResultsReadPort` (wraps `OpsReadClient`, walks cursor pages).
- Create `src/adapters/platform/mock-bot-results.adapter.ts` — `MockBotResultsAdapter` (canned, no I/O).
- Create `src/adapters/platform/fixture-bot-results.adapter.ts` — `FixtureBotResultsAdapter` (reads JSON fixtures) + `src/adapters/platform/__fixtures__/bot-results/{runs,trades,summary}.json`.
- Create `src/adapters/platform/select-bot-results.ts` — `selectBotResults` + env parse/load.
- Modify `src/adapters/platform/sdk-import-boundary.guard.test.ts` — add the new port to `ALLOWED_FILES`.
- Co-located tests: `ops-read-client.test.ts`, `http-ops-read.adapter.test.ts`, `mock-bot-results.adapter.test.ts`, `fixture-bot-results.adapter.test.ts`, `select-bot-results.test.ts`, `vendored-sdk.guard.test.ts`.
- Re-vendor: `vendor/trading-platform-sdk/trading-platform-sdk-0.3.0.tgz` (replace) + `pnpm-lock.yaml`.

---

## Task 1: Re-vendor the `/ops-read`-bearing SDK tarball + vendored-sdk guard test

**Files:** replace `vendor/trading-platform-sdk/trading-platform-sdk-0.3.0.tgz`; `pnpm-lock.yaml`; create `src/adapters/platform/vendored-sdk.guard.test.ts`.

> **Runtime-export precondition (confirmed):** the guard reads `OPS_READ_CONTRACT_VERSION` at **runtime** via `import('@trading-platform/sdk/ops-read')`. This requires it to be a runtime value export, not type-only. Confirmed in the SDK source: `packages/sdk/src/ops-read/version.ts` declares `export const OPS_READ_CONTRACT_VERSION = 'ops.3' as const;` and `index.ts` re-exports it as a **value** (`export { OPS_READ_CONTRACT_VERSION }`, not `export type`). Step 2 below is the executable plan-time check — if it ever prints `version: undefined`, the SDK regressed it to type-only and Task 1 must stop.

- [ ] **Step 1: Re-pack the current SDK into lab's vendor dir**

```bash
cd /home/alexxxnikolskiy/projects/trading-platform && npm run build:sdk
cd /home/alexxxnikolskiy/projects/trading-platform/packages/sdk
npm pack --pack-destination /home/alexxxnikolskiy/projects/trading-lab/vendor/trading-platform-sdk/
ls -l /home/alexxxnikolskiy/projects/trading-lab/vendor/trading-platform-sdk/
```
Expected: `trading-platform-sdk-0.3.0.tgz` present (overwrites the stale one). The SDK source is NOT edited — this is a build+pack only.

- [ ] **Step 2: Re-install in lab so the new tarball is extracted**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm install --force
test -f node_modules/@trading-platform/sdk/dist/ops-read/index.d.ts && echo "OPS-READ PRESENT" || echo "OPS-READ MISSING"
node -e "import('@trading-platform/sdk/ops-read').then(m => console.log('version:', m.OPS_READ_CONTRACT_VERSION))"
```
Expected: `OPS-READ PRESENT` and `version: ops.3`. (`--force` makes pnpm re-extract the `file:` tarball whose bytes changed under the same filename.) **If `version:` prints `undefined`** the SDK exported the constant type-only — STOP and fix the SDK export before continuing (this is the runtime-export precondition above). **If it prints `ops.3`**, the runtime value export is confirmed and the guard test (Step 3) will work.

- [ ] **Step 3: Write the vendored-sdk guard test (the machine guarantee)**

Lab has no `verify:*`/`check`/CI scripts — the established machine-guard idiom is a Vitest test (cf. `sdk-import-boundary.guard.test.ts`). Create `src/adapters/platform/vendored-sdk.guard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Machine guarantee that lab vendors the /ops-read-bearing SDK (not a stale 0.3.0 without it).
const EXPECTED_OPS_VERSION = 'ops.3';
const SPEC_RE = /^file:(\.\/vendor\/trading-platform-sdk\/trading-platform-sdk-\d+\.\d+\.\d+\.tgz)$/;

interface PkgJson { dependencies?: Record<string, string> }

/** Pure: returns specifier problems ([] = clean). No SDK import — safe to unit-test. */
export function checkSpecifier(pkg: PkgJson): string[] {
  const errs: string[] = [];
  const spec = pkg.dependencies?.['@trading-platform/sdk'];
  if (!spec) { errs.push('@trading-platform/sdk missing from dependencies'); return errs; }
  if (!SPEC_RE.test(spec)) errs.push(`@trading-platform/sdk specifier '${spec}' is not the vendored ./vendor/trading-platform-sdk/*.tgz file`);
  return errs;
}

describe('vendored SDK guard', () => {
  it('pins the @trading-platform/sdk specifier to the vendored tgz', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PkgJson;
    expect(checkSpecifier(pkg)).toEqual([]);
  });

  it('rejects a non-vendored specifier (unit)', () => {
    expect(checkSpecifier({ dependencies: { '@trading-platform/sdk': '^0.3.0' } }).length).toBeGreaterThan(0);
    expect(checkSpecifier({ dependencies: {} }).length).toBeGreaterThan(0);
  });

  it('the vendored SDK exposes /ops-read at contract version ops.3', async () => {
    const mod = await import('@trading-platform/sdk/ops-read');
    expect(mod.OPS_READ_CONTRACT_VERSION).toBe(EXPECTED_OPS_VERSION);
  });
});
```

- [ ] **Step 4: Run the guard test**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/platform/vendored-sdk.guard.test.ts
```
Expected: 3 passed. (If the third fails with a module-resolution error, the re-vendor in Steps 1-2 didn't take — re-run them.)

- [ ] **Step 5: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add vendor/trading-platform-sdk/trading-platform-sdk-0.3.0.tgz pnpm-lock.yaml src/adapters/platform/vendored-sdk.guard.test.ts
git commit -m "build(005): re-vendor 0.3.0-with-ops-read SDK tgz + vendored-sdk guard test

Re-packs the post-004 SDK (now carrying /ops-read) into lab's vendor dir, replacing the stale
0.3.0 (no ops-read). A vitest guard asserts the file: specifier shape AND that the installed SDK
exposes /ops-read at OPS_READ_CONTRACT_VERSION='ops.3' — catches silent stale-vendoring."
```

---

## Task 2: `BotResultsReadPort` + boundary-guard allowlist

**Files:** create `src/ports/bot-results-read.port.ts`; modify `src/adapters/platform/sdk-import-boundary.guard.test.ts`.

- [ ] **Step 1: Create the port (sole SDK importer; re-exports the DTOs)**

Create `src/ports/bot-results-read.port.ts`:

```typescript
import type {
  BotRunRecord,
  ClosedTrade,
  ClosedTradesAggregate,
  RunSummary,
  BotMode,
  BotRunStatus,
  TradeSide,
  BotRunStrategyRef,
} from '@trading-platform/sdk/ops-read';

// Re-export the SDK /ops-read DTOs through the port so adapters depend on lab-local port types,
// not the SDK directly (enforced by sdk-import-boundary.guard.test.ts).
export type {
  BotRunRecord, ClosedTrade, ClosedTradesAggregate, RunSummary,
  BotMode, BotRunStatus, TradeSide, BotRunStrategyRef,
};

export interface BotRunsFilter {
  readonly mode?: BotMode;
  readonly status?: BotRunStatus;
}

/**
 * Live bot-results read surface (ops.3) as seen by trading-lab.
 * Separate from ResearchPlatformPort (the backtest getRunResult path) and from PlatformGatewayPort
 * (the synthetic market-context path). Source-abstracting: live HTTP (Surface A) vs mock vs fixture.
 * Pagination is a Surface A transport detail and does not leak: listBotRuns walks cursor pages internally.
 */
export interface BotResultsReadPort {
  listBotRuns(filter?: BotRunsFilter): Promise<readonly BotRunRecord[]>;
  getClosedTrades(runId: string): Promise<readonly ClosedTrade[]>;
  getRunSummary(runId: string): Promise<RunSummary>;
}
```

- [ ] **Step 2: Add the port to the boundary-guard allowlist**

In `src/adapters/platform/sdk-import-boundary.guard.test.ts`, change:
```typescript
const ALLOWED_FILES = new Set<string>(['src/ports/research-platform.port.ts']);
```
to:
```typescript
const ALLOWED_FILES = new Set<string>([
  'src/ports/research-platform.port.ts',
  'src/ports/bot-results-read.port.ts',
]);
```

- [ ] **Step 3: Typecheck + run the boundary guard**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm typecheck
pnpm exec vitest run src/adapters/platform/sdk-import-boundary.guard.test.ts
```
Expected: typecheck exits 0 (the port resolves the SDK `/ops-read` types from the re-vendored tgz); boundary guard passes (the new port is allowlisted; no other file imports the SDK yet).

- [ ] **Step 4: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/ports/bot-results-read.port.ts src/adapters/platform/sdk-import-boundary.guard.test.ts
git commit -m "feat(005): BotResultsReadPort over SDK /ops-read; allowlist the port in the boundary guard"
```

---

## Task 3: `OpsReadClient` (injectable HTTP) + `OpsReadError`

**Files:** create `src/adapters/platform/ops-read-client.ts`; test `src/adapters/platform/ops-read-client.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/ops-read-client.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { OpsReadClient, OpsReadError, type FetchLike } from './ops-read-client.ts';

function fakeFetch(handler: (url: string, init?: { headers?: Record<string, string> }) => { ok: boolean; status: number; body: unknown }): FetchLike {
  return async (url, init) => {
    const r = handler(url, init);
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
}

describe('OpsReadClient', () => {
  it('GETs with a Bearer header and parses JSON', async () => {
    let seenUrl = ''; let seenAuth: string | undefined;
    const client = new OpsReadClient({
      baseUrl: 'http://host:8839/', token: 'raw-tok',
      fetchImpl: fakeFetch((url, init) => { seenUrl = url; seenAuth = init?.headers?.authorization; return { ok: true, status: 200, body: { items: [], nextCursor: null } }; }),
    });
    const out = await client.get<{ items: unknown[]; nextCursor: string | null }>('/ops/runs');
    expect(seenUrl).toBe('http://host:8839/ops/runs'); // trailing slash on baseUrl stripped
    expect(seenAuth).toBe('Bearer raw-tok');
    expect(out.nextCursor).toBeNull();
  });

  it('omits the auth header when the token is empty (loopback-open)', async () => {
    let seenAuth: string | undefined = 'unset';
    const client = new OpsReadClient({
      baseUrl: 'http://host:8839', token: '',
      fetchImpl: fakeFetch((_url, init) => { seenAuth = init?.headers?.authorization; return { ok: true, status: 200, body: {} }; }),
    });
    await client.get('/ops/discover');
    expect(seenAuth).toBeUndefined();
  });

  it('throws OpsReadError on a non-2xx response, carrying status + code', async () => {
    const client = new OpsReadClient({
      baseUrl: 'http://host:8839', token: 't',
      fetchImpl: fakeFetch(() => ({ ok: false, status: 404, body: { category: 'not_found', code: 'run_not_found', message: 'no run' } })),
    });
    await expect(client.get('/ops/runs/x/summary')).rejects.toBeInstanceOf(OpsReadError);
    await client.get('/ops/runs/x/summary').catch((e: OpsReadError) => {
      expect(e.status).toBe(404);
      expect(e.code).toBe('run_not_found');
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/platform/ops-read-client.test.ts
```
Expected: FAIL — cannot find `./ops-read-client.ts`.

- [ ] **Step 3: Implement the client**

Create `src/adapters/platform/ops-read-client.ts`:

```typescript
// Thin HTTP client for the Ops Read Surface A (ops.3) — the trading-platform read surface the mock
// also serves. Mirrors the BacktesterClient split: raw fetch lives here (FetchLike-injectable for
// tests); the adapter is a thin port-implementing bridge. The SDK /ops-read is types-only, so this
// client encodes Surface A's wire contract (paths/envelope/auth) itself.

export interface FetchLikeInit { method?: string; headers?: Record<string, string>; }
export interface FetchLikeResponse { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; }
export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface OpsReadClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Defaults to the global fetch. */
  readonly fetchImpl?: FetchLike;
}

/** Surface A read error in lab's vocabulary (status + ops error code). */
export class OpsReadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(`ops-read ${status}/${code}: ${message}`);
    this.name = 'OpsReadError';
    this.status = status;
    this.code = code;
  }
}

export class OpsReadClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpsReadClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`; // omit when open (loopback)
    const res = await this.fetchImpl(`${this.base}${path}`, { method: 'GET', headers });
    if (res.ok) return (await res.json()) as T;

    let payload: { code?: string; message?: string } | undefined;
    try { payload = (await res.json()) as typeof payload; } catch { payload = undefined; }
    throw new OpsReadError(res.status, payload?.code ?? 'error', payload?.message ?? `ops-read responded ${res.status} for ${path}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/platform/ops-read-client.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/adapters/platform/ops-read-client.ts src/adapters/platform/ops-read-client.test.ts
git commit -m "feat(005): OpsReadClient — injectable Bearer HTTP GET to Surface A; OpsReadError"
```

---

## Task 4: `HttpOpsReadAdapter` (live, walks cursor pages)

**Files:** create `src/adapters/platform/http-ops-read.adapter.ts`; test `src/adapters/platform/http-ops-read.adapter.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/http-ops-read.adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { OpsReadClient, type FetchLike } from './ops-read-client.ts';
import { HttpOpsReadAdapter } from './http-ops-read.adapter.ts';
import type { BotRunRecord, ClosedTrade, RunSummary } from '../../ports/bot-results-read.port.ts';

const RUN_A: BotRunRecord = { runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTC'] };
const RUN_B: BotRunRecord = { ...RUN_A, runId: 'r2' };
const TRADE: ClosedTrade = { tradeId: 't1', runId: 'r1', symbol: 'BTC', side: 'long', openedAtMs: 1, closedAtMs: 2, realizedPnl: '1.5', pnlPct: '0.1', isWin: true, closeReason: 'tp' };
const SUMMARY: RunSummary = { runId: 'r1', excludesReconcile: true, asOf: 9, closedTrades: 1, wins: 1, losses: 0, breakeven: 0, winratePct: 100, pnlUsd: '1.5', avgPnl: '1.5', exitReasons: { tp: 1 } };

/** Normalize a path-or-URL to "pathname[?sorted=query]" so route matching is order-independent
 *  and exact — no fragile endsWith / first-match-wins (URLSearchParams does not guarantee key order). */
function norm(pathOrUrl: string): string {
  const u = new URL(pathOrUrl, 'http://x');
  const entries = [...u.searchParams.entries()]
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const qs = entries.map(([k, v]) => `${k}=${v}`).join('&');
  return u.pathname + (qs ? `?${qs}` : '');
}

/** A fake fetch that maps a NORMALIZED route key → enveloped/bare JSON; records the URLs it saw.
 *  Exact match on the normalized form: order-independent and unambiguous as routes grow. */
function routed(routes: Record<string, unknown>): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const table = new Map(Object.entries(routes).map(([k, v]) => [norm(k), v] as const));
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    const body = table.get(norm(url));
    if (body === undefined) return { ok: false, status: 404, json: async () => ({ code: 'no_route', message: url }), text: async () => '' };
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  return { fetchImpl, urls };
}

function adapter(fetchImpl: FetchLike): HttpOpsReadAdapter {
  return new HttpOpsReadAdapter(new OpsReadClient({ baseUrl: 'http://h:8839', token: 't', fetchImpl }));
}

describe('HttpOpsReadAdapter', () => {
  it('listBotRuns walks cursor pages into a flat array', async () => {
    const { fetchImpl, urls } = routed({
      '/ops/runs': { items: [RUN_A], nextCursor: 'c1' },          // page 1 (no cursor in url)
      '/ops/runs?cursor=c1': { items: [RUN_B], nextCursor: null }, // page 2
    });
    const runs = await adapter(fetchImpl).listBotRuns();
    expect(runs.map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(urls.some((u) => u.endsWith('/ops/runs'))).toBe(true);
    expect(urls.some((u) => u.includes('cursor=c1'))).toBe(true);
  });

  it('listBotRuns passes mode/status filters as query params', async () => {
    const { fetchImpl, urls } = routed({ '/ops/runs?mode=paper&status=finished': { items: [RUN_A], nextCursor: null } });
    const runs = await adapter(fetchImpl).listBotRuns({ mode: 'paper', status: 'finished' });
    expect(runs).toHaveLength(1);
    expect(urls[0]).toContain('mode=paper');
    expect(urls[0]).toContain('status=finished');
  });

  it('getClosedTrades hits /ops/trades?runId=… and walks pages', async () => {
    const { fetchImpl, urls } = routed({
      '/ops/trades?runId=r1': { items: [TRADE], nextCursor: 'c1' },
      '/ops/trades?runId=r1&cursor=c1': { items: [{ ...TRADE, tradeId: 't2' }], nextCursor: null },
    });
    const trades = await adapter(fetchImpl).getClosedTrades('r1');
    expect(trades.map((t) => t.tradeId)).toEqual(['t1', 't2']);
    expect(urls[0]).toContain('/ops/trades?runId=r1');
  });

  it('getRunSummary hits /ops/runs/:id/summary and returns the bare object', async () => {
    const { fetchImpl } = routed({ '/ops/runs/r1/summary': SUMMARY });
    const summary = await adapter(fetchImpl).getRunSummary('r1');
    expect(summary.runId).toBe('r1');
    expect(summary.closedTrades).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/platform/http-ops-read.adapter.test.ts
```
Expected: FAIL — cannot find `./http-ops-read.adapter.ts`.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/platform/http-ops-read.adapter.ts`:

```typescript
import type {
  BotResultsReadPort, BotRunsFilter, BotRunRecord, ClosedTrade, RunSummary,
} from '../../ports/bot-results-read.port.ts';
import type { OpsReadClient } from './ops-read-client.ts';

/** Surface A page envelope — the only fields the adapter needs to walk pages. */
interface PageEnvelope<T> { readonly items: readonly T[]; readonly nextCursor: string | null; }

/** Live BotResultsReadPort over the Ops Read Surface A (ops.3). Pagination is hidden: each list
 *  method walks the opaque cursor to completion and returns a flat array. */
export class HttpOpsReadAdapter implements BotResultsReadPort {
  constructor(private readonly client: OpsReadClient) {}

  async listBotRuns(filter?: BotRunsFilter): Promise<readonly BotRunRecord[]> {
    const base = new URLSearchParams();
    if (filter?.mode) base.set('mode', filter.mode);
    if (filter?.status) base.set('status', filter.status);
    return this.walk<BotRunRecord>('/ops/runs', base);
  }

  async getClosedTrades(runId: string): Promise<readonly ClosedTrade[]> {
    const base = new URLSearchParams({ runId });
    return this.walk<ClosedTrade>('/ops/trades', base);
  }

  async getRunSummary(runId: string): Promise<RunSummary> {
    return this.client.get<RunSummary>(`/ops/runs/${encodeURIComponent(runId)}/summary`);
  }

  /** Walk Surface A cursor pages for `path`, carrying the fixed query params in `base`. */
  private async walk<T>(path: string, base: URLSearchParams): Promise<readonly T[]> {
    const all: T[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams(base);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      const page = await this.client.get<PageEnvelope<T>>(`${path}${qs ? `?${qs}` : ''}`);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/platform/http-ops-read.adapter.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/adapters/platform/http-ops-read.adapter.ts src/adapters/platform/http-ops-read.adapter.test.ts
git commit -m "feat(005): HttpOpsReadAdapter — live BotResultsReadPort over Surface A (cursor-walked)"
```

---

## Task 5: Mock + fixture adapters (+ fixtures)

**Files:** create `src/adapters/platform/mock-bot-results.adapter.ts`, `src/adapters/platform/fixture-bot-results.adapter.ts`, `src/adapters/platform/__fixtures__/bot-results/{runs,trades,summary}.json`; tests `mock-bot-results.adapter.test.ts`, `fixture-bot-results.adapter.test.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/adapters/platform/mock-bot-results.adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MockBotResultsAdapter } from './mock-bot-results.adapter.ts';

describe('MockBotResultsAdapter', () => {
  const a = new MockBotResultsAdapter();
  it('returns at least one canned run with a valid shape', async () => {
    const runs = await a.listBotRuns();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.runId).toBeTruthy();
    expect(['live', 'paper', 'backtest']).toContain(runs[0]?.mode);
  });
  it('returns canned trades and a summary for a run', async () => {
    expect((await a.getClosedTrades('r1')).length).toBeGreaterThan(0);
    const s = await a.getRunSummary('r1');
    expect(s.runId).toBeTruthy();
    expect(typeof s.pnlUsd).toBe('string'); // decimal-as-string
  });
});
```

Create `src/adapters/platform/fixture-bot-results.adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { FixtureBotResultsAdapter } from './fixture-bot-results.adapter.ts';

const DIR = fileURLToPath(new URL('./__fixtures__/bot-results', import.meta.url));

describe('FixtureBotResultsAdapter', () => {
  const a = new FixtureBotResultsAdapter(DIR);
  it('reads runs/trades/summary fixtures into SDK shapes', async () => {
    const runs = await a.listBotRuns();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.runId).toBeTruthy();
    const trades = await a.getClosedTrades(runs[0]!.runId);
    expect(trades.length).toBeGreaterThan(0);
    const s = await a.getRunSummary(runs[0]!.runId);
    expect(typeof s.pnlUsd).toBe('string');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/platform/mock-bot-results.adapter.test.ts src/adapters/platform/fixture-bot-results.adapter.test.ts
```
Expected: FAIL — cannot find the adapter modules.

- [ ] **Step 3: Implement the adapters + fixtures**

Create `src/adapters/platform/mock-bot-results.adapter.ts`:

```typescript
import type {
  BotResultsReadPort, BotRunsFilter, BotRunRecord, ClosedTrade, RunSummary,
} from '../../ports/bot-results-read.port.ts';

const RUN: BotRunRecord = {
  runId: 'mock_run_001', mode: 'paper', status: 'finished',
  strategy: { name: 'mock-strategy', version: '1.0.0' },
  startedAtMs: 1_700_000_000_000, finishedAtMs: 1_700_000_600_000, lastSeenMs: 1_700_000_600_000,
  symbols: ['BTCUSDT'],
};
const TRADE: ClosedTrade = {
  tradeId: 'mock_trade_001', runId: 'mock_run_001', symbol: 'BTCUSDT', side: 'long',
  openedAtMs: 1_700_000_100_000, closedAtMs: 1_700_000_200_000,
  realizedPnl: '12.50', pnlPct: '1.25', isWin: true, closeReason: 'take_profit',
};
const SUMMARY: RunSummary = {
  runId: 'mock_run_001', excludesReconcile: true, asOf: 1_700_000_600_000,
  closedTrades: 1, wins: 1, losses: 0, breakeven: 0, winratePct: 100,
  pnlUsd: '12.50', avgPnl: '12.50', exitReasons: { take_profit: 1 },
};

/** Boot-safe canned BotResultsReadPort — no I/O. */
export class MockBotResultsAdapter implements BotResultsReadPort {
  async listBotRuns(_filter?: BotRunsFilter): Promise<readonly BotRunRecord[]> { return [RUN]; }
  async getClosedTrades(_runId: string): Promise<readonly ClosedTrade[]> { return [TRADE]; }
  async getRunSummary(_runId: string): Promise<RunSummary> { return SUMMARY; }
}
```

Create `src/adapters/platform/fixture-bot-results.adapter.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BotResultsReadPort, BotRunsFilter, BotRunRecord, ClosedTrade, RunSummary,
} from '../../ports/bot-results-read.port.ts';

/** Reads Surface-A-shaped JSON fixtures (port-shaped arrays/object) from a directory. Dev/offline use. */
export class FixtureBotResultsAdapter implements BotResultsReadPort {
  constructor(private readonly dir: string) {}

  private read<T>(file: string): T {
    return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as T;
  }

  async listBotRuns(_filter?: BotRunsFilter): Promise<readonly BotRunRecord[]> {
    return this.read<BotRunRecord[]>('runs.json');
  }
  async getClosedTrades(_runId: string): Promise<readonly ClosedTrade[]> {
    return this.read<ClosedTrade[]>('trades.json');
  }
  async getRunSummary(_runId: string): Promise<RunSummary> {
    return this.read<RunSummary>('summary.json');
  }
}
```

Create `src/adapters/platform/__fixtures__/bot-results/runs.json`:
```json
[
  { "runId": "fx_run_001", "mode": "paper", "status": "finished", "strategy": { "name": "fixture-strategy", "version": "1.0.0" }, "startedAtMs": 1700000000000, "finishedAtMs": 1700000600000, "lastSeenMs": 1700000600000, "symbols": ["BTCUSDT"] }
]
```

Create `src/adapters/platform/__fixtures__/bot-results/trades.json`:
```json
[
  { "tradeId": "fx_trade_001", "runId": "fx_run_001", "symbol": "BTCUSDT", "side": "long", "openedAtMs": 1700000100000, "closedAtMs": 1700000200000, "realizedPnl": "12.50", "pnlPct": "1.25", "isWin": true, "closeReason": "take_profit" }
]
```

Create `src/adapters/platform/__fixtures__/bot-results/summary.json`:
```json
{ "runId": "fx_run_001", "excludesReconcile": true, "asOf": 1700000600000, "closedTrades": 1, "wins": 1, "losses": 0, "breakeven": 0, "winratePct": 100, "pnlUsd": "12.50", "avgPnl": "12.50", "exitReasons": { "take_profit": 1 } }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/platform/mock-bot-results.adapter.test.ts src/adapters/platform/fixture-bot-results.adapter.test.ts
```
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/adapters/platform/mock-bot-results.adapter.ts src/adapters/platform/fixture-bot-results.adapter.ts \
  src/adapters/platform/__fixtures__/bot-results/ \
  src/adapters/platform/mock-bot-results.adapter.test.ts src/adapters/platform/fixture-bot-results.adapter.test.ts
git commit -m "feat(005): mock + fixture BotResultsReadPort adapters (+ ops-read fixtures)"
```

---

## Task 6: `selectBotResults` (env-gated, separate axis) + final green

**Files:** create `src/adapters/platform/select-bot-results.ts`; test `src/adapters/platform/select-bot-results.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/select-bot-results.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { selectBotResults, parseBotResultsIntegration } from './select-bot-results.ts';
import { MockBotResultsAdapter } from './mock-bot-results.adapter.ts';
import { FixtureBotResultsAdapter } from './fixture-bot-results.adapter.ts';
import { HttpOpsReadAdapter } from './http-ops-read.adapter.ts';

describe('parseBotResultsIntegration', () => {
  it('defaults to mock when unset/empty', () => {
    expect(parseBotResultsIntegration(undefined)).toBe('mock');
    expect(parseBotResultsIntegration('')).toBe('mock');
  });
  it('accepts the known values', () => {
    expect(parseBotResultsIntegration('http')).toBe('http');
    expect(parseBotResultsIntegration('fixture')).toBe('fixture');
  });
  it('throws (fail-closed) on an unknown value', () => {
    expect(() => parseBotResultsIntegration('live-prod')).toThrow(/LAB_BOT_RESULTS_INTEGRATION/);
  });
});

describe('selectBotResults', () => {
  it('returns the mock adapter by default', () => {
    expect(selectBotResults({} as NodeJS.ProcessEnv)).toBeInstanceOf(MockBotResultsAdapter);
  });
  it('returns the fixture adapter for fixture', () => {
    expect(selectBotResults({ LAB_BOT_RESULTS_INTEGRATION: 'fixture' } as unknown as NodeJS.ProcessEnv)).toBeInstanceOf(FixtureBotResultsAdapter);
  });
  it('returns the http adapter for http', () => {
    const env = { LAB_BOT_RESULTS_INTEGRATION: 'http', LAB_OPS_READ_URL: 'http://h:8839', LAB_OPS_READ_TOKEN: 't' } as unknown as NodeJS.ProcessEnv;
    expect(selectBotResults(env)).toBeInstanceOf(HttpOpsReadAdapter);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/platform/select-bot-results.test.ts
```
Expected: FAIL — cannot find `./select-bot-results.ts`.

- [ ] **Step 3: Implement the selector**

Create `src/adapters/platform/select-bot-results.ts`:

```typescript
import { fileURLToPath } from 'node:url';
import type { BotResultsReadPort } from '../../ports/bot-results-read.port.ts';
import { MockBotResultsAdapter } from './mock-bot-results.adapter.ts';
import { FixtureBotResultsAdapter } from './fixture-bot-results.adapter.ts';
import { HttpOpsReadAdapter } from './http-ops-read.adapter.ts';
import { OpsReadClient } from './ops-read-client.ts';

// Dedicated axis — SEPARATE from the research-transport integration (TRADING_PLATFORM_*).
// research (backtest) and bot-results (live ops.3) are distinct channels and must not be conflated.
export type BotResultsIntegration = 'mock' | 'fixture' | 'http';

/** Validate the env string against the union; fail closed on anything unknown. */
export function parseBotResultsIntegration(raw: string | undefined): BotResultsIntegration {
  if (raw === undefined || raw === '') return 'mock';
  if (raw === 'mock' || raw === 'fixture' || raw === 'http') return raw;
  throw new Error(`LAB_BOT_RESULTS_INTEGRATION must be one of mock|fixture|http, got '${raw}'`);
}

function defaultFixtureDir(): string {
  return fileURLToPath(new URL('./__fixtures__/bot-results', import.meta.url));
}

/** Boot-safe selector for the live bot-results read surface. Reads its OWN env, never process.env directly. */
export function selectBotResults(source: NodeJS.ProcessEnv): BotResultsReadPort {
  const integration = parseBotResultsIntegration(source.LAB_BOT_RESULTS_INTEGRATION);
  if (integration === 'http') {
    return new HttpOpsReadAdapter(new OpsReadClient({
      baseUrl: source.LAB_OPS_READ_URL ?? 'http://127.0.0.1:8839',
      token: source.LAB_OPS_READ_TOKEN ?? '',
    }));
  }
  if (integration === 'fixture') {
    return new FixtureBotResultsAdapter(source.LAB_OPS_READ_FIXTURE_DIR ?? defaultFixtureDir());
  }
  return new MockBotResultsAdapter();
}
```

- [ ] **Step 4: Run the selector test**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm exec vitest run src/adapters/platform/select-bot-results.test.ts
```
Expected: all passed.

- [ ] **Step 5: Full verification (lab's check = typecheck + test)**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm typecheck
pnpm test
```
Expected: `pnpm typecheck` exits 0; `pnpm test` (vitest run) green — all prior suites plus the new port/client/adapters/selector/guard tests. The boundary guard confirms only `bot-results-read.port.ts` imports the SDK (adapters import port types).

- [ ] **Step 6: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/adapters/platform/select-bot-results.ts src/adapters/platform/select-bot-results.test.ts
git commit -m "feat(005): selectBotResults — env-gated (LAB_BOT_RESULTS_INTEGRATION + LAB_OPS_READ_*), separate from research axis"
```

---

## Self-review checklist (planner)

- **Spec coverage:** seam-only port (T2) ✓; live HTTP Surface A (T3 client + T4 adapter, correct routes `/ops/runs`, `/ops/trades?runId=`, `/ops/runs/:id/summary`) ✓; mock + fixture adapters (T5) ✓; selector on a separate axis + dedicated `LAB_OPS_READ_*` (T6) ✓; re-vendor stay-0.3.0 (T1) ✓; vendored-tgz machine guarantee (T1 vitest guard — asserts `/ops-read` + `ops.3`) ✓; boundary-guard allowlist (T2) ✓; pagination hidden inside the adapter (T4 `walk`) ✓; out-of-scope respected (no Researcher/orchestrator, no backtest path, no SDK/mock source edits — only an SDK re-pack) ✓.
- **No placeholders:** every file has complete code; every run step has an exact command + expected output.
- **Type/name consistency:** `BotResultsReadPort` / `BotRunsFilter` / `listBotRuns` / `getClosedTrades` / `getRunSummary` / `OpsReadClient.get` / `OpsReadError` / `HttpOpsReadAdapter` / `MockBotResultsAdapter` / `FixtureBotResultsAdapter` / `selectBotResults` / `parseBotResultsIntegration` are used identically across tasks. DTO field names match the SDK `/ops-read` shapes (decimal-as-string monetary fields). `.ts` import extensions throughout (lab convention).
- **Lab-convention fidelity:** port re-exports SDK types (sole SDK importer); adapters import port types; selector is a string-literal union with fail-closed env parse; tests are co-located Vitest with injectable fakes; verification is `pnpm typecheck` + `pnpm test` (no build/CI).
