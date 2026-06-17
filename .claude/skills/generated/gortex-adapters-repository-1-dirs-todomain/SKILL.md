---
name: gortex-adapters-repository-1-dirs-todomain
description: "Work in the adapters/repository +1 dirs · toDomain area — 62 symbols across 9 files (82% cohesion)"
---

# adapters/repository +1 dirs · toDomain

62 symbols | 9 files | 82% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-agent-event.repository.ts`
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
| `src/adapters/repository/drizzle-agent-event.repository.ts` | db, constructor |
| `src/adapters/repository/drizzle-backtest-run.repository.ts` | findById, id, paramsHash, hypothesisId, createSubmitted, ... |
| `src/adapters/repository/drizzle-chat-plan.repository.ts` | rows, rows, findPendingByAfterTaskId, id, afterTaskId, ... |
| `src/adapters/repository/drizzle-chat-session.repository.ts` | toDomain, row |
| `src/adapters/repository/drizzle-evaluation.repository.ts` | db, db, DrizzleEvaluationRepository, rows, constructor, ... |
| `src/adapters/repository/drizzle-hypothesis-build.repository.ts` | rows, id, findById |
| `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts` | rows, strategyProfileId, constructor, db, listFingerprints, ... |
| `src/adapters/repository/drizzle-strategy-profile.repository.ts` | findById, rows, id |
| `src/db/client.ts` | Db |

## Entry Points

- `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts::DrizzleHypothesisProposalRepository.findLatestValidatedByProfile`
- `src/adapters/repository/drizzle-chat-plan.repository.ts::DrizzleChatPlanRepository.findPendingByAfterTaskId`
- `src/adapters/repository/drizzle-backtest-run.repository.ts::DrizzleBacktestRunRepository.findByIdentity`

## How to Explore

```
get_communities with id: "community-95"
smart_context with task: "understand adapters/repository +1 dirs · toDomain", format: "gcx"
find_usages with id: "src/adapters/repository/drizzle-hypothesis-proposal.repository.ts::DrizzleHypothesisProposalRepository.findLatestValidatedByProfile", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
