---
name: gortex-adapters-queue-1-dirs-inmemoryqueueadapter
description: "Work in the adapters/queue +1 dirs · InMemoryQueueAdapter area — 12 symbols across 2 files (86% cohesion)"
---

# adapters/queue +1 dirs · InMemoryQueueAdapter

12 symbols | 2 files | 86% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/queue/in-memory-queue.adapter.ts`
- `src/ports/task-queue.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/queue/in-memory-queue.adapter.ts` | envelope, _opts, enqueue, process, handler, ... |
| `src/ports/task-queue.port.ts` | TaskQueuePort |

## Entry Points

- `src/adapters/queue/in-memory-queue.adapter.ts::InMemoryQueueAdapter.enqueue`

## How to Explore

```
get_communities with id: "community-18"
smart_context with task: "understand adapters/queue +1 dirs · InMemoryQueueAdapter", format: "gcx"
find_usages with id: "src/adapters/queue/in-memory-queue.adapter.ts::InMemoryQueueAdapter.enqueue", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
