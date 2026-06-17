---
name: gortex-adapters-platform-2-dirs-fixtureplatformgatewayadapter
description: "Work in the adapters/platform +2 dirs · FixturePlatformGatewayAdapter area — 38 symbols across 4 files (92% cohesion)"
---

# adapters/platform +2 dirs · FixturePlatformGatewayAdapter

38 symbols | 4 files | 92% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/platform/fixture-platform-gateway.adapter.ts`
- `src/adapters/platform/mock-platform-gateway.adapter.ts`
- `src/domain/types.ts`
- `src/ports/platform-gateway.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/platform/fixture-platform-gateway.adapter.ts` | getMarketContext, T, fixtureDir, getBacktestResult, FixturePlatformGatewayAdapter, ... |
| `src/adapters/platform/mock-platform-gateway.adapter.ts` | getMarketRegime, submitBacktest, MockPlatformGatewayAdapter, req, getMarketContext, ... |
| `src/domain/types.ts` | BacktestRunRef |
| `src/ports/platform-gateway.port.ts` | ResearchRunEnvelope, ComparisonSummary, BacktestRunRequest, PlatformGatewayPort, MarketRegime, ... |

## How to Explore

```
get_communities with id: "community-37"
smart_context with task: "understand adapters/platform +2 dirs · FixturePlatformGatewayAdapter", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
