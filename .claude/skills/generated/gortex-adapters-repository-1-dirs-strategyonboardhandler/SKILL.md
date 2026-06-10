---
name: gortex-adapters-repository-1-dirs-strategyonboardhandler
description: "Work in the adapters/repository +1 dirs · strategyOnboardHandler area — 17 symbols across 2 files (78% cohesion)"
---

# adapters/repository +1 dirs · strategyOnboardHandler

17 symbols | 2 files | 78% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/in-memory-agent-event.repository.ts`
- `src/orchestrator/handlers/strategy-onboard.handler.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/in-memory-agent-event.repository.ts` | append, event |
| `src/orchestrator/handlers/strategy-onboard.handler.ts` | input, fingerprint, strategyOnboardHandler, profileOut, services, ... |

## Entry Points

- `src/orchestrator/handlers/strategy-onboard.handler.ts::strategyOnboardHandler`

## How to Explore

```
get_communities with id: "community-45"
smart_context with task: "understand adapters/repository +1 dirs · strategyOnboardHandler", format: "gcx"
find_usages with id: "src/orchestrator/handlers/strategy-onboard.handler.ts::strategyOnboardHandler", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
