---
name: gortex-adapters-platform-1-dirs
description: "Work in the adapters/platform +1 dirs area — 15 symbols across 2 files (87% cohesion)"
---

# adapters/platform +1 dirs

15 symbols | 2 files | 87% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/platform/fixture-platform-gateway.adapter.ts`
- `src/ports/platform-gateway.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/platform/fixture-platform-gateway.adapter.ts` | _symbol, getMarketRegime, T, fixtureDir, name, ... |
| `src/ports/platform-gateway.port.ts` | MarketRegime, MarketContext |

## How to Explore

```
get_communities with id: "community-13"
smart_context with task: "understand adapters/platform +1 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
