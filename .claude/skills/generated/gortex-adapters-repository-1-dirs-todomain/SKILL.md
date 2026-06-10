---
name: gortex-adapters-repository-1-dirs-todomain
description: "Work in the adapters/repository +1 dirs · toDomain area — 30 symbols across 6 files (84% cohesion)"
---

# adapters/repository +1 dirs · toDomain

30 symbols | 6 files | 84% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-agent-event.repository.ts`
- `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts`
- `src/adapters/repository/drizzle-hypothesis-review.repository.ts`
- `src/adapters/repository/drizzle-research-task.repository.ts`
- `src/adapters/repository/drizzle-strategy-profile.repository.ts`
- `src/db/client.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-agent-event.repository.ts` | db, constructor |
| `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts` | findById, rows, id |
| `src/adapters/repository/drizzle-hypothesis-review.repository.ts` | row, toDomain |
| `src/adapters/repository/drizzle-research-task.repository.ts` | findByDedupeKey, create, task, findById, constructor, ... |
| `src/adapters/repository/drizzle-strategy-profile.repository.ts` | fp, id, rows, constructor, findById, ... |
| `src/db/client.ts` | Db |

## Entry Points

- `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts::DrizzleHypothesisProposalRepository.findById`
- `src/adapters/repository/drizzle-strategy-profile.repository.ts::DrizzleStrategyProfileRepository.findById`
- `src/adapters/repository/drizzle-research-task.repository.ts::DrizzleResearchTaskRepository.findByDedupeKey`
- `src/adapters/repository/drizzle-research-task.repository.ts::DrizzleResearchTaskRepository.findById`
- `src/adapters/repository/drizzle-strategy-profile.repository.ts::DrizzleStrategyProfileRepository.findByFingerprint`

## How to Explore

```
get_communities with id: "community-23"
smart_context with task: "understand adapters/repository +1 dirs · toDomain", format: "gcx"
find_usages with id: "src/adapters/repository/drizzle-hypothesis-proposal.repository.ts::DrizzleHypothesisProposalRepository.findById", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
