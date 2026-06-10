---
name: gortex-adapters-queue-1-dirs-bullmqqueueadapter
description: "Work in the adapters/queue +1 dirs · BullMqQueueAdapter area — 12 symbols across 2 files (83% cohesion)"
---

# adapters/queue +1 dirs · BullMqQueueAdapter

12 symbols | 2 files | 83% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/queue/bullmq-queue.adapter.ts`
- `src/ports/task-queue.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/queue/bullmq-queue.adapter.ts` | handler, worker, redisOpts, BullMqQueueAdapter, opts, ... |
| `src/ports/task-queue.port.ts` | QueueHandler |

## How to Explore

```
get_communities with id: "community-15"
smart_context with task: "understand adapters/queue +1 dirs · BullMqQueueAdapter", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
