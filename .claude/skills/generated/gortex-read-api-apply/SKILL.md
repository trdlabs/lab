---
name: gortex-read-api-apply
description: "Work in the read-api · apply area — 29 symbols across 3 files (87% cohesion)"
---

# read-api · apply

29 symbols | 3 files | 87% cohesion

## When to Use

Use this skill when working on files in:
- `src/read-api/agent-taxonomy.ts`
- `src/read-api/dto.ts`
- `src/read-api/projection.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/read-api/agent-taxonomy.ts` | type, agentIdForType, rule, prefix, AgentId, ... |
| `src/read-api/dto.ts` | AgentActivityDto |
| `src/read-api/projection.ts` | s, s, freshIdle, dto, cursor, ... |

## Entry Points

- `src/read-api/projection.ts::AgentActivityProjection.apply`

## Connected Communities

- **read-api · framesForEvent** (1 cross-edges)
- **read-api · toAgentEventDto** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-214"
smart_context with task: "understand read-api · apply", format: "gcx"
find_usages with id: "src/read-api/projection.ts::AgentActivityProjection.apply", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
