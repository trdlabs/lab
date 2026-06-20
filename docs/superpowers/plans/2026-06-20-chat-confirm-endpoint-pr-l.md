# PR-L: structured chat confirm endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /chat/confirm` so the office can resolve a conversational-operator proposal by id (`pendingInteractionId`) + `sessionId` + `decision`, reusing the exact deterministic confirm path that the typed-"да" turn already uses.

**Architecture:** Extract the existing confirmation-consumption block from `handleChatMessage` into a reusable `consumeConfirmation(...)` (behaviour-preserving refactor), then expose a thin `POST /chat/confirm` Hono route that loads the session and calls it. No new domain event, no migration, no new enqueue path — `confirmPending` + `createAndEnqueueTask` (the single Slice-1 chokepoint) are reused unchanged.

**Tech Stack:** TypeScript ESM under `node --experimental-strip-types`, Hono, Zod, Vitest.

## Global Constraints

- Runtime is `node --experimental-strip-types` — **NO TypeScript parameter properties** (`constructor(private x)` breaks at runtime; an AST guard test fails the suite). Use explicit field declarations + assignment.
- **Confirmation before interpretation:** the confirm path never invokes the LLM/interpreter; it resolves the stored `ActionProposal` deterministically.
- **Single enqueue chokepoint:** task creation only via `createAndEnqueueTask`. The confirm endpoint must not introduce a second enqueue path.
- **Audit-safety:** `agent_event` payloads carry ids/types/counts/codes/timings only — never the raw message or strategy text.
- **Auth:** `/chat/confirm` lives behind the same chat bearer gate as `/chat/messages` (`chatAuthMiddleware(deps.authToken)`): token unset → 503; bad/no bearer → 401.
- DTOs/responses reuse the existing `ChatResponse` union (`src/chat/response.ts`) — do not invent a new response shape.

---

### Task 1: Extract `consumeConfirmation` from `handleChatMessage` (behaviour-preserving)

**Files:**
- Modify: `src/chat/chat-handler.ts` (the `if (pending?.kind === 'action_confirmation')` block + `executeConfirmedProposal`/`PENDING_ACTIONS` stay in this module)
- Test: `src/chat/chat-handler.test.ts` (existing — must stay green; no new test needed for a pure refactor)

**Interfaces:**
- Produces: `export async function consumeConfirmation(args: ConsumeConfirmationArgs, deps: ChatHandlerDeps, ev: ChatEvFn, now: () => string): Promise<ChatResponse>` where
  - `export interface ConsumeConfirmationArgs { proposalId: string; decision: 'confirm' | 'cancel' | 'unresolved'; session: ChatSessionContext }`
  - `export type ChatEvFn = (type: string, payload: Record<string, unknown>) => Promise<void>`
- Consumes (already in `ChatHandlerDeps`): `proposals.confirmPending(id, sessionId, now)`, `proposals.cancelPending(id, sessionId, now)`, `proposals.attachTask`, `sessions.upsert`, `researchTasks.findById`, `queue`, `plans`, `events`.

- [ ] **Step 1: Add the `ChatEvFn` type + `ConsumeConfirmationArgs` interface and the `consumeConfirmation` function**

In `src/chat/chat-handler.ts`, add near the top-level declarations (after `ChatHandlerDeps`):

```ts
export type ChatEvFn = (type: string, payload: Record<string, unknown>) => Promise<void>;

export interface ConsumeConfirmationArgs {
  proposalId: string;
  decision: 'confirm' | 'cancel' | 'unresolved';
  session: ChatSessionContext;
}

/**
 * Resolves a pending action proposal deterministically — the single place the
 * confirm/cancel/unresolved outcomes live. Called by the typed-"да" turn in
 * handleChatMessage AND by the structured POST /chat/confirm endpoint, so the
 * two entry points can never drift. The interpreter is never consulted here;
 * a task is created exactly once, only on confirmed_now, via createAndEnqueueTask.
 */
export async function consumeConfirmation(
  args: ConsumeConfirmationArgs,
  deps: ChatHandlerDeps,
  ev: ChatEvFn,
  now: () => string,
): Promise<ChatResponse> {
  const { proposalId, decision, session } = args;
  const sid = session.sessionId;
  const clearPending = (extra: Partial<ChatSessionContext> = {}): Promise<void> =>
    deps.sessions.upsert({ ...session, ...extra, pendingInteraction: undefined, updatedAt: now() });

  if (decision === 'cancel') {
    await deps.proposals.cancelPending(proposalId, sid, now());
    await clearPending();
    await ev('chat.proposal.cancelled', { proposalId, sessionId: sid });
    return assistantMessage(sid, 'Отменил. Если нужно — пришлите стратегию или запрос заново.', { actions: [] });
  }

  if (decision === 'unresolved') {
    await ev('chat.proposal.unresolved_reply', { proposalId, sessionId: sid });
    return assistantMessage(sid, 'Не понял ответ. Подтвердите запуск или отмените действие.', {
      actions: PENDING_ACTIONS,
      pendingInteractionId: proposalId,
    });
  }

  const result = await deps.proposals.confirmPending(proposalId, sid, now());
  switch (result.kind) {
    case 'confirmed_now':
      return executeConfirmedProposal(result.proposal, session, deps, ev, now);
    case 'already_confirmed': {
      const taskId = result.proposal.confirmedTaskId;
      if (!taskId) return assistantMessage(sid, 'Заявка уже подтверждена. Если задача не появилась — проверьте статус задачи.', { actions: [] });
      const task = await deps.researchTasks.findById(taskId);
      return task
        ? taskStatus(sid, taskId, task.status)
        : taskCreated(sid, taskId, result.proposal.task.taskType, 'queued');
    }
    case 'expired':
      await clearPending();
      await ev('chat.proposal.expired', { proposalId, sessionId: sid });
      return assistantMessage(sid, 'Срок подтверждения истёк. Пришлите запрос заново.', { actions: [] });
    case 'not_found':
      await clearPending();
      return assistantMessage(sid, 'Не нашёл активного подтверждения. Пришлите запрос заново.', { actions: [] });
  }
}
```

(Note: `executeConfirmedProposal`, `PENDING_ACTIONS`, `assistantMessage`, `taskStatus`, `taskCreated` already exist in this module — no new imports.)

- [ ] **Step 2: Replace the inline confirm block in `handleChatMessage` with a call to `consumeConfirmation`**

In `handleChatMessage`, the existing block:

```ts
  const pending = input.session.pendingInteraction;
  if (pending?.kind === 'action_confirmation') {
    const proposalId = pending.proposalId;
    const clearPending = ...;
    const reply = resolveConfirmationReply(input.message);
    if (reply === 'cancel') { ... }
    if (reply === 'unresolved') { ... }
    const result = await deps.proposals.confirmPending(...);
    switch (result.kind) { ... }
  }
```

becomes:

```ts
  const pending = input.session.pendingInteraction;
  if (pending?.kind === 'action_confirmation') {
    const reply = resolveConfirmationReply(input.message);
    return consumeConfirmation({ proposalId: pending.proposalId, decision: reply, session: input.session }, deps, ev, now);
  }
```

Keep `resolveConfirmationReply` imported. The `ev` closure in `handleChatMessage` already carries `chatRequestId` in earlier events; `consumeConfirmation`'s events drop `chatRequestId` (it is not meaningful on the structured path). This is an intentional, audit-safe payload trim.

- [ ] **Step 3: Run the existing chat-handler suite to verify behaviour is unchanged**

Run: `npx vitest run src/chat/chat-handler.test.ts`
Expected: PASS (all existing confirmation tests — cancel, confirm→task_created, already_confirmed, expired, not_found, unresolved — stay green).

- [ ] **Step 4: Typecheck**

Run: `pnpm -s typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/chat/chat-handler.ts
git commit -m "refactor(chat): extract consumeConfirmation from handleChatMessage (no behaviour change)"
```

---

### Task 2: `POST /chat/confirm` route + request schema + endpoint tests

**Files:**
- Modify: `src/chat/request.ts` (add `ChatConfirmRequestSchema`)
- Modify: `src/chat/chat-app.ts` (add the `/confirm` route)
- Test: `src/chat/chat-app.test.ts` (add `/chat/confirm` integration cases)

**Interfaces:**
- Consumes: `consumeConfirmation` (Task 1), `validateWithSchema`, `chatAuthMiddleware`, `deps.sessions.get`.
- Produces: `POST /chat/confirm` accepting `{ pendingInteractionId: string; sessionId: string; decision: 'confirm' | 'cancel' }` → `ChatResponse` (200), `{ status:'rejected', issues }` (400) on schema violation, 503/401 from the auth gate.

- [ ] **Step 1: Add the request schema**

In `src/chat/request.ts`, append:

```ts
export const ChatConfirmRequestSchema = z.object({
  pendingInteractionId: z.string().min(1),
  sessionId: z.string().min(1),
  decision: z.enum(['confirm', 'cancel']),
});

export type ChatConfirmRequest = z.infer<typeof ChatConfirmRequestSchema>;
```

- [ ] **Step 2: Write the failing endpoint test**

In `src/chat/chat-app.test.ts`, add (mirror the existing `/messages` test wiring — same `createChatApp(deps)` + bearer header helper):

```ts
it('POST /chat/confirm confirms a pending proposal -> task_created', async () => {
  // Arrange: drive one /messages turn that leaves a pending proposal, capture sessionId + pendingInteractionId.
  const first = await app.request('/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'проанализируй стратегию X', channel: 'web' }),
  });
  const proposal = (await first.json()) as { kind: string; sessionId: string; pendingInteractionId?: string };
  expect(proposal.kind).toBe('assistant_message');
  expect(proposal.pendingInteractionId).toBeTruthy();

  // Act: structured confirm.
  const res = await app.request('/confirm', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingInteractionId: proposal.pendingInteractionId, sessionId: proposal.sessionId, decision: 'confirm' }),
  });

  // Assert
  expect(res.status).toBe(200);
  const body = (await res.json()) as { kind: string; taskId?: string };
  expect(body.kind).toBe('task_created');
  expect(body.taskId).toBeTruthy();
});

it('POST /chat/confirm with unset token -> 503', async () => {
  const noAuth = createChatApp({ ...deps, authToken: undefined });
  const res = await noAuth.request('/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingInteractionId: 'p', sessionId: 's', decision: 'confirm' }),
  });
  expect(res.status).toBe(503);
});

it('POST /chat/confirm for an unknown proposal -> graceful assistant_message (not 500)', async () => {
  const res = await app.request('/confirm', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingInteractionId: 'nope', sessionId: 'ghost', decision: 'confirm' }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { kind: string };
  expect(body.kind).toBe('assistant_message'); // "Не нашёл активного подтверждения…"
});

it('POST /chat/confirm with a bad decision -> 400 rejected', async () => {
  const res = await app.request('/confirm', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingInteractionId: 'p', sessionId: 's', decision: 'maybe' }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/chat/chat-app.test.ts`
Expected: FAIL (no `/confirm` route → 404 on the request).

- [ ] **Step 4: Implement the route**

In `src/chat/chat-app.ts`, add imports and the route. Add `ChatConfirmRequestSchema` to the existing `./request.ts` import, `consumeConfirmation` + `ChatEvFn` to the `./chat-handler.ts` import, and `randomUUID` from `node:crypto`. Then, inside `createChatApp`, after the `/messages` route:

```ts
  app.post('/confirm', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const validation = validateWithSchema(ChatConfirmRequestSchema, raw);
    if (validation.status === 'invalid') {
      return c.json({ status: 'rejected', issues: validation.issues }, 400);
    }
    const req = validation.data;

    const now = (): string => new Date().toISOString();
    const chatRequestId = randomUUID();
    const ev: ChatEvFn = (type, payload) =>
      deps.events.append({ id: randomUUID(), taskId: chatRequestId, type, payload, createdAt: now() });

    const existing = await deps.sessions.get(req.sessionId);
    const session: ChatSessionContext = existing ?? { sessionId: req.sessionId, updatedAt: now() };

    const response = await consumeConfirmation(
      { proposalId: req.pendingInteractionId, decision: req.decision, session },
      deps,
      ev,
      now,
    );
    return c.json(response, 200);
  });
```

(`ChatSessionContext` is already imported in `chat-app.ts`; `deps.events` is part of `ChatHandlerDeps`, already spread into `ChatAppDeps`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/chat/chat-app.test.ts`
Expected: PASS (confirm→task_created; 503 on unset token; unknown→assistant_message; bad decision→400).

- [ ] **Step 6: Typecheck + full chat suite**

Run: `pnpm -s typecheck && npx vitest run src/chat`
Expected: typecheck exit 0; all chat tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/chat/request.ts src/chat/chat-app.ts src/chat/chat-app.test.ts
git commit -m "feat(chat): POST /chat/confirm structured proposal confirmation (reuses consumeConfirmation)"
```

---

## Self-Review

- **Spec coverage (§4 Part A):** endpoint path + body + bearer gate (Task 2) ✓; confirm→`confirmed_now`→`createAndEnqueueTask`→`task_created` (Task 1 reused path) ✓; `already_confirmed` idempotent — natural via `createAndEnqueueTask` dedupeKey `chat-proposal:<id>` and the `already_confirmed` arm (Task 1) ✓; `not_found`/`expired`→graceful `assistant_message` (Task 1) ✓; cancel→cancelled (Task 1) ✓; additive, no migration ✓.
- **Idempotency note:** a second `confirm` after `confirmed_now` hits the `already_confirmed` arm (the proposal row is already `confirmed`), returning the existing task's status — no second enqueue. Even if it reached `createAndEnqueueTask`, the `dedupeKey: chat-proposal:<id>` dedupes to the same task. Both layers covered.
- **Placeholder scan:** none — every step carries real code/commands.
- **Type consistency:** `consumeConfirmation` / `ConsumeConfirmationArgs` / `ChatEvFn` names match across Tasks 1–2; `ChatConfirmRequestSchema` matches its route use; `decision` enum (`confirm|cancel`) at the route is a subset of `consumeConfirmation`'s (`confirm|cancel|unresolved`) — the route never passes `unresolved`.
- **Constraint check:** no parameter properties introduced (plain functions); confirm path does not call the interpreter; single enqueue chokepoint preserved.

## Execution Handoff

PR-L is the prerequisite. PR-O1 (office server) and PR-O2 (office web) plans are authored after PR-L ships, so they bind to the real endpoint + response shapes (avoiding speculative drift).
