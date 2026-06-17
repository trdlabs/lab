---
name: gortex-experiments-strategy-analyst-runonce
description: "Work in the experiments/strategy-analyst · runOnce area — 39 symbols across 3 files (94% cohesion)"
---

# experiments/strategy-analyst · runOnce

39 symbols | 3 files | 94% cohesion

## When to Use

Use this skill when working on files in:
- `src/experiments/strategy-analyst/eval-harness.test.ts`
- `src/experiments/strategy-analyst/eval-harness.ts`
- `src/experiments/strategy-analyst/types.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/experiments/strategy-analyst/eval-harness.test.ts` | m, m, _input, analystFor, clock, ... |
| `src/experiments/strategy-analyst/eval-harness.ts` | RunEvalDeps, perModel, raw, judgeErr, type, ... |
| `src/experiments/strategy-analyst/types.ts` | CandidateError |

## Entry Points

- `src/experiments/strategy-analyst/eval-harness.ts::runEval`

## Connected Communities

- **experiments/strategy-analyst · aggregateRuns** (1 cross-edges)
- **experiments/strategy-analyst · scoreProfile** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-166"
smart_context with task: "understand experiments/strategy-analyst · runOnce", format: "gcx"
find_usages with id: "src/experiments/strategy-analyst/eval-harness.ts::runEval", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
