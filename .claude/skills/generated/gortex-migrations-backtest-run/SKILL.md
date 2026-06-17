---
name: gortex-migrations-backtest-run
description: "Work in the migrations · backtest_run area — 33 symbols across 1 files (100% cohesion)"
---

# migrations · backtest_run

33 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `migrations/0003_lean_cargill.sql`

## Key Files

| File | Symbols |
|------|---------|
| `migrations/0003_lean_cargill.sql` | platform_run_id, max_drawdown_pct, baseline_module_id, bundle_hash, id, ... |

## How to Explore

```
get_communities with id: "community-1"
smart_context with task: "understand migrations · backtest_run", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
