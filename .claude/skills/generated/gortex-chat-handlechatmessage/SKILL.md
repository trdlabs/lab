---
name: gortex-chat-handlechatmessage
description: "Work in the chat · handleChatMessage area — 41 symbols across 3 files (89% cohesion)"
---

# chat · handleChatMessage

41 symbols | 3 files | 89% cohesion

## When to Use

Use this skill when working on files in:
- `src/chat/chat-handler.ts`
- `src/chat/guard.ts`
- `src/chat/response.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/chat/chat-handler.ts` | sid, now, deps, err, correlationId, ... |
| `src/chat/guard.ts` | raw, parseIntent, v, ParseResult |
| `src/chat/response.ts` | taskType, ChatResponse, message, status, PlannedNextStep, ... |

## Entry Points

- `src/chat/chat-handler.ts::handleChatMessage`

## Connected Communities

- **chat +2 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-123"
smart_context with task: "understand chat · handleChatMessage", format: "gcx"
find_usages with id: "src/chat/chat-handler.ts::handleChatMessage", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
