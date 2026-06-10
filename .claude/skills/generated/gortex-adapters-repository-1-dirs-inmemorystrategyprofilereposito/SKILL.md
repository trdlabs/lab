---
name: gortex-adapters-repository-1-dirs-inmemorystrategyprofilereposito
description: "Work in the adapters/repository +1 dirs · InMemoryStrategyProfileReposito… area — 11 symbols across 2 files (92% cohesion)"
---

# adapters/repository +1 dirs · InMemoryStrategyProfileReposito…

11 symbols | 2 files | 92% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/in-memory-strategy-profile.repository.ts`
- `src/ports/strategy-profile.repository.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/in-memory-strategy-profile.repository.ts` | profile, create, InMemoryStrategyProfileRepository, id, p, ... |
| `src/ports/strategy-profile.repository.ts` | StrategyProfileRepository |

## Entry Points

- `src/adapters/repository/in-memory-strategy-profile.repository.ts::InMemoryStrategyProfileRepository.create`

## How to Explore

```
get_communities with id: "community-30"
smart_context with task: "understand adapters/repository +1 dirs · InMemoryStrategyProfileReposito…", format: "gcx"
find_usages with id: "src/adapters/repository/in-memory-strategy-profile.repository.ts::InMemoryStrategyProfileRepository.create", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
