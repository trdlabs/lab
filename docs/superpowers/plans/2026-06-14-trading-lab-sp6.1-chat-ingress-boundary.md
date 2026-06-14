# SP-6.1 — Chat Ingress Service Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate `POST /chat/messages` behind a dedicated service-to-service token (`TRADING_LAB_CHAT_TOKEN`), separate from the read API token, without changing any chat behavior.

**Architecture:** A shared low-level helper (`src/auth/bearer.ts`: `parseBearer` + constant-time `safeEqual`) feeds two independent middlewares — the existing `readAuthMiddleware` (read API) and a new `chatAuthMiddleware` (chat). The chat middleware is registered first inside `createChatApp`, so it runs before JSON parsing/validation/handler. Fail-closed: token unset → 503, token set + missing/wrong Bearer → 401, token set + correct → existing flow unchanged. Read and chat stay structurally separate (different apps, different injected tokens).

**Tech Stack:** TypeScript (Node `--experimental-strip-types`, `.ts` import specifiers), Hono, Zod, Vitest. Test runner: `vitest run`. Typecheck: `tsc -p tsconfig.json`.

**Spec:** `docs/superpowers/specs/2026-06-14-trading-lab-sp6.1-chat-ingress-boundary-design.md`

---

## File Structure

```
src/auth/bearer.ts                 # CREATE: parseBearer + safeEqual (shared primitives, no policy)
src/auth/bearer.test.ts            # CREATE: unit tests for the primitives
src/chat/auth.ts                   # CREATE: chatAuthMiddleware (fail-closed 503/401)
src/chat/auth.test.ts              # CREATE: chat auth + cross-boundary separation tests
src/chat/README.md                 # CREATE: stable contract for TradingLabChatConnector
src/read-api/auth.ts               # MODIFY: consume bearer.ts; re-export safeEqual (read behavior unchanged)
src/chat/chat-app.ts               # MODIFY: ChatAppDeps.authToken; register middleware first
src/chat/chat-app.test.ts          # MODIFY: auth-aware fixtures + gate-before-parse test
src/config/env.ts                  # MODIFY: + TRADING_LAB_CHAT_TOKEN
src/config/env.test.ts             # MODIFY: + load assertions
src/composition.ts                 # MODIFY: chat.authToken = env.TRADING_LAB_CHAT_TOKEN
src/ingress/server.ts              # MODIFY: warn when token unset
test/e2e/chat-to-task.test.ts      # MODIFY: authToken + Bearer header
.env.example                       # MODIFY: + TRADING_LAB_CHAT_TOKEN dev placeholder + comments
```

Conventions to match (observed in this repo): constant-time compare via `createHash('sha256')` + `timingSafeEqual`; 401 envelope `{ error: { code, message } }`; `.ts` extensions on all relative imports; tests co-located as `*.test.ts`.

---

## Task 1: Shared bearer primitives

**Files:**
- Create: `src/auth/bearer.ts`
- Test: `src/auth/bearer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/auth/bearer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseBearer, safeEqual } from './bearer.ts';

describe('parseBearer', () => {
  it('extracts the token after the "Bearer " prefix', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
  });

  it('returns null for an absent header', () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('')).toBeNull();
  });

  it('returns null for a malformed header (no Bearer prefix)', () => {
    expect(parseBearer('Token abc')).toBeNull();
    expect(parseBearer('abc')).toBeNull();
    expect(parseBearer('bearer abc')).toBeNull(); // case-sensitive prefix
  });
});

describe('safeEqual (hash-based constant-time)', () => {
  it('true for equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('false for different strings, including different lengths', () => {
    expect(safeEqual('a', 'ab')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/auth/bearer.test.ts`
Expected: FAIL — `Failed to load .../bearer.ts` / cannot resolve `./bearer.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/auth/bearer.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

// Constant-time compare: hash both sides to a fixed 32-byte digest first, so timing is
// independent of input length — no early length-mismatch leak (always compares 32 bytes).
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

const PREFIX = 'Bearer ';

// Extract the token after the "Bearer " prefix; null when the header is absent or malformed.
export function parseBearer(header: string | undefined): string | null {
  if (!header || !header.startsWith(PREFIX)) return null;
  return header.slice(PREFIX.length);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/auth/bearer.test.ts`
Expected: PASS — 2 suites, 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/auth/bearer.ts src/auth/bearer.test.ts
git commit -m "feat(sp6.1): shared bearer primitives (parseBearer + constant-time safeEqual)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Refactor read auth onto the shared helper

Read API behavior must not change. `readAuthMiddleware` keeps its 401 envelope; `safeEqual` is re-exported from `read-api/auth.ts` so the existing `read-api/auth.test.ts` import (`import { readAuthMiddleware, safeEqual } from './auth.ts'`) keeps resolving with **no edit to that test file**.

**Files:**
- Modify: `src/read-api/auth.ts`
- Test (existing, unchanged): `src/read-api/auth.test.ts`

- [ ] **Step 1: Confirm the existing read auth test passes before the refactor**

Run: `npx vitest run src/read-api/auth.test.ts`
Expected: PASS — this is the regression baseline for the refactor.

- [ ] **Step 2: Rewrite `src/read-api/auth.ts` to consume the shared helper**

Replace the entire file `src/read-api/auth.ts` with:

```ts
import type { MiddlewareHandler } from 'hono';
import { parseBearer, safeEqual } from '../auth/bearer.ts';

// Re-exported so existing importers of this module (read-api/auth.test.ts) keep resolving safeEqual here.
export { safeEqual } from '../auth/bearer.ts';

export function readAuthMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const presented = parseBearer(c.req.header('authorization'));
    if (presented === null || !safeEqual(presented, token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}
```

- [ ] **Step 3: Run the existing read auth test to verify no regression**

Run: `npx vitest run src/read-api/auth.test.ts`
Expected: PASS — same 3 tests (401 without/with wrong token; 200 with correct; 401 envelope; `safeEqual` constant-time) still green.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/read-api/auth.ts
git commit -m "refactor(sp6.1): read auth consumes shared bearer helper, re-exports safeEqual" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Chat auth middleware + boundary separation

`chatAuthMiddleware` is fail-closed. The separation tests live here and prove the guardrail behaviorally; the read middleware is imported **in test code only** to assert cross-rejection (production `chat/auth.ts` never imports read-api).

**Files:**
- Create: `src/chat/auth.ts`
- Test: `src/chat/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/chat/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { chatAuthMiddleware } from './auth.ts';
import { readAuthMiddleware } from '../read-api/auth.ts'; // test-only: cross-boundary separation proof

function chatApp(token?: string): Hono {
  const app = new Hono();
  app.use('*', chatAuthMiddleware(token));
  app.post('/messages', (c) => c.json({ ok: true }));
  return app;
}

function readApp(token: string): Hono {
  const app = new Hono();
  app.use('*', readAuthMiddleware(token));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono, token?: string | null) {
  const headers: Record<string, string> = {};
  if (token != null) headers.authorization = `Bearer ${token}`;
  return app.request('/messages', { method: 'POST', headers });
}

describe('chatAuthMiddleware', () => {
  it('503 service_unavailable when the token is unset', async () => {
    const res = await post(chatApp(undefined), 'anything');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'chat ingress not configured' } });
  });

  it('503 when the token is empty string', async () => {
    expect((await post(chatApp(''), 'anything')).status).toBe(503);
  });

  it('401 when the token is set but the Authorization header is missing', async () => {
    const res = await post(chatApp('chat-secret'), null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
  });

  it('401 when the token is set but the Bearer value is wrong', async () => {
    expect((await post(chatApp('chat-secret'), 'nope')).status).toBe(401);
  });

  it('passes through to the route when the Bearer value matches', async () => {
    const res = await post(chatApp('chat-secret'), 'chat-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('chat/read boundary separation', () => {
  it('chat ingress rejects a read token', async () => {
    expect((await post(chatApp('chat-token'), 'read-token')).status).toBe(401);
  });

  it('read API rejects a chat token', async () => {
    const res = await readApp('read-token').request('/x', { headers: { authorization: 'Bearer chat-token' } });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/chat/auth.test.ts`
Expected: FAIL — cannot resolve `./auth.ts` (chatAuthMiddleware not defined).

- [ ] **Step 3: Write minimal implementation**

Create `src/chat/auth.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import { parseBearer, safeEqual } from '../auth/bearer.ts';

// Service-to-service gate for the chat ingress. Fail-closed:
//   token unset/empty         -> 503 (boundary not configured — an operator signal)
//   token set, bad/no Bearer  -> 401 (caller problem; same envelope as the read API)
//   token set, Bearer matches -> next()
export function chatAuthMiddleware(token?: string): MiddlewareHandler {
  return async (c, next) => {
    if (!token) {
      return c.json({ error: { code: 'service_unavailable', message: 'chat ingress not configured' } }, 503);
    }
    const presented = parseBearer(c.req.header('authorization'));
    if (presented === null || !safeEqual(presented, token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/chat/auth.test.ts`
Expected: PASS — 2 suites, 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/chat/auth.ts src/chat/auth.test.ts
git commit -m "feat(sp6.1): chatAuthMiddleware (fail-closed) + chat/read separation tests" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Env config — TRADING_LAB_CHAT_TOKEN

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/config/env.test.ts`, add this new describe block at the end of the file (after the `SP-6 agent-activity knobs` block):

```ts
describe('SP-6.1 chat ingress token', () => {
  it('defaults TRADING_LAB_CHAT_TOKEN to undefined', () => {
    expect(loadEnv({} as NodeJS.ProcessEnv).TRADING_LAB_CHAT_TOKEN).toBeUndefined();
  });

  it('reads TRADING_LAB_CHAT_TOKEN from source', () => {
    const env = loadEnv({ TRADING_LAB_CHAT_TOKEN: 'chat-secret' } as unknown as NodeJS.ProcessEnv);
    expect(env.TRADING_LAB_CHAT_TOKEN).toBe('chat-secret');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL — TypeScript error / assertion fail: `TRADING_LAB_CHAT_TOKEN` does not exist on `Env`.

- [ ] **Step 3: Write minimal implementation**

In `src/config/env.ts`, add the field to the `Env` interface immediately after the `TRADING_LAB_READ_TOKEN?: string;` line:

```ts
  TRADING_LAB_READ_TOKEN?: string;
  TRADING_LAB_CHAT_TOKEN?: string;
```

And in `loadEnv`'s returned object, add the pass-through immediately after the `TRADING_LAB_READ_TOKEN: source.TRADING_LAB_READ_TOKEN,` line:

```ts
    TRADING_LAB_READ_TOKEN: source.TRADING_LAB_READ_TOKEN,
    TRADING_LAB_CHAT_TOKEN: source.TRADING_LAB_CHAT_TOKEN,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS — all env suites green, including the new SP-6.1 block.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(sp6.1): load TRADING_LAB_CHAT_TOKEN env" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire the gate into the chat app (gate-before-parse)

This is the load-bearing task: register `chatAuthMiddleware` as the **first** middleware so it runs before `c.req.json()`. The existing behavior tests are updated to flow through the gate with a valid token (proving no regression), and a new test proves a malformed body with no/unset auth never reaches validation.

**Files:**
- Modify: `src/chat/chat-app.ts`
- Test: `src/chat/chat-app.test.ts`

- [ ] **Step 1: Update the test fixtures and add the gate-before-parse test**

In `src/chat/chat-app.test.ts`:

(a) Add a token constant and `authToken` to the shared `appDeps()`. Replace the `appDeps` function with:

```ts
const CHAT_TOKEN = 'chat-test-token';

function appDeps(over: Partial<ChatAppDeps> = {}): ChatAppDeps {
  return {
    classifier: new FakeIntentClassifier(),
    sessions: new InMemoryChatSessionRepository(),
    plans: new InMemoryChatPlanRepository(),
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    hypotheses: new InMemoryHypothesisProposalRepository(),
    events: new InMemoryAgentEventRepository(),
    queue: new InMemoryQueueAdapter(),
    minConfidence: 0.6,
    maxMessageChars: 4000,
    authToken: CHAT_TOKEN,
    ...over,
  };
}
```

(b) Replace the `post` helper so it sends the Bearer header by default and supports auth/body overrides for the gate test:

```ts
function post(
  app: ReturnType<typeof createChatApp>,
  body: unknown,
  opts: { token?: string | null; rawBody?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token === undefined ? CHAT_TOKEN : opts.token; // default: valid; null omits header
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request('/messages', {
    method: 'POST',
    headers,
    body: opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(body),
  });
}
```

(c) Add a new describe block (after the existing `describe('POST /chat/messages', ...)`) that proves the gate runs before body parsing:

```ts
describe('chat auth gate runs before body parsing', () => {
  it('401 (not 400) for a malformed JSON body when the token is set but auth is missing', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, undefined, { token: null, rawBody: '{ this is not json' });
    expect(res.status).toBe(401); // auth gate rejects before c.req.json() runs — never a 400 validation error
  });

  it('503 (not 400) for a malformed JSON body when the token is unset', async () => {
    const app = createChatApp(appDeps({ authToken: undefined }));
    const res = await post(app, undefined, { token: null, rawBody: '{ this is not json' });
    expect(res.status).toBe(503);
  });

  it('401 for a well-formed request when the Bearer token is wrong', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, { message: 'привет' }, { token: 'wrong-token' });
    expect(res.status).toBe(401);
  });
});
```

Leave the existing `describe('POST /chat/messages', ...)` tests as they are — they now exercise the handler **through** the gate, because `appDeps()` sets a token and `post()` sends the matching Bearer header.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/chat/chat-app.test.ts`
Expected: FAIL — the new gate tests fail (no middleware yet: malformed body falls through to `c.req.json().catch(() => null)` → schema → **400**, not 401/503; wrong-token request returns 200).

- [ ] **Step 3: Wire the middleware into `createChatApp`**

In `src/chat/chat-app.ts`:

(a) Add the import near the other local imports:

```ts
import { chatAuthMiddleware } from './auth.ts';
```

(b) Add `authToken` to `ChatAppDeps`:

```ts
export interface ChatAppDeps extends ChatHandlerDeps {
  maxMessageChars: number;
  authToken?: string;
}
```

(c) Register the gate as the first middleware, before the route. Replace the start of `createChatApp` so it reads:

```ts
export function createChatApp(deps: ChatAppDeps): Hono {
  const app = new Hono();

  // Service-to-service auth gate — first middleware, so unauthorized requests never reach
  // JSON parsing / schema validation / the size cap / the handler.
  app.use('*', chatAuthMiddleware(deps.authToken));

  app.post('/messages', async (c) => {
```

(Leave the rest of the `app.post('/messages', ...)` body and `return app;` unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/chat/chat-app.test.ts`
Expected: PASS — existing behavior tests (empty/whitespace/oversize/out_of_scope/task_created) still green through the gate, plus the 3 new gate tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/chat/chat-app.ts src/chat/chat-app.test.ts
git commit -m "feat(sp6.1): gate POST /chat/messages with chatAuthMiddleware before body parsing" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire the token through composition

**Files:**
- Modify: `src/composition.ts`

- [ ] **Step 1: Add the token to the chat deps**

In `src/composition.ts`, inside the `const chat: ChatAppDeps = { ... }` object, add the field after `maxMessageChars: env.CHAT_MAX_MESSAGE_CHARS,`:

```ts
    minConfidence: env.INTENT_CLASSIFIER_MIN_CONFIDENCE,
    maxMessageChars: env.CHAT_MAX_MESSAGE_CHARS,
    authToken: env.TRADING_LAB_CHAT_TOKEN,
  };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors — `authToken` matches `ChatAppDeps.authToken?: string` and `env.TRADING_LAB_CHAT_TOKEN` is `string | undefined`.

- [ ] **Step 3: Commit**

```bash
git add src/composition.ts
git commit -m "feat(sp6.1): inject TRADING_LAB_CHAT_TOKEN into chat app deps" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Startup warning when the token is unset

Mirrors the read listener's warn-on-unset, so a misconfigured prod deploy is visible in logs. `server.ts` is a top-level script (runs on import); this is a log line covered by typecheck.

**Files:**
- Modify: `src/ingress/server.ts`

- [ ] **Step 1: Add the warning after the chat route is mounted**

In `src/ingress/server.ts`, immediately after the line `app.route('/chat', createChatApp(chat));`, add:

```ts
app.route('/chat', createChatApp(chat));
if (!env.TRADING_LAB_CHAT_TOKEN) {
  console.warn('[chat] TRADING_LAB_CHAT_TOKEN not set — POST /chat/messages will reject all requests (503)');
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ingress/server.ts
git commit -m "feat(sp6.1): warn at startup when TRADING_LAB_CHAT_TOKEN is unset" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Update the e2e chat→task test

The e2e test builds `createChatApp` directly and posts without auth; under the gate it must supply a token and Bearer header.

**Files:**
- Modify: `test/e2e/chat-to-task.test.ts`

- [ ] **Step 1: Add `authToken` to the app deps**

In `test/e2e/chat-to-task.test.ts`, in the `createChatApp({ ... })` call, add `authToken` to the deps object:

```ts
    const app = createChatApp({
      classifier: new FakeIntentClassifier(),
      sessions: services.chatSessions, plans: services.chatPlans,
      researchTasks: services.researchTasks, strategyProfiles: services.strategyProfiles,
      hypotheses: services.hypotheses, events: services.events, queue,
      minConfidence: 0.6, maxMessageChars: 4000,
      authToken: 'e2e-chat-token',
    });
```

- [ ] **Step 2: Send the Bearer header on the request**

In the same test, update the `app.request('/messages', { ... })` headers to include the Authorization header:

```ts
    const res = await app.request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-chat-token' },
      body: JSON.stringify({ message: 'исследуй эту стратегию: лонг при росте OI и падении цены', sessionId: 's1' }),
    });
```

- [ ] **Step 3: Run the e2e test to verify it passes**

Run: `npx vitest run test/e2e/chat-to-task.test.ts`
Expected: PASS — chat→onboard→auto-chain research flow still works through the gate (`task_created`, `plannedNextStep.taskType === 'research.run_cycle'`, profile + research task persisted).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/chat-to-task.test.ts
git commit -m "test(sp6.1): authorize e2e chat->task flow through the auth gate" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Contract README for the connector

**Files:**
- Create: `src/chat/README.md`

- [ ] **Step 1: Write the contract doc**

Create `src/chat/README.md`:

```markdown
# Chat Ingress (SP-4.6 / SP-6.1)

Service-to-service write/ingress boundary for the trading-office backend. `POST /chat/messages` is served by `createChatApp`, mounted at `/chat` on the main ingress app (`INGRESS_PORT`). This is the only supported caller path:

```
Browser → trading-office backend → TradingLabChatConnector → trading-lab POST /chat/messages
```

The browser never calls trading-lab directly; user auth lives in trading-office. trading-lab only ever receives a service-to-service request.

## Auth (SP-6.1)

`Authorization: Bearer <TRADING_LAB_CHAT_TOKEN>` on `POST /chat/messages`. The chat token is separate from `TRADING_LAB_READ_TOKEN` (read API); neither token works on the other boundary. The gate is the first middleware — it runs before JSON parsing, schema validation, the size cap, and the handler. Fail-closed:

- token unset/empty → `503 { "error": { "code": "service_unavailable", "message": "chat ingress not configured" } }`
- token set, missing/wrong Bearer → `401 { "error": { "code": "unauthorized", "message": "missing or invalid token" } }`
- token set, Bearer matches → request proceeds

## Request

`POST /chat/messages`, `content-type: application/json`:

| Field | Type | Notes |
|---|---|---|
| `message` | string | trimmed, length 1..`CHAT_MAX_MESSAGE_CHARS` (default 4000). Empty/whitespace → 400. |
| `sessionId` | string? | optional; omitted → a new id is generated and echoed back |
| `channel` | `'web' \| 'telegram'` | default `'web'` |

## Response

`200` with a `ChatResponse` discriminated union (`kind`), always echoing `sessionId`:

- `task_created` — `{ taskId, taskType, status, plannedNextStep? }`. `plannedNextStep` documents an auto-chain continuation (e.g. `{ taskType: 'research.run_cycle', after: 'strategy.onboard' }`).
- `task_status` — `{ taskId, status }`
- `needs_clarification` — `{ question, missing[] }`
- `out_of_scope` — `{ message }`
- `capability_not_available` — `{ capability, message }`
- `help` — `{ message, supportedIntents[] }`
- `rejected` — `{ reason, issues? }`
- `error` — `{ message }`

`400` rejection envelopes (body validation): invalid body `{ status: 'rejected', issues }`; oversize `{ status: 'rejected', reason: 'message_too_long', maxMessageChars }`.

`401` / `503` auth envelopes — see Auth above.

## Out of scope

No browser-facing endpoint, no streaming assistant responses, no command channel, no chat transcript UI. SP-6 SSE (`GET /v1/stream`) is a separate read-side boundary and is unaffected. See `docs/superpowers/specs/2026-06-14-trading-lab-sp6.1-chat-ingress-boundary-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add src/chat/README.md
git commit -m "docs(sp6.1): chat ingress contract for TradingLabChatConnector" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: .env.example dev placeholder

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add the chat token block**

In `.env.example`, immediately after the `CHAT_MAX_MESSAGE_CHARS=4000` line (end of the SP-4.6 chat block), insert:

```
# SP-6.1 Chat ingress service-to-service auth (fail-closed: unset -> POST /chat/messages returns 503)
TRADING_LAB_CHAT_TOKEN=dev-chat-token     # service-to-service token for POST /chat/messages
# production MUST override this value
# MUST differ from TRADING_LAB_READ_TOKEN (read API and chat ingress are separate boundaries)
# browser never calls trading-lab directly — the office backend is the only caller
# INGRESS_PORT must not be public without network protection (reverse proxy / firewall)
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(sp6.1): .env.example chat token dev placeholder + boundary notes" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final Verification (after all tasks)

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — entire suite green, including: `src/auth/bearer.test.ts`, `src/chat/auth.test.ts`, `src/read-api/auth.test.ts` (unchanged), `src/chat/chat-app.test.ts` (auth-aware + gate-before-parse), `src/config/env.test.ts`, `test/e2e/chat-to-task.test.ts`.

- [ ] **Step 3: Confirm the guardrails behaviorally**

Confirm the following are all covered by green tests:
- unset token → 503; missing/wrong Bearer → 401; correct Bearer → existing flow (Task 3, Task 5).
- read token rejected by chat; chat token rejected by read API (Task 3 separation block).
- malformed JSON with no/unset auth → 401/503, never 400 (Task 5 gate-before-parse block).
- existing chat behavior (validation, size cap, session handling, auto-chain) unchanged through the gate (Task 5 existing block + Task 8 e2e).

- [ ] **Step 4: Push the branch and open the PR**

```bash
git push -u origin sp6.1-chat-ingress-boundary
gh pr create --fill --base main
```
