# SP-5 — Read-Only API Foundation (for trading-office)

Status: **Approved** (design) · Date: 2026-06-13 · Depends on: SP-1 (task ingress, `agent_event`, repositories), SP-3 (`hypothesis_proposal`), SP-4 (`hypothesis_build` / `backtest_run` / `evaluation`)

---

## 1. Goal

Give `trading-lab` a **read-only HTTP API** that a future `TradingLabHttpConnector` in `trading-office` (server-to-server) can call to render the *hypotheses*, *backtests*, and *agent activity* panels — without granting any execution authority, without exposing the internal DB schema, and without coupling `trading-lab` to `trading-platform`.

This slice is a **foundation**: a stable, sanitized, paginated, authenticated read boundary. It deliberately ships no commands, no writes, no realtime transport, and no infra/bot-health beyond a minimal liveness/readiness probe.

**Consumer topology (decided):** browser → trading-office backend/BFF → (`TradingLabHttpConnector`) → trading-lab read API. The browser never talks to trading-lab directly. `OfficeGateway` stays the UI-facing contract inside trading-office; trading-lab knows nothing about browser sessions, so no browser CORS is needed in this slice.

### Core invariant

> **The read API is read-only and non-authoritative.**
> It may only *read* trading-lab's own Postgres through read-only ports. It MUST NOT:
> - write any table, enqueue any task, or import/call `task-intake`, the queue, the worker, the workflow-router, or orchestrator handlers;
> - call or import anything from `trading-platform` (the platform boundary stays the SP-1 `MockPlatformGatewayAdapter`);
> - serialize internal/coupling fields — platform ids, raw `params`, hashes, module ids, contract versions, correlation ids (except the curated `agent-events` join), fingerprints, the full proposal draft, raw event payloads, secrets, or raw user content.
>
> The static read token is **service-to-service** auth only. It is **not** user authorization — user auth/permissions live in trading-office.

---

## 2. Scope boundary

**In SP-5:**

- Three read-only query ports — `HypothesisReadPort`, `BacktestReadPort`, `AgentEventReadPort` — `list` + `getById`, keyset pagination, no write methods.
- Drizzle read adapters (reuse the existing `db` / `pool`) + seedable in-memory fakes for tests.
- `createReadApp` Hono driving adapter under `src/read-api/`, on a **separate port** (`READ_API_PORT`), same process.
- Endpoints: `GET /v1/hypotheses`, `/v1/hypotheses/:id`, `/v1/backtests`, `/v1/backtests/:id`, `/v1/agent-events`; plus `GET /healthz` (liveness) and `GET /readyz` (**DB / read-deps readiness only**).
- Curated, **deny-by-default** DTOs (`HypothesisListItemDto`, `HypothesisDetailDto`, `BacktestDto`, `AgentEventDto`) + Zod query schemas.
- Service-to-service auth middleware (`Authorization: Bearer <TRADING_LAB_READ_TOKEN>`, constant-time).
- Keyset cursor pagination + index migrations on `created_at`.
- Read-boundary import guard (test) over the whole read boundary.
- Full test matrix (§12).

**Designed but deferred (boundary is ready; not wired):**

- Lifecycle rollup in the hypothesis DTO (built→backtested→evaluated) and the evaluation rollup in the backtest DTO — later as **v1.1** or behind an explicit `?include=rollups` query param. *Reason:* rollups add joins/aggregation and widen scope; the foundation needs a stable, sanitized, paginated, authenticated boundary first. The office backend can compose a richer picture later.
- Realtime: an **internal** SSE/WS event stream for the office backend (reuses `AgentEventReadPort`). Browser-facing realtime stays in trading-office (`/api/office/events`).
- Current-activity ("what is each agent doing now") projection — belongs to the office store or a later trading-lab endpoint; **not** a source of truth here.
- Infra / ops status (queue / Redis / worker health) — a **separate** read/ops projection in a later slice, never mixed into this read-only foundation.
- pgvector similarity endpoints; richer sorting/filtering; OpenAPI emission.
- User auth and browser CORS (consumer is server-to-server).
- bot-health / anything from the live `trading-platform`.

---

## 3. Architecture overview

```
trading-office backend  (TradingLabHttpConnector)
  │  Authorization: Bearer <TRADING_LAB_READ_TOKEN>
  ▼
READ_API_PORT   (separate Hono app, same process; INGRESS_PORT untouched)
  createReadApp(deps)
    ├─ readAuthMiddleware            [gates /v1/* ; /healthz + /readyz are open]
    ├─ GET /v1/hypotheses (:id)  → HypothesisReadPort  → mappers          → Hypothesis*Dto
    ├─ GET /v1/backtests  (:id)  → BacktestReadPort     → mappers          → BacktestDto
    ├─ GET /v1/agent-events      → AgentEventReadPort   → mappers(sanitize)→ AgentEventDto
    ├─ GET /healthz              → 200 liveness
    └─ GET /readyz               → deps.checkReadiness() — DB ping ONLY (no queue/worker/Redis)
          │
          ▼   (read-only ports — no write method exists on them)
   Drizzle read adapters ──reuse──▶ db/client + db/schema ──▶ Postgres (trading-lab only)
```

No edge leaves toward `trading-platform`. `artifactRefs` are never read into a DTO. The write side (`POST /tasks`, `/callbacks/backtest-completed`, `/chat/messages`) keeps running unchanged on `INGRESS_PORT`.

---

## 4. Module layout

```
src/ports/
  hypothesis-read.port.ts          # NEW: HypothesisReadPort
  backtest-read.port.ts            # NEW: BacktestReadPort
  agent-event-read.port.ts         # NEW: AgentEventReadPort
src/adapters/read/                 # NEW dir: read-only adapters (reuse db/pool)
  drizzle-hypothesis-read.adapter.ts
  drizzle-backtest-read.adapter.ts
  drizzle-agent-event-read.adapter.ts
  in-memory-hypothesis-read.adapter.ts    # seedable fakes for unit tests
  in-memory-backtest-read.adapter.ts
  in-memory-agent-event-read.adapter.ts
  # + co-located *.test.ts (drizzle integration tests + fakes)
src/read-api/                      # NEW dir: driving HTTP adapter
  read-app.ts                      # createReadApp(deps): Hono — middleware + routes
  deps.ts                          # ReadApiDeps type (ports + checkReadiness + token)
  auth.ts                          # readAuthMiddleware (bearer, constant-time)
  dto.ts                           # DTO types + Zod response/query schemas
  mappers.ts                       # domain/row -> DTO (projection + sanitization)
  pagination.ts                    # keyset cursor encode/decode
  routes/
    hypotheses.ts
    backtests.ts
    agent-events.ts
    health.ts                      # /healthz + /readyz
  # + co-located *.test.ts: read-app, mappers, auth, read-boundary.guard
src/config/env.ts                  # TOUCH: + READ_API_PORT, + TRADING_LAB_READ_TOKEN
src/composition.ts                 # TOUCH: build read adapters, return `read: ReadApiDeps`
src/ingress/server.ts              # TOUCH: second serve() on READ_API_PORT (iff token set)
migrations/                        # NEW: created_at indexes (drizzle-kit generated)
```

`src/read-api/` (driving HTTP adapter) is intentionally separate from `src/ingress/` (write side), `src/chat/` (chat/task creation), `src/adapters/read/` (read-side data adapters), and `src/ports/*-read.port.ts` (read contracts). Tests are co-located `*.test.ts` next to each unit, per repo convention; the read-boundary import guard lives at `src/read-api/read-boundary.guard.test.ts`.

---

## 5. Read ports (CQRS-lite)

Ports expose **read only**. Hypothesis/backtest ports return existing **domain types** (`HypothesisProposal` / `BacktestRun`); the agent-event port returns a thin row (no domain type exists). The Drizzle read adapters do their **own** row→domain mapping **inside the read boundary** — they do **not** import the write adapters or their `toDomain` helpers (that would violate §11). Projection to DTOs happens in `mappers.ts`.

```ts
// keyset page result
interface Page<T> { items: T[]; nextCursor: string | null; }

interface HypothesisReadPort {
  // newest-first; (createdAt, id) DESC keyset
  list(q: { status?: HypothesisStatus; profileId?: string; limit: number; cursor?: string }): Promise<Page<HypothesisProposal>>;
  getById(id: string): Promise<HypothesisProposal | null>;
}

interface BacktestReadPort {
  // newest-first; (createdAt, id) DESC keyset
  list(q: { hypothesisId?: string; status?: BacktestRunStatus; limit: number; cursor?: string }): Promise<Page<BacktestRun>>;
  getById(id: string): Promise<BacktestRun | null>;
}

interface AgentEventReadPort {
  // backfill-friendly: oldest-first; (createdAt, id) ASC keyset.
  // taskId/type/since are native columns; correlationId resolves via JOIN agent_event.task_id -> research_task.
  list(q: {
    taskId?: string; type?: string; since?: string; correlationId?: string;
    limit: number; cursor?: string;
  }): Promise<Page<AgentEventRow>>;
}

interface AgentEventRow {
  id: string; taskId: string; type: string;
  payload: Record<string, unknown>;   // raw — consumed only by the sanitizing mapper, never serialized
  createdAt: string; correlationId?: string;
}
```

- Pagination is **keyset** on `(createdAt, id)` (stable for append-only-ish data, backfill-friendly). `cursor` is an opaque base64 of `{ createdAt, id }`; never an offset.
- `limit` default **20**, max **100** (Zod-clamped/validated).
- Ordering: hypotheses & backtests **DESC** (newest first, dashboard lists); agent-events **ASC** (oldest first, stream/backfill continuity).

---

## 6. Endpoint surface (v1)

All `/v1/*` sit behind the read token. Health endpoints are open (for probes).

| Method + path | Purpose | Query |
|---|---|---|
| `GET /v1/hypotheses` | list (newest first) | `status?`, `profileId?`, `limit?`, `cursor?` |
| `GET /v1/hypotheses/:id` | one hypothesis / 404 | — |
| `GET /v1/backtests` | list (newest first) | `hypothesisId?`, `status?`, `limit?`, `cursor?` |
| `GET /v1/backtests/:id` | one backtest / 404 | — |
| `GET /v1/agent-events` | append-only feed (oldest first) | `taskId?`, `type?`, `since?`, `correlationId?`, `limit?`, `cursor?` |
| `GET /healthz` | liveness, **no token** | — |
| `GET /readyz` | readiness: **DB / read-deps ping only**, no token | — |

- List envelope: `{ "data": T[], "page": { "nextCursor": string \| null, "limit": number } }`.
- Non-GET on any `/v1/*` route → `405`. **Explicit handler required:** Hono otherwise returns `404` for an unmatched method on a known path, so each resource registers an explicit method-not-allowed fallback (dedicated test in §12, requirement R9.2).
- `/readyz` calls `deps.checkReadiness()` — a cheap `SELECT 1`-style DB probe wired through the read deps. It does **not** touch the queue, Redis, or the worker (that would violate the Core invariant and pull write-side deps into the read boundary). Queue/worker/infra health, if ever needed by office, becomes a separate ops projection in a later slice.

---

## 7. DTOs + projection / sanitization (enforces R3)

**Deny-by-default**: a DTO field exists only if it is on the allowlist below. A contract test asserts the serialized key set equals the allowlist, so an accidental new field fails CI.

### 7.1 Hypotheses — list vs detail split

`GET /v1/hypotheses` returns **summary-level** items (no full rules array). `GET /v1/hypotheses/:id` returns a **curated** detail projection (still allowlist-only; never raw `ruleAction` / `proposal`).

**`HypothesisListItemDto`** (list):

| Expose | From |
|---|---|
| `id`, `profileId`, `thesis`, `targetBehavior`, `status` (`'validated' \| 'rejected'`) | `hypothesis_proposal` |
| `confidence`, `expectedEffect` `{ metric, direction, magnitude? }` | — |
| `rulesSummary` `{ appliesTo: Direction, ruleCount: number }` | derived from `ruleAction` — **no rule bodies** |
| `createdAt`, `updatedAt` | — |

**`HypothesisDetailDto`** (detail) = list item **plus**:

| Expose | Notes |
|---|---|
| `requiredFeatures: string[]`, `invalidationCriteria: string[]` | curated |
| `rules: { appliesTo: Direction, rules: [{ when, action, rationale? }] }` | **curated projection, allowlist-only**: `when`, `action`, `rationale` only. Rule `params` are **dropped**. Not raw `ruleAction`, not `proposal`. |
| `rejectionReasons?: string[]` | derived from `issues` **only when** `status === 'rejected'`; sanitized messages |

**Dropped from both (internal):** `fingerprint`, `proposal` (full original draft), raw `issues`, `contractVersion`, rule `params`.

### 7.2 Backtests

**`BacktestDto`** (same shape for list and detail; already lean):

| Expose | From |
|---|---|
| `id`, `hypothesisId`, `status` | `backtest_run` |
| `metrics` `{ netPnlUsd, netPnlPct, totalTrades, winRate, profitFactor, maxDrawdownPct, expectancyUsd, sharpe, topTradeContributionPct }` (each `number \| null` until completed) | flattened metric columns |
| `delta` `{ netPnlUsd, maxDrawdownPct }` (`number \| null`) | `deltaNetPnlUsd`, `deltaMaxDrawdownPct` |
| `isFragile` (`boolean \| null`) | — |
| `submittedAt`, `finishedAt` (`string \| null`), `createdAt`, `updatedAt` | — |

**Dropped (internal / coupling):** `hypothesisBuildId`, `strategyProfileId`, `platformRunId`, `correlationId`, `params`, `paramsHash`, `bundleHash`, `baselineModuleId`, `variantModuleId`, `baselineMetrics`, `artifactRefs`, `platformContractVersion`, `sdkContractVersion`.

No `evaluation` rollup in v1 (deferred).

### 7.3 Agent events — deny-by-default sanitization

`agent_event` has only `{ id, taskId, type, payload(jsonb), createdAt }` — no `level`, no `message`, no `correlationId` column. The mapper **derives** safe fields and **never** serializes raw `payload`.

**`AgentEventDto`**:

| Expose | Logic |
|---|---|
| `id`, `ts` (= `createdAt`), `type`, `taskId` | straight from the row |
| `correlationId?` | resolved via JOIN to `research_task` (omitted if unresolved) |
| `level` (`'info' \| 'warn' \| 'error'`) | **derived** from `type` (matches `fail`/`error`/`reject` → `error`/`warn`; else `info`) |
| `summary` (string) | **derived** human-readable string from `type` (+ allowlisted payload fields when the type is known) |
| `payloadSummary?` (`Record<string, unknown>`) | **allowlist per known event `type`**. Unknown type → omitted/empty. Raw payload, user content, and secrets are never included. |

**Sanitization rule (explicit):**
- Raw `payload` is **never** returned.
- `payloadSummary` is populated **only** from a per-`type` allowlist map.
- Unknown event types → **empty** `payloadSummary` + a human-readable `summary` derived from `type` alone.
- No secrets, no raw user-provided strategy/hypothesis text.

---

## 8. Auth + topology

- **`readAuthMiddleware`** — checks `Authorization: Bearer <token>` against `env.TRADING_LAB_READ_TOKEN` with a constant-time compare; mounted on `/v1/*`. `/healthz` and `/readyz` are open. Missing/invalid token → `401`.
- **`composeRuntime()`** builds the three Drizzle read adapters from the **same** `db` / `pool` (no second connection pool) and returns `read: ReadApiDeps = { hypothesisRead, backtestRead, agentEventRead, checkReadiness }`. `checkReadiness()` runs a cheap `SELECT 1` through the shared db client, so the `read-api` layer never imports `db/client` directly — readiness flows in as a dependency.
- **`src/ingress/server.ts`** — when `TRADING_LAB_READ_TOKEN` is set: `serve({ fetch: createReadApp({ ...read, token }).fetch, port: env.READ_API_PORT })` as a **second** listener in the same process. When the token is **unset**: the read listener does **not** start (log a warning); the write ingress is unaffected. *Safe default: no token → no external read boundary.*
- **Env additions** (`src/config/env.ts`): `READ_API_PORT` (number, configurable, distinct from `INGRESS_PORT`); `TRADING_LAB_READ_TOKEN` (string, optional; required to enable the read listener). Default config stays key-free so `docker compose up` still boots the write side without secrets.
- **Auth semantics:** this token is service-to-service (office backend → trading-lab), read-only, and carries no command/execution authority. It is never applied to the write ingress endpoints. User auth stays in trading-office; the browser never reaches trading-lab.

---

## 9. Error handling

Single envelope `{ "error": { "code": string, "message": string } }`, no stack traces or internal details. Codes: `unauthorized` (401), `not_found` (404), `bad_request` (400 — Zod query/cursor validation), `method_not_allowed` (405), `internal` (500). Every endpoint is strictly side-effect-free (GET only).

**R9.1 — Cursor robustness.** An invalid, expired, or malformed `cursor` → `400 bad_request` with a generic message. Decode/parse failures (non-base64, truncated, tampered, or schema-mismatched payload) are caught and **never leak internals** — no stack trace, no raw decode error, no exception text in the body. Cursor parsing lives in `pagination.ts` and returns a typed failure that routes map to `bad_request`.

**R9.2 — Method-not-allowed.** A non-GET request to an existing `/v1/*` path → `405 method_not_allowed`, **not** `404`. Hono's default for an unmatched method on a known route can be `404`, so each resource registers an explicit `405` fallback (e.g. `app.on(['POST','PUT','PATCH','DELETE'], path, …)` or an `app.all` tail). A dedicated test asserts this (§12).

---

## 10. Migrations (drizzle-kit)

Add btree indexes on `created_at` (or composite `(created_at, id)`) to support time-ordered keyset pagination:

- `agent_event` — currently only indexed on `task_id`.
- `hypothesis_proposal` — has `profile`/`status` indexes; add `created_at`.
- `backtest_run` — has `hypothesis`/`status` indexes; add `created_at`.

Filter indexes (`status`, `hypothesis_id`, `task_id`) already exist and are reused. Migrations are additive (new indexes only) — no schema change, no write-path impact.

---

## 11. Read-boundary import guard

A test (Vitest; AST/import scan, or `dependency-cruiser` rule) asserts the **entire read boundary**:

- `src/read-api/**`
- `src/adapters/read/**`
- `src/ports/*-read.port.ts`

…does **not** import any of:

- `orchestrator/task-intake` (`createAndEnqueueTask`)
- queue ports/adapters (`ports/task-queue.port`, `adapters/queue/**`)
- the worker (`worker/**`)
- the workflow router (`orchestrator/workflow-router`)
- orchestrator handlers (`orchestrator/handlers/**`)
- write repositories — `adapters/repository/**` (the write-side `Drizzle*Repository` / `InMemory*Repository` modules) and their `toDomain` helpers
- anything under `trading-platform`

**Allowed exceptions:** read adapters (`src/adapters/read/**`) may import `db/schema` and `db/client` (types + the shared client); all read-boundary modules may import `src/domain/**` types. The guard is the executable form of the Core invariant — a violation fails CI.

---

## 12. Testing strategy

- **`mappers.test.ts`** — table-driven: every internal field is **absent** from each DTO; payload sanitization (raw payload never present; `payloadSummary` only allowlisted keys; unknown type → empty `payloadSummary` + derived `summary`); `level`/`summary` derivation; rules curation (rule `params` dropped); `rejectionReasons` only for rejected.
- **Contract guard** — assert the serialized key set of each DTO equals its allowlist (accidental field leak → red CI).
- **`read-app.test.ts`** — Hono `app.request()` with seeded in-memory fakes: list + filters + cursor round-trip (keyset stability); `getById` 200/404; auth 401 (missing/bad token) / 200 (valid); 400 (bad query); `/healthz` 200; `/readyz` ok/down (DB only).
- **`405` test (R9.2)** — a non-GET (`POST`/`PUT`/`PATCH`/`DELETE`) on `/v1/hypotheses` etc. returns `405 method_not_allowed`, explicitly guarding against Hono's default `404`.
- **Cursor-robustness test (R9.1)** — malformed / non-base64 / truncated / tampered / expired `cursor` → `400 bad_request`, and the response body leaks no decode error, stack, or internal detail.
- **`auth.test.ts`** — accept/reject + constant-time compare.
- **Drizzle read adapters** — integration tests against the docker-compose Postgres (mirroring existing drizzle repo tests): query correctness, keyset ordering (ASC events / DESC hyp+backtests), filters, `correlationId` JOIN.
- **Import guard** (§11) — the read boundary imports nothing forbidden.
- **e2e wiring** — `createReadApp` with in-memory fakes, end-to-end over the route table.

---

## 13. Out of scope (restated)

bot-health / live `trading-platform`; infra/ops status beyond `/healthz` + `/readyz` (separate ops projection later); commands / execution; WebSocket/SSE now (boundary is realtime-ready via the read ports); user auth and browser CORS; lifecycle/evaluation rollups (v1.1 or `?include=rollups`); current-activity projection.
