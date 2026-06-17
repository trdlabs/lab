---
name: gortex-ports-2-dirs
description: "Work in the ports +2 dirs area — 33 symbols across 4 files (96% cohesion)"
---

# ports +2 dirs

33 symbols | 4 files | 96% cohesion

## When to Use

Use this skill when working on files in:
- `src/composition.ts`
- `src/mastra/compose-mastra.ts`
- `src/ports/builder.port.ts`
- `src/ports/critic.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/composition.ts` | rt, buildAnalyst, rt, queue, buildIntentClassifier, ... |
| `src/mastra/compose-mastra.ts` | MastraRuntime |
| `src/ports/builder.port.ts` | BuilderPort |
| `src/ports/critic.port.ts` | CriticPort |

## Entry Points

- `src/composition.ts::composeRuntime`

## How to Explore

```
get_communities with id: "community-129"
smart_context with task: "understand ports +2 dirs", format: "gcx"
find_usages with id: "src/composition.ts::composeRuntime", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
