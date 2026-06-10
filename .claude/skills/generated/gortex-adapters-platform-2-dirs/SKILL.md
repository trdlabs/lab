---
name: gortex-adapters-platform-2-dirs
description: "Work in the adapters/platform +2 dirs area — 17 symbols across 4 files (84% cohesion)"
---

# adapters/platform +2 dirs

17 symbols | 4 files | 84% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/platform/fixture-platform-gateway.adapter.ts`
- `src/adapters/platform/mock-platform-gateway.adapter.ts`
- `src/domain/types.ts`
- `src/ports/platform-gateway.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/platform/fixture-platform-gateway.adapter.ts` | getBacktestResult, submitBacktest, req, ref |
| `src/adapters/platform/mock-platform-gateway.adapter.ts` | _tsOrWindow, _symbol, getMarketRegime, getBacktestResult, req, ... |
| `src/domain/types.ts` | BacktestRunRef |
| `src/ports/platform-gateway.port.ts` | ResearchRunEnvelope, BacktestRunRequest, PlatformGatewayPort |

## How to Explore

```
get_communities with id: "community-14"
smart_context with task: "understand adapters/platform +2 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
