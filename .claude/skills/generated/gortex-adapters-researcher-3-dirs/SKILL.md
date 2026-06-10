---
name: gortex-adapters-researcher-3-dirs
description: "Work in the adapters/researcher +3 dirs area — 21 symbols across 6 files (93% cohesion)"
---

# adapters/researcher +3 dirs

21 symbols | 6 files | 93% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/researcher/fake-researcher.test.ts`
- `src/adapters/researcher/fake-researcher.ts`
- `src/adapters/researcher/mastra-researcher.ts`
- `src/domain/hypothesis.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.test.ts`
- `src/ports/researcher.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/researcher/fake-researcher.test.ts` | maxHypotheses, input, profile |
| `src/adapters/researcher/fake-researcher.ts` | model, n, input, propose, FakeResearcher, ... |
| `src/adapters/researcher/mastra-researcher.ts` | result, buildPrompt, input, input, propose, ... |
| `src/domain/hypothesis.ts` | ResearcherOutput |
| `src/orchestrator/handlers/research-run-cycle.handler.test.ts` | stubResearcher, out |
| `src/ports/researcher.port.ts` | ResearcherInput, ResearcherPort |

## Entry Points

- `src/adapters/researcher/mastra-researcher.ts::MastraResearcher.propose`
- `src/adapters/researcher/fake-researcher.ts::FakeResearcher.propose`

## How to Explore

```
get_communities with id: "community-32"
smart_context with task: "understand adapters/researcher +3 dirs", format: "gcx"
find_usages with id: "src/adapters/researcher/mastra-researcher.ts::MastraResearcher.propose", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
