---
name: gortex-adapters-repository-2-dirs-search
description: "Work in the adapters/repository +2 dirs · search area — 19 symbols across 3 files (91% cohesion)"
---

# adapters/repository +2 dirs · search

19 symbols | 3 files | 91% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts`
- `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts`
- `src/domain/hypothesis.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts` | rows, listByStrategyProfile, strategyProfileId |
| `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts` | search, t, query, intersection, strategyProfileId, ... |
| `src/domain/hypothesis.ts` | SimilarHypothesisSummary |

## Entry Points

- `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts::InMemoryLexicalSimilarHypothesisSearch.search`
- `src/adapters/repository/drizzle-hypothesis-proposal.repository.ts::DrizzleHypothesisProposalRepository.listByStrategyProfile`

## How to Explore

```
get_communities with id: "community-34"
smart_context with task: "understand adapters/repository +2 dirs · search", format: "gcx"
find_usages with id: "src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts::InMemoryLexicalSimilarHypothesisSearch.search", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
