---
name: gortex-chat-2-dirs
description: "Work in the chat +2 dirs area — 71 symbols across 10 files (93% cohesion)"
---

# chat +2 dirs

71 symbols | 10 files | 93% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-chat-session.repository.test.ts`
- `src/adapters/repository/drizzle-research-task.repository.ts`
- `src/adapters/repository/in-memory-chat-session.repository.test.ts`
- `src/chat/guard.test.ts`
- `src/chat/guard.ts`
- `src/chat/intent.ts`
- `src/chat/ref-resolver.test.ts`
- `src/chat/ref-resolver.ts`
- `src/chat/response.ts`
- `src/ports/chat-session.repository.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-chat-session.repository.test.ts` | over, ctx |
| `src/adapters/repository/drizzle-research-task.repository.ts` | rows, id, findById |
| `src/adapters/repository/in-memory-chat-session.repository.test.ts` | ctx, over |
| `src/chat/guard.test.ts` | session, over |
| `src/chat/guard.ts` | kind, sid, PlanArgs, text, t, ... |
| `src/chat/intent.ts` | AllowedIntent |
| `src/chat/ref-resolver.test.ts` | over, session, deps |
| `src/chat/ref-resolver.ts` | t, resolveBuildableHypothesis, deps, t, deps, ... |
| `src/chat/response.ts` | taskStatus, outOfScope, sessionId, sessionId, question, ... |
| `src/ports/chat-session.repository.ts` | ChatSessionContext |

## Entry Points

- `src/chat/guard.ts::planChatAction`

## Connected Communities

- **adapters/repository +1 dirs · toDomain** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-128"
smart_context with task: "understand chat +2 dirs", format: "gcx"
find_usages with id: "src/chat/guard.ts::planChatAction", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
