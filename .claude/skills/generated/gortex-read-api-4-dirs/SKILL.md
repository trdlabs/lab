---
name: gortex-read-api-4-dirs
description: "Work in the read-api +4 dirs area — 35 symbols across 10 files (81% cohesion)"
---

# read-api +4 dirs

35 symbols | 10 files | 81% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/read/in-memory-backtest-read.adapter.test.ts`
- `src/adapters/read/in-memory-backtest-read.adapter.ts`
- `src/adapters/repository/in-memory-backtest-run.repository.test.ts`
- `src/adapters/repository/in-memory-backtest-run.repository.ts`
- `src/domain/backtest-run.ts`
- `src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts`
- `src/orchestrator/handlers/resume-platform-backtest.test.ts`
- `src/read-api/dto.ts`
- `src/read-api/mappers.test.ts`
- `src/read-api/mappers.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/read/in-memory-backtest-read.adapter.test.ts` | over, run, id, now |
| `src/adapters/read/in-memory-backtest-read.adapter.ts` | b, cmpDesc, a |
| `src/adapters/repository/in-memory-backtest-run.repository.test.ts` | id, run, over, now |
| `src/adapters/repository/in-memory-backtest-run.repository.ts` | createSubmitted, r, run |
| `src/domain/backtest-run.ts` | BacktestRun |
| `src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts` | stub.submitOverlayRun, b, o |
| `src/orchestrator/handlers/resume-platform-backtest.test.ts` | s, over, seed, over, run, ... |
| `src/read-api/dto.ts` | BacktestDto |
| `src/read-api/mappers.test.ts` | over, backtest |
| `src/read-api/mappers.ts` | toBacktestDto, m, b |

## How to Explore

```
get_communities with id: "community-87"
smart_context with task: "understand read-api +4 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
