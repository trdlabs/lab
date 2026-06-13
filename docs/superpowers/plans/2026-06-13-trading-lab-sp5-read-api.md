# SP-5 — Read-Only API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only, sanitized, paginated, service-to-service-authenticated HTTP API in trading-lab (hypotheses / backtests / agent-events) for a future `TradingLabHttpConnector` in trading-office.

**Architecture:** Hexagonal CQRS-lite. Three read-only query ports (no write methods) with Drizzle adapters (own row→domain mapping, reuse `db`/`pool`) + seedable in-memory fakes. A separate Hono app (`createReadApp`) on its own port (`READ_API_PORT`, same process), deny-by-default DTO mappers, keyset cursor pagination, a service-to-service bearer middleware, and a read-boundary import guard. Reads trading-lab's own Postgres only — never `trading-platform`, never the write side.

**Tech Stack:** TypeScript (Node 22, `node --experimental-strip-types`, ESM, `.ts` import specifiers), Hono 4.6 + `@hono/node-server`, Drizzle ORM 0.36 + drizzle-kit 0.28 (Postgres), Zod 3, Vitest 2. Spec: `docs/superpowers/specs/2026-06-13-trading-lab-sp5-read-api-design.md`.

**Conventions:** commit subjects `feat(sp5): …` / `test(sp5): …` / `chore(sp5): …`; every commit ends with the Opus co-author trailer:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```
Run a single test file: `pnpm vitest run <path>`. Run all: `pnpm test`. Typecheck: `pnpm typecheck`. Drizzle integration tests are gated on `DATABASE_URL` and skip when it is unset.

---

## File Structure

**New (read contracts + keyset type):**
- `src/ports/keyset.ts` — `Cursor { t, id }` structured keyset position (shared by ports + read-api).
- `src/ports/hypothesis-read.port.ts`, `src/ports/backtest-read.port.ts`, `src/ports/agent-event-read.port.ts`.

**New (read adapters):**
- `src/adapters/read/{drizzle,in-memory}-hypothesis-read.adapter.ts`
- `src/adapters/read/{drizzle,in-memory}-backtest-read.adapter.ts`
- `src/adapters/read/{drizzle,in-memory}-agent-event-read.adapter.ts`

**New (HTTP driving adapter):**
- `src/read-api/pagination.ts` — opaque wire cursor codec + `InvalidCursorError`.
- `src/read-api/dto.ts` — DTO types + Zod query schemas.
- `src/read-api/mappers.ts` — domain/row → DTO projection + sanitization.
- `src/read-api/auth.ts` — `readAuthMiddleware` (constant-time bearer).
- `src/read-api/deps.ts` — `ReadApiDeps`.
- `src/read-api/routes/{hypotheses,backtests,agent-events,health}.ts`
- `src/read-api/read-app.ts` — `createReadApp`.
- `src/read-api/read-boundary.guard.test.ts` — import guard.

**Modified:**
- `src/config/env.ts` — `READ_API_PORT`, `TRADING_LAB_READ_TOKEN`.
- `src/db/schema.ts` — `created_at` indexes on `agent_event`, `hypothesis_proposal`, `backtest_run`.
- `src/composition.ts` — build read adapters + `checkReadiness`, return `read`.
- `src/ingress/server.ts` — second `serve()` on `READ_API_PORT` iff token set.
- `migrations/` — generated index migration.

**Layering rule (enforced by Task 17):** `keyset.ts` defines the structured `Cursor`; `read-api/pagination.ts` adds the wire codec on top of it. Ports take a **structured `after?: Cursor`** and return **arrays**; the read-app owns the opaque wire cursor and computes `nextCursor`. The data layer never sees the wire format.

---

## Task 1: Env config — READ_API_PORT + TRADING_LAB_READ_TOKEN

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts` (create if absent; otherwise add cases)

- [ ] **Step 1: Write the failing test**

Create/append `src/config/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';

describe('loadEnv read API config', () => {
  it('defaults READ_API_PORT to 3100 and token to undefined', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.READ_API_PORT).toBe(3100);
    expect(env.TRADING_LAB_READ_TOKEN).toBeUndefined();
  });

  it('reads READ_API_PORT and TRADING_LAB_READ_TOKEN from source', () => {
    const env = loadEnv({ READ_API_PORT: '4601', TRADING_LAB_READ_TOKEN: 'secret' } as unknown as NodeJS.ProcessEnv);
    expect(env.READ_API_PORT).toBe(4601);
    expect(env.TRADING_LAB_READ_TOKEN).toBe('secret');
  });
});
```

- [ ] **Step 2: Run it, confirm failure**

Run: `pnpm vitest run src/config/env.test.ts`
Expected: FAIL (`READ_API_PORT` undefined on the returned object).

- [ ] **Step 3: Implement**

In `src/config/env.ts`, add to the `Env` interface (after `INGRESS_PORT: number;`):

```ts
  READ_API_PORT: number;
  TRADING_LAB_READ_TOKEN?: string;
```

In `loadEnv`'s returned object (after `INGRESS_PORT: parsePort(source.INGRESS_PORT, 3000),`):

```ts
    READ_API_PORT: parsePort(source.READ_API_PORT, 3100),
    TRADING_LAB_READ_TOKEN: source.TRADING_LAB_READ_TOKEN,
```

- [ ] **Step 4: Run, confirm pass**

Run: `pnpm vitest run src/config/env.test.ts` → PASS. Then `pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(sp5): add READ_API_PORT + TRADING_LAB_READ_TOKEN env" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Keyset type + opaque cursor codec

**Files:**
- Create: `src/ports/keyset.ts`
- Create: `src/read-api/pagination.ts`
- Test: `src/read-api/pagination.test.ts`

- [ ] **Step 1: Write the keyset type**

`src/ports/keyset.ts`:

```ts
// Structured keyset position for time-ordered pagination. `t` is an ISO-8601 createdAt.
export interface Cursor {
  t: string;
  id: string;
}
```

- [ ] **Step 2: Write the failing test**

`src/read-api/pagination.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, InvalidCursorError } from './pagination.ts';

describe('cursor codec', () => {
  it('round-trips a cursor', () => {
    const c = { t: '2026-01-01T00:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('rejects non-base64 / truncated / tampered / wrong-shape cursors with InvalidCursorError', () => {
    const valid = encodeCursor({ t: '2026-01-01T00:00:00.000Z', id: 'abc' });
    for (const bad of ['', '!!!!', valid.slice(0, valid.length - 3), Buffer.from('{"t":1}', 'utf8').toString('base64url'), Buffer.from('not json', 'utf8').toString('base64url')]) {
      expect(() => decodeCursor(bad)).toThrow(InvalidCursorError);
    }
  });

  it('error message leaks no internals', () => {
    try { decodeCursor('garbage'); } catch (e) {
      expect((e as Error).message).toBe('invalid cursor');
    }
  });
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `pnpm vitest run src/read-api/pagination.test.ts`
Expected: FAIL (`pagination.ts` not found).

- [ ] **Step 4: Implement**

`src/read-api/pagination.ts`:

```ts
import { z } from 'zod';
import type { Cursor } from '../ports/keyset.ts';

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

const CursorSchema = z.object({ t: z.string().datetime(), id: z.string().min(1) });

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidCursorError();
  }
  const result = CursorSchema.safeParse(parsed);
  if (!result.success) throw new InvalidCursorError();
  return result.data;
}
```

> Note (R9.1): keyset cursors do not time-expire — a stale cursor decodes fine and yields whatever rows follow it (graceful). Only malformed cursors error, and always as a generic `invalid cursor` with no decode detail.

- [ ] **Step 5: Run, confirm pass**

Run: `pnpm vitest run src/read-api/pagination.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ports/keyset.ts src/read-api/pagination.ts src/read-api/pagination.test.ts
git commit -m "feat(sp5): keyset Cursor type + opaque wire cursor codec" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Read ports (interfaces)

Type-only files; no standalone test (the in-memory fakes in Tasks 4–6 exercise the contracts).

**Files:**
- Create: `src/ports/hypothesis-read.port.ts`, `src/ports/backtest-read.port.ts`, `src/ports/agent-event-read.port.ts`

- [ ] **Step 1: Write the three port files**

`src/ports/hypothesis-read.port.ts`:

```ts
import type { HypothesisProposal, HypothesisStatus } from '../domain/hypothesis.ts';
import type { Cursor } from './keyset.ts';

export interface HypothesisListQuery {
  status?: HypothesisStatus;
  profileId?: string;
  limit: number;
  after?: Cursor;
}

export interface HypothesisReadPort {
  list(q: HypothesisListQuery): Promise<HypothesisProposal[]>;
  getById(id: string): Promise<HypothesisProposal | null>;
}
```

`src/ports/backtest-read.port.ts`:

```ts
import type { BacktestRun, BacktestRunStatus } from '../domain/backtest-run.ts';
import type { Cursor } from './keyset.ts';

export interface BacktestListQuery {
  hypothesisId?: string;
  status?: BacktestRunStatus;
  limit: number;
  after?: Cursor;
}

export interface BacktestReadPort {
  list(q: BacktestListQuery): Promise<BacktestRun[]>;
  getById(id: string): Promise<BacktestRun | null>;
}
```

`src/ports/agent-event-read.port.ts`:

```ts
import type { Cursor } from './keyset.ts';

export interface AgentEventRow {
  id: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown>; // raw — consumed only by the sanitizing mapper, never serialized
  createdAt: string;
  correlationId?: string;
}

export interface AgentEventListQuery {
  taskId?: string;
  type?: string;
  since?: string; // ISO-8601
  correlationId?: string;
  limit: number;
  after?: Cursor;
}

export interface AgentEventReadPort {
  list(q: AgentEventListQuery): Promise<AgentEventRow[]>;
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm typecheck` → clean.

```bash
git add src/ports/hypothesis-read.port.ts src/ports/backtest-read.port.ts src/ports/agent-event-read.port.ts
git commit -m "feat(sp5): read-only query ports (hypothesis/backtest/agent-event)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: In-memory backtest read fake

**Files:**
- Create: `src/adapters/read/in-memory-backtest-read.adapter.ts`
- Test: `src/adapters/read/in-memory-backtest-read.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

`src/adapters/read/in-memory-backtest-read.adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryBacktestReadAdapter } from './in-memory-backtest-read.adapter.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';

function run(id: string, over: Partial<BacktestRun> = {}): BacktestRun {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id, hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'mock-run', correlationId: 'c1', params: {}, paramsHash: 'sha:p', bundleHash: 'sha:b',
    status: 'completed', baselineModuleId: 'm0', variantModuleId: 'm1',
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'mock-0', sdkContractVersion: 'sdk-0',
    submittedAt: now, finishedAt: null, createdAt: now, updatedAt: now, ...over,
  };
}

describe('InMemoryBacktestReadAdapter', () => {
  const seed = [
    run('r1', { createdAt: '2026-01-01T00:00:01.000Z', hypothesisId: 'h1', status: 'completed' }),
    run('r2', { createdAt: '2026-01-01T00:00:02.000Z', hypothesisId: 'h1', status: 'evaluated' }),
    run('r3', { createdAt: '2026-01-01T00:00:03.000Z', hypothesisId: 'h2', status: 'completed' }),
  ];

  it('lists newest-first', async () => {
    const a = new InMemoryBacktestReadAdapter(seed);
    const rows = await a.list({ limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('filters by hypothesisId and status', async () => {
    const a = new InMemoryBacktestReadAdapter(seed);
    expect((await a.list({ hypothesisId: 'h1', limit: 10 })).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect((await a.list({ status: 'completed', limit: 10 })).map((r) => r.id)).toEqual(['r3', 'r1']);
  });

  it('paginates by keyset (after)', async () => {
    const a = new InMemoryBacktestReadAdapter(seed);
    const first = await a.list({ limit: 2 });
    expect(first.map((r) => r.id)).toEqual(['r3', 'r2']);
    const last = first[first.length - 1];
    const next = await a.list({ limit: 2, after: { t: last.createdAt, id: last.id } });
    expect(next.map((r) => r.id)).toEqual(['r1']);
  });

  it('getById returns the row or null', async () => {
    const a = new InMemoryBacktestReadAdapter(seed);
    expect((await a.getById('r2'))?.id).toBe('r2');
    expect(await a.getById('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm vitest run src/adapters/read/in-memory-backtest-read.adapter.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`src/adapters/read/in-memory-backtest-read.adapter.ts`:

```ts
import type { BacktestRun } from '../../domain/backtest-run.ts';
import type { BacktestReadPort, BacktestListQuery } from '../../ports/backtest-read.port.ts';

// DESC by (createdAt, id): newest first.
function cmpDesc(a: BacktestRun, b: BacktestRun): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

export class InMemoryBacktestReadAdapter implements BacktestReadPort {
  constructor(private readonly seed: BacktestRun[] = []) {}

  async list(q: BacktestListQuery): Promise<BacktestRun[]> {
    let rows = [...this.seed];
    if (q.hypothesisId) rows = rows.filter((r) => r.hypothesisId === q.hypothesisId);
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    rows.sort(cmpDesc);
    if (q.after) {
      const { t, id } = q.after;
      rows = rows.filter((r) => r.createdAt < t || (r.createdAt === t && r.id < id));
    }
    return rows.slice(0, q.limit);
  }

  async getById(id: string): Promise<BacktestRun | null> {
    return this.seed.find((r) => r.id === id) ?? null;
  }
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `pnpm vitest run src/adapters/read/in-memory-backtest-read.adapter.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/read/in-memory-backtest-read.adapter.ts src/adapters/read/in-memory-backtest-read.adapter.test.ts
git commit -m "feat(sp5): in-memory backtest read fake (keyset, filters)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: In-memory hypothesis read fake

**Files:**
- Create: `src/adapters/read/in-memory-hypothesis-read.adapter.ts`
- Test: `src/adapters/read/in-memory-hypothesis-read.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

`src/adapters/read/in-memory-hypothesis-read.adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryHypothesisReadAdapter } from './in-memory-hypothesis-read.adapter.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';

function hyp(id: string, over: Partial<HypothesisProposal> = {}): HypothesisProposal {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id, strategyProfileId: 'p1', thesis: 't', targetBehavior: 'tb',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'x>1', action: 'block_entry', params: {} }] },
    requiredFeatures: ['oi'], validationPlan: 'plan',
    expectedEffect: { metric: 'pnl', direction: 'increase' },
    invalidationCriteria: ['c'], confidence: 0.7, status: 'validated', fingerprint: 'fp',
    proposal: {} as HypothesisProposal['proposal'], issues: [], contractVersion: 'v1',
    createdAt: now, updatedAt: now, ...over,
  };
}

describe('InMemoryHypothesisReadAdapter', () => {
  const seed = [
    hyp('h1', { createdAt: '2026-01-01T00:00:01.000Z', strategyProfileId: 'p1', status: 'validated' }),
    hyp('h2', { createdAt: '2026-01-01T00:00:02.000Z', strategyProfileId: 'p2', status: 'rejected' }),
  ];

  it('lists newest-first and filters by status + profileId', async () => {
    const a = new InMemoryHypothesisReadAdapter(seed);
    expect((await a.list({ limit: 10 })).map((h) => h.id)).toEqual(['h2', 'h1']);
    expect((await a.list({ status: 'rejected', limit: 10 })).map((h) => h.id)).toEqual(['h2']);
    expect((await a.list({ profileId: 'p1', limit: 10 })).map((h) => h.id)).toEqual(['h1']);
  });

  it('getById returns the row or null', async () => {
    const a = new InMemoryHypothesisReadAdapter(seed);
    expect((await a.getById('h1'))?.id).toBe('h1');
    expect(await a.getById('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure** — `pnpm vitest run src/adapters/read/in-memory-hypothesis-read.adapter.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/adapters/read/in-memory-hypothesis-read.adapter.ts`:

```ts
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { HypothesisReadPort, HypothesisListQuery } from '../../ports/hypothesis-read.port.ts';

function cmpDesc(a: HypothesisProposal, b: HypothesisProposal): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

export class InMemoryHypothesisReadAdapter implements HypothesisReadPort {
  constructor(private readonly seed: HypothesisProposal[] = []) {}

  async list(q: HypothesisListQuery): Promise<HypothesisProposal[]> {
    let rows = [...this.seed];
    if (q.status) rows = rows.filter((h) => h.status === q.status);
    if (q.profileId) rows = rows.filter((h) => h.strategyProfileId === q.profileId);
    rows.sort(cmpDesc);
    if (q.after) {
      const { t, id } = q.after;
      rows = rows.filter((h) => h.createdAt < t || (h.createdAt === t && h.id < id));
    }
    return rows.slice(0, q.limit);
  }

  async getById(id: string): Promise<HypothesisProposal | null> {
    return this.seed.find((h) => h.id === id) ?? null;
  }
}
```

- [ ] **Step 4: Run, confirm pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/read/in-memory-hypothesis-read.adapter.ts src/adapters/read/in-memory-hypothesis-read.adapter.test.ts
git commit -m "feat(sp5): in-memory hypothesis read fake (keyset, filters)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: In-memory agent-event read fake

**Files:**
- Create: `src/adapters/read/in-memory-agent-event-read.adapter.ts`
- Test: `src/adapters/read/in-memory-agent-event-read.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

`src/adapters/read/in-memory-agent-event-read.adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryAgentEventReadAdapter } from './in-memory-agent-event-read.adapter.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

function ev(id: string, over: Partial<AgentEventRow> = {}): AgentEventRow {
  return { id, taskId: 't1', type: 'strategy_analyst.started', payload: {}, createdAt: '2026-01-01T00:00:00.000Z', ...over };
}

describe('InMemoryAgentEventReadAdapter', () => {
  const seed = [
    ev('e1', { createdAt: '2026-01-01T00:00:01.000Z', taskId: 't1', type: 'strategy_analyst.started', correlationId: 'c1' }),
    ev('e2', { createdAt: '2026-01-01T00:00:02.000Z', taskId: 't1', type: 'strategy_analyst.completed', correlationId: 'c1' }),
    ev('e3', { createdAt: '2026-01-01T00:00:03.000Z', taskId: 't2', type: 'strategy_analyst.started', correlationId: 'c2' }),
  ];

  it('lists oldest-first (backfill order)', async () => {
    const a = new InMemoryAgentEventReadAdapter(seed);
    expect((await a.list({ limit: 10 })).map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('filters by taskId, type, since, correlationId', async () => {
    const a = new InMemoryAgentEventReadAdapter(seed);
    expect((await a.list({ taskId: 't1', limit: 10 })).map((r) => r.id)).toEqual(['e1', 'e2']);
    expect((await a.list({ type: 'strategy_analyst.started', limit: 10 })).map((r) => r.id)).toEqual(['e1', 'e3']);
    expect((await a.list({ since: '2026-01-01T00:00:02.000Z', limit: 10 })).map((r) => r.id)).toEqual(['e2', 'e3']);
    expect((await a.list({ correlationId: 'c2', limit: 10 })).map((r) => r.id)).toEqual(['e3']);
  });

  it('paginates ascending by keyset', async () => {
    const a = new InMemoryAgentEventReadAdapter(seed);
    const first = await a.list({ limit: 2 });
    const last = first[first.length - 1];
    const next = await a.list({ limit: 2, after: { t: last.createdAt, id: last.id } });
    expect(next.map((r) => r.id)).toEqual(['e3']);
  });
});
```

- [ ] **Step 2: Run, confirm failure** — FAIL.

- [ ] **Step 3: Implement**

`src/adapters/read/in-memory-agent-event-read.adapter.ts`:

```ts
import type { AgentEventReadPort, AgentEventListQuery, AgentEventRow } from '../../ports/agent-event-read.port.ts';

function cmpAsc(a: AgentEventRow, b: AgentEventRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export class InMemoryAgentEventReadAdapter implements AgentEventReadPort {
  constructor(private readonly seed: AgentEventRow[] = []) {}

  async list(q: AgentEventListQuery): Promise<AgentEventRow[]> {
    let rows = [...this.seed];
    if (q.taskId) rows = rows.filter((r) => r.taskId === q.taskId);
    if (q.type) rows = rows.filter((r) => r.type === q.type);
    if (q.since) rows = rows.filter((r) => r.createdAt >= q.since!);
    if (q.correlationId) rows = rows.filter((r) => r.correlationId === q.correlationId);
    rows.sort(cmpAsc);
    if (q.after) {
      const { t, id } = q.after;
      rows = rows.filter((r) => r.createdAt > t || (r.createdAt === t && r.id > id));
    }
    return rows.slice(0, q.limit);
  }
}
```

- [ ] **Step 4: Run, confirm pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/read/in-memory-agent-event-read.adapter.ts src/adapters/read/in-memory-agent-event-read.adapter.test.ts
git commit -m "feat(sp5): in-memory agent-event read fake (asc keyset, filters)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: created_at indexes + migration

**Files:**
- Modify: `src/db/schema.ts` (index blocks for `agentEvent`, `hypothesisProposal`, `backtestRun`)
- Create: `migrations/<generated>.sql` (via drizzle-kit)

- [ ] **Step 1: Add composite `(created_at, id)` indexes**

In `src/db/schema.ts`, extend each table's index block (the `(t) => ({ … })` argument).

`agentEvent` block — add alongside `taskIdx`:
```ts
  createdIdx: index('agent_event_created_idx').on(t.createdAt, t.id),
```
`hypothesisProposal` block — add alongside `statusIdx`:
```ts
  createdIdx: index('hypothesis_proposal_created_idx').on(t.createdAt, t.id),
```
`backtestRun` block — add alongside `statusIdx`:
```ts
  createdIdx: index('backtest_run_created_idx').on(t.createdAt, t.id),
```
(`index` is already imported in `schema.ts`.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file under `migrations/` containing three `CREATE INDEX … (created_at, id)` statements; `pnpm typecheck` clean.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts migrations/
git commit -m "feat(sp5): created_at keyset indexes for read pagination" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Drizzle backtest read adapter (integration)

**Files:**
- Create: `src/adapters/read/drizzle-backtest-read.adapter.ts`
- Test: `src/adapters/read/drizzle-backtest-read.adapter.test.ts` (gated on `DATABASE_URL`)

- [ ] **Step 1: Write the failing integration test**

`src/adapters/read/drizzle-backtest-read.adapter.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDbClient } from '../../db/client.ts';
import { backtestRun } from '../../db/schema.ts';
import { DrizzleBacktestReadAdapter } from './drizzle-backtest-read.adapter.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('DrizzleBacktestReadAdapter', () => {
  const { db, pool } = createDbClient(url!);
  const ids = ['sp5r1', 'sp5r2', 'sp5r3'];

  beforeAll(async () => {
    await db.delete(backtestRun).where(inArray(backtestRun.id, ids));
    let i = 1;
    for (const id of ids) {
      await db.insert(backtestRun).values({
        id, hypothesisBuildId: 'b', hypothesisId: id === 'sp5r3' ? 'hB' : 'hA', strategyProfileId: 'p',
        platformRunId: 'mock', correlationId: 'c', params: {}, paramsHash: `ph-${id}`, bundleHash: `bh-${id}`,
        status: 'completed', baselineModuleId: 'm0', variantModuleId: 'm1',
        artifactRefs: [], platformContractVersion: 'mock-0', sdkContractVersion: 'sdk-0',
        submittedAt: new Date(`2026-02-0${i}T00:00:00Z`), createdAt: new Date(`2026-02-0${i}T00:00:00Z`), updatedAt: new Date(`2026-02-0${i}T00:00:00Z`),
      });
      i++;
    }
  });

  afterAll(async () => {
    await db.delete(backtestRun).where(inArray(backtestRun.id, ids));
    await pool.end();
  });

  it('lists newest-first within a hypothesis filter', async () => {
    const a = new DrizzleBacktestReadAdapter(db);
    expect((await a.list({ hypothesisId: 'hA', limit: 50 })).map((r) => r.id)).toEqual(['sp5r2', 'sp5r1']);
    expect((await a.list({ hypothesisId: 'hB', limit: 50 })).map((r) => r.id)).toEqual(['sp5r3']);
  });

  it('keyset paginates', async () => {
    const a = new DrizzleBacktestReadAdapter(db);
    const page1 = await a.list({ limit: 1, hypothesisId: 'hA' });
    expect(page1[0].id).toBe('sp5r2');
    const after = { t: page1[0].createdAt, id: page1[0].id };
    const page2 = await a.list({ limit: 1, hypothesisId: 'hA', after });
    expect(page2[0].id).toBe('sp5r1');
  });
});
```

> The integration test is gated on `DATABASE_URL` (skips when unset) and self-cleans its inserted rows in `afterAll`.

- [ ] **Step 2: Run, confirm failure (or skip without DB)**

Run: `DATABASE_URL=... pnpm vitest run src/adapters/read/drizzle-backtest-read.adapter.test.ts`
Expected: FAIL (adapter missing). Without `DATABASE_URL`: SKIPPED.

- [ ] **Step 3: Implement**

`src/adapters/read/drizzle-backtest-read.adapter.ts`:

```ts
import { eq, and, or, lt, desc } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { backtestRun } from '../../db/schema.ts';
import type { BacktestRun, BacktestRunStatus } from '../../domain/backtest-run.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { BacktestReadPort, BacktestListQuery } from '../../ports/backtest-read.port.ts';

type Row = typeof backtestRun.$inferSelect;

// Own row→domain mapping inside the read boundary (do NOT import the write adapter — see import guard).
function metricsFromRow(row: Row): BacktestMetricBlock | null {
  if (row.netPnlUsd === null) return null;
  return {
    netPnlUsd: row.netPnlUsd, netPnlPct: row.netPnlPct!, totalTrades: row.totalTrades!, winRate: row.winRate!,
    profitFactor: row.profitFactor!, maxDrawdownPct: row.maxDrawdownPct!, expectancyUsd: row.expectancyUsd!,
    sharpe: row.sharpe!, topTradeContributionPct: row.topTradeContributionPct!,
  };
}

function toDomain(row: Row): BacktestRun {
  return {
    id: row.id, hypothesisBuildId: row.hypothesisBuildId, hypothesisId: row.hypothesisId, strategyProfileId: row.strategyProfileId,
    platformRunId: row.platformRunId, correlationId: row.correlationId, params: row.params, paramsHash: row.paramsHash, bundleHash: row.bundleHash,
    status: row.status as BacktestRunStatus, baselineModuleId: row.baselineModuleId, variantModuleId: row.variantModuleId,
    metrics: metricsFromRow(row), baselineMetrics: (row.baselineMetrics as BacktestMetricBlock | null) ?? null,
    deltaNetPnlUsd: row.deltaNetPnlUsd, deltaMaxDrawdownPct: row.deltaMaxDrawdownPct, isFragile: row.isFragile,
    artifactRefs: row.artifactRefs, platformContractVersion: row.platformContractVersion, sdkContractVersion: row.sdkContractVersion,
    submittedAt: row.submittedAt.toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleBacktestReadAdapter implements BacktestReadPort {
  constructor(private readonly db: Db) {}

  async list(q: BacktestListQuery): Promise<BacktestRun[]> {
    const conds = [];
    if (q.hypothesisId) conds.push(eq(backtestRun.hypothesisId, q.hypothesisId));
    if (q.status) conds.push(eq(backtestRun.status, q.status));
    if (q.after) {
      const d = new Date(q.after.t);
      conds.push(or(lt(backtestRun.createdAt, d), and(eq(backtestRun.createdAt, d), lt(backtestRun.id, q.after.id))));
    }
    const rows = await this.db.select().from(backtestRun)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(backtestRun.createdAt), desc(backtestRun.id))
      .limit(q.limit);
    return rows.map(toDomain);
  }

  async getById(id: string): Promise<BacktestRun | null> {
    const rows = await this.db.select().from(backtestRun).where(eq(backtestRun.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }
}
```

- [ ] **Step 4: Run, confirm pass** — with `DATABASE_URL`: PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/read/drizzle-backtest-read.adapter.ts src/adapters/read/drizzle-backtest-read.adapter.test.ts
git commit -m "feat(sp5): drizzle backtest read adapter (desc keyset)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Drizzle hypothesis read adapter (integration)

**Files:**
- Create: `src/adapters/read/drizzle-hypothesis-read.adapter.ts`
- Test: `src/adapters/read/drizzle-hypothesis-read.adapter.test.ts` (gated on `DATABASE_URL`)

- [ ] **Step 1: Write the failing integration test**

`src/adapters/read/drizzle-hypothesis-read.adapter.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDbClient } from '../../db/client.ts';
import { hypothesisProposal } from '../../db/schema.ts';
import { DrizzleHypothesisReadAdapter } from './drizzle-hypothesis-read.adapter.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('DrizzleHypothesisReadAdapter', () => {
  const { db, pool } = createDbClient(url!);
  const ids = ['sp5h1', 'sp5h2'];

  beforeAll(async () => {
    await db.delete(hypothesisProposal).where(inArray(hypothesisProposal.id, ids));
    let i = 1;
    for (const id of ids) {
      await db.insert(hypothesisProposal).values({
        id, strategyProfileId: id === 'sp5h2' ? 'pB' : 'pA', thesis: 't', targetBehavior: 'tb',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'block_entry', params: {} }] },
        requiredFeatures: ['oi'], validationPlan: 'plan', expectedEffect: { metric: 'pnl', direction: 'increase' },
        invalidationCriteria: ['c'], confidence: 0.7, status: id === 'sp5h2' ? 'rejected' : 'validated',
        fingerprint: `fp-${id}`, proposal: {}, issues: [], contractVersion: 'v1',
        createdAt: new Date(`2026-03-0${i}T00:00:00Z`), updatedAt: new Date(`2026-03-0${i}T00:00:00Z`),
      });
      i++;
    }
  });

  afterAll(async () => {
    await db.delete(hypothesisProposal).where(inArray(hypothesisProposal.id, ids));
    await pool.end();
  });

  it('lists newest-first; filters status + profileId; getById', async () => {
    const a = new DrizzleHypothesisReadAdapter(db);
    const all = (await a.list({ limit: 50 })).filter((h) => ids.includes(h.id)).map((h) => h.id);
    expect(all).toEqual(['sp5h2', 'sp5h1']);
    expect((await a.list({ status: 'rejected', limit: 50 })).filter((h) => ids.includes(h.id)).map((h) => h.id)).toEqual(['sp5h2']);
    expect((await a.list({ profileId: 'pA', limit: 50 })).map((h) => h.id)).toEqual(['sp5h1']);
    expect((await a.getById('sp5h1'))?.status).toBe('validated');
    expect(await a.getById('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure / skip** — FAIL with DB, SKIP without.

- [ ] **Step 3: Implement**

`src/adapters/read/drizzle-hypothesis-read.adapter.ts`:

```ts
import { eq, and, or, lt, desc } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { hypothesisProposal } from '../../db/schema.ts';
import type { HypothesisProposal, HypothesisStatus, RuleAction, ExpectedEffect, HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import type { HypothesisReadPort, HypothesisListQuery } from '../../ports/hypothesis-read.port.ts';

type Row = typeof hypothesisProposal.$inferSelect;

function toDomain(row: Row): HypothesisProposal {
  return {
    id: row.id, strategyProfileId: row.strategyProfileId, thesis: row.thesis, targetBehavior: row.targetBehavior,
    ruleAction: row.ruleAction as RuleAction, requiredFeatures: row.requiredFeatures, validationPlan: row.validationPlan,
    expectedEffect: row.expectedEffect as ExpectedEffect, invalidationCriteria: row.invalidationCriteria, confidence: row.confidence,
    status: row.status as HypothesisStatus, fingerprint: row.fingerprint, proposal: row.proposal as HypothesisProposalDraft,
    issues: row.issues as ValidationIssue[], contractVersion: row.contractVersion,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleHypothesisReadAdapter implements HypothesisReadPort {
  constructor(private readonly db: Db) {}

  async list(q: HypothesisListQuery): Promise<HypothesisProposal[]> {
    const conds = [];
    if (q.status) conds.push(eq(hypothesisProposal.status, q.status));
    if (q.profileId) conds.push(eq(hypothesisProposal.strategyProfileId, q.profileId));
    if (q.after) {
      const d = new Date(q.after.t);
      conds.push(or(lt(hypothesisProposal.createdAt, d), and(eq(hypothesisProposal.createdAt, d), lt(hypothesisProposal.id, q.after.id))));
    }
    const rows = await this.db.select().from(hypothesisProposal)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(hypothesisProposal.createdAt), desc(hypothesisProposal.id))
      .limit(q.limit);
    return rows.map(toDomain);
  }

  async getById(id: string): Promise<HypothesisProposal | null> {
    const rows = await this.db.select().from(hypothesisProposal).where(eq(hypothesisProposal.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }
}
```

- [ ] **Step 4: Run, confirm pass** — PASS with DB.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/read/drizzle-hypothesis-read.adapter.ts src/adapters/read/drizzle-hypothesis-read.adapter.test.ts
git commit -m "feat(sp5): drizzle hypothesis read adapter (desc keyset)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Drizzle agent-event read adapter (correlationId JOIN)

**Files:**
- Create: `src/adapters/read/drizzle-agent-event-read.adapter.ts`
- Test: `src/adapters/read/drizzle-agent-event-read.adapter.test.ts` (gated on `DATABASE_URL`)

- [ ] **Step 1: Write the failing integration test**

`src/adapters/read/drizzle-agent-event-read.adapter.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDbClient } from '../../db/client.ts';
import { agentEvent, researchTask } from '../../db/schema.ts';
import { DrizzleAgentEventReadAdapter } from './drizzle-agent-event-read.adapter.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('DrizzleAgentEventReadAdapter', () => {
  const { db, pool } = createDbClient(url!);
  const taskId = 'sp5task';
  const evIds = ['sp5e1', 'sp5e2'];

  beforeAll(async () => {
    await db.delete(agentEvent).where(inArray(agentEvent.id, evIds));
    await db.delete(researchTask).where(eq(researchTask.id, taskId));
    await db.insert(researchTask).values({
      id: taskId, taskType: 'strategy.onboard', source: 'web', correlationId: 'corr-sp5', status: 'queued', payload: {},
    });
    await db.insert(agentEvent).values([
      { id: 'sp5e1', taskId, type: 'strategy_analyst.started', payload: { secret: 'x' }, createdAt: new Date('2026-04-01T00:00:01Z') },
      { id: 'sp5e2', taskId, type: 'strategy_analyst.completed', payload: { profileId: 'p1' }, createdAt: new Date('2026-04-01T00:00:02Z') },
    ]);
  });

  afterAll(async () => {
    await db.delete(agentEvent).where(inArray(agentEvent.id, evIds));
    await db.delete(researchTask).where(eq(researchTask.id, taskId));
    await pool.end();
  });

  it('lists ascending, resolves correlationId via JOIN, filters by type + correlationId', async () => {
    const a = new DrizzleAgentEventReadAdapter(db);
    const rows = await a.list({ taskId, limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(['sp5e1', 'sp5e2']);
    expect(rows[0].correlationId).toBe('corr-sp5');
    expect((await a.list({ type: 'strategy_analyst.completed', limit: 10 })).some((r) => r.id === 'sp5e2')).toBe(true);
    expect((await a.list({ correlationId: 'corr-sp5', limit: 10 })).map((r) => r.id)).toEqual(['sp5e1', 'sp5e2']);
  });
});
```

- [ ] **Step 2: Run, confirm failure / skip.**

- [ ] **Step 3: Implement**

`src/adapters/read/drizzle-agent-event-read.adapter.ts`:

```ts
import { eq, and, or, gt, gte, asc } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { agentEvent, researchTask } from '../../db/schema.ts';
import type { AgentEventReadPort, AgentEventListQuery, AgentEventRow } from '../../ports/agent-event-read.port.ts';

export class DrizzleAgentEventReadAdapter implements AgentEventReadPort {
  constructor(private readonly db: Db) {}

  async list(q: AgentEventListQuery): Promise<AgentEventRow[]> {
    const conds = [];
    if (q.taskId) conds.push(eq(agentEvent.taskId, q.taskId));
    if (q.type) conds.push(eq(agentEvent.type, q.type));
    if (q.since) conds.push(gte(agentEvent.createdAt, new Date(q.since)));
    if (q.correlationId) conds.push(eq(researchTask.correlationId, q.correlationId));
    if (q.after) {
      const d = new Date(q.after.t);
      conds.push(or(gt(agentEvent.createdAt, d), and(eq(agentEvent.createdAt, d), gt(agentEvent.id, q.after.id))));
    }
    const rows = await this.db
      .select({
        id: agentEvent.id, taskId: agentEvent.taskId, type: agentEvent.type,
        payload: agentEvent.payload, createdAt: agentEvent.createdAt,
        correlationId: researchTask.correlationId,
      })
      .from(agentEvent)
      .leftJoin(researchTask, eq(agentEvent.taskId, researchTask.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(agentEvent.createdAt), asc(agentEvent.id))
      .limit(q.limit);

    return rows.map((r) => ({
      id: r.id, taskId: r.taskId, type: r.type,
      payload: r.payload as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
      ...(r.correlationId ? { correlationId: r.correlationId } : {}),
    }));
  }
}
```

- [ ] **Step 4: Run, confirm pass** — PASS with DB.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/read/drizzle-agent-event-read.adapter.ts src/adapters/read/drizzle-agent-event-read.adapter.test.ts
git commit -m "feat(sp5): drizzle agent-event read adapter (asc keyset + correlationId join)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: DTOs + Zod query schemas

**Files:**
- Create: `src/read-api/dto.ts`
- Test: `src/read-api/dto.test.ts`

- [ ] **Step 1: Write the failing test**

`src/read-api/dto.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { HypothesisListQuerySchema, BacktestListQuerySchema, AgentEventListQuerySchema } from './dto.ts';

describe('query schemas', () => {
  it('defaults limit to 20 and clamps invalid', () => {
    expect(HypothesisListQuerySchema.parse({}).limit).toBe(20);
    expect(HypothesisListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(HypothesisListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(HypothesisListQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('rejects unknown status', () => {
    expect(BacktestListQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(HypothesisListQuerySchema.safeParse({ status: 'validated' }).success).toBe(true);
  });

  it('agent-event since must be ISO datetime', () => {
    expect(AgentEventListQuerySchema.safeParse({ since: 'yesterday' }).success).toBe(false);
    expect(AgentEventListQuerySchema.safeParse({ since: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm failure** — FAIL.

- [ ] **Step 3: Implement**

`src/read-api/dto.ts`:

```ts
import { z } from 'zod';

const limit = z.coerce.number().int().min(1).max(100).default(20);
const BACKTEST_STATUSES = ['queued', 'submitted', 'running', 'completed', 'rejected', 'failed', 'evaluated'] as const;

export const HypothesisListQuerySchema = z.object({
  status: z.enum(['validated', 'rejected']).optional(),
  profileId: z.string().min(1).optional(),
  limit,
  cursor: z.string().min(1).optional(),
});

export const BacktestListQuerySchema = z.object({
  hypothesisId: z.string().min(1).optional(),
  status: z.enum(BACKTEST_STATUSES).optional(),
  limit,
  cursor: z.string().min(1).optional(),
});

export const AgentEventListQuerySchema = z.object({
  taskId: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  correlationId: z.string().min(1).optional(),
  limit,
  cursor: z.string().min(1).optional(),
});

// ---- DTO shapes (allowlist; mappers enforce these) ----
export interface ExpectedEffectDto { metric: string; direction: 'increase' | 'decrease'; magnitude?: string; }
export interface RulesSummaryDto { appliesTo: string; ruleCount: number; }

export interface HypothesisListItemDto {
  id: string; profileId: string; thesis: string; targetBehavior: string;
  status: 'validated' | 'rejected'; confidence: number;
  expectedEffect: ExpectedEffectDto; rulesSummary: RulesSummaryDto;
  createdAt: string; updatedAt: string;
}

export interface CuratedRuleDto { when: string; action: string; rationale?: string; }

export interface HypothesisDetailDto extends HypothesisListItemDto {
  requiredFeatures: string[];
  invalidationCriteria: string[];
  rules: { appliesTo: string; rules: CuratedRuleDto[] };
  rejectionReasons?: string[];
}

export interface BacktestMetricsDto {
  netPnlUsd: number | null; netPnlPct: number | null; totalTrades: number | null; winRate: number | null;
  profitFactor: number | null; maxDrawdownPct: number | null; expectancyUsd: number | null; sharpe: number | null; topTradeContributionPct: number | null;
}

export interface BacktestDto {
  id: string; hypothesisId: string; status: string;
  metrics: BacktestMetricsDto;
  delta: { netPnlUsd: number | null; maxDrawdownPct: number | null };
  isFragile: boolean | null;
  submittedAt: string; finishedAt: string | null; createdAt: string; updatedAt: string;
}

export interface AgentEventDto {
  id: string; ts: string; type: string; taskId: string;
  correlationId?: string;
  level: 'info' | 'warn' | 'error';
  summary: string;
  payloadSummary?: Record<string, unknown>;
}

export interface ListEnvelope<T> { data: T[]; page: { nextCursor: string | null; limit: number }; }
```

- [ ] **Step 4: Run, confirm pass** — PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/read-api/dto.ts src/read-api/dto.test.ts
git commit -m "feat(sp5): read DTO types + zod query schemas" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Mappers — projection + deny-by-default sanitization (R3)

**Files:**
- Create: `src/read-api/mappers.ts`
- Test: `src/read-api/mappers.test.ts`

- [ ] **Step 1: Write the failing test**

`src/read-api/mappers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toHypothesisListItem, toHypothesisDetail, toBacktestDto, toAgentEventDto } from './mappers.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';

const HYP_LIST_KEYS = ['id', 'profileId', 'thesis', 'targetBehavior', 'status', 'confidence', 'expectedEffect', 'rulesSummary', 'createdAt', 'updatedAt'];
const BACKTEST_KEYS = ['id', 'hypothesisId', 'status', 'metrics', 'delta', 'isFragile', 'submittedAt', 'finishedAt', 'createdAt', 'updatedAt'];

function hyp(over: Partial<HypothesisProposal> = {}): HypothesisProposal {
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 'thesis', targetBehavior: 'tb',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'x>1', action: 'block_entry', params: { threshold: 5 }, rationale: 'r' }] },
    requiredFeatures: ['oi'], validationPlan: 'plan', expectedEffect: { metric: 'pnl', direction: 'increase' },
    invalidationCriteria: ['c'], confidence: 0.7, status: 'validated', fingerprint: 'SECRET-FP',
    proposal: { thesis: 'draft' } as HypothesisProposal['proposal'], issues: [], contractVersion: 'v1',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...over,
  };
}
function backtest(over: Partial<BacktestRun> = {}): BacktestRun {
  return {
    id: 'r1', hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1', platformRunId: 'PLAT-SECRET',
    correlationId: 'CORR-SECRET', params: { foo: 'bar' }, paramsHash: 'HASH', bundleHash: 'BHASH', status: 'completed',
    baselineModuleId: 'MOD0', variantModuleId: 'MOD1',
    metrics: { netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.6, profitFactor: 2, maxDrawdownPct: 8, expectancyUsd: 8, sharpe: 1.4, topTradeContributionPct: 22 },
    baselineMetrics: null, deltaNetPnlUsd: 150, deltaMaxDrawdownPct: 1, isFragile: false,
    artifactRefs: ['platform://x'], platformContractVersion: 'PCV', sdkContractVersion: 'SCV',
    submittedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...over,
  };
}

describe('hypothesis mappers', () => {
  it('list item: exact allowlist key set + summary-only rules', () => {
    const dto = toHypothesisListItem(hyp());
    expect(Object.keys(dto).sort()).toEqual([...HYP_LIST_KEYS].sort());
    expect(dto.rulesSummary).toEqual({ appliesTo: 'long', ruleCount: 1 });
    expect(JSON.stringify(dto)).not.toContain('SECRET-FP');
    expect(JSON.stringify(dto)).not.toContain('threshold');
  });

  it('detail: curated rules drop params; never leak fingerprint/proposal/issues/contractVersion', () => {
    const dto = toHypothesisDetail(hyp());
    expect(dto.rules.rules).toEqual([{ when: 'x>1', action: 'block_entry', rationale: 'r' }]);
    const json = JSON.stringify(dto);
    for (const leak of ['SECRET-FP', 'threshold', 'contractVersion', 'draft']) expect(json).not.toContain(leak);
    expect((dto as Record<string, unknown>).fingerprint).toBeUndefined();
  });

  it('detail: rejectionReasons only when rejected', () => {
    expect(toHypothesisDetail(hyp({ status: 'validated' })).rejectionReasons).toBeUndefined();
    const rejected = toHypothesisDetail(hyp({ status: 'rejected', issues: [{ code: 'x', severity: 'error', path: 'a', message: 'too risky' }] }));
    expect(rejected.rejectionReasons).toEqual(['too risky']);
  });
});

describe('backtest mapper', () => {
  it('exact allowlist key set; never leak platform/params/hashes/modules/contracts/artifacts', () => {
    const dto = toBacktestDto(backtest());
    expect(Object.keys(dto).sort()).toEqual([...BACKTEST_KEYS].sort());
    const json = JSON.stringify(dto);
    for (const leak of ['PLAT-SECRET', 'CORR-SECRET', 'HASH', 'BHASH', 'MOD0', 'MOD1', 'PCV', 'SCV', 'platform://x', 'foo']) {
      expect(json).not.toContain(leak);
    }
    expect(dto.metrics.netPnlUsd).toBe(250);
    expect(dto.delta).toEqual({ netPnlUsd: 150, maxDrawdownPct: 1 });
  });

  it('null metrics when not completed', () => {
    const dto = toBacktestDto(backtest({ metrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null }));
    expect(dto.metrics.netPnlUsd).toBeNull();
    expect(dto.delta.netPnlUsd).toBeNull();
  });
});

describe('agent-event mapper (deny-by-default)', () => {
  it('known type: only allowlisted scalar payload keys survive', () => {
    const row: AgentEventRow = { id: 'e1', taskId: 't1', type: 'strategy_analyst.completed', payload: { profileId: 'p1', secret: 'KEY', nested: { a: 1 } }, createdAt: '2026-01-01T00:00:00.000Z', correlationId: 'c1' };
    const dto = toAgentEventDto(row);
    expect(dto.payloadSummary).toEqual({ profileId: 'p1' });
    const json = JSON.stringify(dto);
    expect(json).not.toContain('KEY');
    expect(json).not.toContain('nested');
    expect(dto.level).toBe('info');
    expect(dto.correlationId).toBe('c1');
  });

  it('unknown type: empty payloadSummary + summary derived from type; raw payload never leaks', () => {
    const row: AgentEventRow = { id: 'e2', taskId: 't1', type: 'some.unknown.event', payload: { token: 'SECRET' }, createdAt: '2026-01-01T00:00:00.000Z' };
    const dto = toAgentEventDto(row);
    expect(dto.payloadSummary).toBeUndefined();
    expect(dto.summary).toBe('Some Unknown Event');
    expect(JSON.stringify(dto)).not.toContain('SECRET');
  });

  it('derives error level from type', () => {
    expect(toAgentEventDto({ id: 'e', taskId: 't', type: 'strategy_analyst.failed', payload: {}, createdAt: '2026-01-01T00:00:00.000Z' }).level).toBe('error');
  });
});
```

- [ ] **Step 2: Run, confirm failure** — FAIL.

- [ ] **Step 3: Implement**

`src/read-api/mappers.ts`:

```ts
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';
import type { HypothesisListItemDto, HypothesisDetailDto, BacktestDto, AgentEventDto, CuratedRuleDto } from './dto.ts';

export function toHypothesisListItem(h: HypothesisProposal): HypothesisListItemDto {
  return {
    id: h.id, profileId: h.strategyProfileId, thesis: h.thesis, targetBehavior: h.targetBehavior,
    status: h.status, confidence: h.confidence,
    expectedEffect: { metric: h.expectedEffect.metric, direction: h.expectedEffect.direction, ...(h.expectedEffect.magnitude ? { magnitude: h.expectedEffect.magnitude } : {}) },
    rulesSummary: { appliesTo: h.ruleAction.appliesTo, ruleCount: h.ruleAction.rules.length },
    createdAt: h.createdAt, updatedAt: h.updatedAt,
  };
}

export function toHypothesisDetail(h: HypothesisProposal): HypothesisDetailDto {
  const rules: CuratedRuleDto[] = h.ruleAction.rules.map((r) => ({
    when: r.when, action: r.action, ...(r.rationale ? { rationale: r.rationale } : {}),
  }));
  return {
    ...toHypothesisListItem(h),
    requiredFeatures: h.requiredFeatures,
    invalidationCriteria: h.invalidationCriteria,
    rules: { appliesTo: h.ruleAction.appliesTo, rules },
    ...(h.status === 'rejected' ? { rejectionReasons: h.issues.map((i) => i.message) } : {}),
  };
}

export function toBacktestDto(b: BacktestRun): BacktestDto {
  const m = b.metrics;
  return {
    id: b.id, hypothesisId: b.hypothesisId, status: b.status,
    metrics: {
      netPnlUsd: m?.netPnlUsd ?? null, netPnlPct: m?.netPnlPct ?? null, totalTrades: m?.totalTrades ?? null,
      winRate: m?.winRate ?? null, profitFactor: m?.profitFactor ?? null, maxDrawdownPct: m?.maxDrawdownPct ?? null,
      expectancyUsd: m?.expectancyUsd ?? null, sharpe: m?.sharpe ?? null, topTradeContributionPct: m?.topTradeContributionPct ?? null,
    },
    delta: { netPnlUsd: b.deltaNetPnlUsd, maxDrawdownPct: b.deltaMaxDrawdownPct },
    isFragile: b.isFragile,
    submittedAt: b.submittedAt, finishedAt: b.finishedAt, createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
}

// ---- agent event sanitization (deny-by-default) ----
// type -> allowlist of payload keys that may surface (scalars only).
const PAYLOAD_ALLOWLIST: Record<string, string[]> = {
  'strategy_analyst.started': [],
  'strategy_analyst.completed': ['profileId', 'direction'],
  'strategy_analyst.failed': ['reason'],
  'strategy.onboard.deduped': ['profileId'],
};
const SUMMARY_BY_TYPE: Record<string, string> = {
  'strategy_analyst.started': 'Strategy analysis started',
  'strategy_analyst.completed': 'Strategy analysis completed',
  'strategy_analyst.failed': 'Strategy analysis failed',
  'strategy.onboard.deduped': 'Duplicate strategy onboarding skipped',
};

function deriveLevel(type: string): 'info' | 'warn' | 'error' {
  const t = type.toLowerCase();
  if (t.includes('fail') || t.includes('error') || t.includes('reject')) return 'error';
  if (t.includes('warn') || t.includes('skip') || t.includes('dedup')) return 'warn';
  return 'info';
}
function humanize(type: string): string {
  return type.replace(/[._]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}
function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}
function pickAllowed(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in payload && isScalar(payload[k])) out[k] = payload[k];
  return Object.keys(out).length > 0 ? out : undefined;
}

export function toAgentEventDto(row: AgentEventRow): AgentEventDto {
  const known = Object.prototype.hasOwnProperty.call(PAYLOAD_ALLOWLIST, row.type);
  const payloadSummary = known ? pickAllowed(row.payload, PAYLOAD_ALLOWLIST[row.type]) : undefined;
  const dto: AgentEventDto = {
    id: row.id, ts: row.createdAt, type: row.type, taskId: row.taskId,
    level: deriveLevel(row.type),
    summary: SUMMARY_BY_TYPE[row.type] ?? humanize(row.type),
  };
  if (row.correlationId) dto.correlationId = row.correlationId;
  if (payloadSummary) dto.payloadSummary = payloadSummary;
  return dto;
}
```

> When a new agent-event `type` needs surfaced fields, add it to `PAYLOAD_ALLOWLIST` (+ optionally `SUMMARY_BY_TYPE`). Anything not listed yields no `payloadSummary` — secrets/user content can never leak by omission.

- [ ] **Step 4: Run, confirm pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/read-api/mappers.ts src/read-api/mappers.test.ts
git commit -m "feat(sp5): DTO mappers with deny-by-default sanitization" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Auth middleware (constant-time bearer)

**Files:**
- Create: `src/read-api/auth.ts`
- Test: `src/read-api/auth.test.ts`

- [ ] **Step 1: Write the failing test**

`src/read-api/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { readAuthMiddleware, safeEqual } from './auth.ts';

function appWithToken(token: string): Hono {
  const app = new Hono();
  app.use('*', readAuthMiddleware(token));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('readAuthMiddleware', () => {
  it('401 without / with wrong token; 200 with correct token', async () => {
    const app = appWithToken('secret');
    expect((await app.request('/x')).status).toBe(401);
    expect((await app.request('/x', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await app.request('/x', { headers: { authorization: 'Bearer secret' } })).status).toBe(200);
  });

  it('401 body uses the unauthorized error envelope', async () => {
    const res = await appWithToken('s').request('/x');
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
  });

  it('safeEqual (hash-based constant-time): equal match, different reject incl. different lengths', () => {
    expect(safeEqual('a', 'ab')).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm failure** — FAIL.

- [ ] **Step 3: Implement**

`src/read-api/auth.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

// Constant-time compare: hash both sides to a fixed 32-byte digest first, so timing is
// independent of input length — no early length-mismatch leak (always compares 32 bytes).
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

const PREFIX = 'Bearer ';

export function readAuthMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    if (!header.startsWith(PREFIX) || !safeEqual(header.slice(PREFIX.length), token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}
```

- [ ] **Step 4: Run, confirm pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/read-api/auth.ts src/read-api/auth.test.ts
git commit -m "feat(sp5): service-to-service bearer auth middleware" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Deps + read-app skeleton (health, error envelope, auth, 405)

**Files:**
- Create: `src/read-api/deps.ts`, `src/read-api/routes/health.ts`, `src/read-api/read-app.ts`
- Test: `src/read-api/read-app.test.ts`

- [ ] **Step 1: Write `deps.ts`**

`src/read-api/deps.ts`:

```ts
import type { HypothesisReadPort } from '../ports/hypothesis-read.port.ts';
import type { BacktestReadPort } from '../ports/backtest-read.port.ts';
import type { AgentEventReadPort } from '../ports/agent-event-read.port.ts';

export interface ReadApiDeps {
  hypotheses: HypothesisReadPort;
  backtests: BacktestReadPort;
  agentEvents: AgentEventReadPort;
  checkReadiness: () => Promise<boolean>;
  token: string;
}
```

- [ ] **Step 2: Write the failing skeleton test**

`src/read-api/read-app.test.ts` (first batch — skeleton concerns; route cases added in Task 15):

```ts
import { describe, it, expect } from 'vitest';
import { createReadApp } from './read-app.ts';
import type { ReadApiDeps } from './deps.ts';
import { InMemoryHypothesisReadAdapter } from '../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../adapters/read/in-memory-agent-event-read.adapter.ts';

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function deps(over: Partial<ReadApiDeps> = {}): ReadApiDeps {
  return {
    hypotheses: new InMemoryHypothesisReadAdapter([]),
    backtests: new InMemoryBacktestReadAdapter([]),
    agentEvents: new InMemoryAgentEventReadAdapter([]),
    checkReadiness: async () => true,
    token: TOKEN,
    ...over,
  };
}

describe('createReadApp skeleton', () => {
  it('GET /healthz is open and 200', async () => {
    const res = await createReadApp(deps()).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reflects checkReadiness', async () => {
    expect((await createReadApp(deps()).request('/readyz')).status).toBe(200);
    const down = await createReadApp(deps({ checkReadiness: async () => false })).request('/readyz');
    expect(down.status).toBe(503);
  });

  it('GET /v1/* requires a token (401 without it)', async () => {
    expect((await createReadApp(deps()).request('/v1/hypotheses')).status).toBe(401);
    // The 200-with-token case needs real routes — it lands in Task 15 (stub routes register no GET here).
  });

  it('non-GET on a /v1 path returns 405 (not 404)', async () => {
    const app = createReadApp(deps());
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/v1/hypotheses', { method, headers: AUTH });
      expect(res.status, method).toBe(405);
      expect((await res.json()).error.code).toBe('method_not_allowed');
    }
  });
});
```

- [ ] **Step 3: Run, confirm failure** — FAIL (`read-app.ts` missing).

- [ ] **Step 4: Implement health routes + read-app**

`src/read-api/routes/health.ts`:

```ts
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';

export function registerHealthRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    const ok = await deps.checkReadiness();
    return c.json({ status: ok ? 'ok' : 'degraded', checks: { db: ok } }, ok ? 200 : 503);
  });
}
```

`src/read-api/read-app.ts`:

```ts
import { Hono, type Context } from 'hono';
import type { ReadApiDeps } from './deps.ts';
import { readAuthMiddleware } from './auth.ts';
import { InvalidCursorError } from './pagination.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerHypothesisRoutes } from './routes/hypotheses.ts';
import { registerBacktestRoutes } from './routes/backtests.ts';
import { registerAgentEventRoutes } from './routes/agent-events.ts';

const V1_PATHS = ['/hypotheses', '/hypotheses/:id', '/backtests', '/backtests/:id', '/agent-events'];

export function createReadApp(deps: ReadApiDeps): Hono {
  const app = new Hono();

  app.onError((err, c: Context) => {
    if (err instanceof InvalidCursorError) {
      return c.json({ error: { code: 'bad_request', message: 'invalid cursor' } }, 400);
    }
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  // open probes
  registerHealthRoutes(app, deps);

  // gated read surface
  const v1 = new Hono();
  v1.use('*', readAuthMiddleware(deps.token));
  registerHypothesisRoutes(v1, deps);
  registerBacktestRoutes(v1, deps);
  registerAgentEventRoutes(v1, deps);

  // Explicit 405 — Hono would otherwise 404 an unmatched method on a known path (R9.2).
  const methodNotAllowed = (c: Context) => c.json({ error: { code: 'method_not_allowed', message: 'method not allowed' } }, 405);
  for (const p of V1_PATHS) v1.on(['POST', 'PUT', 'PATCH', 'DELETE'], p, methodNotAllowed);

  app.route('/v1', v1);
  return app;
}
```

**Step 4a: Create compile-green stub route files (Task 15 fills the bodies)**

`read-app.ts` imports the three registrars, so they must exist before it compiles. Create each with the **final typed signature** (no-op body) — a bare `export function registerHypothesisRoutes() {}` would fail `tsc` because `read-app.ts` calls it with `(v1, deps)`; typed params keep it compile-green and let Task 15 fill the body with zero call-site changes.

`src/read-api/routes/hypotheses.ts`:
```ts
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
export function registerHypothesisRoutes(_app: Hono, _deps: ReadApiDeps): void {}
```
`src/read-api/routes/backtests.ts`:
```ts
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
export function registerBacktestRoutes(_app: Hono, _deps: ReadApiDeps): void {}
```
`src/read-api/routes/agent-events.ts`:
```ts
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
export function registerAgentEventRoutes(_app: Hono, _deps: ReadApiDeps): void {}
```

> With empty stubs, `GET /v1/hypotheses` (even with a token) has no registered route yet → Hono returns 404. That is why the skeleton test above asserts only `/healthz`, `/readyz`, the 401-without-token gate, and the 405 fallback — all independent of the real routes (the 405 fallback is registered in `read-app.ts`, not in the stubs). The 200 / keyset / 404 GET cases land in Task 15.

- [ ] **Step 5: Run, confirm pass** — with stubbed/real routes: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/read-api/deps.ts src/read-api/routes/health.ts src/read-api/routes/hypotheses.ts src/read-api/routes/backtests.ts src/read-api/routes/agent-events.ts src/read-api/read-app.ts src/read-api/read-app.test.ts
git commit -m "feat(sp5): read-app skeleton + typed stub route registrars — health, error envelope, auth gate, 405 fallback" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Resource routes (hypotheses / backtests / agent-events)

**Files:**
- Create: `src/read-api/routes/hypotheses.ts`, `src/read-api/routes/backtests.ts`, `src/read-api/routes/agent-events.ts`
- Test: extend `src/read-api/read-app.test.ts`

- [ ] **Step 1: Write the failing route tests (append to `read-app.test.ts`)**

```ts
import { InMemoryHypothesisReadAdapter as HypAd } from '../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter as BtAd } from '../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter as EvAd } from '../adapters/read/in-memory-agent-event-read.adapter.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';

function hyp(id: string, createdAt: string): HypothesisProposal {
  return {
    id, strategyProfileId: 'p1', thesis: 't', targetBehavior: 'tb',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'block_entry', params: {} }] },
    requiredFeatures: [], validationPlan: 'p', expectedEffect: { metric: 'pnl', direction: 'increase' },
    invalidationCriteria: ['c'], confidence: 0.5, status: 'validated', fingerprint: 'fp', proposal: {} as HypothesisProposal['proposal'],
    issues: [], contractVersion: 'v1', createdAt, updatedAt: createdAt,
  };
}

describe('routes', () => {
  it('GET /v1/hypotheses returns envelope + keyset nextCursor', async () => {
    const seed = [hyp('h1', '2026-01-01T00:00:01.000Z'), hyp('h2', '2026-01-01T00:00:02.000Z'), hyp('h3', '2026-01-01T00:00:03.000Z')];
    const app = createReadApp(deps({ hypotheses: new HypAd(seed) }));
    const res = await app.request('/v1/hypotheses?limit=2', { headers: AUTH });
    const body = await res.json();
    expect(body.data.map((h: { id: string }) => h.id)).toEqual(['h3', 'h2']);
    expect(body.page.nextCursor).toBeTruthy();
    const res2 = await app.request(`/v1/hypotheses?limit=2&cursor=${encodeURIComponent(body.page.nextCursor)}`, { headers: AUTH });
    expect((await res2.json()).data.map((h: { id: string }) => h.id)).toEqual(['h1']);
  });

  it('GET /v1/hypotheses/:id → 200 / 404', async () => {
    const app = createReadApp(deps({ hypotheses: new HypAd([hyp('h1', '2026-01-01T00:00:01.000Z')]) }));
    expect((await app.request('/v1/hypotheses/h1', { headers: AUTH })).status).toBe(200);
    const miss = await app.request('/v1/hypotheses/nope', { headers: AUTH });
    expect(miss.status).toBe(404);
    expect((await miss.json()).error.code).toBe('not_found');
  });

  it('malformed cursor → 400 bad_request, no internal leak (R9.1)', async () => {
    const app = createReadApp(deps());
    const res = await app.request('/v1/hypotheses?cursor=%%%bad', { headers: AUTH });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'bad_request', message: 'invalid cursor' } });
  });

  it('invalid query (bad limit) → 400', async () => {
    const res = await createReadApp(deps()).request('/v1/backtests?limit=999', { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it('GET /v1/agent-events sanitizes payload', async () => {
    const rows: AgentEventRow[] = [{ id: 'e1', taskId: 't1', type: 'some.unknown', payload: { secret: 'X' }, createdAt: '2026-01-01T00:00:01.000Z' }];
    const res = await createReadApp(deps({ agentEvents: new EvAd(rows) })).request('/v1/agent-events', { headers: AUTH });
    const body = await res.json();
    expect(body.data[0].payloadSummary).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('X');
  });
});
```

- [ ] **Step 2: Run, confirm failure** — FAIL.

- [ ] **Step 3: Replace the stub bodies with the real routes** (signatures already match the Task 14 stubs — no call-site changes)

`src/read-api/routes/hypotheses.ts`:

```ts
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { HypothesisListQuerySchema } from '../dto.ts';
import { toHypothesisListItem, toHypothesisDetail } from '../mappers.ts';
import { decodeCursor, encodeCursor } from '../pagination.ts';

export function registerHypothesisRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/hypotheses', async (c) => {
    const parsed = HypothesisListQuerySchema.safeParse({
      status: c.req.query('status'), profileId: c.req.query('profileId'),
      limit: c.req.query('limit'), cursor: c.req.query('cursor'),
    });
    if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'invalid query' } }, 400);
    const { status, profileId, limit, cursor } = parsed.data;
    const after = cursor ? decodeCursor(cursor) : undefined; // InvalidCursorError -> onError 400
    const items = await deps.hypotheses.list({ status, profileId, limit, after });
    const data = items.map(toHypothesisListItem);
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null;
    return c.json({ data, page: { nextCursor, limit } });
  });

  app.get('/hypotheses/:id', async (c) => {
    const h = await deps.hypotheses.getById(c.req.param('id'));
    if (!h) return c.json({ error: { code: 'not_found', message: 'hypothesis not found' } }, 404);
    return c.json(toHypothesisDetail(h));
  });
}
```

`src/read-api/routes/backtests.ts`:

```ts
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { BacktestListQuerySchema } from '../dto.ts';
import { toBacktestDto } from '../mappers.ts';
import { decodeCursor, encodeCursor } from '../pagination.ts';

export function registerBacktestRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/backtests', async (c) => {
    const parsed = BacktestListQuerySchema.safeParse({
      hypothesisId: c.req.query('hypothesisId'), status: c.req.query('status'),
      limit: c.req.query('limit'), cursor: c.req.query('cursor'),
    });
    if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'invalid query' } }, 400);
    const { hypothesisId, status, limit, cursor } = parsed.data;
    const after = cursor ? decodeCursor(cursor) : undefined;
    const items = await deps.backtests.list({ hypothesisId, status, limit, after });
    const data = items.map(toBacktestDto);
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null;
    return c.json({ data, page: { nextCursor, limit } });
  });

  app.get('/backtests/:id', async (c) => {
    const b = await deps.backtests.getById(c.req.param('id'));
    if (!b) return c.json({ error: { code: 'not_found', message: 'backtest not found' } }, 404);
    return c.json(toBacktestDto(b));
  });
}
```

`src/read-api/routes/agent-events.ts`:

```ts
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { AgentEventListQuerySchema } from '../dto.ts';
import { toAgentEventDto } from '../mappers.ts';
import { decodeCursor, encodeCursor } from '../pagination.ts';

export function registerAgentEventRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/agent-events', async (c) => {
    const parsed = AgentEventListQuerySchema.safeParse({
      taskId: c.req.query('taskId'), type: c.req.query('type'), since: c.req.query('since'),
      correlationId: c.req.query('correlationId'), limit: c.req.query('limit'), cursor: c.req.query('cursor'),
    });
    if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'invalid query' } }, 400);
    const { taskId, type, since, correlationId, limit, cursor } = parsed.data;
    const after = cursor ? decodeCursor(cursor) : undefined;
    const items = await deps.agentEvents.list({ taskId, type, since, correlationId, limit, after });
    const data = items.map(toAgentEventDto);
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null;
    return c.json({ data, page: { nextCursor, limit } });
  });
}
```

- [ ] **Step 4: Run, confirm pass** — `pnpm vitest run src/read-api/read-app.test.ts` → PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/read-api/routes/hypotheses.ts src/read-api/routes/backtests.ts src/read-api/routes/agent-events.ts src/read-api/read-app.test.ts
git commit -m "feat(sp5): hypotheses/backtests/agent-events read routes" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Composition + server wiring + e2e

**Files:**
- Modify: `src/composition.ts`, `src/ingress/server.ts`
- Test: `src/read-api/read-app.e2e.test.ts`

- [ ] **Step 1: Write the failing e2e test**

`src/read-api/read-app.e2e.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createReadApp } from './read-app.ts';
import { InMemoryHypothesisReadAdapter } from '../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../adapters/read/in-memory-agent-event-read.adapter.ts';

describe('read-app e2e (in-memory wiring)', () => {
  it('serves the full route table behind auth', async () => {
    const app = createReadApp({
      hypotheses: new InMemoryHypothesisReadAdapter([]),
      backtests: new InMemoryBacktestReadAdapter([]),
      agentEvents: new InMemoryAgentEventReadAdapter([]),
      checkReadiness: async () => true,
      token: 'e2e',
    });
    const auth = { authorization: 'Bearer e2e' };
    for (const path of ['/v1/hypotheses', '/v1/backtests', '/v1/agent-events']) {
      const res = await app.request(path, { headers: auth });
      expect(res.status, path).toBe(200);
      expect((await res.json()).data).toEqual([]);
    }
    expect((await app.request('/healthz')).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run, confirm pass** — this passes immediately (it exercises Task 15 code); it locks the wiring contract. Run: `pnpm vitest run src/read-api/read-app.e2e.test.ts` → PASS.

- [ ] **Step 3: Wire `composition.ts`**

Add imports at the top of `src/composition.ts`:

```ts
import { sql } from 'drizzle-orm';
import { DrizzleHypothesisReadAdapter } from './adapters/read/drizzle-hypothesis-read.adapter.ts';
import { DrizzleBacktestReadAdapter } from './adapters/read/drizzle-backtest-read.adapter.ts';
import { DrizzleAgentEventReadAdapter } from './adapters/read/drizzle-agent-event-read.adapter.ts';
import type { ReadApiDeps } from './read-api/deps.ts';
```

Inside `composeRuntime`, after the `chat` object and before `return`:

```ts
  const read: ReadApiDeps = {
    hypotheses: new DrizzleHypothesisReadAdapter(db),
    backtests: new DrizzleBacktestReadAdapter(db),
    agentEvents: new DrizzleAgentEventReadAdapter(db),
    checkReadiness: async () => {
      try { await db.execute(sql`select 1`); return true; } catch { return false; }
    },
    token: env.TRADING_LAB_READ_TOKEN ?? '',
  };
```

Change the return to include `read`:

```ts
  return { env, db, pool, queue, router, services, chat, read };
```

- [ ] **Step 4: Wire `server.ts`**

Edit `src/ingress/server.ts`. Add import:

```ts
import { createReadApp } from '../read-api/read-app.ts';
```

Destructure `read` and start the second listener after the ingress `serve(...)`:

```ts
const { env, services, queue, pool, chat, read } = composeRuntime();
const app = createIngressApp({ repo: services.researchTasks, queue });
app.route('/chat', createChatApp(chat));
serve({ fetch: app.fetch, port: env.INGRESS_PORT });
console.log(`ingress listening on :${env.INGRESS_PORT}`);

if (env.TRADING_LAB_READ_TOKEN) {
  serve({ fetch: createReadApp(read).fetch, port: env.READ_API_PORT });
  console.log(`read API listening on :${env.READ_API_PORT}`);
} else {
  console.warn('[read-api] TRADING_LAB_READ_TOKEN not set — read API listener not started');
}
```

(Leave the existing `shutdown` handler as-is.)

- [ ] **Step 5: Verify** — `pnpm typecheck` clean; `pnpm vitest run src/read-api/read-app.e2e.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/composition.ts src/ingress/server.ts src/read-api/read-app.e2e.test.ts
git commit -m "feat(sp5): wire read adapters + checkReadiness into composition; start read listener iff token" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Read-boundary import guard

**Files:**
- Create: `src/read-api/read-boundary.guard.test.ts`

- [ ] **Step 1: Write the guard test**

`src/read-api/read-boundary.guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Roots scanned recursively + explicit port files (the read boundary, §11 of the spec).
const ROOT_DIRS = ['src/read-api', 'src/adapters/read'];
const PORT_FILES = [
  'src/ports/keyset.ts',
  'src/ports/hypothesis-read.port.ts',
  'src/ports/backtest-read.port.ts',
  'src/ports/agent-event-read.port.ts',
];

// The read boundary must not import the write side or the platform.
const FORBIDDEN: RegExp[] = [
  /orchestrator\/task-intake/,
  /ports\/task-queue/,
  /adapters\/queue/,
  /worker\//,
  /orchestrator\/workflow-router/,
  /orchestrator\/handlers/,
  /adapters\/repository\//,
  /trading-platform/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
}

describe('read boundary import guard', () => {
  const files = [...ROOT_DIRS.flatMap(walk), ...PORT_FILES];

  it('covers the expected file set (sanity)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${file} imports nothing forbidden`, () => {
      const offenders = importSpecifiers(file).filter((spec) => FORBIDDEN.some((re) => re.test(spec)));
      expect(offenders, `${file} imports forbidden: ${offenders.join(', ')}`).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run, confirm pass (boundary is clean)**

Run: `pnpm vitest run src/read-api/read-boundary.guard.test.ts`
Expected: PASS — no read-boundary file imports the write side or `trading-platform`. (If it fails, the offending import must be removed/refactored, not the test.)

- [ ] **Step 3: Sanity-check the guard actually fails on a violation**

Temporarily add `import { createAndEnqueueTask } from '../orchestrator/task-intake.ts';` to `src/read-api/read-app.ts`, run the guard → it must FAIL for that file. Remove the line; re-run → PASS. (Confirms the regex catches real violations.)

- [ ] **Step 4: Commit**

```bash
git add src/read-api/read-boundary.guard.test.ts
git commit -m "test(sp5): read-boundary import guard (no write-side / platform imports)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Final verification, docs, env example

**Files:**
- Modify: `.env.example` (if present) and/or `README` / `src/read-api/README.md`

- [ ] **Step 1: Document the read API**

Create `src/read-api/README.md`:

```markdown
# Read API (SP-5)

Read-only, service-to-service HTTP boundary for trading-office. Separate Hono app on `READ_API_PORT` (same process as ingress). Starts only when `TRADING_LAB_READ_TOKEN` is set.

Auth: `Authorization: Bearer <TRADING_LAB_READ_TOKEN>` on every `/v1/*` route. `/healthz` + `/readyz` are open.

Endpoints:
- `GET /v1/hypotheses` (`status?`, `profileId?`, `limit?`, `cursor?`) · `GET /v1/hypotheses/:id`
- `GET /v1/backtests` (`hypothesisId?`, `status?`, `limit?`, `cursor?`) · `GET /v1/backtests/:id`
- `GET /v1/agent-events` (`taskId?`, `type?`, `since?`, `correlationId?`, `limit?`, `cursor?`)
- `GET /healthz` · `GET /readyz` (DB readiness only — no queue/worker)

Pagination is keyset (opaque `cursor`); `limit` default 20, max 100. DTOs are deny-by-default projections; internal schema is never exposed; no `trading-platform` calls. See `docs/superpowers/specs/2026-06-13-trading-lab-sp5-read-api-design.md`.
```

If `.env.example` exists, append:
```
READ_API_PORT=3100
TRADING_LAB_READ_TOKEN=
```

- [ ] **Step 2: Full verification**

Run, expecting all green:
```bash
pnpm typecheck
pnpm test
```
With a database, also run the gated adapter tests:
```bash
DATABASE_URL=postgres://... pnpm test
```
Expected: all pass; drizzle adapter tests run (not skipped) when `DATABASE_URL` is set.

- [ ] **Step 3: Commit**

```bash
git add src/read-api/README.md .env.example
git commit -m "docs(sp5): read API README + env example" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Open the slice PR (one PR per slice, off main)**

```bash
git push -u origin sp5-read-api
gh pr create --base main --title "SP-5: read-only API foundation for trading-office" --body "Implements docs/superpowers/specs/2026-06-13-trading-lab-sp5-read-api-design.md. CQRS-lite read ports + Drizzle/in-memory adapters, separate READ_API_PORT Hono app, service-to-service bearer auth, deny-by-default DTO sanitization, keyset pagination, read-boundary import guard. No write paths, no trading-platform coupling.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review (completed during planning)

**Spec coverage** — every spec section maps to a task: §1 invariant → Tasks 12/17 (sanitization + guard); §4 layout → all; §5 ports → Task 3; §6 endpoints → Tasks 14/15; §7 DTOs → Tasks 11/12; §8 auth/topology → Tasks 13/16; §9 errors incl. R9.1/R9.2 → Tasks 2/14/15; §10 migrations → Task 7; §11 guard → Task 17; §12 tests → Tasks 4–17.

**Type consistency** — `Cursor {t,id}` (Task 2) used everywhere; ports return `T[]` with `after?: Cursor` + `limit` (Task 3) consumed identically by fakes (4–6) and Drizzle adapters (8–10); `ReadApiDeps` fields `hypotheses/backtests/agentEvents/checkReadiness/token` (Task 14) match composition (Task 16) and tests; DTO names (`HypothesisListItemDto`/`HypothesisDetailDto`/`BacktestDto`/`AgentEventDto`, Task 11) match the mappers (Task 12) and routes (Task 15); route registrar names (`registerHypothesisRoutes` etc.) match read-app (Task 14) and route files (Task 15).

**No placeholders** — every code step is complete. The only intentionally-flagged scaffolding is in Task 8 Step 1, where the finalized `eq`/`inArray` cleanup helpers are given explicitly beneath the test.
