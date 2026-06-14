# SP-6 — Agent Activity Projection + Internal Realtime Stream Implementation Plan

> **For implementers:** Steps use checkbox (`- [ ]`) syntax for task-by-task tracking.

**Goal:** Add a read-only, in-memory Agent Activity Projection and an internal server-to-server SSE realtime stream to trading-lab's SP-5 read API, so the trading-office backend can render live agent state without browser polling.

**Architecture:** A Postgres `AFTER INSERT` trigger on `agent_event` fires `pg_notify('trading_lab_agent_event', …)` as a wake-up signal. The read process holds one dedicated `LISTEN` client (`PgNotifyAgentEventStream`); on every notify / reconnect / safety-net tick it does a **keyset catch-up read** of `agent_event` (the source of truth & ordering) and fans rows to subscribers. An in-memory `AgentActivityProjection` consumes that stream to serve `GET /v1/agents` and `/v1/agents/:agentId`. `GET /v1/stream` (SSE) runs a per-connection reducer: replay-from-cursor via the SP-5 read port, then live via the stream port, deduped by a monotonic keyset cursor. Everything is read-only; the projection is in-memory (never writes a table); the stream is one-directional (no command channel).

**Tech Stack:** TypeScript (Node `--experimental-strip-types`), Hono 4.12 (`hono/streaming` `streamSSE`), Drizzle ORM + `pg` (node-postgres) on Postgres, Vitest. Reuses SP-5 `AgentEventReadPort`, keyset `Cursor` + `encodeCursor`/`decodeCursor`, deny-by-default `toAgentEventDto`, Bearer `readAuthMiddleware`.

**Spec:** `docs/superpowers/specs/2026-06-13-trading-lab-sp6-agent-activity-stream-design.md`

---

## File structure

**New files:**
- `src/read-api/agent-taxonomy.ts` — pure derivation: `agentIdForType`, `lifecycleForType`, `AGENT_IDS`, `KNOWN_AGENT_IDS`, types `AgentId` / `AgentLifecycle`. (+ `.test.ts`)
- `src/read-api/projection.ts` — `AgentActivityProjection` (in-memory; `apply` / `snapshot` / `getAgent` / `cursorKey`). (+ `.test.ts`)
- `src/read-api/stream-frames.ts` — pure `framesForEvent` + `StreamFrame` envelope + SSE event-name constants. (+ `.test.ts`)
- `src/ports/agent-event-stream.port.ts` — `AgentEventStreamPort` (`start` / `stop` / `subscribe`).
- `src/adapters/read/in-memory-agent-event-stream.ts` — test fake. (+ `.test.ts`)
- `src/adapters/read/pg-notify-agent-event-stream.ts` — real LISTEN + catch-up adapter. (+ `.test.ts`, DB-gated)
- `src/read-api/routes/agents.ts` — `GET /agents`, `GET /agents/:agentId`.
- `src/read-api/routes/stream.ts` — `GET /stream` (SSE).
- `migrations/0006_agent_event_notify.sql` — trigger (scaffolded via `drizzle-kit generate --custom`).

**Modified files:**
- `src/read-api/dto.ts` — add `AgentSummaryDto`, `AgentActivityDto`, `AgentStatusChanged`, `AgentEventAppended`.
- `src/read-api/deps.ts` — `ReadApiDeps` gains `projection`, `agentStream`, `streamHeartbeatMs`.
- `src/read-api/read-app.ts` — register agents + stream routes; add new paths to `V1_PATHS`.
- `src/read-api/read-app.test.ts` — extend the `deps()` helper with the new fields.
- `src/read-api/read-boundary.guard.test.ts` — add the new port to `PORT_FILES`.
- `src/config/env.ts` — add four knobs to `Env` + `loadEnv`.
- `src/composition.ts` — build projection + `PgNotifyAgentEventStream` into `ReadApiDeps`.
- `src/ingress/server.ts` — rebuild → `start()` → subscribe projection; `stop()` on shutdown (token-gated).

**Ordering rationale (keeps `pnpm typecheck` green at every commit):** leaf/pure modules first (Tasks 1–4), standalone route functions with narrow structural deps (Tasks 5–6) that don't touch `ReadApiDeps`, the migration + DB adapter (Tasks 7–8), env knobs (Task 9), and a single wire-up task (Task 10) that extends `ReadApiDeps` and updates every consumer (composition, server, read-app, test helper, boundary guard) at once.

---

## Task 1: Agent taxonomy (pure derivation)

**Files:**
- Create: `src/read-api/agent-taxonomy.ts`
- Test: `src/read-api/agent-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { agentIdForType, lifecycleForType, AGENT_IDS, KNOWN_AGENT_IDS } from './agent-taxonomy.ts';

describe('agentIdForType (ordered, separator-tolerant)', () => {
  it('routes builder events, including the underscore form', () => {
    expect(agentIdForType('build.started')).toBe('builder');
    expect(agentIdForType('build_failed')).toBe('builder');         // underscore, not dot
    expect(agentIdForType('builder.completed')).toBe('builder');
    expect(agentIdForType('artifact.stored')).toBe('builder');
    expect(agentIdForType('backtest.submitted')).toBe('builder');
    expect(agentIdForType('evaluation.completed')).toBe('builder');
    expect(agentIdForType('hypothesis.build.started')).toBe('builder'); // specific-first guard
  });
  it('routes researcher events without swallowing build', () => {
    expect(agentIdForType('research.run_cycle.started')).toBe('researcher');
    expect(agentIdForType('researcher.completed')).toBe('researcher');
    expect(agentIdForType('hypothesis.validated')).toBe('researcher');
    expect(agentIdForType('hypothesis.rejected')).toBe('researcher');
    expect(agentIdForType('hypothesis.deduped')).toBe('researcher');
  });
  it('routes analyst + critic', () => {
    expect(agentIdForType('strategy_analyst.started')).toBe('analyst');
    expect(agentIdForType('strategy.onboard.deduped')).toBe('analyst');
    expect(agentIdForType('critic.reviewed')).toBe('critic');
  });
  it('falls unknown types back to system, never researcher', () => {
    expect(agentIdForType('chat.message.received')).toBe('system');
    expect(agentIdForType('totally.unknown')).toBe('system');
  });
});

describe('lifecycleForType (failure-first)', () => {
  it('maps suffixes', () => {
    expect(lifecycleForType('researcher.started')).toBe('working');
    expect(lifecycleForType('research.run_cycle.completed')).toBe('succeeded');
    expect(lifecycleForType('hypothesis.validated')).toBe('succeeded');
    expect(lifecycleForType('hypothesis.deduped')).toBe('succeeded');
    expect(lifecycleForType('critic.failed')).toBe('failed');
    expect(lifecycleForType('hypothesis.rejected')).toBe('failed');
    expect(lifecycleForType('build_failed')).toBe('failed');           // underscore terminal
  });
  it('defaults unknown mid-workflow suffixes to working', () => {
    expect(lifecycleForType('backtest.submitted')).toBe('working');
    expect(lifecycleForType('artifact.stored')).toBe('working');
  });
});

describe('id constants', () => {
  it('exposes four known agents + system', () => {
    expect(KNOWN_AGENT_IDS).toEqual(['analyst', 'researcher', 'critic', 'builder']);
    expect(AGENT_IDS).toEqual(['analyst', 'researcher', 'critic', 'builder', 'system']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/read-api/agent-taxonomy.test.ts`
Expected: FAIL — `Cannot find module './agent-taxonomy.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/read-api/agent-taxonomy.ts
// Pure derivation of a logical agent id + lifecycle status from an agent_event.type.
// Matching is ordered (first rule wins) and separator-tolerant: a prefix P matches T
// iff T === P or T starts with P + '.' or P + '_'. The underscore case is load-bearing —
// the build handler emits `build_failed`, which a dotted-only `build.` rule would miss.

export type AgentId = 'analyst' | 'researcher' | 'critic' | 'builder' | 'system';
export type AgentLifecycle = 'idle' | 'working' | 'succeeded' | 'failed';

export const KNOWN_AGENT_IDS = ['analyst', 'researcher', 'critic', 'builder'] as const;
export const AGENT_IDS = [...KNOWN_AGENT_IDS, 'system'] as const;

function matches(type: string, prefix: string): boolean {
  return type === prefix || type.startsWith(`${prefix}.`) || type.startsWith(`${prefix}_`);
}

// Ordered, specific-first. `hypothesis.build` precedes the concrete researcher events.
const RULES: ReadonlyArray<{ prefixes: readonly string[]; agentId: Exclude<AgentId, 'system'> }> = [
  { prefixes: ['hypothesis.build'], agentId: 'builder' },
  { prefixes: ['build', 'builder', 'artifact', 'backtest', 'evaluation'], agentId: 'builder' },
  {
    prefixes: [
      'research.run_cycle', 'researcher',
      'hypothesis.generated', 'hypothesis.validated', 'hypothesis.rejected', 'hypothesis.deduped',
    ],
    agentId: 'researcher',
  },
  { prefixes: ['strategy_analyst', 'strategy.onboard'], agentId: 'analyst' },
  { prefixes: ['critic'], agentId: 'critic' },
];

export function agentIdForType(type: string): AgentId {
  for (const rule of RULES) {
    if (rule.prefixes.some((p) => matches(type, p))) return rule.agentId;
  }
  return 'system';
}

const FAILED = new Set(['failed', 'rejected', 'error']);
const WORKING = new Set(['started', 'running']);
const SUCCEEDED = new Set(['completed', 'validated', 'reviewed', 'deduped', 'skipped']);

// A single event always implies one of working|succeeded|failed; `idle` is a projection-level
// (no-events) state, never returned here. Failure is checked first so a type carrying both
// tokens cannot be misclassified.
export function lifecycleForType(type: string): Exclude<AgentLifecycle, 'idle'> {
  const last = type.toLowerCase().split(/[._]/).pop() ?? '';
  if (FAILED.has(last)) return 'failed';
  if (WORKING.has(last)) return 'working';
  if (SUCCEEDED.has(last)) return 'succeeded';
  return 'working'; // unknown mid-workflow suffix (e.g. submitted, stored, reused)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/read-api/agent-taxonomy.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/read-api/agent-taxonomy.ts src/read-api/agent-taxonomy.test.ts
git commit -m "feat(sp6): pure agent taxonomy + lifecycle derivation"
```

---

## Task 2: Agent activity DTOs + in-memory projection

**Files:**
- Modify: `src/read-api/dto.ts` (append agent DTOs)
- Create: `src/read-api/projection.ts`
- Test: `src/read-api/projection.test.ts`

- [ ] **Step 1: Add the DTO types** (append to `src/read-api/dto.ts`, after the existing `AgentEventDto` block)

```ts
import type { AgentId, AgentLifecycle } from './agent-taxonomy.ts';

export interface AgentSummaryDto {
  agentId: AgentId;
  status: AgentLifecycle;
  currentTaskId: string | null;
  lastEvent: AgentEventDto | null;
}

export interface AgentActivityDto {
  agentId: AgentId;
  status: AgentLifecycle;
  currentTask: { id: string; type: string; status: AgentLifecycle } | null; // type = latest event type
  trace: AgentEventDto[]; // ring-buffer tail, oldest→newest, sanitized
}

// SSE delta payloads (carried as `data:` JSON).
export interface AgentStatusChanged { agentId: AgentId; status: AgentLifecycle; currentTaskId: string | null; ts: string; }
export interface AgentEventAppended { agentId: AgentId; event: AgentEventDto; }
```

(Place the `import type` at the top of the file with the other imports; the interfaces may go at the end.)

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { AgentActivityProjection } from './projection.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';

function ev(id: string, type: string, over: Partial<AgentEventRow> = {}): AgentEventRow {
  return { id, taskId: 't1', type, payload: {}, createdAt: `2026-01-01T00:00:${id.padStart(2, '0')}.000Z`, ...over };
}

describe('AgentActivityProjection', () => {
  it('boots known agents idle with null currentTask and empty trace', () => {
    const p = new AgentActivityProjection(50);
    const snap = p.snapshot();
    expect(snap.cursor).toBeNull();
    expect(snap.data.map((a) => a.agentId)).toEqual(['analyst', 'researcher', 'critic', 'builder']);
    expect(snap.data.every((a) => a.status === 'idle' && a.currentTaskId === null && a.lastEvent === null)).toBe(true);
    expect(p.getAgent('researcher')).toEqual({ agentId: 'researcher', status: 'idle', currentTask: null, trace: [] });
  });

  it('derives working then retains the terminal outcome (idle does not overwrite)', () => {
    const p = new AgentActivityProjection(50);
    p.apply(ev('01', 'researcher.started'));
    expect(p.getAgent('researcher')!.status).toBe('working');
    p.apply(ev('02', 'researcher.completed'));
    const a = p.getAgent('researcher')!;
    expect(a.status).toBe('succeeded');                 // terminal retained
    expect(a.currentTask).toEqual({ id: 't1', type: 'researcher.completed', status: 'succeeded' });
  });

  it('surfaces the system agent only after an unknown event', () => {
    const p = new AgentActivityProjection(50);
    expect(p.snapshot().data.map((a) => a.agentId)).not.toContain('system');
    expect(p.getAgent('system')).toBeNull();
    p.apply(ev('01', 'chat.message.received'));
    expect(p.snapshot().data.map((a) => a.agentId)).toContain('system');
    expect(p.getAgent('system')!.status).toBe('working');
  });

  it('caps the trace ring buffer and keeps newest', () => {
    const p = new AgentActivityProjection(2);
    p.apply(ev('01', 'researcher.started'));
    p.apply(ev('02', 'researcher.started'));
    p.apply(ev('03', 'researcher.completed'));
    const trace = p.getAgent('researcher')!.trace;
    expect(trace.map((e) => e.id)).toEqual(['02', '03']);
  });

  it('is idempotent and monotonic on the keyset cursor', () => {
    const p = new AgentActivityProjection(50);
    p.apply(ev('02', 'researcher.started'));
    const c1 = p.cursorKey();
    p.apply(ev('01', 'researcher.completed')); // older key → ignored
    expect(p.getAgent('researcher')!.status).toBe('working');
    expect(p.cursorKey()).toEqual(c1);
  });

  it('sanitizes the trace (no raw payload leak)', () => {
    const p = new AgentActivityProjection(50);
    p.apply(ev('01', 'some.unknown', { payload: { secret: 'X' } }));
    expect(JSON.stringify(p.snapshot())).not.toContain('X');
  });

  it('returns null for an unknown agentId (→ 404 at the route)', () => {
    expect(new AgentActivityProjection(50).getAgent('ghost' as never)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run src/read-api/projection.test.ts`
Expected: FAIL — `Cannot find module './projection.ts'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/read-api/projection.ts
// In-memory Agent Activity Projection (read-only; never persisted). Serves the REST
// snapshot/activity endpoints. apply() is idempotent + monotonic on the keyset cursor.
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';
import type { Cursor } from '../ports/keyset.ts';
import { encodeCursor } from './pagination.ts';
import { toAgentEventDto } from './mappers.ts';
import { agentIdForType, lifecycleForType, KNOWN_AGENT_IDS, AGENT_IDS, type AgentId, type AgentLifecycle } from './agent-taxonomy.ts';
import type { AgentEventDto, AgentSummaryDto, AgentActivityDto } from './dto.ts';

interface AgentState {
  status: AgentLifecycle;
  currentTask: { id: string; type: string; status: AgentLifecycle } | null;
  lastEvent: AgentEventDto | null;
  trace: AgentEventDto[];
}

function freshIdle(): AgentState {
  return { status: 'idle', currentTask: null, lastEvent: null, trace: [] };
}

function isAfter(a: Cursor, b: Cursor): boolean {
  return a.t > b.t || (a.t === b.t && a.id > b.id);
}

export class AgentActivityProjection {
  private readonly state = new Map<AgentId, AgentState>();
  private cursor: Cursor | null = null;

  constructor(private readonly traceLimit: number) {
    for (const id of KNOWN_AGENT_IDS) this.state.set(id, freshIdle());
  }

  apply(row: AgentEventRow): void {
    const key: Cursor = { t: row.createdAt, id: row.id };
    if (this.cursor && !isAfter(key, this.cursor)) return; // idempotent / monotonic

    const agentId = agentIdForType(row.type);
    const status = lifecycleForType(row.type);
    const dto = toAgentEventDto(row);

    const s = this.state.get(agentId) ?? freshIdle();
    s.status = status;
    s.currentTask = { id: row.taskId, type: row.type, status };
    s.lastEvent = dto;
    s.trace.push(dto);
    if (s.trace.length > this.traceLimit) s.trace.shift();
    this.state.set(agentId, s);

    this.cursor = key;
  }

  cursorKey(): Cursor | null {
    return this.cursor;
  }

  snapshot(): { data: AgentSummaryDto[]; cursor: string | null } {
    const ids: AgentId[] = [...KNOWN_AGENT_IDS];
    if (this.state.has('system')) ids.push('system');
    const data = ids.map((agentId) => {
      const s = this.state.get(agentId)!;
      return { agentId, status: s.status, currentTaskId: s.currentTask?.id ?? null, lastEvent: s.lastEvent };
    });
    return { data, cursor: this.cursor ? encodeCursor(this.cursor) : null };
  }

  getAgent(agentId: AgentId): AgentActivityDto | null {
    if (!(AGENT_IDS as readonly string[]).includes(agentId)) return null;
    if (agentId === 'system' && !this.state.has('system')) return null;
    const s = this.state.get(agentId) ?? freshIdle();
    return { agentId, status: s.status, currentTask: s.currentTask, trace: [...s.trace] };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run src/read-api/projection.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add src/read-api/dto.ts src/read-api/projection.ts src/read-api/projection.test.ts
git commit -m "feat(sp6): agent activity DTOs + in-memory projection"
```

---

## Task 3: AgentEventStreamPort + in-memory fake

**Files:**
- Create: `src/ports/agent-event-stream.port.ts`
- Create: `src/adapters/read/in-memory-agent-event-stream.ts`
- Test: `src/adapters/read/in-memory-agent-event-stream.test.ts`
- Modify: `src/read-api/read-boundary.guard.test.ts` (add the new port to `PORT_FILES`)

- [ ] **Step 1: Create the port** (no test of its own — it is a type)

```ts
// src/ports/agent-event-stream.port.ts
import type { AgentEventRow } from './agent-event-read.port.ts';
import type { Cursor } from './keyset.ts';

// A source of agent_event rows in keyset order. Lifecycle is part of the contract so
// composition/shutdown/reconnect are explicit, not implementation detail. start() takes
// an optional resume cursor (the projection's post-rebuild position) so catch-up begins
// AFTER what has already been applied — not from the beginning of agent_event. subscribe()
// supports multiple subscribers (the projection + each live SSE connection).
export interface AgentEventStreamPort {
  start(startCursor?: Cursor | null): Promise<void>;
  stop(): Promise<void>;
  subscribe(onEvent: (row: AgentEventRow) => void): () => void; // returns unsubscribe
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryAgentEventStream } from './in-memory-agent-event-stream.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

const row = (id: string): AgentEventRow => ({ id, taskId: 't', type: 'researcher.started', payload: {}, createdAt: `2026-01-01T00:00:0${id}.000Z` });

describe('InMemoryAgentEventStream', () => {
  it('fans pushed rows to all subscribers until unsubscribed', async () => {
    const s = new InMemoryAgentEventStream();
    await s.start();
    const a: string[] = []; const b: string[] = [];
    const offA = s.subscribe((r) => a.push(r.id));
    s.subscribe((r) => b.push(r.id));
    s.push(row('1'));
    offA();
    s.push(row('2'));
    expect(a).toEqual(['1']);
    expect(b).toEqual(['1', '2']);
    await s.stop();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run src/adapters/read/in-memory-agent-event-stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/adapters/read/in-memory-agent-event-stream.ts
import type { AgentEventStreamPort } from '../../ports/agent-event-stream.port.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

export class InMemoryAgentEventStream implements AgentEventStreamPort {
  private readonly subs = new Set<(row: AgentEventRow) => void>();

  async start(): Promise<void> {} // optional resume cursor is ignored — the fake has no catch-up
  async stop(): Promise<void> { this.subs.clear(); }

  subscribe(onEvent: (row: AgentEventRow) => void): () => void {
    this.subs.add(onEvent);
    return () => { this.subs.delete(onEvent); };
  }

  // Test helper: simulate a new event arriving.
  push(row: AgentEventRow): void {
    for (const cb of [...this.subs]) cb(row);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run src/adapters/read/in-memory-agent-event-stream.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the new port to the read-boundary guard**

In `src/read-api/read-boundary.guard.test.ts`, extend the `PORT_FILES` array:

```ts
const PORT_FILES = [
  'src/ports/keyset.ts',
  'src/ports/hypothesis-read.port.ts',
  'src/ports/backtest-read.port.ts',
  'src/ports/agent-event-read.port.ts',
  'src/ports/agent-event-stream.port.ts',
];
```

(The guard already walks `src/read-api` and `src/adapters/read` recursively, so every other new file is covered automatically.)

- [ ] **Step 7: Run the boundary guard + typecheck**

Run: `pnpm exec vitest run src/read-api/read-boundary.guard.test.ts`
Expected: PASS (the new port imports only `agent-event-read.port.ts`).

```bash
pnpm typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/ports/agent-event-stream.port.ts src/adapters/read/in-memory-agent-event-stream.ts src/adapters/read/in-memory-agent-event-stream.test.ts src/read-api/read-boundary.guard.test.ts
git commit -m "feat(sp6): AgentEventStreamPort + in-memory fake + boundary guard"
```

---

## Task 4: Stream frames (pure)

**Files:**
- Create: `src/read-api/stream-frames.ts`
- Test: `src/read-api/stream-frames.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { framesForEvent, SSE_STATUS_CHANGED, SSE_EVENT_APPENDED } from './stream-frames.ts';
import { encodeCursor } from './pagination.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';

const row: AgentEventRow = { id: 'e1', taskId: 't1', type: 'researcher.started', payload: { secret: 'X' }, createdAt: '2026-01-01T00:00:01.000Z' };

describe('framesForEvent', () => {
  it('emits status_changed (no id) + event_appended (id) on a status transition', () => {
    const { frames, status } = framesForEvent(undefined, row);
    expect(status).toBe('working');
    expect(frames).toHaveLength(2);

    const changed = frames[0]!;
    expect(changed.event).toBe(SSE_STATUS_CHANGED);
    expect(changed.id).toBeUndefined();                       // derived → non-resumable
    expect(changed.data).toEqual({ agentId: 'researcher', status: 'working', currentTaskId: 't1', ts: '2026-01-01T00:00:01.000Z' });

    const appended = frames[1]!;
    expect(appended.event).toBe(SSE_EVENT_APPENDED);
    expect(appended.id).toBe(encodeCursor({ t: row.createdAt, id: row.id })); // resumable keyset cursor
    expect((appended.data as { agentId: string }).agentId).toBe('researcher');
    expect(JSON.stringify(appended.data)).not.toContain('X'); // sanitized
  });

  it('omits status_changed when status is unchanged', () => {
    const { frames } = framesForEvent('working', row);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe(SSE_EVENT_APPENDED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/read-api/stream-frames.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/read-api/stream-frames.ts
// Pure: compute the SSE frames for one event given the agent's previous status.
// Only agent_event_appended carries the keyset `id` (resumable); agent_status_changed
// is a derived signal with no id, so replay-from-cursor re-derives it without gaps.
import { encodeCursor } from './pagination.ts';
import { toAgentEventDto } from './mappers.ts';
import { agentIdForType, lifecycleForType, type AgentLifecycle } from './agent-taxonomy.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';
import type { AgentStatusChanged, AgentEventAppended } from './dto.ts';

export const SSE_STATUS_CHANGED = 'agent_status_changed';
export const SSE_EVENT_APPENDED = 'agent_event_appended';

export interface StreamFrame {
  id?: string;
  event: typeof SSE_STATUS_CHANGED | typeof SSE_EVENT_APPENDED;
  data: AgentStatusChanged | AgentEventAppended;
}

export function framesForEvent(
  prev: AgentLifecycle | undefined,
  row: AgentEventRow,
): { frames: StreamFrame[]; status: AgentLifecycle } {
  const agentId = agentIdForType(row.type);
  const status = lifecycleForType(row.type);
  const dto = toAgentEventDto(row);
  const frames: StreamFrame[] = [];
  if (prev !== status) {
    frames.push({ event: SSE_STATUS_CHANGED, data: { agentId, status, currentTaskId: row.taskId, ts: row.createdAt } });
  }
  frames.push({ id: encodeCursor({ t: row.createdAt, id: row.id }), event: SSE_EVENT_APPENDED, data: { agentId, event: dto } });
  return { frames, status };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/read-api/stream-frames.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/read-api/stream-frames.ts src/read-api/stream-frames.test.ts
git commit -m "feat(sp6): pure SSE frame derivation"
```

---

## Task 5: routes/agents.ts (snapshot + activity)

**Files:**
- Create: `src/read-api/routes/agents.ts`
- Test: `src/read-api/routes/agents.test.ts`

The route function takes a **narrow structural dep** (`{ projection }`) so it does not require editing `ReadApiDeps` yet (that lands in Task 10). It is structurally compatible with `ReadApiDeps` once that field is added.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerAgentRoutes } from './agents.ts';
import { AgentActivityProjection } from '../projection.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

function appWith(p: AgentActivityProjection): Hono {
  const app = new Hono();
  registerAgentRoutes(app, { projection: p });
  return app;
}
const ev = (id: string, type: string): AgentEventRow => ({ id, taskId: 't1', type, payload: {}, createdAt: `2026-01-01T00:00:0${id}.000Z` });

describe('GET /agents', () => {
  it('returns the four known agents + a cursor', async () => {
    const p = new AgentActivityProjection(50);
    p.apply(ev('1', 'researcher.started'));
    const res = await appWith(p).request('/agents');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { agentId: string; status: string }[]; cursor: string | null };
    expect(body.data.map((a) => a.agentId)).toEqual(['analyst', 'researcher', 'critic', 'builder']);
    expect(body.data.find((a) => a.agentId === 'researcher')!.status).toBe('working');
    expect(body.cursor).toBeTruthy();
  });

  it('returns a null cursor when empty', async () => {
    const res = await appWith(new AgentActivityProjection(50)).request('/agents');
    expect((await res.json() as { cursor: string | null }).cursor).toBeNull();
  });
});

describe('GET /agents/:agentId', () => {
  it('200 for a known agent', async () => {
    const res = await appWith(new AgentActivityProjection(50)).request('/agents/researcher');
    expect(res.status).toBe(200);
    expect((await res.json() as { agentId: string }).agentId).toBe('researcher');
  });
  it('404 for an unknown agent', async () => {
    const res = await appWith(new AgentActivityProjection(50)).request('/agents/ghost');
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/read-api/routes/agents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/read-api/routes/agents.ts
import type { Hono } from 'hono';
import type { AgentActivityProjection } from '../projection.ts';
import type { AgentId } from '../agent-taxonomy.ts';

export interface AgentRouteDeps {
  projection: AgentActivityProjection;
}

export function registerAgentRoutes(app: Hono, deps: AgentRouteDeps): void {
  app.get('/agents', (c) => c.json(deps.projection.snapshot()));
  app.get('/agents/:agentId', (c) => {
    const activity = deps.projection.getAgent(c.req.param('agentId') as AgentId);
    if (!activity) return c.json({ error: { code: 'not_found', message: 'unknown agent' } }, 404);
    return c.json(activity);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/read-api/routes/agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/read-api/routes/agents.ts src/read-api/routes/agents.test.ts
git commit -m "feat(sp6): agents snapshot + activity routes"
```

---

## Task 6: routes/stream.ts (SSE)

**Files:**
- Create: `src/read-api/routes/stream.ts`
- Test: `src/read-api/routes/stream.test.ts`

Per-connection reducer: subscribe live first (buffer), replay from the resume cursor via the read port, then drain the buffer and go live. A monotonic keyset cursor (`lastKey`) dedups the replay/live overlap. `Last-Event-ID` beats `?cursor=`; a malformed header is ignored (resume from tail), a malformed explicit `?cursor=` throws → SP-5 `onError` → 400.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerStreamRoutes } from './stream.ts';
import { encodeCursor } from '../pagination.ts';
import { InMemoryAgentEventReadAdapter } from '../../adapters/read/in-memory-agent-event-read.adapter.ts';
import { InMemoryAgentEventStream } from '../../adapters/read/in-memory-agent-event-stream.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

const ev = (id: string, type: string): AgentEventRow => ({ id, taskId: 't1', type, payload: {}, createdAt: `2026-01-01T00:00:0${id}.000Z` });

// Read an open SSE response until `marker` appears (or N chunks), then abort.
async function readUntil(res: Response, marker: string, ac: AbortController): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (let i = 0; i < 50 && !buf.includes(marker); i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  ac.abort();
  await reader.cancel().catch(() => {});
  return buf;
}

function appWith(seed: AgentEventRow[], stream: InMemoryAgentEventStream, liveCursor: { t: string; id: string } | null = null): Hono {
  const app = new Hono();
  registerStreamRoutes(app, {
    agentEvents: new InMemoryAgentEventReadAdapter(seed),
    agentStream: stream,
    heartbeatMs: 60_000, // keep heartbeats out of the assertion window
    getLiveCursor: () => liveCursor,
  });
  return app;
}

describe('GET /stream (SSE)', () => {
  it('replays from an explicit ?cursor= as frames', async () => {
    const stream = new InMemoryAgentEventStream();
    await stream.start();
    const app = appWith([ev('1', 'researcher.started'), ev('2', 'researcher.completed')], stream);
    const before = encodeCursor({ t: '2026-01-01T00:00:00.000Z', id: '' }); // before e1
    const ac = new AbortController();
    const res = await app.request(`/stream?cursor=${encodeURIComponent(before)}`, { signal: ac.signal });
    const text = await readUntil(res, 'event: agent_event_appended', ac);
    expect(text).toContain('event: agent_status_changed');
    expect(text).toContain('event: agent_event_appended');
    expect(text).toContain('"agentId":"researcher"');
    await stream.stop();
  });

  it('defaults to the live tail — no history replay — and delivers live events', async () => {
    const stream = new InMemoryAgentEventStream();
    await stream.start();
    const seeded = ev('1', 'researcher.started');
    const app = appWith([seeded], stream, { t: seeded.createdAt, id: seeded.id }); // live cursor = newest seeded
    const ac = new AbortController();
    const res = await app.request('/stream', { signal: ac.signal });           // no resume token → live tail
    setTimeout(() => stream.push(ev('5', 'critic.failed')), 20);
    const text = await readUntil(res, 'critic', ac);
    expect(text).toContain('"agentId":"critic"');
    expect(text).toContain('"status":"failed"');
    expect(text).not.toContain('"agentId":"researcher"');                      // history NOT replayed
    await stream.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/read-api/routes/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/read-api/routes/stream.ts
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentEventReadPort, AgentEventRow } from '../../ports/agent-event-read.port.ts';
import type { AgentEventStreamPort } from '../../ports/agent-event-stream.port.ts';
import type { Cursor } from '../../ports/keyset.ts';
import type { AgentId, AgentLifecycle } from '../agent-taxonomy.ts';
import { agentIdForType } from '../agent-taxonomy.ts';
import { framesForEvent } from '../stream-frames.ts';
import { decodeCursor } from '../pagination.ts';

export interface StreamRouteDeps {
  agentEvents: AgentEventReadPort;
  agentStream: AgentEventStreamPort;
  heartbeatMs: number;
  getLiveCursor: () => Cursor | null; // projection.cursorKey(): default resume = live tail
  replayPageSize?: number;
}

const keyOf = (row: AgentEventRow): Cursor => ({ t: row.createdAt, id: row.id });
const isAfter = (a: Cursor, b: Cursor): boolean => a.t > b.t || (a.t === b.t && a.id > b.id);

export function registerStreamRoutes(app: Hono, deps: StreamRouteDeps): void {
  const pageSize = deps.replayPageSize ?? 200;

  app.get('/stream', (c) => {
    // Resume point: valid Last-Event-ID wins; else valid ?cursor=; else the live tail
    // (projection cursor) so a fresh client does NOT replay all history. A malformed
    // Last-Event-ID is ignored (fall through); a malformed explicit ?cursor= throws → 400.
    const headerId = c.req.header('last-event-id');
    const queryCursor = c.req.query('cursor');
    let after: Cursor | undefined;
    if (headerId) {
      try { after = decodeCursor(headerId); }
      catch { after = queryCursor ? decodeCursor(queryCursor) : (deps.getLiveCursor() ?? undefined); }
    } else if (queryCursor) {
      after = decodeCursor(queryCursor);
    } else {
      after = deps.getLiveCursor() ?? undefined;
    }

    return streamSSE(c, async (stream) => {
      const status = new Map<AgentId, AgentLifecycle>();
      let lastKey: Cursor | undefined = after;

      const emit = async (row: AgentEventRow): Promise<void> => {
        const k = keyOf(row);
        if (lastKey && !isAfter(k, lastKey)) return; // monotonic dedup (replay/live overlap)
        const agentId = agentIdForType(row.type);
        const { frames, status: s } = framesForEvent(status.get(agentId), row);
        status.set(agentId, s);
        for (const f of frames) {
          await stream.writeSSE({ event: f.event, data: JSON.stringify(f.data), ...(f.id ? { id: f.id } : {}) });
        }
        lastKey = k;
      };

      // 1) Subscribe live first; buffer until replay completes (gapless handover).
      const buffer: AgentEventRow[] = [];
      let live = false;
      let pumping = false;
      const pump = async (): Promise<void> => {
        if (pumping) return;
        pumping = true;
        while (buffer.length) await emit(buffer.shift()!);
        pumping = false;
      };
      const unsub = deps.agentStream.subscribe((row) => { buffer.push(row); if (live) void pump(); });

      try {
        // 2) Replay from the resume cursor up to the current tail.
        let cur = after;
        for (;;) {
          const rows = await deps.agentEvents.list({ after: cur, limit: pageSize });
          if (rows.length === 0) break;
          for (const row of rows) await emit(row);
          cur = keyOf(rows[rows.length - 1]!);
          if (rows.length < pageSize) break;
        }
        // 3) Go live: drain anything buffered during replay, then stream live.
        live = true;
        await pump();

        // 4) Heartbeat + hold open until the client disconnects.
        const hb = setInterval(() => { void stream.write(': ping\n\n'); }, deps.heartbeatMs);
        await new Promise<void>((resolve) => {
          const signal = c.req.raw.signal;
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        clearInterval(hb);
      } finally {
        unsub();
      }
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/read-api/routes/stream.test.ts`
Expected: PASS. (If the live test is timing-sensitive on a slow machine, the `setTimeout(…, 20)` gives the handler time to finish replay and set `live = true`; the 50-chunk read budget in `readUntil` is the upper bound.)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/read-api/routes/stream.ts src/read-api/routes/stream.test.ts
git commit -m "feat(sp6): internal SSE stream route (replay-from-cursor + live)"
```

---

## Task 7: Trigger migration

**Files:**
- Create: `migrations/0006_agent_event_notify.sql` (+ auto-updated `migrations/meta/_journal.json`, `migrations/meta/0006_snapshot.json`)

- [ ] **Step 1: Scaffold an empty custom migration**

Run: `pnpm exec drizzle-kit generate --custom --name agent_event_notify`
Expected: creates `migrations/0006_agent_event_notify.sql` (empty), appends an `idx: 6` entry to `migrations/meta/_journal.json`, and writes `migrations/meta/0006_snapshot.json`.

- [ ] **Step 2: Fill in the trigger SQL**

Write `migrations/0006_agent_event_notify.sql`:

```sql
CREATE OR REPLACE FUNCTION agent_event_notify() RETURNS trigger AS $$
BEGIN
  -- Minimal, safe wake-up signal on a service-scoped channel: id + created_at only.
  -- No payload, user text, or secrets. The read process re-reads the canonical row by keyset.
  PERFORM pg_notify('trading_lab_agent_event', NEW.id || '|' || extract(epoch from NEW.created_at)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_event_notify_tr ON agent_event;
--> statement-breakpoint
CREATE TRIGGER agent_event_notify_tr
  AFTER INSERT ON agent_event
  FOR EACH ROW EXECUTE FUNCTION agent_event_notify();
```

(`--> statement-breakpoint` is drizzle's statement separator; keep one between each statement.)

- [ ] **Step 3: Apply against a local/test database**

Run (requires `DATABASE_URL`): `pnpm db:migrate`
Expected: `0006_agent_event_notify` applies cleanly; re-running is safe (the `DROP TRIGGER IF EXISTS` makes it idempotent).

- [ ] **Step 4: Sanity-check the trigger fires** (optional, requires `psql`)

```bash
psql "$DATABASE_URL" -c "SELECT tgname FROM pg_trigger WHERE tgname = 'agent_event_notify_tr';"
```
Expected: one row.

- [ ] **Step 5: Commit**

```bash
git add migrations/0006_agent_event_notify.sql migrations/meta/_journal.json migrations/meta/0006_snapshot.json
git commit -m "feat(sp6): agent_event NOTIFY trigger migration"
```

---

## Task 8: PgNotifyAgentEventStream adapter

**Files:**
- Create: `src/adapters/read/pg-notify-agent-event-stream.ts`
- Test: `src/adapters/read/pg-notify-agent-event-stream.test.ts` (DB-gated, like the SP-5 drizzle tests)

- [ ] **Step 1: Write the failing test** (skips when `DATABASE_URL` is unset)

```ts
import { describe, it, expect } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDbClient } from '../../db/client.ts';
import { agentEvent, researchTask } from '../../db/schema.ts';
import { DrizzleAgentEventReadAdapter } from './drizzle-agent-event-read.adapter.ts';
import { PgNotifyAgentEventStream } from './pg-notify-agent-event-stream.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('PgNotifyAgentEventStream', () => {
  const { db, pool } = createDbClient(url!);
  const taskId = 'sp6task';
  const evId = 'sp6e1';

  it('delivers a freshly inserted agent_event to subscribers via NOTIFY', async () => {
    await db.delete(agentEvent).where(inArray(agentEvent.id, [evId]));
    await db.delete(researchTask).where(eq(researchTask.id, taskId));
    await db.insert(researchTask).values({ id: taskId, taskType: 'research.run_cycle', source: 'web', correlationId: 'corr-sp6', status: 'running', payload: {} });

    const stream = new PgNotifyAgentEventStream(pool, new DrizzleAgentEventReadAdapter(db), { safetyTickMs: 60_000 });
    const got: string[] = [];
    const received = new Promise<void>((resolve) => { stream.subscribe((r: AgentEventRow) => { got.push(r.id); resolve(); }); });
    await stream.start({ t: new Date().toISOString(), id: '' });

    await db.insert(agentEvent).values({ id: evId, taskId, type: 'researcher.started', payload: { secret: 'x' }, createdAt: new Date() });

    await Promise.race([received, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for NOTIFY')), 4000))]);
    expect(got).toContain(evId);

    await stream.stop();
    await db.delete(agentEvent).where(inArray(agentEvent.id, [evId]));
    await db.delete(researchTask).where(eq(researchTask.id, taskId));
    await pool.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/adapters/read/pg-notify-agent-event-stream.test.ts`
Expected: FAIL — module not found (or `describe.skip` with no `DATABASE_URL`; set it to exercise the real path against a DB that has the Task 7 migration applied).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapters/read/pg-notify-agent-event-stream.ts
// Real stream source: one dedicated LISTEN client + keyset catch-up reads. NOTIFY is only
// a wake-up signal — the canonical rows (and ordering) come from AgentEventReadPort.
import type { Pool, PoolClient } from 'pg';
import type { AgentEventReadPort, AgentEventRow } from '../../ports/agent-event-read.port.ts';
import type { AgentEventStreamPort } from '../../ports/agent-event-stream.port.ts';
import type { Cursor } from '../../ports/keyset.ts';

const CHANNEL = 'trading_lab_agent_event';
const isAfter = (a: Cursor, b: Cursor): boolean => a.t > b.t || (a.t === b.t && a.id > b.id);

export interface PgNotifyOpts {
  safetyTickMs: number;
  pageSize?: number;
  reconnectMs?: number;
}

export class PgNotifyAgentEventStream implements AgentEventStreamPort {
  private client: PoolClient | null = null;
  private readonly subs = new Set<(row: AgentEventRow) => void>();
  private cursor: Cursor | undefined;
  private tick: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly reader: AgentEventReadPort,
    private readonly opts: PgNotifyOpts,
  ) {}

  // startCursor = the projection's post-rebuild position; catch-up resumes AFTER it.
  // Falsy (null/undefined) → cursor stays unset (catch-up reads from the start of agent_event).
  async start(startCursor?: Cursor | null): Promise<void> {
    this.stopped = false;
    if (startCursor) this.cursor = startCursor;
    await this.connect();
    this.tick = setInterval(() => { void this.catchUp(); }, this.opts.safetyTickMs);
    await this.catchUp();
  }

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    client.on('notification', () => { void this.catchUp(); });
    client.on('error', () => { this.reconnect(); });
    await client.query(`LISTEN ${CHANNEL}`);
    this.client = client;
  }

  private reconnect(): void {
    if (this.stopped) return;
    try { this.client?.release(); } catch { /* ignore */ }
    this.client = null;
    setTimeout(() => {
      if (this.stopped) return;
      void this.connect().then(() => this.catchUp()).catch(() => this.reconnect());
    }, this.opts.reconnectMs ?? 1000);
  }

  private async catchUp(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      const pageSize = this.opts.pageSize ?? 200;
      for (;;) {
        const rows = await this.reader.list({ after: this.cursor, limit: pageSize });
        if (rows.length === 0) break;
        for (const row of rows) {
          const k: Cursor = { t: row.createdAt, id: row.id };
          if (this.cursor && !isAfter(k, this.cursor)) continue;
          for (const cb of [...this.subs]) cb(row);
          this.cursor = k;
        }
        if (rows.length < pageSize) break;
      }
    } finally {
      this.draining = false;
    }
  }

  subscribe(onEvent: (row: AgentEventRow) => void): () => void {
    this.subs.add(onEvent);
    return () => { this.subs.delete(onEvent); };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    if (this.client) {
      try { await this.client.query(`UNLISTEN ${CHANNEL}`); } catch { /* ignore */ }
      this.client.release();
      this.client = null;
    }
    this.subs.clear();
  }
}
```

- [ ] **Step 4: Run the test**

Run (with a migrated `DATABASE_URL`): `DATABASE_URL=postgres://… pnpm exec vitest run src/adapters/read/pg-notify-agent-event-stream.test.ts`
Expected: PASS — the subscriber receives `sp6e1` within the timeout. Without `DATABASE_URL`: the suite is skipped (still a green run).

- [ ] **Step 5: Typecheck + boundary guard + commit**

```bash
pnpm typecheck
pnpm exec vitest run src/read-api/read-boundary.guard.test.ts
git add src/adapters/read/pg-notify-agent-event-stream.ts src/adapters/read/pg-notify-agent-event-stream.test.ts
git commit -m "feat(sp6): PgNotify agent-event stream adapter (LISTEN + keyset catch-up)"
```

---

## Task 9: Env knobs

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts` (add cases)

- [ ] **Step 1: Write the failing test** (append to `src/config/env.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';

describe('SP-6 agent-activity knobs', () => {
  it('defaults the four knobs', () => {
    const env = loadEnv({});
    expect(env.AGENT_ACTIVITY_REBUILD_WINDOW_HOURS).toBe(24);
    expect(env.AGENT_ACTIVITY_TRACE_LIMIT).toBe(50);
    expect(env.AGENT_EVENT_STREAM_SAFETY_TICK_MS).toBe(5000);
    expect(env.AGENT_EVENT_STREAM_HEARTBEAT_MS).toBe(15000);
  });
  it('parses overrides', () => {
    const env = loadEnv({
      AGENT_ACTIVITY_REBUILD_WINDOW_HOURS: '6',
      AGENT_ACTIVITY_TRACE_LIMIT: '10',
      AGENT_EVENT_STREAM_SAFETY_TICK_MS: '1000',
      AGENT_EVENT_STREAM_HEARTBEAT_MS: '30000',
    });
    expect(env.AGENT_ACTIVITY_REBUILD_WINDOW_HOURS).toBe(6);
    expect(env.AGENT_ACTIVITY_TRACE_LIMIT).toBe(10);
    expect(env.AGENT_EVENT_STREAM_SAFETY_TICK_MS).toBe(1000);
    expect(env.AGENT_EVENT_STREAM_HEARTBEAT_MS).toBe(30000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/config/env.test.ts`
Expected: FAIL — the new `Env` fields are `undefined` / not present.

- [ ] **Step 3: Add the fields to the `Env` interface**

In `src/config/env.ts`, add to `interface Env` (e.g. after `CHAT_MAX_MESSAGE_CHARS`):

```ts
  AGENT_ACTIVITY_REBUILD_WINDOW_HOURS: number;
  AGENT_ACTIVITY_TRACE_LIMIT: number;
  AGENT_EVENT_STREAM_SAFETY_TICK_MS: number;
  AGENT_EVENT_STREAM_HEARTBEAT_MS: number;
```

And add to the object returned by `loadEnv` (reusing the existing `parsePositiveInt` helper):

```ts
    AGENT_ACTIVITY_REBUILD_WINDOW_HOURS: parsePositiveInt(source.AGENT_ACTIVITY_REBUILD_WINDOW_HOURS, 24),
    AGENT_ACTIVITY_TRACE_LIMIT: parsePositiveInt(source.AGENT_ACTIVITY_TRACE_LIMIT, 50),
    AGENT_EVENT_STREAM_SAFETY_TICK_MS: parsePositiveInt(source.AGENT_EVENT_STREAM_SAFETY_TICK_MS, 5000),
    AGENT_EVENT_STREAM_HEARTBEAT_MS: parsePositiveInt(source.AGENT_EVENT_STREAM_HEARTBEAT_MS, 15000),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/config/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(sp6): env knobs for projection rebuild + stream timings"
```

---

## Task 10: Wire-up — deps, routes, composition, server lifecycle

**Files:**
- Modify: `src/read-api/deps.ts`
- Modify: `src/read-api/read-app.ts`
- Modify: `src/read-api/read-app.test.ts`
- Modify: `src/composition.ts`
- Modify: `src/ingress/server.ts`

This task adds the new `ReadApiDeps` fields and updates every consumer in one commit so `pnpm typecheck` stays green.

- [ ] **Step 1: Extend `ReadApiDeps`** (`src/read-api/deps.ts`)

```ts
import type { BacktestReadPort } from '../ports/backtest-read.port.ts';
import type { AgentEventReadPort } from '../ports/agent-event-read.port.ts';
import type { HypothesisReadPort } from '../ports/hypothesis-read.port.ts';
import type { AgentEventStreamPort } from '../ports/agent-event-stream.port.ts';
import type { AgentActivityProjection } from './projection.ts';

export interface ReadApiDeps {
  hypotheses: HypothesisReadPort;
  backtests: BacktestReadPort;
  agentEvents: AgentEventReadPort;
  projection: AgentActivityProjection;
  agentStream: AgentEventStreamPort;
  streamHeartbeatMs: number;
  checkReadiness: () => Promise<boolean>;
  token: string;
}
```

(Keep the existing import for `HypothesisReadPort` if it was already imported — adjust to avoid duplicate imports.)

- [ ] **Step 2: Register the new routes + extend `V1_PATHS`** (`src/read-api/read-app.ts`)

Add imports:

```ts
import { registerAgentRoutes } from './routes/agents.ts';
import { registerStreamRoutes } from './routes/stream.ts';
```

Extend `V1_PATHS`:

```ts
const V1_PATHS = ['/hypotheses', '/hypotheses/:id', '/backtests', '/backtests/:id', '/agent-events', '/agents', '/agents/:agentId', '/stream'];
```

Register inside `createReadApp`, alongside the existing route registrations on `v1`:

```ts
  registerAgentRoutes(v1, deps);
  registerStreamRoutes(v1, {
    agentEvents: deps.agentEvents,
    agentStream: deps.agentStream,
    heartbeatMs: deps.streamHeartbeatMs,
    getLiveCursor: () => deps.projection.cursorKey(),
  });
```

- [ ] **Step 3: Update the test `deps()` helper** (`src/read-api/read-app.test.ts`)

Add imports:

```ts
import { AgentActivityProjection } from './projection.ts';
import { InMemoryAgentEventStream } from '../adapters/read/in-memory-agent-event-stream.ts';
```

Extend the returned object in `deps()`:

```ts
  return {
    hypotheses: new InMemoryHypothesisReadAdapter([]),
    backtests: new InMemoryBacktestReadAdapter([]),
    agentEvents: new InMemoryAgentEventReadAdapter([]),
    projection: new AgentActivityProjection(50),
    agentStream: new InMemoryAgentEventStream(),
    streamHeartbeatMs: 60_000,
    checkReadiness: async () => true,
    token: TOKEN,
    ...over,
  };
```

- [ ] **Step 3b: Update the inline deps in the e2e test** (`src/read-api/read-app.e2e.test.ts`)

This file constructs `ReadApiDeps` as an inline object literal, so the new required fields must be added here too (otherwise `pnpm typecheck` breaks). Add imports:

```ts
import { AgentActivityProjection } from './projection.ts';
import { InMemoryAgentEventStream } from '../adapters/read/in-memory-agent-event-stream.ts';
```

Extend the `createReadApp({ … })` object literal with the three new fields:

```ts
    const app = createReadApp({
      hypotheses: new InMemoryHypothesisReadAdapter([]),
      backtests: new InMemoryBacktestReadAdapter([]),
      agentEvents: new InMemoryAgentEventReadAdapter([]),
      projection: new AgentActivityProjection(50),
      agentStream: new InMemoryAgentEventStream(),
      streamHeartbeatMs: 60_000,
      checkReadiness: async () => true,
      token: 'e2e',
    });
```

Optionally extend the asserted path list to include the new GET routes:

```ts
    for (const path of ['/v1/hypotheses', '/v1/backtests', '/v1/agent-events', '/v1/agents']) {
```

(Do **not** add `/v1/stream` to that loop — it is a long-lived SSE response, not a JSON `{ data: [] }` body.)

- [ ] **Step 4: Add a wired route test** (append to `src/read-api/read-app.test.ts`, inside the `routes` describe block)

```ts
  it('GET /v1/agents requires a token and returns the known agents', async () => {
    expect((await createReadApp(deps()).request('/v1/agents')).status).toBe(401);
    const res = await createReadApp(deps()).request('/v1/agents', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { agentId: string }[]; cursor: string | null };
    expect(body.data.map((a) => a.agentId)).toEqual(['analyst', 'researcher', 'critic', 'builder']);
  });

  it('GET /v1/agents/:agentId → 404 for unknown', async () => {
    const res = await createReadApp(deps()).request('/v1/agents/ghost', { headers: AUTH });
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 5: Wire composition** (`src/composition.ts`)

Add imports near the other read-adapter imports:

```ts
import { AgentActivityProjection } from './read-api/projection.ts';
import { PgNotifyAgentEventStream } from './adapters/read/pg-notify-agent-event-stream.ts';
```

In `composeRuntime`, build the read agent-event adapter once so both the read port and the stream share it, then construct the projection + stream. Replace the existing `read` block's `agentEvents` wiring with:

```ts
  const agentEventsRead = new DrizzleAgentEventReadAdapter(db);
  const projection = new AgentActivityProjection(env.AGENT_ACTIVITY_TRACE_LIMIT);
  const agentStream = new PgNotifyAgentEventStream(pool, agentEventsRead, {
    safetyTickMs: env.AGENT_EVENT_STREAM_SAFETY_TICK_MS,
  });

  const read: ReadApiDeps = {
    hypotheses: new DrizzleHypothesisReadAdapter(db),
    backtests: new DrizzleBacktestReadAdapter(db),
    agentEvents: agentEventsRead,
    projection,
    agentStream,
    streamHeartbeatMs: env.AGENT_EVENT_STREAM_HEARTBEAT_MS,
    checkReadiness: async () => {
      try { await db.execute(sql`select 1`); return true; } catch { return false; }
    },
    token: env.TRADING_LAB_READ_TOKEN ?? '',
  };
```

(Remove the now-duplicated `agentEvents: new DrizzleAgentEventReadAdapter(db)` line from the old `read` literal.)

- [ ] **Step 6: Wire server lifecycle** (`src/ingress/server.ts`)

Replace the read-API start block with a rebuild → start → subscribe sequence, and stop the stream on shutdown. The rebuild reads the tail via the read port and seeds the projection; the stream then starts from the projection's cursor:

```ts
import { loadEnv } from '../config/env.ts';
// ...existing imports...

const { env, services, queue, pool, chat, read } = composeRuntime();
const app = createIngressApp({ repo: services.researchTasks, queue });
app.route('/chat', createChatApp(chat));
serve({ fetch: app.fetch, port: env.INGRESS_PORT });
console.log(`ingress listening on :${env.INGRESS_PORT}`);

if (env.TRADING_LAB_READ_TOKEN) {
  // Rebuild the projection from the tail of agent_event, then go live.
  const sinceMs = Date.now() - env.AGENT_ACTIVITY_REBUILD_WINDOW_HOURS * 3_600_000;
  const since = new Date(sinceMs).toISOString();
  let cur: { t: string; id: string } | undefined;
  for (;;) {
    const rows = await read.agentEvents.list({ since, after: cur, limit: 500 });
    if (rows.length === 0) break;
    for (const row of rows) read.projection.apply(row);
    cur = { t: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.id };
    if (rows.length < 500) break;
  }
  read.agentStream.subscribe((row) => read.projection.apply(row));
  await read.agentStream.start(read.projection.cursorKey());

  serve({ fetch: createReadApp(read).fetch, port: env.READ_API_PORT });
  console.log(`read API listening on :${env.READ_API_PORT}`);
} else {
  console.warn('[read-api] TRADING_LAB_READ_TOKEN not set — read API listener not started');
}

const shutdown = async () => {
  if (env.TRADING_LAB_READ_TOKEN) await read.agentStream.stop();
  await queue.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

(`server.ts` already runs at top-level `await` — the file uses `await import` elsewhere in the codebase pattern; the ingress entry is a module, so top-level `await` is fine under `node --experimental-strip-types`.)

- [ ] **Step 7: Run the full read-api + boundary suite**

Run: `pnpm exec vitest run src/read-api/ src/adapters/read/ src/config/env.test.ts`
Expected: PASS (including the SP-5 `read-app.e2e.test.ts` and `read-boundary.guard.test.ts` — the boundary guard must stay green with the new files).

- [ ] **Step 8: Full typecheck + test run**

Run:
```bash
pnpm typecheck
pnpm test
```
Expected: typecheck clean; all tests pass (DB-gated suites skip without `DATABASE_URL`).

- [ ] **Step 9: Commit**

```bash
git add src/read-api/deps.ts src/read-api/read-app.ts src/read-api/read-app.test.ts src/read-api/read-app.e2e.test.ts src/composition.ts src/ingress/server.ts
git commit -m "feat(sp6): wire agent activity projection + SSE stream into read API"
```

---

## Task 11: README + env example

**Files:**
- Modify: `src/read-api/README.md`
- Modify: `.env.example` (if present in the repo root — otherwise skip)

- [ ] **Step 1: Update the read-api README** (`src/read-api/README.md`) — add the new endpoints + the realtime note:

```markdown
SP-6 adds an internal, read-only Agent Activity Projection + realtime stream:
- `GET /v1/agents` — snapshot of logical agents (`analyst`, `researcher`, `critic`, `builder`, `system`) with status + currentTaskId + last event, plus an opaque `cursor`.
- `GET /v1/agents/:agentId` — agent activity (status, currentTask, sanitized trace tail).
- `GET /v1/stream` — SSE (server→client only). Resume via `Last-Event-ID` (preferred) or `?cursor=`. Events: `agent_status_changed`, `agent_event_appended`. `: ping` heartbeat.

Delivery: a Postgres `AFTER INSERT` trigger on `agent_event` fires `pg_notify('trading_lab_agent_event', …)` as a wake-up; the read process LISTENs and does a keyset catch-up read (source of truth). The projection is in-memory (rebuilt from the tail on boot); the read API never writes a table. v1 assumes a single read instance. Knobs: `AGENT_ACTIVITY_REBUILD_WINDOW_HOURS`, `AGENT_ACTIVITY_TRACE_LIMIT`, `AGENT_EVENT_STREAM_SAFETY_TICK_MS`, `AGENT_EVENT_STREAM_HEARTBEAT_MS`. See `docs/superpowers/specs/2026-06-13-trading-lab-sp6-agent-activity-stream-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add src/read-api/README.md
git commit -m "docs(sp6): read API README — agent activity + stream endpoints"
```

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- §4 taxonomy + status derivation → Task 1 (ordered/separator-tolerant matching incl. `build_failed`; failure-first lifecycle).
- §4.3 currentTask semantics → Task 2 (currentTask = latest event's task/type/status; null only at boot idle; terminal retained).
- §5 projection (rebuild-from-tail, ring buffer, monotonic cursor) → Task 2 (object) + Task 10 Step 6 (boot rebuild).
- §6 `AgentEventStreamPort` (start/stop/subscribe) + fakes/real adapter → Tasks 3, 8.
- §7 DTOs + sanitization via `toAgentEventDto` → Task 2 (DTOs) + Task 4 (frames reuse sanitizer).
- §8 endpoints (`/agents`, `/agents/:id`, `/stream`; cursor=null when empty; Last-Event-ID > ?cursor; heartbeat; abort) → Tasks 5, 6, 10.
- §9 trigger migration (service-scoped channel, DROP-before-CREATE, id+created_at payload) → Task 7.
- §10 env knobs → Task 9.
- §11 single-instance assumption → documented in README (Task 11) + spec; no multi-instance code.
- §12 module layout → matches the File structure section.
- §13 boundary guard (new port in PORT_FILES; dirs auto-walked) → Task 3 Step 6 + Task 10 Step 7.
- §14 test matrix → taxonomy (T1), projection (T2), in-memory stream (T3), frames (T4), routes (T5/T6), pg-notify integration (T8), boundary (T3/T10).

**2. Placeholder scan:** No TBD/TODO; every code step shows full file or exact insertion; every command has expected output. The migration filename index `0006` is concrete (verified: existing `0000`–`0005`).

**3. Type consistency:** `AgentId`/`AgentLifecycle` declared in `agent-taxonomy.ts` and imported everywhere (dto.ts, projection.ts, stream-frames.ts, routes). `framesForEvent(prev, row) → { frames, status }` used consistently in Task 4 (definition) and Task 6 (consumer). `AgentActivityProjection(traceLimit)` constructor arity matches all call sites (tests pass `50`; composition passes `env.AGENT_ACTIVITY_TRACE_LIMIT`). `PgNotifyAgentEventStream(pool, reader, opts)` signature matches Task 8 test + Task 10 composition. `ReadApiDeps` gains `projection`/`agentStream`/`streamHeartbeatMs`; the test helper, composition, and read-app all updated in Task 10. `AgentEventReadPort.list({ after, since, limit })` calls match the SP-5 port signature.

**Note for the implementer:** Task 8's integration test and Task 7's migration must both be applied to the same `DATABASE_URL` for the NOTIFY path to be exercised; without `DATABASE_URL` those suites skip (a green run that does not prove the live path). Run them against a migrated database before declaring SP-6 verified.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-13-trading-lab-sp6-agent-activity-stream.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
