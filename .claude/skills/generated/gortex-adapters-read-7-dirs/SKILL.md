---
name: gortex-adapters-read-7-dirs
description: "Work in the adapters/read +7 dirs area — 38 symbols across 13 files (87% cohesion)"
---

# adapters/read +7 dirs

38 symbols | 13 files | 87% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/read/drizzle-hypothesis-read.adapter.ts`
- `src/adapters/read/in-memory-hypothesis-read.adapter.test.ts`
- `src/adapters/read/in-memory-hypothesis-read.adapter.ts`
- `src/adapters/repository/drizzle-hypothesis.repository.test.ts`
- `src/adapters/repository/in-memory-hypothesis-proposal.repository.test.ts`
- `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts`
- `src/chat/guard.test.ts`
- `src/chat/ref-resolver.test.ts`
- `src/domain/hypothesis.ts`
- `src/orchestrator/handlers/hypothesis-build.handler.test.ts`
- `src/read-api/mappers.test.ts`
- `src/read-api/read-app.test.ts`
- `test/e2e/hypothesis-build.test.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/read/drizzle-hypothesis-read.adapter.ts` | toDomain, row |
| `src/adapters/read/in-memory-hypothesis-read.adapter.test.ts` | id, over, hyp, now |
| `src/adapters/read/in-memory-hypothesis-read.adapter.ts` | cmpDesc, a, b |
| `src/adapters/repository/drizzle-hypothesis.repository.test.ts` | id, fp, status, hyp |
| `src/adapters/repository/in-memory-hypothesis-proposal.repository.test.ts` | profileId, hyp, fp, id |
| `src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.test.ts` | hyp, thesis, id |
| `src/chat/guard.test.ts` | validatedHyp, id, profileId |
| `src/chat/ref-resolver.test.ts` | status, hyp, id, profileId |
| `src/domain/hypothesis.ts` | HypothesisProposal |
| `src/orchestrator/handlers/hypothesis-build.handler.test.ts` | hypothesis, now |
| `src/read-api/mappers.test.ts` | over, hyp |
| `src/read-api/read-app.test.ts` | createdAt, id, hyp |
| `test/e2e/hypothesis-build.test.ts` | hypothesis, over, now |

## How to Explore

```
get_communities with id: "community-89"
smart_context with task: "understand adapters/read +7 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
