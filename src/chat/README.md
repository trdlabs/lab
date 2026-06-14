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
