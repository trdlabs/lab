---
name: gortex-adapters-repository-4-dirs-researchtask
description: "Work in the adapters/repository +4 dirs · ResearchTask area — 15 symbols across 7 files (89% cohesion)"
---

# adapters/repository +4 dirs · ResearchTask

15 symbols | 7 files | 89% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-research-task.repository.test.ts`
- `src/adapters/repository/in-memory-research-task.repository.test.ts`
- `src/domain/types.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.test.ts`
- `src/orchestrator/handlers/strategy-onboard.handler.test.ts`
- `src/orchestrator/workflow-router.test.ts`
- `src/worker/worker.test.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-research-task.repository.test.ts` | task, over |
| `src/adapters/repository/in-memory-research-task.repository.test.ts` | over, task |
| `src/domain/types.ts` | ResearchTask |
| `src/orchestrator/handlers/research-run-cycle.handler.test.ts` | task, payload |
| `src/orchestrator/handlers/strategy-onboard.handler.test.ts` | payload, task |
| `src/orchestrator/workflow-router.test.ts` | task, over |
| `src/worker/worker.test.ts` | t, researchTasks.create, over, task |

## Entry Points

- `src/adapters/repository/drizzle-research-task.repository.test.ts::task`

## How to Explore

```
get_communities with id: "community-46"
smart_context with task: "understand adapters/repository +4 dirs · ResearchTask", format: "gcx"
find_usages with id: "src/adapters/repository/drizzle-research-task.repository.test.ts::task", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
