# HTTP TradeEvidenceReadPort (lab side of Slice B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trading-lab consumer of the platform's (forthcoming) `/ops/trade-evidence` endpoint — a real HTTP `TradeEvidenceReadPort` that fills the researcher's forensic per-trade evidence (entry/exit prices + lifecycle timeline), wired in composition, with the redundant raw minute-context dropped from the prompt.

**Architecture:** A thin, pure `HttpTradeEvidenceAdapter` over the existing `OpsReadClient` maps the platform `TradeEvidence` rows → lab `TradeEvidenceBundle` (minuteContext dropped). A `selectTradeEvidence` selector (mirroring `selectBotResults`) wires it on the `http` ops-read integration path. `forensicBundleText` stops rendering the raw minute lines (it already renders prices + lifecycle).

**Tech Stack:** TypeScript under `node --experimental-strip-types`; Vitest; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-29-http-trade-evidence-design.md` (platform half: `…-platform-trade-evidence-handoff.md`).

## Global Constraints

- Pure mapping — no I/O beyond `OpsReadClient.get`, no `Date.now()`/`Math.random()` in the adapter/formatter.
- Reuse the existing `OpsReadClient` (same `LAB_OPS_READ_URL`/`LAB_OPS_READ_TOKEN` as bot-results); follow the existing `LAB_BOT_RESULTS_INTEGRATION` switch (`mock|fixture|http`) — no new env var.
- `minuteContext` is **dropped** from the HTTP path (always `[]`); the raw `minute …` lines are removed from `forensicBundleText` (redundant with Slice A's per-trade table). Prices + lifecycle are already rendered by `forensicBundleText`.
- Do NOT change Slice A's per-trade context, the math engine, `marketContextMath`, or the `TradeEvidenceReadPort`/`TradeEvidenceBundle` port types.
- Fail-soft is owned by the handler (it wraps `getTradeEvidence` in try/catch); the adapter may let `OpsReadClient` errors propagate.
- Relative imports keep the `.ts` extension. `noUncheckedIndexedAccess` on. Zero new runtime deps.
- BOTH gates green: `npm run typecheck` (exit 0) AND `npx vitest run` (baseline 2373 passed / 0 failed on `main`).

---

### Task 1: `HttpTradeEvidenceAdapter`

**Files:**
- Create: `src/adapters/platform/http-trade-evidence.adapter.ts`
- Test: `src/adapters/platform/http-trade-evidence.adapter.test.ts`

**Interfaces:**
- Consumes: `OpsReadClient` (`./ops-read-client.ts`, `get<T>(path): Promise<T>` + `OpsReadClientOptions{baseUrl,token,fetchImpl?}` + `FetchLike`); `TradeEvidenceReadPort`/`TradeEvidenceQuery`/`TradeEvidenceBundle`/`TradeLifecycleEvidence` (`../../ports/trade-evidence-read.port.ts`).
- Produces: `export class HttpTradeEvidenceAdapter implements TradeEvidenceReadPort`.

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/http-trade-evidence.adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { HttpTradeEvidenceAdapter } from './http-trade-evidence.adapter.ts';
import { OpsReadClient, type FetchLike } from './ops-read-client.ts';

function row(tradeId: string, extra: Record<string, unknown> = {}) {
  return {
    tradeId, runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long',
    openedAtMs: 1_000_000, closedAtMs: 1_600_000,
    entryPrice: '0.0512', exitPrice: '0.0447', realizedPnl: '-46.78', pnlPct: '-12.64', closeReason: 'hard_stop',
    lifecycle: [
      { tsMs: 1_000_000, type: 'entry', price: '0.0512', qty: '900' },
      { tsMs: 1_300_000, type: 'dca', price: '0.0490', qty: '900' },
      { tsMs: 1_600_000, type: 'sl', price: '0.0447', qty: '1800' },
    ],
    ...extra,
  };
}

/** Capture requested URLs; return queued JSON pages. */
function fakeFetch(pages: unknown[]): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const body = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
  };
  return { fetch, urls };
}

describe('HttpTradeEvidenceAdapter', () => {
  it('maps /ops/trade-evidence rows to TradeEvidenceBundles (prices + lifecycle; minuteContext dropped)', async () => {
    const { fetch, urls } = fakeFetch([{ items: [row('t1')], nextCursor: null }]);
    const client = new OpsReadClient({ baseUrl: 'http://ops:8839', token: 'tok', fetchImpl: fetch });
    const out = await new HttpTradeEvidenceAdapter(client).getTradeEvidence({ tradeIds: ['t1'], minuteWindowBefore: 20, minuteWindowAfter: 180 });
    expect(urls[0]).toBe('http://ops:8839/ops/trade-evidence?tradeIds=t1');
    expect(out.length).toBe(1);
    const b = out[0]!;
    expect(b.tradeId).toBe('t1');
    expect(b.symbol).toBe('ESPORTSUSDT');
    expect(b.enteredAtMs).toBe(1_000_000);
    expect(b.closedAtMs).toBe(1_600_000);
    expect(b.entryPrice).toBe('0.0512');
    expect(b.exitPrice).toBe('0.0447');
    expect(b.holdingDurationMs).toBe(600_000); // closed - opened
    expect(b.lifecycleEvents.map((e) => e.type)).toEqual(['entry', 'dca', 'sl']);
    expect(b.lifecycleEvents[1]!.price).toBe('0.0490');
    expect(b.minuteContext).toEqual([]); // dropped — Slice A owns the window
  });

  it('joins multiple tradeIds and walks cursor pages', async () => {
    const { fetch, urls } = fakeFetch([
      { items: [row('t1')], nextCursor: 'c2' },
      { items: [row('t2')], nextCursor: null },
    ]);
    const client = new OpsReadClient({ baseUrl: 'http://ops:8839', token: 'tok', fetchImpl: fetch });
    const out = await new HttpTradeEvidenceAdapter(client).getTradeEvidence({ tradeIds: ['t1', 't2'], minuteWindowBefore: 0, minuteWindowAfter: 0 });
    expect(urls[0]).toBe('http://ops:8839/ops/trade-evidence?tradeIds=t1%2Ct2');
    expect(urls[1]).toBe('http://ops:8839/ops/trade-evidence?tradeIds=t1%2Ct2&cursor=c2');
    expect(out.map((b) => b.tradeId)).toEqual(['t1', 't2']);
  });

  it('returns [] without calling the client when tradeIds is empty', async () => {
    const { fetch, urls } = fakeFetch([{ items: [], nextCursor: null }]);
    const client = new OpsReadClient({ baseUrl: 'http://ops:8839', token: 'tok', fetchImpl: fetch });
    const out = await new HttpTradeEvidenceAdapter(client).getTradeEvidence({ tradeIds: [], minuteWindowBefore: 0, minuteWindowAfter: 0 });
    expect(out).toEqual([]);
    expect(urls.length).toBe(0);
  });

  it('maps a null closedAtMs to a null holdingDurationMs', async () => {
    const { fetch } = fakeFetch([{ items: [row('t1', { closedAtMs: null })], nextCursor: null }]);
    const client = new OpsReadClient({ baseUrl: 'http://ops:8839', token: 'tok', fetchImpl: fetch });
    const out = await new HttpTradeEvidenceAdapter(client).getTradeEvidence({ tradeIds: ['t1'], minuteWindowBefore: 0, minuteWindowAfter: 0 });
    expect(out[0]!.holdingDurationMs).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/platform/http-trade-evidence.adapter.test.ts`
Expected: FAIL — module `./http-trade-evidence.adapter.ts` / class `HttpTradeEvidenceAdapter` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/adapters/platform/http-trade-evidence.adapter.ts`:

```ts
import type {
  TradeEvidenceBundle, TradeEvidenceQuery, TradeEvidenceReadPort, TradeLifecycleEvidence,
} from '../../ports/trade-evidence-read.port.ts';
import type { OpsReadClient } from './ops-read-client.ts';

/** Wire shape of the platform `/ops/trade-evidence` rows (Surface A, ops.3). */
interface TradeEvidenceRow {
  readonly tradeId: string; readonly runId: string; readonly symbol: string; readonly side: 'long' | 'short';
  readonly openedAtMs: number; readonly closedAtMs: number | null;
  readonly entryPrice: string | null; readonly exitPrice: string | null;
  readonly realizedPnl: string; readonly pnlPct: string; readonly closeReason: string | null;
  readonly lifecycle: ReadonlyArray<{
    tsMs: number; type: TradeLifecycleEvidence['type']; price: string | null; qty: string | null; note?: string | null;
  }>;
}

interface PageEnvelope<T> { readonly items: readonly T[]; readonly nextCursor: string | null; }

/** Live TradeEvidenceReadPort over the Ops Read Surface A `/ops/trade-evidence` batch endpoint. */
export class HttpTradeEvidenceAdapter implements TradeEvidenceReadPort {
  private readonly client: OpsReadClient;

  constructor(client: OpsReadClient) { this.client = client; }

  async getTradeEvidence(query: TradeEvidenceQuery): Promise<readonly TradeEvidenceBundle[]> {
    if (query.tradeIds.length === 0) return [];
    const rows: TradeEvidenceRow[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ tradeIds: query.tradeIds.join(',') });
      if (cursor) params.set('cursor', cursor);
      const page = await this.client.get<PageEnvelope<TradeEvidenceRow>>(`/ops/trade-evidence?${params.toString()}`);
      rows.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return rows.map((r) => ({
      tradeId: r.tradeId, runId: r.runId, symbol: r.symbol, side: r.side,
      enteredAtMs: r.openedAtMs, closedAtMs: r.closedAtMs,
      entryPrice: r.entryPrice, exitPrice: r.exitPrice,
      realizedPnl: r.realizedPnl, pnlPct: r.pnlPct,
      holdingDurationMs: r.closedAtMs != null ? r.closedAtMs - r.openedAtMs : null,
      closeReason: r.closeReason,
      lifecycleEvents: r.lifecycle.map((e) => ({
        tsMs: e.tsMs, type: e.type, price: e.price ?? null, qty: e.qty ?? null, note: e.note ?? null,
      })),
      minuteContext: [], // dropped — Slice A's per-trade context owns the market window
    }));
  }
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run src/adapters/platform/http-trade-evidence.adapter.test.ts && npm run typecheck`
Expected: PASS (all 4 adapter tests) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/http-trade-evidence.adapter.ts src/adapters/platform/http-trade-evidence.adapter.test.ts
git commit -m "feat(platform): HttpTradeEvidenceAdapter over /ops/trade-evidence (lab side of Slice B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `selectTradeEvidence` selector + composition wiring

**Files:**
- Create: `src/adapters/platform/select-trade-evidence.ts`
- Modify: `src/composition.ts` (use the selector for `tradeEvidence`)
- Test: `src/adapters/platform/select-trade-evidence.test.ts`

**Interfaces:**
- Consumes: `HttpTradeEvidenceAdapter` (Task 1); `OpsReadClient`; `MockTradeEvidenceAdapter` (`./mock-trade-evidence.adapter.ts`); `FixtureTradeEvidenceAdapter` (`./fixture-trade-evidence.adapter.ts`, ctor `(dir: string)`); `parseBotResultsIntegration` (`./select-bot-results.ts`).
- Produces: `export function selectTradeEvidence(source: NodeJS.ProcessEnv): TradeEvidenceReadPort`.

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/select-trade-evidence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectTradeEvidence } from './select-trade-evidence.ts';
import { HttpTradeEvidenceAdapter } from './http-trade-evidence.adapter.ts';
import { MockTradeEvidenceAdapter } from './mock-trade-evidence.adapter.ts';
import { FixtureTradeEvidenceAdapter } from './fixture-trade-evidence.adapter.ts';

describe('selectTradeEvidence', () => {
  it('returns the HTTP adapter on the http integration path', () => {
    const port = selectTradeEvidence({ LAB_BOT_RESULTS_INTEGRATION: 'http', LAB_OPS_READ_URL: 'http://ops:8839', LAB_OPS_READ_TOKEN: 'tok' } as NodeJS.ProcessEnv);
    expect(port).toBeInstanceOf(HttpTradeEvidenceAdapter);
  });
  it('returns the Mock adapter by default (no env)', () => {
    expect(selectTradeEvidence({} as NodeJS.ProcessEnv)).toBeInstanceOf(MockTradeEvidenceAdapter);
  });
  it('returns the Fixture adapter on the fixture integration path', () => {
    const port = selectTradeEvidence({ LAB_BOT_RESULTS_INTEGRATION: 'fixture', LAB_OPS_READ_FIXTURE_DIR: '/tmp/x' } as NodeJS.ProcessEnv);
    expect(port).toBeInstanceOf(FixtureTradeEvidenceAdapter);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/platform/select-trade-evidence.test.ts`
Expected: FAIL — module `./select-trade-evidence.ts` does not exist.

- [ ] **Step 3: Write the selector**

Create `src/adapters/platform/select-trade-evidence.ts`:

```ts
import { fileURLToPath } from 'node:url';
import type { TradeEvidenceReadPort } from '../../ports/trade-evidence-read.port.ts';
import { MockTradeEvidenceAdapter } from './mock-trade-evidence.adapter.ts';
import { FixtureTradeEvidenceAdapter } from './fixture-trade-evidence.adapter.ts';
import { HttpTradeEvidenceAdapter } from './http-trade-evidence.adapter.ts';
import { OpsReadClient } from './ops-read-client.ts';
import { parseBotResultsIntegration } from './select-bot-results.ts';

function defaultFixtureDir(): string {
  return fileURLToPath(new URL('./__fixtures__/trade-evidence', import.meta.url));
}

/** Boot-safe selector for the trade-evidence read surface — same ops.3 axis as bot-results
 *  (`LAB_BOT_RESULTS_INTEGRATION`), reusing the same OpsReadClient config on the http path. */
export function selectTradeEvidence(source: NodeJS.ProcessEnv): TradeEvidenceReadPort {
  const integration = parseBotResultsIntegration(source.LAB_BOT_RESULTS_INTEGRATION);
  if (integration === 'http') {
    return new HttpTradeEvidenceAdapter(new OpsReadClient({
      baseUrl: source.LAB_OPS_READ_URL ?? 'http://127.0.0.1:8839',
      token: source.LAB_OPS_READ_TOKEN ?? '',
    }));
  }
  if (integration === 'fixture') {
    return new FixtureTradeEvidenceAdapter(source.LAB_OPS_READ_FIXTURE_DIR ?? defaultFixtureDir());
  }
  return new MockTradeEvidenceAdapter();
}
```

- [ ] **Step 4: Wire it in composition**

In `src/composition.ts`: add the import `import { selectTradeEvidence } from './adapters/platform/select-trade-evidence.ts';` (next to the `selectBotResults` import), and replace the line `tradeEvidence: new MockTradeEvidenceAdapter(),` with:

```ts
    tradeEvidence: selectTradeEvidence(process.env),
```

Remove the now-unused `import { MockTradeEvidenceAdapter } from './adapters/platform/mock-trade-evidence.adapter.ts';` from `composition.ts` (it moved into the selector). (If `npm run typecheck` flags the unused import, that confirms it must go.)

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `npx vitest run src/adapters/platform/select-trade-evidence.test.ts && npm run typecheck`
Expected: PASS (3 selector tests) and typecheck exit 0 (no unused-import error in `composition.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/platform/select-trade-evidence.ts src/adapters/platform/select-trade-evidence.test.ts src/composition.ts
git commit -m "feat(platform): select trade-evidence adapter by ops-read integration (Slice B wiring)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: drop the raw minute-context lines from `forensicBundleText`

**Files:**
- Modify: `src/adapters/researcher/mastra-researcher.ts` (`forensicBundleText`)
- Test: `src/adapters/researcher/mastra-researcher.test.ts` (update the existing forensic assertion)

**Interfaces:**
- Consumes: the existing `forensicBundleText(bundles)` (renders trade line with `entryPrice`/`exitPrice` + `lifecycle …` lines + `minute …` lines).
- Produces: same function, no longer emitting `minute …` lines.

- [ ] **Step 1: Update the failing test**

In `src/adapters/researcher/mastra-researcher.test.ts`, the test `'includes full strategy profile details and forensic trade evidence when available'` currently asserts (line ~85):

```ts
    expect(out).toContain('close=1.11 volume=18000 oi=390000');
```

Replace that line with an assertion that the raw minute line is gone (while keeping the trade-line + lifecycle assertions above it):

```ts
    expect(out).not.toContain('close=1.11 volume=18000'); // raw minute-context dropped (redundant with per-trade context)
    expect(out).not.toMatch(/^ {2}minute tsMs=/m);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts -t forensic`
Expected: FAIL — `forensicBundleText` still emits the `minute …` lines, so `not.toContain`/`not.toMatch` fail.

- [ ] **Step 3: Remove the minute-context rendering**

In `src/adapters/researcher/mastra-researcher.ts`, in `forensicBundleText`, delete the `...bundle.minuteContext.map((point) => …)` block (the `  minute tsMs=… close=… volume=… oi=… liquidationsLong=… liquidationsShort=…` lines). Keep the trade-level line (with `entryPrice`/`exitPrice`) and the `...bundle.lifecycleEvents.map((event) => …)` lifecycle lines. The resulting per-bundle output is the trade line followed by its lifecycle events only.

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts && npm run typecheck`
Expected: PASS (the forensic test now asserts no minute lines; the trade-line + `type=dca` lifecycle assertions still pass) and typecheck exit 0.

- [ ] **Step 5: Run the full suite (no regression)**

Run: `npx vitest run`
Expected: 0 failed; passed count ≥ baseline + the new adapter/selector tests.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/researcher/mastra-researcher.ts src/adapters/researcher/mastra-researcher.test.ts
git commit -m "feat(research): drop redundant raw minute-context from forensic evidence (Slice B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after Task 3)

- [ ] `npm run typecheck` → exit 0.
- [ ] `npx vitest run` → 0 failed.
- [ ] `git diff main -- src/research-math src/ports` is empty (engine + port types untouched).
- [ ] `git diff main -- package.json` empty (no new deps).
- [ ] Live integration-verification is deferred to the platform release (the handoff doc) — note in the PR.

## Task dependency graph

- **Task 1** (adapter) → prerequisite for **Task 2** (selector uses it).
- **Task 3** (formatter) is independent.
- Suggested order: T1 → T2 → T3 (one implementer at a time).
