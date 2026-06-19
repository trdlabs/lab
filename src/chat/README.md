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

## Two-Turn Confirmation Protocol

Strategy and research intents follow a two-turn flow. Read-only / static intents (`help`, `task.status`, `out_of_scope`) are still one-turn and return their response directly.

```
Turn 1 (strategy message)
  → assistant_message + pendingInteractionId + actions:[confirm, cancel]
  → proposal persisted; NO task enqueued; session.pendingInteraction set

Turn 2 (operator sends 'да' / 'подтверждаю' / '1')
  → task_created + taskId + plannedNextStep.taskType = 'research.run_cycle'
  → strategy.onboard task enqueued

Worker drains
  → strategy.onboard runs (creates StrategyProfile)
  → advanceChatPlan auto-chains research.run_cycle
  → research.run_cycle runs and completes
```

### Key invariants

- **Pending confirm/cancel bypasses the LLM classifier.** When `session.pendingInteraction` is set, the second turn is resolved against the STORED proposal using an exact allow-list only (`да`, `подтверждаю`, `подтвердить`, `1` → confirm; `нет`, `отмена`, `отменить`, `0` → cancel; anything else → `unresolved`, stays parked). The classifier is NOT consulted.
- **Raw strategy text is absent from audit events.** `chat.proposal.created` carries only IDs / task type / expiry — never the message body. The `messageChars` field logs length only. Privacy is asserted in the E2E test (`test/e2e/chat-to-task.test.ts`).
- **`pendingPlanId` is the post-task auto-chain pointer.** It points at the `ChatPlan` that `advanceChatPlan` will consume to enqueue the next task after completion. It is NOT the conversational confirmation pointer — that is `pendingInteraction.proposalId` (cleared on confirm or cancel).
- **Confirmation is idempotent.** A duplicate confirm replays the already-created task's status; it never enqueues a second time.

### Event ordering

For any strategy/research flow the events are guaranteed to appear in this order:

```
chat.proposal.created
chat.proposal.confirmed
chat.task_created
(then worker events: chat.plan.advanced, etc.)
```

### Proposal TTL

`proposalTtlMs` (injected by the app factory) is the confirmation window. Expired proposals return a prompt to re-send the strategy; TTL policy is set at the app layer, not in the handler.

## Response

`200` with a `ChatResponse` discriminated union (`kind`), always echoing `sessionId`:

- `assistant_message` — `{ message, evidence[], actions[], pendingInteractionId? }`. Returned on turn 1 of a strategy/research proposal, and for any static response. `pendingInteractionId` is present only when a proposal awaits confirmation.
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

## Operator RAG (evidence-first retrieval)

### Evidence flow

```
TurnInterpreter (one LLM call)
  -> OperatorRetrievalPlanner
       -> exact fingerprint lookup
       -> structured repository reads
       -> PostgreSQL FTS (lexical, top-50)    ┐ parallel
       -> pgvector similarity search (top-50) ┘
  -> RRF fusion (k=60)
  -> conditional reranker (fail-soft)
  -> EvidencePolicy
  -> evidence-first assistant_message + proposed actions
  -> deterministic confirmation guard
  -> task enqueued (only after explicit confirm)
```

One LLM call interprets the turn. All retrieval and proposal policy is deterministic. No task is created before the operator sends an explicit confirmation.

### Feature flag

`OPERATOR_RAG_ENABLED` (default **false**). When false, `DisabledOperatorRetrieval` is used — it makes zero embedding or database calls and the chat flow works normally, just without similarity evidence. When true, both `DATABASE_URL` and `OPENROUTER_API_KEY` are required.

### Embedding model / dimension lock

Provider: `openrouter`. Model: `baai/bge-m3`. Dimension: **1024**.

Configuration fails closed: if `OPERATOR_EMBEDDING_DIMENSIONS` is set to any value other than 1024, `loadEnv` throws at startup before any request is served. Vectors from different models or normalization rules are never mixed in one active index; changing the model requires a new `OPERATOR_RETRIEVAL_INDEX_VERSION` and a full reindex.

### Deadlines

| Boundary | Meaning |
|---|---|
| **5 s soft** | No new retrieval or model calls are started after this point |
| **10 s hard** | Any remaining in-flight work is aborted; available (possibly degraded) evidence is returned |

A timeout never produces a false "nothing found" result. Partial-source failure becomes an explicit `EvidenceWarning` in the response; the user can decide whether to proceed.

### Operational commands

| Command | Default mode | With `--run` |
|---|---|---|
| `pnpm operator-rag:reindex` | Dry run — scans profiles and reports stale/missing projections | Paid: embeds and upserts each stale projection |
| `pnpm operator-rag:eval` | Dry run — prints eval config and dataset summary | Paid: runs retrieval against the golden dataset and writes reports under `.artifacts/` |

Dry run is the default for both commands; add `--run` to execute the paid/write path.

### Why PostgreSQL FTS is NOT called BM25

v1 uses PostgreSQL built-in `ts_rank_cd` lexical ranking via the `simple` text-search configuration. This is full-text ranking, not BM25. Strict BM25 scoring would require a separate extension or external service and is explicitly out of scope for this version. Do not describe the FTS branch as BM25 in code, docs, or metrics.

### Fingerprint is the only exact-duplicate authority

Fingerprint lookup (`StrategyProfileRepository.findByFingerprint`) is the sole mechanism that may declare two strategies identical. Semantic similarity results from RRF or the reranker are always labelled "similar" — never "the same". This rule is enforced by `EvidencePolicy` and asserted in integration tests.
