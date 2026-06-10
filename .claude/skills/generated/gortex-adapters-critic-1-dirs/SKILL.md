---
name: gortex-adapters-critic-1-dirs
description: "Work in the adapters/critic +1 dirs area — 12 symbols across 3 files (96% cohesion)"
---

# adapters/critic +1 dirs

12 symbols | 3 files | 96% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/critic/fake-critic.ts`
- `src/adapters/critic/mastra-critic.ts`
- `src/domain/critic.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/critic/fake-critic.ts` | model, FakeCritic, review, adapter, input |
| `src/adapters/critic/mastra-critic.ts` | buildPrompt, input, input, review, result |
| `src/domain/critic.ts` | CriticOutput, CriticInput |

## Entry Points

- `src/adapters/critic/mastra-critic.ts::MastraCritic.review`

## How to Explore

```
get_communities with id: "community-12"
smart_context with task: "understand adapters/critic +1 dirs", format: "gcx"
find_usages with id: "src/adapters/critic/mastra-critic.ts::MastraCritic.review", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
