---
name: gortex-adapters-repository-2-dirs-hyp
description: "Work in the adapters/repository +2 dirs · hyp area — 14 symbols across 5 files (86% cohesion)"
---

# adapters/repository +2 dirs · hyp

14 symbols | 5 files | 86% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts`
- `src/adapters/repository/drizzle-hypothesis.repository.test.ts`
- `src/adapters/repository/in-memory-hypothesis-proposal.repository.test.ts`
- `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts`
- `src/domain/hypothesis.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts` | toDomain, row |
| `src/adapters/repository/drizzle-hypothesis.repository.test.ts` | id, hyp, fp, status |
| `src/adapters/repository/in-memory-hypothesis-proposal.repository.test.ts` | id, profileId, fp, hyp |
| `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts` | thesis, id, hyp |
| `src/domain/hypothesis.ts` | HypothesisProposal |

## Entry Points

- `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts::toDomain`

## How to Explore

```
get_communities with id: "community-26"
smart_context with task: "understand adapters/repository +2 dirs · hyp", format: "gcx"
find_usages with id: "src/adapters/repository/drizzle-hypothesis-proposal.repository.ts::toDomain", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
