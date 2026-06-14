# SP-6.2 Task Ingress Service Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put `POST /tasks` and `POST /callbacks/backtest-completed` (both on `INGRESS_PORT`) behind fail-closed, per-boundary bearer-token gates, mirroring the SP-6.1 chat boundary, with no change to workflow logic or the task payload contract.

**Architecture:** Extract a narrow, route-scoped `bearerAuth(token, { notConfiguredMessage })` middleware factory in `src/auth/` that owns only the 503-unset / 401-bad / pass-through bearer semantics. `chatAuthMiddleware` is refactored to delegate to it (behavior-preserving). Two new env tokens (`TRADING_LAB_TASK_TOKEN`, `TRADING_LAB_CALLBACK_TOKEN`) feed two path-scoped gates registered inside `createIngressApp` ahead of the handlers, so unauthorized requests never reach JSON parsing, validation, or task intake. The read API is untouched.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`), Hono, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-06-14-trading-lab-sp6.2-task-ingress-boundary-design.md`

**Commands used throughout:**
- Single test file: `pnpm exec vitest run <path>`
- Full suite: `pnpm test`
- Type-check: `pnpm typecheck`

**Conventions:**
- Branch is already `sp6.2-task-ingress-boundary` (the spec was committed there).
- Each commit must leave `pnpm test` and `pnpm typecheck` green.
- End every commit message with the trailer shown in the commit steps.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/auth/bearer-auth.ts` | `bearerAuth` middleware factory (503/401 service-token semantics) — narrow, no app policy | CREATE |
| `src/auth/bearer-auth.test.ts` | Unit tests for the factory, incl. per-boundary message | CREATE |
| `src/ingress/README.md` | Ingress-port boundary contract | CREATE |
| `src/chat/auth.ts` | `chatAuthMiddleware` delegates to `bearerAuth` (stays chat boundary owner) | MODIFY |
| `src/config/env.ts` | `+ TRADING_LAB_TASK_TOKEN`, `+ TRADING_LAB_CALLBACK_TOKEN` | MODIFY |
| `src/config/env.test.ts` | Assert the two new tokens load | MODIFY |
| `src/ingress/app.ts` | `IngressDeps.taskToken/callbackToken`; register two route-scoped gates first | MODIFY |
| `src/ingress/app.test.ts` | Inject tokens; triad + cross-token isolation + gate-before-body tests | MODIFY |
| `src/ingress/server.ts` | Pass tokens into `createIngressApp`; warn per unset token | MODIFY |
| `test/e2e/ingress-to-worker.test.ts` | Supply task token + Bearer header | MODIFY |
| `test/e2e/research-run-cycle.test.ts` | Supply task token + Bearer header | MODIFY |
| `test/e2e/strategy-onboard.test.ts` | Supply task token + Bearer header | MODIFY |
| `.env.example` | Dev placeholders + comments for the two tokens | MODIFY |

**Sequencing rationale:** Tasks 1–3 are additive and independently green. Task 4 updates the *non-feature* callers (server + the three e2e tests) to already pass a token while the gate does **not yet exist** — these changes are inert (deps/headers ignored), so the suite stays green. Task 5 then wires the gate and rewrites the feature's own test (`app.test.ts`) TDD-style; because Task 4 pre-seeded the other callers, the full suite is green the moment the gate lands. Task 6 is docs.

---

## Task 1: `bearerAuth` middleware factory

**Files:**
- Test: `src/auth/bearer-auth.test.ts` (CREATE)
- Create: `src/auth/bearer-auth.ts`

- [ ] **Step 1: Write the failing test**

Create `src/auth/bearer-auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { bearerAuth } from './bearer-auth.ts';

function app(token?: string, message = 'service ingress not configured'): Hono {
  const a = new Hono();
  a.use('*', bearerAuth(token, { notConfiguredMessage: message }));
  a.post('/x', (c) => c.json({ ok: true }));
  return a;
}

function post(a: Hono, token?: string | null) {
  const headers: Record<string, string> = {};
  if (token != null) headers.authorization = `Bearer ${token}`;
  return a.request('/x', { method: 'POST', headers });
}

describe('bearerAuth factory', () => {
  it('503 with the supplied notConfiguredMessage when the token is unset', async () => {
    const res = await post(app(undefined, 'task ingress not configured'), 'anything');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'task ingress not configured' } });
  });

  it('503 when the token is an empty string', async () => {
    expect((await post(app(''), 'anything')).status).toBe(503);
  });

  it('401 when the token is set but the Authorization header is missing', async () => {
    const res = await post(app('secret'), null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
  });

  it('401 when the token is set but the Bearer value is wrong', async () => {
    expect((await post(app('secret'), 'nope')).status).toBe(401);
  });

  it('passes through to the route when the Bearer value matches', async () => {
    const res = await post(app('secret'), 'secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('emits a distinct notConfiguredMessage per boundary', async () => {
    const res = await post(app(undefined, 'callback ingress not configured'), null);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'callback ingress not configured' } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/auth/bearer-auth.test.ts`
Expected: FAIL — cannot resolve `./bearer-auth.ts` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/auth/bearer-auth.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import { parseBearer, safeEqual } from './bearer.ts';

export interface BearerAuthOptions {
  /** 503 body message when this boundary's token is unset (per-boundary operator signal). */
  notConfiguredMessage: string;
}

// Narrow, route-scoped service-token gate. Fail-closed:
//   token unset/empty         -> 503 (boundary not configured — an operator signal)
//   token set, bad/no Bearer  -> 401 (caller problem; constant envelope across boundaries)
//   token set, Bearer matches -> next()
// This is a bearer-semantics factory ONLY — not an app-wide auth policy. Boundary ownership
// (which token, which routes, the 503 message) stays with the caller.
export function bearerAuth(token: string | undefined, opts: BearerAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!token) {
      return c.json({ error: { code: 'service_unavailable', message: opts.notConfiguredMessage } }, 503);
    }
    const presented = parseBearer(c.req.header('authorization'));
    if (presented === null || !safeEqual(presented, token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/auth/bearer-auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/bearer-auth.ts src/auth/bearer-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(sp6.2): add narrow route-scoped bearerAuth middleware factory

503-unset / 401-bad / pass-through bearer semantics with a per-boundary
notConfiguredMessage; consumes parseBearer + safeEqual primitives.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `chatAuthMiddleware` delegates to `bearerAuth`

Behavior-preserving refactor: chat stays the public owner of the `/chat/messages` boundary; its body becomes a one-line delegation. The existing SP-6.1 chat tests are the regression proof — they must pass unchanged.

**Files:**
- Modify: `src/chat/auth.ts`
- (No test edit — `src/chat/auth.test.ts` is the unchanged regression guard.)

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `src/chat/auth.ts` with:

```ts
import type { MiddlewareHandler } from 'hono';
import { bearerAuth } from '../auth/bearer-auth.ts';

// Service-to-service gate for the chat ingress. Delegates to the shared bearerAuth
// factory; chat remains the OWNER of the /chat/messages boundary (its 503 message and
// its wiring in createChatApp). Behavior is identical to SP-6.1:
//   token unset/empty         -> 503 { error: { code: 'service_unavailable', message: 'chat ingress not configured' } }
//   token set, bad/no Bearer  -> 401 { error: { code: 'unauthorized', message: 'missing or invalid token' } }
//   token set, Bearer matches -> next()
export function chatAuthMiddleware(token?: string): MiddlewareHandler {
  return bearerAuth(token, { notConfiguredMessage: 'chat ingress not configured' });
}
```

- [ ] **Step 2: Run the chat auth tests to verify no behavior change**

Run: `pnpm exec vitest run src/chat/auth.test.ts`
Expected: PASS — every existing assertion (503 unset, 401 missing/wrong, 200 match, chat↔read separation) still holds.

- [ ] **Step 3: Run the broader chat suite + type-check**

Run: `pnpm exec vitest run src/chat && pnpm typecheck`
Expected: PASS — `chat-app.test.ts` and the rest still green; no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/chat/auth.ts
git commit -m "$(cat <<'EOF'
refactor(sp6.2): chatAuthMiddleware delegates to shared bearerAuth

Behavior-preserving: same 503 'chat ingress not configured' and 401
envelopes; chat stays the owner of the /chat/messages boundary.
SP-6.1 chat tests pass unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Env tokens

Add the two boundary tokens to `Env` and `loadEnv`, plain pass-through (like the read/chat tokens — no `?? ''`, so unset stays distinguishable).

**Files:**
- Test: `src/config/env.test.ts` (MODIFY)
- Modify: `src/config/env.ts`

- [ ] **Step 1: Write the failing test**

In `src/config/env.test.ts`, append this block after the existing `describe('SP-6.1 chat ingress token', …)` block (end of file):

```ts
describe('SP-6.2 task + callback ingress tokens', () => {
  it('defaults both tokens to undefined', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.TRADING_LAB_TASK_TOKEN).toBeUndefined();
    expect(env.TRADING_LAB_CALLBACK_TOKEN).toBeUndefined();
  });

  it('reads TRADING_LAB_TASK_TOKEN and TRADING_LAB_CALLBACK_TOKEN from source', () => {
    const env = loadEnv({
      TRADING_LAB_TASK_TOKEN: 'task-secret',
      TRADING_LAB_CALLBACK_TOKEN: 'callback-secret',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.TRADING_LAB_TASK_TOKEN).toBe('task-secret');
    expect(env.TRADING_LAB_CALLBACK_TOKEN).toBe('callback-secret');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/config/env.test.ts`
Expected: FAIL — `env.TRADING_LAB_TASK_TOKEN` is not a known property / both reads return undefined (TS error or assertion failure on the second test).

- [ ] **Step 3: Add the fields to the `Env` interface**

In `src/config/env.ts`, find this line in the `Env` interface:

```ts
  TRADING_LAB_CHAT_TOKEN?: string;
```

and add two lines directly after it:

```ts
  TRADING_LAB_CHAT_TOKEN?: string;
  TRADING_LAB_TASK_TOKEN?: string;
  TRADING_LAB_CALLBACK_TOKEN?: string;
```

- [ ] **Step 4: Add the pass-through to `loadEnv`**

In `src/config/env.ts`, inside `loadEnv`'s returned object, find:

```ts
    TRADING_LAB_CHAT_TOKEN: source.TRADING_LAB_CHAT_TOKEN,
```

and add two lines directly after it:

```ts
    TRADING_LAB_CHAT_TOKEN: source.TRADING_LAB_CHAT_TOKEN,
    TRADING_LAB_TASK_TOKEN: source.TRADING_LAB_TASK_TOKEN,
    TRADING_LAB_CALLBACK_TOKEN: source.TRADING_LAB_CALLBACK_TOKEN,
```

- [ ] **Step 5: Run the test + type-check to verify they pass**

Run: `pnpm exec vitest run src/config/env.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "$(cat <<'EOF'
feat(sp6.2): load TRADING_LAB_TASK_TOKEN + TRADING_LAB_CALLBACK_TOKEN

Plain pass-through in Env/loadEnv (unset stays undefined, distinct from
empty), mirroring the read/chat tokens.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add deps fields + pre-seed non-feature callers (inert before the gate)

This task makes `IngressDeps` carry the two optional tokens and updates the *non-feature* callers — the production server and the three e2e tests — to pass a task token and Bearer header **before** the gate exists. These changes are inert (the app ignores the deps/headers until Task 5), so the suite stays green. This is what lets Task 5 land the gate without breaking e2e.

**Files:**
- Modify: `src/ingress/app.ts` (interface only)
- Modify: `src/ingress/server.ts`
- Modify: `test/e2e/ingress-to-worker.test.ts`
- Modify: `test/e2e/research-run-cycle.test.ts`
- Modify: `test/e2e/strategy-onboard.test.ts`

- [ ] **Step 1: Add the optional fields to `IngressDeps`**

In `src/ingress/app.ts`, replace the `IngressDeps` interface:

```ts
export interface IngressDeps {
  repo: ResearchTaskRepository;
  queue: TaskQueuePort;
}
```

with:

```ts
export interface IngressDeps {
  repo: ResearchTaskRepository;
  queue: TaskQueuePort;
  /** SP-6.2: service-to-service token for POST /tasks (unset => 503). */
  taskToken?: string;
  /** SP-6.2: service-to-service token for POST /callbacks/backtest-completed (unset => 503). */
  callbackToken?: string;
}
```

- [ ] **Step 2: Wire the tokens + warns in `server.ts`**

In `src/ingress/server.ts`, replace:

```ts
const app = createIngressApp({ repo: services.researchTasks, queue });
```

with:

```ts
const app = createIngressApp({
  repo: services.researchTasks,
  queue,
  taskToken: env.TRADING_LAB_TASK_TOKEN,
  callbackToken: env.TRADING_LAB_CALLBACK_TOKEN,
});
```

Then, directly after the existing chat-token warn block:

```ts
if (!env.TRADING_LAB_CHAT_TOKEN) {
  console.warn('[chat] TRADING_LAB_CHAT_TOKEN not set — POST /chat/messages will reject all requests (503)');
}
```

add:

```ts
if (!env.TRADING_LAB_TASK_TOKEN) {
  console.warn('[ingress] TRADING_LAB_TASK_TOKEN not set — POST /tasks will reject all requests (503)');
}
if (!env.TRADING_LAB_CALLBACK_TOKEN) {
  console.warn('[ingress] TRADING_LAB_CALLBACK_TOKEN not set — POST /callbacks/backtest-completed will reject all requests (503)');
}
```

- [ ] **Step 3: Update `test/e2e/ingress-to-worker.test.ts`**

Replace:

```ts
    const app = createIngressApp({ repo: services.researchTasks, queue });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } }),
    });
```

with:

```ts
    const app = createIngressApp({ repo: services.researchTasks, queue, taskToken: 'e2e-task-token' });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-task-token' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } }),
    });
```

- [ ] **Step 4: Update `test/e2e/research-run-cycle.test.ts`**

Replace:

```ts
    const app = createIngressApp({ repo: services.researchTasks, queue });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'research.run_cycle', source: 'operator', payload: { strategyProfileId: 'p-e2e' } }),
    });
```

with:

```ts
    const app = createIngressApp({ repo: services.researchTasks, queue, taskToken: 'e2e-task-token' });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-task-token' },
      body: JSON.stringify({ taskType: 'research.run_cycle', source: 'operator', payload: { strategyProfileId: 'p-e2e' } }),
    });
```

- [ ] **Step 5: Update `test/e2e/strategy-onboard.test.ts`**

Replace:

```ts
    const app = createIngressApp({ repo: services.researchTasks, queue });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskType: 'strategy.onboard', source: 'operator',
        payload: { kind: 'manual_description', content: 'long OI divergence', title: 'OI div' },
      }),
    });
```

with:

```ts
    const app = createIngressApp({ repo: services.researchTasks, queue, taskToken: 'e2e-task-token' });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-task-token' },
      body: JSON.stringify({
        taskType: 'strategy.onboard', source: 'operator',
        payload: { kind: 'manual_description', content: 'long OI divergence', title: 'OI div' },
      }),
    });
```

- [ ] **Step 6: Run the full suite + type-check (everything still green — gate not added yet)**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — the new deps fields are optional and unused by the app, the Bearer headers are inert, so nothing changes behaviorally.

- [ ] **Step 7: Commit**

```bash
git add src/ingress/app.ts src/ingress/server.ts test/e2e/ingress-to-worker.test.ts test/e2e/research-run-cycle.test.ts test/e2e/strategy-onboard.test.ts
git commit -m "$(cat <<'EOF'
feat(sp6.2): thread task/callback tokens through IngressDeps + callers

Add optional taskToken/callbackToken to IngressDeps; server passes the
env tokens and warns per unset token; e2e tests pre-supply a task token
+ Bearer header. Inert until the gate lands (next task) — suite stays green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire the route-scoped gates + ingress tests

Now the feature itself: two path-scoped gates inside `createIngressApp`, registered before the handlers, plus the dedicated `app.test.ts` rewrite asserting the triad, cross-token isolation, and gate-before-body ordering.

**Files:**
- Test: `src/ingress/app.test.ts` (MODIFY — full rewrite)
- Modify: `src/ingress/app.ts`

- [ ] **Step 1: Rewrite the failing test**

Replace the entire contents of `src/ingress/app.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import type { Hono } from 'hono';
import { createIngressApp } from './app.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';

const TASK_TOKEN = 'task-secret';
const CALLBACK_TOKEN = 'callback-secret';

// Pass { taskToken: undefined } / { callbackToken: undefined } to exercise the unset (503) path.
function setup(tokens: { taskToken?: string; callbackToken?: string } = {}) {
  const repo = new InMemoryResearchTaskRepository();
  const queue = new InMemoryQueueAdapter();
  const app = createIngressApp({
    repo,
    queue,
    taskToken: 'taskToken' in tokens ? tokens.taskToken : TASK_TOKEN,
    callbackToken: 'callbackToken' in tokens ? tokens.callbackToken : CALLBACK_TOKEN,
  });
  return { app, repo, queue };
}

const validTask = JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } });

function postTask(app: Hono, body: string, token?: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token != null) headers.authorization = `Bearer ${token}`;
  return app.request('/tasks', { method: 'POST', headers, body });
}

function postCallback(app: Hono, token?: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token != null) headers.authorization = `Bearer ${token}`;
  return app.request('/callbacks/backtest-completed', { method: 'POST', headers, body: '{}' });
}

describe('Ingress POST /tasks (authorized)', () => {
  it('accepts a valid task, persists it, and enqueues an envelope', async () => {
    const { app, repo, queue } = setup();
    const res = await postTask(app, validTask, TASK_TOKEN);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { taskId: string; status: string };
    expect(body.status).toBe('queued');
    expect((await repo.findById(body.taskId))?.status).toBe('queued');
    expect(queue.queued).toHaveLength(1);
    expect(queue.queued[0]!.taskId).toBe(body.taskId);
  });

  it('rejects an invalid payload with 400 (auth passed, validation ran)', async () => {
    const { app, queue } = setup();
    const res = await postTask(app, JSON.stringify({ taskType: 'nope', source: 'web' }), TASK_TOKEN);
    expect(res.status).toBe(400);
    expect(queue.queued).toHaveLength(0);
  });

  it('deduplicates by dedupeKey: second call returns the same taskId without re-enqueue', async () => {
    const { app, queue } = setup();
    const body = JSON.stringify({ taskType: 'strategy.onboard', source: 'web', dedupeKey: 'k1', payload: {} });
    const first = (await (await postTask(app, body, TASK_TOKEN)).json()) as { taskId: string };
    const second = (await (await postTask(app, body, TASK_TOKEN)).json()) as { taskId: string };
    expect(second.taskId).toBe(first.taskId);
    expect(queue.queued).toHaveLength(1);
  });
});

describe('Ingress POST /tasks auth gate', () => {
  it('503 service_unavailable when the task token is unset', async () => {
    const { app } = setup({ taskToken: undefined });
    const res = await postTask(app, validTask, 'anything');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'task ingress not configured' } });
  });

  it('401 when the task token is set but the Bearer value is wrong', async () => {
    const { app } = setup();
    const res = await postTask(app, validTask, 'nope');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
  });

  it('401 when the Authorization header is missing', async () => {
    const { app } = setup();
    expect((await postTask(app, validTask, null)).status).toBe(401);
  });
});

describe('Ingress POST /callbacks/backtest-completed auth gate', () => {
  it('503 when the callback token is unset', async () => {
    const { app } = setup({ callbackToken: undefined });
    const res = await postCallback(app, 'anything');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'callback ingress not configured' } });
  });

  it('401 when the callback token is wrong', async () => {
    const { app } = setup();
    expect((await postCallback(app, 'nope')).status).toBe(401);
  });

  it('202 accepted (stub unchanged) when the callback token matches', async () => {
    const { app } = setup();
    const res = await postCallback(app, CALLBACK_TOKEN);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });
  });
});

describe('Ingress cross-token isolation', () => {
  it('the task token does NOT authorize /callbacks', async () => {
    const { app } = setup();
    expect((await postCallback(app, TASK_TOKEN)).status).toBe(401);
  });

  it('the callback token does NOT authorize /tasks', async () => {
    const { app } = setup();
    expect((await postTask(app, validTask, CALLBACK_TOKEN)).status).toBe(401);
  });
});

describe('Ingress gate precedes body parsing', () => {
  const malformed = '{ not json';

  it('malformed body with no token -> 503 (not 400)', async () => {
    const { app, queue } = setup({ taskToken: undefined });
    const res = await postTask(app, malformed, null);
    expect(res.status).toBe(503);
    expect(queue.queued).toHaveLength(0);
  });

  it('malformed body with a wrong token -> 401 (not 400)', async () => {
    const { app, queue } = setup();
    const res = await postTask(app, malformed, 'nope');
    expect(res.status).toBe(401);
    expect(queue.queued).toHaveLength(0);
  });

  it('malformed body with the correct token -> 400 (validation runs after the gate)', async () => {
    const { app, queue } = setup();
    const res = await postTask(app, malformed, TASK_TOKEN);
    expect(res.status).toBe(400);
    expect(queue.queued).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/ingress/app.test.ts`
Expected: FAIL — the auth-gate / isolation / ordering tests fail (the app currently returns 202/400, never 503/401) because no gate is wired yet. (The three "authorized" tests pass.)

- [ ] **Step 3: Add the import for `bearerAuth`**

In `src/ingress/app.ts`, find the import block ending with:

```ts
import { createAndEnqueueTask } from '../orchestrator/task-intake.ts';
```

and add directly after it:

```ts
import { createAndEnqueueTask } from '../orchestrator/task-intake.ts';
import { bearerAuth } from '../auth/bearer-auth.ts';
```

- [ ] **Step 4: Register the two route-scoped gates before the handlers**

In `src/ingress/app.ts`, find:

```ts
export function createIngressApp(deps: IngressDeps): Hono {
  const app = new Hono();

  app.post('/tasks', async (c) => {
```

and insert the two gates between `const app = new Hono();` and `app.post('/tasks', …)`:

```ts
export function createIngressApp(deps: IngressDeps): Hono {
  const app = new Hono();

  // SP-6.2: fail-closed, per-boundary service-token gates, registered BEFORE the handlers
  // so unauthorized requests never reach JSON parsing / validation / task intake.
  app.use('/tasks', bearerAuth(deps.taskToken, { notConfiguredMessage: 'task ingress not configured' }));
  app.use(
    '/callbacks/backtest-completed',
    bearerAuth(deps.callbackToken, { notConfiguredMessage: 'callback ingress not configured' }),
  );

  app.post('/tasks', async (c) => {
```

- [ ] **Step 5: Run the ingress test to verify it passes**

Run: `pnpm exec vitest run src/ingress/app.test.ts`
Expected: PASS (all describe blocks: authorized, /tasks gate, /callbacks gate, cross-token isolation, gate-precedes-body).

- [ ] **Step 6: Run the full suite + type-check**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — the e2e tests (pre-seeded in Task 4 with `e2e-task-token` + header) are now authorized through the live gate; everything green.

- [ ] **Step 7: Commit**

```bash
git add src/ingress/app.ts src/ingress/app.test.ts
git commit -m "$(cat <<'EOF'
feat(sp6.2): fail-closed bearer gates on POST /tasks and /callbacks

Two route-scoped gates registered before the handlers, each fed by its
own token (TRADING_LAB_TASK_TOKEN / TRADING_LAB_CALLBACK_TOKEN). Tests
cover the 503/401/200 triad, cross-token isolation, and gate-before-body
ordering (malformed JSON -> 503/401, never 400, when unauthorized).
Callback stays a 202 stub behind its gate.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Docs — `.env.example` + ingress README

**Files:**
- Modify: `.env.example`
- Create: `src/ingress/README.md`

- [ ] **Step 1: Add the token block to `.env.example`**

In `.env.example`, find the SP-6.1 chat block (it ends with the `INGRESS_PORT must not be public …` comment, just before the blank line and `# SP-5 Read API`):

```
# INGRESS_PORT must not be public without network protection (reverse proxy / firewall)

# SP-5 Read API
```

and insert the SP-6.2 block between them:

```
# INGRESS_PORT must not be public without network protection (reverse proxy / firewall)

# SP-6.2 Task + callback ingress service-to-service auth (fail-closed: unset -> 503)
TRADING_LAB_TASK_TOKEN=dev-task-token           # service-to-service token for POST /tasks
TRADING_LAB_CALLBACK_TOKEN=dev-callback-token   # service-to-service token for POST /callbacks/backtest-completed
# production MUST override these values
# each ingress token MUST be distinct (read / chat / task / callback are separate boundaries)
# /tasks is NOT the office path — trading-office uses /chat/messages

# SP-5 Read API
```

- [ ] **Step 2: Create the ingress README**

Create `src/ingress/README.md`:

```markdown
# Ingress (SP-1 / SP-6.2)

Service-to-service write/ingress on `INGRESS_PORT` (default 3000), served by `createIngressApp`. Each route below is a fail-closed boundary fed by its **own** token — if a token is unset, that route rejects every request with `503`; with a token set, a missing/wrong `Authorization: Bearer …` gets `401`. The gates run before JSON parsing / validation / task intake.

`/tasks` is **not** the office path — trading-office reaches the lab through `POST /chat/messages` (see `../chat/README.md`). `/tasks` is a low-level internal ingress; `/callbacks/backtest-completed` is an inbound signal from the backtest runner.

| Route | Token | Unset behavior |
|---|---|---|
| `POST /tasks` | `TRADING_LAB_TASK_TOKEN` | `503` (route mounted, rejects all) |
| `POST /callbacks/backtest-completed` | `TRADING_LAB_CALLBACK_TOKEN` | `503` (route mounted, rejects all) |

Each token must be distinct from the others (`read` / `chat` / `task` / `callback` are separate boundaries); a token for one route never authorizes another (proven by the cross-token isolation tests in `app.test.ts`).

## `POST /tasks`

- **Auth:** `Authorization: Bearer <TRADING_LAB_TASK_TOKEN>`. `401` on missing/wrong token; `503` when unset.
- **Request** (`IngressTaskRequestSchema`): `{ taskType, source, payload?, correlationId?, dedupeKey? }`, `content-type: application/json`.
- **Response:** `202 { taskId, status }`. Invalid body → `400 { status: 'rejected', issues }`. A repeated `dedupeKey` returns the same `taskId` without re-enqueue.

## `POST /callbacks/backtest-completed`

- **Auth:** `Authorization: Bearer <TRADING_LAB_CALLBACK_TOKEN>`. `401` on missing/wrong token; `503` when unset.
- **Behavior:** SP-1 stub — returns `202 { status: 'accepted' }`. This boundary only adds the gate; real suspend/resume wiring is a later slice.

`INGRESS_PORT` must not be public without network protection (reverse proxy / firewall). See `docs/superpowers/specs/2026-06-14-trading-lab-sp6.2-task-ingress-boundary-design.md`.
```

- [ ] **Step 3: Sanity-check the docs build nothing but verify the suite is still green**

Run: `pnpm test && pnpm typecheck`
Expected: PASS (docs-only change; nothing should regress).

- [ ] **Step 4: Commit**

```bash
git add .env.example src/ingress/README.md
git commit -m "$(cat <<'EOF'
docs(sp6.2): ingress boundary README + .env.example task/callback tokens

Document the two fail-closed ingress gates and their distinct tokens;
add dev placeholders with the per-boundary distinctness + "/tasks is not
the office path" notes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Run the complete suite + type-check one more time**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — full green, no type errors.

- [ ] **Confirm the boundary by eye**

Run: `git diff main --stat`
Expected: the 13 files from the File Structure table (3 created, 10 modified), no others.

---

## Self-Review (completed during planning)

**1. Spec coverage** — every spec section maps to a task:
- §4 `bearerAuth` factory → Task 1.
- §5 chat delegation (behavior-preserving, chat stays owner) → Task 2.
- §6 env tokens → Task 3; `IngressDeps` fields + server warns → Task 4; route-scoped gates → Task 5.
- §7 ingress README → Task 6.
- §8 `.env.example` → Task 6.
- §9 tests: factory unit (Task 1); triad + cross-token isolation + **gate-before-body ordering** + callback-202 (Task 5); the four `/tasks` call-site touches — `app.test.ts` (Task 5) and the three e2e files (Task 4); env assertions (Task 3).
- §10 guardrails: cross-token isolation tests (Task 5); read API untouched (no read file appears in any task); factory stays narrow (Task 1 comment + no app-wide use).
- §11 file list matches the File Structure table here exactly (13 files).

**2. Placeholder scan** — no TBD/TODO/"add error handling"/"similar to Task N"; every code step shows complete, runnable code.

**3. Type/name consistency** — `bearerAuth(token: string | undefined, opts: BearerAuthOptions)` with `BearerAuthOptions.notConfiguredMessage` is used identically in Tasks 1, 2, 5. `IngressDeps.taskToken` / `IngressDeps.callbackToken` are defined in Task 4 and consumed in Task 5. Env keys `TRADING_LAB_TASK_TOKEN` / `TRADING_LAB_CALLBACK_TOKEN` are spelled identically across Tasks 3, 4, 6. 503 messages `task ingress not configured` / `callback ingress not configured` match between the gate wiring (Task 5) and the assertions (Tasks 1, 5). The 401 envelope `{ error: { code: 'unauthorized', message: 'missing or invalid token' } }` is constant across all boundaries.

**Green-at-each-commit invariant** — Tasks 1–3 are additive. Task 4's caller updates are inert because the gate does not exist yet (optional deps + ignored headers). Task 5 lands the gate after the callers are pre-seeded, so the full suite is green at that commit. Task 6 is docs-only.
```
