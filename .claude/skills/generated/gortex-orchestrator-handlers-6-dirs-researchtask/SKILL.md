---
name: gortex-orchestrator-handlers-6-dirs-researchtask
description: "Work in the orchestrator/handlers +6 dirs · ResearchTask area — 32 symbols across 15 files (90% cohesion)"
---

# orchestrator/handlers +6 dirs · ResearchTask

32 symbols | 15 files | 90% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-research-task.repository.test.ts`
- `src/adapters/repository/in-memory-research-task.repository.test.ts`
- `src/chat/guard.test.ts`
- `src/chat/ref-resolver.test.ts`
- `src/domain/types.ts`
- `src/orchestrator/chain-runner.test.ts`
- `src/orchestrator/handlers/backtest-support.ts`
- `src/orchestrator/handlers/hypothesis-build.handler.test.ts`
- `src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.test.ts`
- `src/orchestrator/handlers/run-platform-backtest.test.ts`
- `src/orchestrator/handlers/strategy-onboard.handler.test.ts`
- `src/orchestrator/workflow-router.test.ts`
- `src/worker/worker.test.ts`
- `test/e2e/hypothesis-build.test.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-research-task.repository.test.ts` | task, over |
| `src/adapters/repository/in-memory-research-task.repository.test.ts` | task, over |
| `src/chat/guard.test.ts` | task, id |
| `src/chat/ref-resolver.test.ts` | task, id |
| `src/domain/types.ts` | ResearchTask |
| `src/orchestrator/chain-runner.test.ts` | onboardTask, id |
| `src/orchestrator/handlers/backtest-support.ts` | task |
| `src/orchestrator/handlers/hypothesis-build.handler.test.ts` | now, task, payload |
| `src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts` | task, payload, now |
| `src/orchestrator/handlers/research-run-cycle.handler.test.ts` | task, payload |
| `src/orchestrator/handlers/run-platform-backtest.test.ts` | task, now |
| `src/orchestrator/handlers/strategy-onboard.handler.test.ts` | task, payload |
| `src/orchestrator/workflow-router.test.ts` | over, task |
| `src/worker/worker.test.ts` | t, task, over, researchTasks.create |
| `test/e2e/hypothesis-build.test.ts` | task, now |

## How to Explore

```
get_communities with id: "community-198"
smart_context with task: "understand orchestrator/handlers +6 dirs · ResearchTask", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
