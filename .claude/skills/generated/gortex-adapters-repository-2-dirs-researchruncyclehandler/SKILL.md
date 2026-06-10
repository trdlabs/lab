---
name: gortex-adapters-repository-2-dirs-researchruncyclehandler
description: "Work in the adapters/repository +2 dirs · researchRunCycleHandler area — 45 symbols across 5 files (92% cohesion)"
---

# adapters/repository +2 dirs · researchRunCycleHandler

45 symbols | 5 files | 92% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/platform/mock-platform-gateway.adapter.ts`
- `src/adapters/repository/in-memory-hypothesis-proposal.repository.ts`
- `src/adapters/repository/in-memory-hypothesis-review.repository.test.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.test.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/platform/mock-platform-gateway.adapter.ts` | tsOrWindow, getMarketContext, symbol |
| `src/adapters/repository/in-memory-hypothesis-proposal.repository.ts` | strategyProfileId, listFingerprints |
| `src/adapters/repository/in-memory-hypothesis-review.repository.test.ts` | review, hypothesisId, id |
| `src/orchestrator/handlers/research-run-cycle.handler.test.ts` | _in, propose |
| `src/orchestrator/handlers/research-run-cycle.handler.ts` | result, payload, errMsg, review, err, ... |

## Entry Points

- `src/orchestrator/handlers/research-run-cycle.handler.ts::researchRunCycleHandler`
- `src/adapters/repository/in-memory-hypothesis-proposal.repository.ts::InMemoryHypothesisProposalRepository.listFingerprints`

## How to Explore

```
get_communities with id: "community-43"
smart_context with task: "understand adapters/repository +2 dirs · researchRunCycleHandler", format: "gcx"
find_usages with id: "src/orchestrator/handlers/research-run-cycle.handler.ts::researchRunCycleHandler", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
