---
name: gortex-adapters-platform-2-dirs-getrunresult
description: "Work in the adapters/platform +2 dirs · getRunResult area — 29 symbols across 4 files (86% cohesion)"
---

# adapters/platform +2 dirs · getRunResult

29 symbols | 4 files | 86% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/platform/http-backtester.adapter.ts`
- `src/adapters/platform/mcp-research-platform.adapter.ts`
- `src/ports/research-platform.port.ts`
- `src/research/run-backtest.test.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/platform/http-backtester.adapter.ts` | err, at, getRunResult, s, runId, ... |
| `src/adapters/platform/mcp-research-platform.adapter.ts` | result, getRunResult, runId |
| `src/ports/research-platform.port.ts` | RunResultView |
| `src/research/run-backtest.test.ts` | fakePort, statuses, i, result |

## How to Explore

```
get_communities with id: "community-41"
smart_context with task: "understand adapters/platform +2 dirs · getRunResult", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
