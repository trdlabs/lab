---
name: gortex-experiments-intent-classifier-renderreport
description: "Work in the experiments/intent-classifier · renderReport area — 46 symbols across 4 files (94% cohesion)"
---

# experiments/intent-classifier · renderReport

46 symbols | 4 files | 94% cohesion

## When to Use

Use this skill when working on files in:
- `src/experiments/intent-classifier/fixtures.ts`
- `src/experiments/intent-classifier/report.ts`
- `src/experiments/intent-classifier/scoring.test.ts`
- `src/experiments/intent-classifier/types.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/experiments/intent-classifier/fixtures.ts` | fingerprintCases, cases |
| `src/experiments/intent-classifier/report.ts` | schemaInvalidButRight, cases, cases, c, r, ... |
| `src/experiments/intent-classifier/scoring.test.ts` | over, evalCase |
| `src/experiments/intent-classifier/types.ts` | EvalCase, EvalRunResult, ManifestMeta |

## Entry Points

- `src/experiments/intent-classifier/report.ts::renderReport`

## Connected Communities

- **experiments/intent-classifier · rankAggregates** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-153"
smart_context with task: "understand experiments/intent-classifier · renderReport", format: "gcx"
find_usages with id: "src/experiments/intent-classifier/report.ts::renderReport", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
