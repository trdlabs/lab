---
name: gortex-adapters-researcher-3-dirs
description: "Work in the adapters/researcher +3 dirs area — 30 symbols across 7 files (93% cohesion)"
---

# adapters/researcher +3 dirs

30 symbols | 7 files | 93% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/researcher/fake-researcher.test.ts`
- `src/adapters/researcher/fake-researcher.ts`
- `src/adapters/researcher/mastra-researcher.ts`
- `src/domain/hypothesis.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.test.ts`
- `src/ports/bot-results-read.port.ts`
- `src/ports/researcher.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/researcher/fake-researcher.test.ts` | profile, botResults, inputWithBotResults, input, maxHypotheses |
| `src/adapters/researcher/fake-researcher.ts` | propose, adapter, n, hypotheses, input, ... |
| `src/adapters/researcher/mastra-researcher.ts` | input, similar, botPerf, propose, input, ... |
| `src/domain/hypothesis.ts` | ResearcherOutput |
| `src/orchestrator/handlers/research-run-cycle.handler.test.ts` | out, capturingResearcher, cap, inp, port.propose, ... |
| `src/ports/bot-results-read.port.ts` | BotRunResultDetail |
| `src/ports/researcher.port.ts` | ResearcherPort, ResearcherInput |

## How to Explore

```
get_communities with id: "community-113"
smart_context with task: "understand adapters/researcher +3 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
