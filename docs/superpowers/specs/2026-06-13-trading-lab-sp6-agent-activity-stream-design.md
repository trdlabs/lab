# SP-6 — Agent Activity Projection + Internal Realtime Stream (for trading-office)

Status: **Approved** (design) · Date: 2026-06-13 · Depends on: SP-1 (`agent_event`, `research_task`, repositories), SP-5 (read-only API foundation: `AgentEventReadPort`, keyset pagination, deny-by-default DTOs, read-boundary guard, `READ_API_PORT`, `TRADING_LAB_READ_TOKEN`)

---

## 1. Goal

Give `trading-lab` a **read-only Agent Activity Projection** and an **internal server-to-server realtime stream** so a future `TradingLabHttpConnector` in `trading-office` (server-to-server) can render live agent state — *which agents exist, what each is doing now, its status, current task, last event, and a tail of its trace* — with realtime updates instead of browser polling.

This slice picks up exactly what SP-5 deferred ("an **internal** SSE/WS event stream for the office backend (reuses `AgentEventReadPort`)" and the "current-activity projection"). It reuses SP-5's sanitizer (`toAgentEventDto`), keyset cursor, and Bearer auth.

**Consumer topology (unchanged from SP-5):** browser → trading-office backend/BFF → (`TradingLabHttpConnector`) → trading-lab read API. The browser never talks to trading-lab directly. trading-office maps trading-lab's neutral DTOs to its own floor characters and UI status enum; that mapping is **out of scope** here.

### Core invariant (extends SP-5, does not weaken it)

> The read API stays **read-only and non-authoritative.** SP-6 adds three constraints:
> - The read process **only `LISTEN`s** Postgres and **reads** `agent_event` through the SP-5 read port. It MUST NOT write any table — the projection is **in-memory**. (A persistent projection written by the read runtime would violate this; it is explicitly deferred.)
> - It MUST NOT import or call the write side (`task-intake`, queue, worker, workflow-router, orchestrator handlers, write repositories) or anything from `trading-platform`.
> - The realtime stream is **one-directional (SSE)**. There is no route that accepts a command body — the absence of a command channel is structural, not policy.
>
> The static read token remains **service-to-service** auth only — not user authorization. No `Boss*` terminology anywhere (no `BossCommand`/`BossMessage`/`sendBossCommand`/`boss_command_*`).

---

## 2. Scope boundary

**In SP-6:**

- Pure derivation `agent_event.type → agentId + lifecycle status` (§4), no side effects.
- In-memory `AgentActivityProjection` (§5): rebuild-from-tail on boot, per-agent ring-buffer trace, monotonic keyset cursor.
- `AgentEventStreamPort` with explicit lifecycle `start()` / `stop()` / `subscribe()` (§6); real `PgNotifyAgentEventStream` (LISTEN + keyset catch-up + safety-net tick + reconnect) and `InMemoryAgentEventStream` fake.
- Raw-SQL migration: trigger function + `AFTER INSERT` trigger on `agent_event` emitting a minimal `pg_notify` signal (§9).
- Endpoints under the SP-5 gated `/v1` surface (§8): `GET /agents` (snapshot + cursor), `GET /agents/:agentId` (activity + trace), `GET /stream` (SSE; `Last-Event-ID` / `?cursor=`; heartbeat).
- DTOs + mappers (§7) reusing the deny-by-default `toAgentEventDto`.
- Env-configurable knobs (§10); composition wiring + lifecycle/shutdown, gated on `TRADING_LAB_READ_TOKEN` exactly like the SP-5 listener.
- Read-boundary import-guard extension + full test matrix (§13).

**Designed but deferred (boundary is ready; not wired):**

- WebSocket transport; any client→server path (commands over stream).
- Persistent `agent_activity` table / activity history as a source of truth.
- Redis pub/sub, durable replay beyond the keyset window, cross-instance fanout / multi-instance consistency (§11 — v1 assumes a single read instance).
- Refining agent status via `research_task.status`; deep payload/trace; idle-timeout (an agent decaying to `idle` after inactivity) — a v1.1 knob.
- Infra / ops health (queue / Redis / worker) and bot-health from `trading-platform`.
- All trading-office work: `TradingLabHttpConnector`, `POST /api/office/chat/messages`, real chat submission, platform SDK/MCP integration.

---

## 3. Architecture overview

```
worker process                          ingress + read process  (READ_API_PORT)
─────────────                           ──────────────────────────────────────────
handlers append agent_event ──INSERT──▶ Postgres (trading-lab only)
                                          │  AFTER INSERT trigger → pg_notify('trading_lab_agent_event', '<id>|<created_at_epoch>')
                                          │       (minimal wake-up signal — never raw payload / user text / secrets)
                                          │
            PgNotifyAgentEventStream  ◀── LISTEN trading_lab_agent_event   (one dedicated pooled client)
              on notify | reconnect | safety-net tick:
                AgentEventReadPort keyset read WHERE (created_at,id) > cursor   ◀── source of truth & ordering
                │  emits rows in order
                ▼
       AgentActivityProjection (in-memory)              AgentEventReadPort (SP-5, read-only)
         apply(row) → status + currentTask + trace ring
                │  yields deltas (agent_status_changed?, agent_event_appended)
                ▼
        SSE fan-out  ──▶ GET /v1/stream     (Bearer; id:=keyset cursor; events: agent_status_changed, agent_event_appended; :ping heartbeat)
        snapshot     ──▶ GET /v1/agents,  GET /v1/agents/:agentId
                                          ▲
                                          │ Authorization: Bearer <TRADING_LAB_READ_TOKEN>
                              trading-office backend (TradingLabHttpConnector)  →  browser via OfficeGateway
```

No edge leaves toward `trading-platform`. The write side (`POST /tasks`, `/chat/messages`, `/callbacks/*`) keeps running unchanged on `INGRESS_PORT`. The trigger lives in a migration and is **not** imported by read code; the worker and handlers are untouched (they keep `INSERT`-ing as today).

---

## 4. Agent taxonomy & status derivation

A logical agent is derived from the `agent_event.type` prefix. v1 fixes four agents; `builder` absorbs the backtest/evaluation phase of the build workflow.

### 4.1 Ordered, specific-first matching

Matching is **ordered** — the first rule that matches wins, evaluated top-to-bottom over an ordered rule list (not a map). `hypothesis.build` is checked **before** the concrete `hypothesis.*` researcher events so build events never leak into `researcher`.

**Separator-tolerant prefix match.** A rule prefix `P` matches event type `T` iff `T === P` **or** `T` starts with `P` followed by a separator — either `.` or `_`. The underscore case is load-bearing: the build handler emits `build_failed` (underscore, not dot), so a naive `build.*` dotted match would miss it and dump it into `system`. With the separator rule, prefix `build` matches both `build.started` and `build_failed`. (`builder.*` is **not** covered by prefix `build` — `er` is not a separator — so `builder` is listed explicitly.)

| order | rule prefixes (matched per the rule above) | → agentId | covers e.g. |
|------:|---------------------------------------------|-----------|-------------|
| 1 | `hypothesis.build` | `builder` | defensive: future `hypothesis.build.*` |
| 2 | `build`, `builder`, `artifact`, `backtest`, `evaluation` | `builder` | `build.started`, `build_failed`, `builder.completed`, `artifact.stored`, `backtest.submitted`, `evaluation.completed` |
| 3 | `research.run_cycle`, `researcher`, `hypothesis.generated`, `hypothesis.validated`, `hypothesis.rejected`, `hypothesis.deduped` | `researcher` | `research.run_cycle.started`, `researcher.completed`, `hypothesis.validated` |
| 4 | `strategy_analyst`, `strategy.onboard` | `analyst` | `strategy_analyst.started`, `strategy.onboard.deduped` |
| 5 | `critic` | `critic` | `critic.reviewed`, `critic.failed` |
| 6 | *unmatched* | `system` | unknown / unmapped types (e.g. chat events) |

Notes:
- There is **no** generic `hypothesis.*` catch-all. The researcher rule lists the concrete hypothesis events (rule 3); any `hypothesis.build.*` is already claimed by rule 1. New `hypothesis.*` events that are not explicitly listed fall to `system`, never silently into `researcher`.
- `system` is a neutral fallback bucket for unknown/unmapped event types. Unknown events are **still sanitized** through `toAgentEventDto` — no raw leak. `system` is a real `agentId` the snapshot may surface; it is not an error.
- `AGENT_IDS = ['analyst','researcher','critic','builder','system']`. The first four are the "known" agents always present in the snapshot (even with zero events → `idle`); `system` appears only once it has at least one event.

### 4.2 Lifecycle status (neutral, minimal)

The lab emits a minimal neutral enum and never copies the office UI enum. trading-office maps these to its richer presentation states (`thinking`/`running`/`reviewing`/`backtesting`/`success`/…).

```
type AgentLifecycle = 'idle' | 'working' | 'succeeded' | 'failed';
```

Derivation from the **suffix** of the agent's most recent event (ordered, specific-first):

| order | suffix / token | → status |
|------:|----------------|----------|
| 1 | `*.failed`, `*_failed`, `*.rejected`, `*.error` | `failed` |
| 2 | `*.started`, `*.running` | `working` |
| 3 | `*.completed`, `*.validated`, `*.reviewed`, `*.deduped`, `*.skipped` | `succeeded` |
| — | known agent with **no** events | `idle` |

**Resolved semantics (this removes the earlier idle↔terminal contradiction):**
- A terminal status (`succeeded` / `failed`) is the agent's **last known outcome** and is **retained** until the agent's next event arrives. `idle` does **not** overwrite a terminal status immediately after a terminal event.
- `idle` is only the **boot state** of a known agent that has produced no events within the rebuild window.
- An idle-timeout (decay back to `idle` after N minutes of inactivity) is **deferred to v1.1**; v1 keeps the last outcome indefinitely.
- The failure check is ordered **first** so a type containing both tokens cannot be misclassified.

### 4.3 `currentTask` semantics (explicit)

`currentTask` always reflects the **task of the agent's most recent event**, regardless of whether that event was terminal. After a terminal event the agent shows `status: succeeded|failed` **with** `currentTask` pointing at the task that just finished (so the UI renders "researcher · succeeded · task X" rather than a null flicker). `currentTask` is `null` **only** for a known agent that has produced no events (boot `idle`). `currentTask` exposes `{ id, type, status }` where `id` is the `agent_event.task_id` of the latest event, `type` is that latest event's **event type** (the projection reads only `agent_event` and never joins `research_task`, so it does **not** expose `research_task.task_type`), and `status` is the **derived agent lifecycle** — never the task payload.

---

## 5. AgentActivityProjection (in-memory)

A single in-memory object owned by the read process.

```ts
class AgentActivityProjection {
  // Pure transition. Applies one event, updates per-agent state, pushes a
  // sanitized AgentEventDto into that agent's ring buffer, advances the cursor.
  // Returns the deltas to fan out: always an agent_event_appended; plus an
  // agent_status_changed iff the derived status actually changed.
  apply(row: AgentEventRow): ProjectionDelta[];

  snapshot(): { data: AgentSummaryDto[]; cursor: string | null };
  getAgent(agentId: AgentId): AgentActivityDto | null;   // null → 404
  cursor(): string | null;                               // opaque SP-5 keyset cursor
}
```

- **State per agent:** `status`, `currentTask`, `lastEvent` (sanitized `AgentEventDto`), and a **ring buffer** of the last `AGENT_ACTIVITY_TRACE_LIMIT` (default 50) sanitized events, oldest→newest.
- **Cursor:** the keyset `(createdAt, id)` of the last applied row, encoded with SP-5's `encodeCursor`. `null` before any event is applied.
- **Rebuild-from-tail (boot):** read forward via `AgentEventReadPort.list({ since: now − AGENT_ACTIVITY_REBUILD_WINDOW_HOURS, limit, after })`, paginating to the current tail and applying each row. The SP-5 port is **unchanged** — `since` + keyset `after` already support this. Agents whose last activity predates the window boot as `idle` with an empty trace (acceptable for v1; documented).
- **Idempotent / monotonic:** `apply` ignores any row whose `(createdAt, id)` is ≤ the current cursor, so an overlapping catch-up read (notify racing the safety-net tick) cannot double-apply or emit duplicate deltas. The cursor only moves forward.

---

## 6. Event source: `AgentEventStreamPort` + adapters

Lifecycle is part of the contract (so composition/shutdown/reconnect are explicit, not an implementation detail):

```ts
// src/ports/agent-event-stream.port.ts
export interface AgentEventStreamPort {
  start(startCursor?: Cursor | null): Promise<void>;       // resume from projection's post-rebuild cursor
  stop(): Promise<void>;                                   // remove listeners, release client
  subscribe(onEvent: (row: AgentEventRow) => void): () => void; // returns unsubscribe
}
```

- **`PgNotifyAgentEventStream`** (`src/adapters/read/`): constructed with the node-postgres `pool` and the `AgentEventReadPort`.
  - `start(startCursor?)` seeds its catch-up cursor from the projection's post-rebuild position (so it resumes **after** what the projection already applied, never from the start of `agent_event`), checks out **one dedicated** client from the pool (held for the listener's lifetime, never returned mid-listen) and issues `LISTEN trading_lab_agent_event`.
  - On `notification` **or** a `AGENT_EVENT_STREAM_SAFETY_TICK_MS` tick (default 5000) **or** reconnect, it performs a **keyset catch-up read** (`AgentEventReadPort.list({ after: cursor, limit })`, looping until drained) and emits each row, in order, to subscribers. The NOTIFY payload is only a wake-up signal; the canonical row is always re-read from `agent_event`.
  - On client error / connection drop it reconnects with backoff and re-`LISTEN`s; the next catch-up read covers any events missed while disconnected.
  - `stop()` removes the notification handler and releases the client.
- **`InMemoryAgentEventStream`** (`src/adapters/read/`): a fake with `push(row)` driving `subscribe` callbacks synchronously, for projection/stream/route unit tests without a database. `start`/`stop` are no-ops.

Both adapters import only `pg`, the read port, and `keyset` — never the write side (enforced by §12 guard).

---

## 7. DTOs & sanitization

Added beside the SP-5 shapes in `src/read-api/dto.ts`; mappers in `src/read-api/mappers.ts` reuse `toAgentEventDto`.

```ts
type AgentId        = 'analyst' | 'researcher' | 'critic' | 'builder' | 'system';
type AgentLifecycle = 'idle' | 'working' | 'succeeded' | 'failed';

interface AgentSummaryDto {
  agentId: AgentId;
  status: AgentLifecycle;
  currentTaskId: string | null;
  lastEvent: AgentEventDto | null;        // sanitized; null at boot idle
}

interface AgentActivityDto {
  agentId: AgentId;
  status: AgentLifecycle;
  currentTask: { id: string; type: string; status: AgentLifecycle } | null; // type = latest event type
  trace: AgentEventDto[];                 // ring-buffer tail, oldest→newest, sanitized
}

// SSE delta envelopes (carried as `data:` JSON; see §8)
interface AgentStatusChanged  { agentId: AgentId; status: AgentLifecycle; currentTaskId: string | null; ts: string; }
interface AgentEventAppended  { agentId: AgentId; event: AgentEventDto; }
```

- `lastEvent` / `trace` / `event` are produced **only** through `toAgentEventDto` (deny-by-default; raw `payload` never serialized; only allow-listed scalar `payloadSummary` survives).
- `currentTask` exposes `id` + latest-event `type` + derived `status` only. No `payload`, `params`, hashes, module ids, contract versions, correlation ids, fingerprints, strategy text, user content, or secrets.
- Field is named **`trace`** in lab DTOs (consistent everywhere); trading-office maps `trace` → its `logs` as needed.

---

## 8. Endpoints

All three live under the SP-5 gated `/v1` surface (`readAuthMiddleware(deps.token)`). SP-5 routes are untouched; the new paths are added to `V1_PATHS` so the explicit-405 guard covers non-GET methods on them too.

- **`GET /v1/agents`** → `{ data: AgentSummaryDto[], cursor: string | null }`.
  - `data` includes the four known agents always (boot `idle` if no events) plus `system` once it has events.
  - `cursor` is the projection's current opaque keyset cursor (the same encoding SP-5 uses), or `null` when the projection is empty. The client opens the stream from exactly this cursor for a gap-free / duplicate-free snapshot→stream handover.
- **`GET /v1/agents/:agentId`** → `AgentActivityDto`; `404 { error: { code: 'not_found' } }` if `agentId` is outside `AGENT_IDS`.
- **`GET /v1/stream`** (SSE via `hono/streaming` `streamSSE`):
  - **Replay-from-cursor on connect:** resume point = `Last-Event-ID` header if present, else `?cursor=` query, else from the live tail. **`Last-Event-ID` takes priority** (SSE standard); `?cursor=` is the fallback for first connects / clients that can't set the header. The handler does a keyset catch-up from that cursor, then streams live deltas.
  - **Frame shape:** `id:` = keyset cursor of the event, `event:` ∈ {`agent_status_changed`, `agent_event_appended`}, `data:` = the corresponding JSON DTO from §7.
  - **Heartbeat:** a `:ping` comment every `AGENT_EVENT_STREAM_HEARTBEAT_MS` (default 15000) keeps proxies/connections warm.
  - **Teardown:** closes on `c.req.raw.signal` abort; the per-connection subscription is removed and no work leaks.

Replay, rebuild, and snapshot-cursor all ride the **same** keyset mechanism, so they compose without special cases.

---

## 9. Migration (trigger)

A hand-authored raw-SQL migration (same approach SP-5 used for index migrations; `drizzle-kit` does not model triggers):

```sql
CREATE OR REPLACE FUNCTION agent_event_notify() RETURNS trigger AS $$
BEGIN
  -- minimal, safe wake-up signal on a service-scoped channel: id + created_at only.
  -- No payload, user text, or secrets.
  PERFORM pg_notify('trading_lab_agent_event', NEW.id || '|' || extract(epoch from NEW.created_at)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DROP-before-CREATE so local re-runs / debug are idempotent.
DROP TRIGGER IF EXISTS agent_event_notify_tr ON agent_event;
CREATE TRIGGER agent_event_notify_tr
  AFTER INSERT ON agent_event
  FOR EACH ROW EXECUTE FUNCTION agent_event_notify();
```

The NOTIFY channel is **service-scoped** (`trading_lab_agent_event`, not the generic `agent_event`). The payload carries only `id` + `created_at`; the read process still reads the canonical row from `agent_event` by keyset cursor (the payload is never trusted as content). Authoring a trigger in a migration is **not** a read-boundary violation — the boundary forbids the read *runtime* from writing tables, which it does not (§11).

---

## 10. Config (env-configurable knobs)

Added to the `Env` interface and `loadEnv` in `src/config/env.ts`, with the documented defaults (exact names may be refined in the plan):

| env | default | meaning |
|-----|--------:|---------|
| `AGENT_ACTIVITY_REBUILD_WINDOW_HOURS` | 24 | how far back boot rebuild reads `agent_event` |
| `AGENT_ACTIVITY_TRACE_LIMIT` | 50 | per-agent ring-buffer size |
| `AGENT_EVENT_STREAM_SAFETY_TICK_MS` | 5000 | catch-up tick covering missed NOTIFYs |
| `AGENT_EVENT_STREAM_HEARTBEAT_MS` | 15000 | SSE `:ping` interval |

---

## 11. Multi-instance assumption (v1)

Explicitly recorded for v1:
- The projection is **in-memory, per read instance**; SSE fan-out is **per read instance**.
- There is **no cross-instance realtime guarantee** — two read instances maintain independent projections and independent client sets.
- Deployment **must route the trading-office backend to a single read instance** in v1.
- Redis pub/sub, durable fanout, and multi-instance consistency are **deferred**. Because each instance derives its projection independently from the shared `agent_event` table, scaling out later is additive and does not change the wire contract.

---

## 12. Module layout

```
src/ports/
  agent-event-stream.port.ts                 # NEW: AgentEventStreamPort (start/stop/subscribe)
src/adapters/read/
  pg-notify-agent-event-stream.ts            # NEW (+ .test.ts — integration: trigger→notify→catch-up)
  in-memory-agent-event-stream.ts            # NEW (+ .test.ts)
src/read-api/
  agent-taxonomy.ts                          # NEW: pure agentId + lifecycle derivation (+ .test.ts)
  projection.ts                              # NEW: AgentActivityProjection (+ .test.ts)
  routes/agents.ts                           # NEW: GET /agents, GET /agents/:agentId
  routes/stream.ts                           # NEW: GET /stream (SSE)
  dto.ts                                     # EXTEND: agent activity DTOs + SSE envelopes
  mappers.ts                                 # EXTEND: summary/activity mappers (reuse toAgentEventDto)
  deps.ts                                    # EXTEND: ReadApiDeps gains projection + stream
  read-app.ts                                # EXTEND: register agents + stream routes; add paths to V1_PATHS
  read-boundary.guard.test.ts                # EXTEND: cover new files
src/config/env.ts                            # EXTEND: four knobs (§10)
src/composition.ts                           # EXTEND: build projection + PgNotify stream into read deps
src/ingress/server.ts                        # EXTEND: rebuild→start→subscribe; stop on shutdown (token-gated)
migrations/<n>_agent_event_notify.sql       # NEW: trigger migration (next free index: 0006; + meta/_journal entry)
```

---

## 13. Read-only / no-execution guarantees

- `read-boundary.guard.test.ts` extends `ROOT_DIRS` / `PORT_FILES` to cover the new files; `FORBIDDEN` is unchanged (`orchestrator/task-intake`, `ports/task-queue`, `adapters/queue`, `worker/`, `orchestrator/workflow-router`, `orchestrator/handlers`, `adapters/repository/`, `trading-platform`).
- SSE is server→client only; there is no route accepting a command/body — the no-command-channel property is structural.
- The projection is in-memory: **zero table writes** from the read runtime. The only DDL is the migration trigger, which is not imported by read code.

---

## 14. Test matrix

- **taxonomy** (`agent-taxonomy.test.ts`): every prefix → expected `agentId`, including the ordered-matching guard that `hypothesis.build.started` → `builder` (not `researcher`), the separator-tolerant case that `build_failed` (underscore) → `builder` (not `system`), and that `builder.completed` → `builder`; unknown type → `system`. Every suffix → expected lifecycle, including the failure-first ordering (`build_failed` → `failed`, `*.failed` beats `*.started`).
- **projection** (`projection.test.ts`): `apply` emits `agent_event_appended` always and `agent_status_changed` only on change; terminal status retained (next non-terminal event needed to leave it); ring buffer capped at the limit; rebuild-from-tail is idempotent and the cursor is monotonic (≤-cursor rows ignored); `currentTask` null only at boot idle.
- **in-memory stream** (`in-memory-agent-event-stream.test.ts`): `push` → subscriber → projection delta.
- **pg-notify adapter** (`pg-notify-agent-event-stream.test.ts`, integration): trigger fires NOTIFY → catch-up read emits in order; a dropped/missed NOTIFY is still picked up by the safety-net tick; reconnect re-LISTENs and catches up.
- **routes** (in `read-app.test.ts` / a new agents/stream test): auth gate (401 without Bearer); `/agents` returns the four known agents + cursor; `/agents/:id` 404 outside the set; SSE — initial replay from `Last-Event-ID` (priority) and `?cursor=` (fallback), live deltas, `:ping` heartbeat, abort closes cleanly.
- **boundary** (`read-boundary.guard.test.ts`): new files import nothing forbidden; SP-5 e2e (`read-app.e2e.test.ts`) still green.

---

## 15. Out of scope (confirmed)

trading-office implementation; browser-facing WebSocket; chat submission / `TradingLabChatConnector` / `POST /api/office/chat/messages`; any command over the stream; platform SDK/MCP integration; live bot-health from `trading-platform`; Redis pub/sub / durable replay / multi-instance fanout; CI setup.
