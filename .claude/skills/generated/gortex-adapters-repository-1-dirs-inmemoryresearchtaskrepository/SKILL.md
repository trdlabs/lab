---
name: gortex-adapters-repository-1-dirs-inmemoryresearchtaskrepository
description: "Work in the adapters/repository +1 dirs · InMemoryResearchTaskRepository area — 14 symbols across 2 files (91% cohesion)"
---

# adapters/repository +1 dirs · InMemoryResearchTaskRepository

14 symbols | 2 files | 91% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/in-memory-research-task.repository.ts`
- `src/ports/research-task.repository.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/in-memory-research-task.repository.ts` | findById, create, findByDedupeKey, id, t, ... |
| `src/ports/research-task.repository.ts` | ResearchTaskRepository |

## Entry Points

- `src/adapters/repository/in-memory-research-task.repository.ts::InMemoryResearchTaskRepository.updateStatus`
- `src/adapters/repository/in-memory-research-task.repository.ts::InMemoryResearchTaskRepository.create`

## How to Explore

```
get_communities with id: "community-28"
smart_context with task: "understand adapters/repository +1 dirs · InMemoryResearchTaskRepository", format: "gcx"
find_usages with id: "src/adapters/repository/in-memory-research-task.repository.ts::InMemoryResearchTaskRepository.updateStatus", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
