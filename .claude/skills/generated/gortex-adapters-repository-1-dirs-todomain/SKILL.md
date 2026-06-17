---
name: gortex-adapters-repository-1-dirs-todomain
description: "Work in the adapters/repository +1 dirs · toDomain area — 53 symbols across 8 files (81% cohesion)"
---

# adapters/repository +1 dirs · toDomain

53 symbols | 8 files | 81% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-backtest-run.repository.ts`
- `src/adapters/repository/drizzle-chat-plan.repository.ts`
- `src/adapters/repository/drizzle-chat-session.repository.ts`
- `src/adapters/repository/drizzle-evaluation.repository.ts`
- `src/adapters/repository/drizzle-hypothesis-build.repository.ts`
- `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts`
- `src/adapters/repository/drizzle-strategy-profile.repository.ts`
- `src/db/client.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-backtest-run.repository.ts` | rows, rows, paramsHash, findByIdentity, bundleHash, ... |
| `src/adapters/repository/drizzle-chat-plan.repository.ts` | findById, id, id, rows, markAdvanced, ... |
| `src/adapters/repository/drizzle-chat-session.repository.ts` | toDomain, row |
| `src/adapters/repository/drizzle-evaluation.repository.ts` | constructor, id, db, db, rows, ... |
| `src/adapters/repository/drizzle-hypothesis-build.repository.ts` | id, findById, rows |
| `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts` | findById, findLatestValidatedByProfile, create, db, strategyProfileId, ... |
| `src/adapters/repository/drizzle-strategy-profile.repository.ts` | rows, findById, id |
| `src/db/client.ts` | Db |

## Entry Points

- `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts::DrizzleHypothesisProposalRepository.findLatestValidatedByProfile`
- `src/adapters/repository/drizzle-backtest-run.repository.ts::DrizzleBacktestRunRepository.findByIdentity`

## How to Explore

```
get_communities with id: "community-97"
smart_context with task: "understand adapters/repository +1 dirs · toDomain", format: "gcx"
find_usages with id: "src/adapters/repository/drizzle-hypothesis-proposal.repository.ts::DrizzleHypothesisProposalRepository.findLatestValidatedByProfile", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
