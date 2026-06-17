---
name: gortex-adapters-read-3-dirs
description: "Work in the adapters/read +3 dirs area — 52 symbols across 11 files (92% cohesion)"
---

# adapters/read +3 dirs

52 symbols | 11 files | 92% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/read/in-memory-agent-event-read.adapter.test.ts`
- `src/adapters/read/in-memory-agent-event-read.adapter.ts`
- `src/adapters/read/in-memory-agent-event-stream.test.ts`
- `src/adapters/read/pg-notify-agent-event-stream.ts`
- `src/ports/agent-event-read.port.ts`
- `src/ports/keyset.ts`
- `src/read-api/pagination.ts`
- `src/read-api/projection.test.ts`
- `src/read-api/routes/agents.test.ts`
- `src/read-api/routes/stream.test.ts`
- `src/read-api/routes/stream.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/read/in-memory-agent-event-read.adapter.test.ts` | id, over, ev |
| `src/adapters/read/in-memory-agent-event-read.adapter.ts` | a, b, cmpAsc |
| `src/adapters/read/in-memory-agent-event-stream.test.ts` | id, row |
| `src/adapters/read/pg-notify-agent-event-stream.ts` | b, isAfter, a |
| `src/ports/agent-event-read.port.ts` | AgentEventRow |
| `src/ports/keyset.ts` | Cursor |
| `src/read-api/pagination.ts` | result, raw, json, decodeCursor, parsed |
| `src/read-api/projection.test.ts` | id, over, ev, type |
| `src/read-api/routes/agents.test.ts` | type, id, ev |
| `src/read-api/routes/stream.test.ts` | app, stream, type, liveCursor, seed, ... |
| `src/read-api/routes/stream.ts` | StreamRouteDeps, emit, registerStreamRoutes, isAfter, deps, ... |

## Entry Points

- `src/read-api/routes/stream.ts::registerStreamRoutes`

## How to Explore

```
get_communities with id: "community-220"
smart_context with task: "understand adapters/read +3 dirs", format: "gcx"
find_usages with id: "src/read-api/routes/stream.ts::registerStreamRoutes", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
