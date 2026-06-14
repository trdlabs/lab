# SP-6.2 — Task Ingress Service Boundary — Design

Status: **Approved** (design) · Date: 2026-06-14 · Depends on: SP-6.1 (chat ingress boundary: `src/auth/bearer.ts` primitives `parseBearer` + `safeEqual`, `chatAuthMiddleware`, fail-closed 503/401 pattern, `TRADING_LAB_CHAT_TOKEN`), SP-1 (ingress app: `createIngressApp`, `POST /tasks`, `POST /callbacks/backtest-completed` stub)

## 1. Goal

Put the two remaining unauthenticated endpoints on `INGRESS_PORT` behind fail-closed service-to-service auth gates, mirroring SP-6.1 — so that if the ingress port is ever reachable from outside, neither endpoint accepts traffic without a per-boundary token.

```
POST /tasks                         (Authorization: Bearer <TRADING_LAB_TASK_TOKEN>)      ← low-level task intake
POST /callbacks/backtest-completed  (Authorization: Bearer <TRADING_LAB_CALLBACK_TOKEN>)  ← backtest-runner resume signal (still a stub)
```

`/tasks` is **not** the office path — trading-office reaches the lab through `/chat/messages` (SP-6.1). `/tasks` remains a low-level internal ingress; `/callbacks/backtest-completed` is an inbound callback from a different caller (the backtest runner). Two distinct callers ⇒ two distinct tokens.

This is a small boundary/security slice. **No** change to workflow logic, the task payload contract, the callback's stub behavior, or any trading-office / platform-SDK integration.

## 2. Scope boundary

In scope:
- A reusable, narrow `bearerAuth` middleware factory that centralizes only the 503/401 bearer **semantics** (not application policy).
- Route-scoped auth gates: `TRADING_LAB_TASK_TOKEN` on `POST /tasks`, `TRADING_LAB_CALLBACK_TOKEN` on `POST /callbacks/backtest-completed`.
- A behavior-preserving refactor of `chatAuthMiddleware` to delegate to the factory.
- Tests proving the triad (503/401/200) per endpoint, cross-token isolation, and no regression of task intake / dedupe.
- `.env.example` entries and an ingress boundary README.

Explicitly out of scope (unchanged):
- Read API (`createReadApp`, `readAuthMiddleware`, `TRADING_LAB_READ_TOKEN`) — untouched; its listener-gated-on-token semantics differ and it does **not** adopt the factory.
- Workflow / chain / intent / research logic; task payload contract (`IngressTaskRequestSchema`); the `/callbacks/backtest-completed` stub's real resume logic (it only gains a gate); trading-office connector; platform SDK / MCP; SP-6 SSE semantics; chat request/response contract.

## 3. Topology (what changes, what doesn't)

`POST /tasks` and `POST /callbacks/backtest-completed` stay where they are: defined inside `createIngressApp` (`src/ingress/app.ts`), served on `INGRESS_PORT` (default 3000) in `src/ingress/server.ts`, alongside the chat app mounted at `/chat`.

No new ports, no new endpoints, no change to handler bodies. The only additions are **two route-scoped auth gates** in front of the two existing routes, each fed by its own token.

Because `/tasks` and `/callbacks` live in the **same** Hono app but require **different** tokens, the gates are **path-scoped** (`app.use('/tasks', …)` / `app.use('/callbacks/backtest-completed', …)`), not app-wide (`'*'`). This is the structural difference from the chat app, where a single `app.use('*', …)` suffices because the whole sub-app shares one token.

| Boundary | Route | Port | Token | Unset behavior |
|---|---|---|---|---|
| Read API | `/v1/*` | `READ_API_PORT` (3100) | `TRADING_LAB_READ_TOKEN` | listener does not start |
| Chat ingress | `/chat/messages` | `INGRESS_PORT` (3000) | `TRADING_LAB_CHAT_TOKEN` | route mounted, **rejects all → 503** |
| **Task ingress** | `/tasks` | `INGRESS_PORT` (3000) | `TRADING_LAB_TASK_TOKEN` | route mounted, **rejects all → 503** |
| **Callback ingress** | `/callbacks/backtest-completed` | `INGRESS_PORT` (3000) | `TRADING_LAB_CALLBACK_TOKEN` | route mounted, **rejects all → 503** |

## 4. `bearerAuth` middleware factory

New `src/auth/bearer-auth.ts`:

```ts
export interface BearerAuthOptions { notConfiguredMessage: string }
export function bearerAuth(token: string | undefined, opts: BearerAuthOptions): MiddlewareHandler
```

It consumes `parseBearer` + `safeEqual` from `src/auth/bearer.ts` and reproduces SP-6.1's fail-closed policy exactly. The **only** per-boundary variable is the 503 message; the 401 envelope is constant across boundaries.

| Condition | Status | Body |
|---|---|---|
| `token` unset / empty | **503** | `{ error: { code: 'service_unavailable', message: opts.notConfiguredMessage } }` |
| `token` set, header missing or token wrong | **401** | `{ error: { code: 'unauthorized', message: 'missing or invalid token' } }` |
| `token` set, Bearer matches (constant-time) | — | `next()` |

**This factory is deliberately narrow.** It is a route-scoped service-token middleware factory for one repeated bearer semantics — *not* an application-wide auth policy. It owns no routing decisions, no token sourcing, no per-route configuration beyond the message string. Boundary ownership stays in the concrete places:

- `chatAuthMiddleware` (`src/chat/auth.ts`) remains the public owner of the `/chat/messages` boundary.
- The task / callback gate wiring (`src/ingress/app.ts`) owns the ingress-route boundaries.
- `readAuthMiddleware` (`src/read-api/auth.ts`) remains the read-API owner and keeps its distinct listener-gated semantics — it does **not** adopt the factory.

Registration is **before the handlers** (Hono applies `app.use(path, …)` declared ahead of the route), so an unauthorized request never reaches JSON parsing, schema validation, or `createAndEnqueueTask`.

## 5. Behavior-preserving chat refactor

`src/chat/auth.ts` keeps `chatAuthMiddleware(token?: string)` as its exported boundary owner; its body becomes a one-line delegation:

```ts
export function chatAuthMiddleware(token?: string): MiddlewareHandler {
  return bearerAuth(token, { notConfiguredMessage: 'chat ingress not configured' });
}
```

This is behavior-preserving: same 503 message (`chat ingress not configured`), same 401 envelope (`missing or invalid token`), same constant-time compare. `src/chat/auth.ts` does not disappear and is not renamed; existing SP-6.1 chat tests (`src/chat/auth.test.ts`, `chat-app.test.ts`, `test/e2e/chat-to-task.test.ts`) must stay green **with no change in meaning**.

## 6. Wiring

- `src/config/env.ts`: add `TRADING_LAB_TASK_TOKEN?: string` and `TRADING_LAB_CALLBACK_TOKEN?: string` to `Env`, with plain pass-through in `loadEnv` (like the chat/read tokens; no `?? ''`, so unset stays distinguishable from empty).
- `src/ingress/app.ts`: `IngressDeps` gains `taskToken?: string` and `callbackToken?: string`. `createIngressApp` registers, before the route handlers:
  ```ts
  app.use('/tasks', bearerAuth(deps.taskToken, { notConfiguredMessage: 'task ingress not configured' }));
  app.use('/callbacks/backtest-completed', bearerAuth(deps.callbackToken, { notConfiguredMessage: 'callback ingress not configured' }));
  ```
- `src/ingress/server.ts`: pass `taskToken: env.TRADING_LAB_TASK_TOKEN` and `callbackToken: env.TRADING_LAB_CALLBACK_TOKEN` into `createIngressApp`; add a startup `console.warn` per unset token, mirroring the existing chat warn:
  - `[ingress] TRADING_LAB_TASK_TOKEN not set — POST /tasks will reject all requests (503)`
  - `[ingress] TRADING_LAB_CALLBACK_TOKEN not set — POST /callbacks/backtest-completed will reject all requests (503)`

## 7. Contract (ingress README)

New `src/ingress/README.md` (mirrors `src/read-api/README.md` and `src/chat/README.md`) documents the ingress-port boundaries:

- **Endpoints:** `POST /tasks` and `POST /callbacks/backtest-completed` on `INGRESS_PORT`. Service-to-service only. `/tasks` is **not** the office path — office uses `/chat/messages`.
- **Auth:** `Authorization: Bearer <token>`; `/tasks` ⇒ `TRADING_LAB_TASK_TOKEN`, `/callbacks/backtest-completed` ⇒ `TRADING_LAB_CALLBACK_TOKEN`. Each is distinct from every other boundary token. `401` on missing/wrong token; `503` when that boundary is not configured.
- **Request (`POST /tasks`):** unchanged `IngressTaskRequestSchema` — `{ taskType, source, payload?, correlationId?, dedupeKey? }`. `content-type: application/json`. Response `202 { taskId, status }`; invalid body `400 { status: 'rejected', issues }`; dedupe returns the same `taskId` without re-enqueue.
- **Callback:** `POST /callbacks/backtest-completed` remains an SP-1 stub returning `202 { status: 'accepted' }`; this slice only adds the gate.
- **Notes:** a pointer to `src/chat/README.md` for the chat boundary; `INGRESS_PORT` must not be public without network protection (reverse proxy / firewall).

## 8. `.env.example`

Add an ingress block with **dev placeholders** (non-empty so `docker compose up` works under fail-closed), each distinct:

```
TRADING_LAB_TASK_TOKEN=dev-task-token           # service-to-service token for POST /tasks
TRADING_LAB_CALLBACK_TOKEN=dev-callback-token   # service-to-service token for POST /callbacks/backtest-completed
# production MUST override these values
# each ingress token MUST be distinct from the others (read / chat / task / callback are separate boundaries)
# /tasks is NOT the office path — trading-office uses /chat/messages
# INGRESS_PORT must not be public without network protection (reverse proxy / firewall)
```

## 9. Tests

- `src/auth/bearer-auth.test.ts` — CREATE. Factory unit tests against a trivial downstream handler: unset token → 503 and the body carries the **passed-in** `notConfiguredMessage` (proves per-boundary messaging); set + missing header → 401; set + wrong token → 401; set + correct Bearer → handler runs (200).
- `src/ingress/app.test.ts` — TOUCH. `setup()` injects `taskToken` + `callbackToken`; existing `/tasks` calls add the `Authorization: Bearer …` header (so the accept / invalid / dedupe assertions still exercise the real handler through the real gate). Add:
  - `/tasks`: unset task token → 503; wrong token → 401.
  - `/callbacks/backtest-completed`: unset callback token → 503; wrong token → 401; correct token → 202 `{ status: 'accepted' }`.
  - **Cross-token isolation:** the task token presented to `/callbacks` → 401; the callback token presented to `/tasks` → 401.
- `test/e2e/ingress-to-worker.test.ts`, `test/e2e/research-run-cycle.test.ts`, `test/e2e/strategy-onboard.test.ts` — TOUCH. Each builds `createIngressApp` and POSTs `/tasks`; inject a `taskToken` and send the Bearer header so the authorized end-to-end flow still runs.
- `src/config/env.test.ts` — TOUCH. Assert `TRADING_LAB_TASK_TOKEN` and `TRADING_LAB_CALLBACK_TOKEN` load from source.

## 10. Guardrails

- Each ingress token authorizes **only** its own route: `TRADING_LAB_TASK_TOKEN` never opens `/callbacks` (or `/chat` / `/v1`), `TRADING_LAB_CALLBACK_TOKEN` never opens `/tasks` (or `/chat` / `/v1`), and neither read nor chat tokens open the task/callback routes — proven by the cross-token isolation tests.
- Fail-closed: every route is always mounted; an unconfigured token ⇒ 503, never silent accept.
- `bearerAuth` stays a narrow bearer-semantics factory; it must not accrete routing, token sourcing, or app-wide policy.
- No change to task payload contract, workflow/chain logic, callback resume logic, read API, chat contract, or SP-6 SSE.

## 11. Files

```
src/auth/bearer-auth.ts            # CREATE: bearerAuth factory (503/401 service-token semantics)
src/auth/bearer-auth.test.ts       # CREATE
src/ingress/README.md              # CREATE: ingress boundary contract
src/chat/auth.ts                   # TOUCH: chatAuthMiddleware delegates to bearerAuth (behavior-preserving)
src/ingress/app.ts                 # TOUCH: IngressDeps.taskToken/callbackToken; register route-scoped gates first
src/ingress/app.test.ts            # TOUCH: inject tokens + Bearer headers; triad + cross-token isolation
src/config/env.ts                  # TOUCH: + TRADING_LAB_TASK_TOKEN, TRADING_LAB_CALLBACK_TOKEN
src/config/env.test.ts             # TOUCH: + assertions
src/ingress/server.ts              # TOUCH: pass tokens; warn per unset token
test/e2e/ingress-to-worker.test.ts # TOUCH: taskToken + Bearer header
test/e2e/research-run-cycle.test.ts# TOUCH: taskToken + Bearer header
test/e2e/strategy-onboard.test.ts  # TOUCH: taskToken + Bearer header
.env.example                       # TOUCH: + task/callback dev placeholders + comments
```
