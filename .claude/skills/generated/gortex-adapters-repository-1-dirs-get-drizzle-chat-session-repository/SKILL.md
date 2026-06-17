---
name: gortex-adapters-repository-1-dirs-get-drizzle-chat-session-repository
description: "Work in the adapters/repository +1 dirs · get · drizzle-chat-session.repository area — 30 symbols across 9 files (81% cohesion)"
---

# adapters/repository +1 dirs · get · drizzle-chat-session.repository

30 symbols | 9 files | 81% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-chat-session.repository.ts`
- `src/adapters/repository/in-memory-backtest-run.repository.ts`
- `src/adapters/repository/in-memory-chat-plan.repository.ts`
- `src/adapters/repository/in-memory-evaluation.repository.ts`
- `src/adapters/repository/in-memory-hypothesis-build.repository.ts`
- `src/adapters/repository/in-memory-hypothesis-proposal.repository.ts`
- `src/adapters/repository/in-memory-research-task.repository.ts`
- `src/adapters/repository/in-memory-strategy-profile.repository.ts`
- `src/ports/research-task.repository.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-chat-session.repository.ts` | sessionId, get, rows |
| `src/adapters/repository/in-memory-backtest-run.repository.ts` | findById, id |
| `src/adapters/repository/in-memory-chat-plan.repository.ts` | findById, id, found |
| `src/adapters/repository/in-memory-evaluation.repository.ts` | id, findById |
| `src/adapters/repository/in-memory-hypothesis-build.repository.ts` | findById, id |
| `src/adapters/repository/in-memory-hypothesis-proposal.repository.ts` | findById, id |
| `src/adapters/repository/in-memory-research-task.repository.ts` | existing, findByDedupeKey, t, updateStatus, id, ... |
| `src/adapters/repository/in-memory-strategy-profile.repository.ts` | findById, id |
| `src/ports/research-task.repository.ts` | ResearchTaskRepository |

## Connected Communities

- **adapters/repository +1 dirs · toDomain** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-106"
smart_context with task: "understand adapters/repository +1 dirs · get · drizzle-chat-session.repository", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
