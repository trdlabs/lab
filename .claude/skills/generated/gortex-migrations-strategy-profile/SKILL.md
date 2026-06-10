---
name: gortex-migrations-strategy-profile
description: "Work in the migrations · strategy_profile area — 15 symbols across 1 files (100% cohesion)"
---

# migrations · strategy_profile

15 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `migrations/0001_flawless_snowbird.sql`

## Key Files

| File | Symbols |
|------|---------|
| `migrations/0001_flawless_snowbird.sql` | contract_version, profile, created_at, source_artifact_ref, source_kind, ... |

## How to Explore

```
get_communities with id: "community-4"
smart_context with task: "understand migrations · strategy_profile", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
