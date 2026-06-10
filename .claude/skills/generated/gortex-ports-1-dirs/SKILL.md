---
name: gortex-ports-1-dirs
description: "Work in the ports +1 dirs area — 16 symbols across 3 files (98% cohesion)"
---

# ports +1 dirs

16 symbols | 3 files | 98% cohesion

## When to Use

Use this skill when working on files in:
- `src/composition.ts`
- `src/ports/critic.port.ts`
- `src/ports/strategy-analyst.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/composition.ts` | env, router, hypotheses, db, queue, ... |
| `src/ports/critic.port.ts` | CriticPort |
| `src/ports/strategy-analyst.port.ts` | StrategyAnalystPort |

## Entry Points

- `src/composition.ts::composeRuntime`

## How to Explore

```
get_communities with id: "community-35"
smart_context with task: "understand ports +1 dirs", format: "gcx"
find_usages with id: "src/composition.ts::composeRuntime", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
