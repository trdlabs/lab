---
name: gortex-experiments-intent-classifier-runonce
description: "Work in the experiments/intent-classifier · runOnce area — 59 symbols across 4 files (94% cohesion)"
---

# experiments/intent-classifier · runOnce

59 symbols | 4 files | 94% cohesion

## When to Use

Use this skill when working on files in:
- `src/experiments/intent-classifier/eval-harness.test.ts`
- `src/experiments/intent-classifier/eval-harness.ts`
- `src/experiments/intent-classifier/scoring.ts`
- `src/experiments/intent-classifier/types.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/experiments/intent-classifier/eval-harness.test.ts` | classifierFor, providerOf, c, judge, input, ... |
| `src/experiments/intent-classifier/eval-harness.ts` | perModel, RunEvalInput, runs, runEval, judge, ... |
| `src/experiments/intent-classifier/scoring.ts` | threshold, opts, total, intentAccuracy, cases, ... |
| `src/experiments/intent-classifier/types.ts` | CandidateError |

## Entry Points

- `src/experiments/intent-classifier/eval-harness.ts::runEval`
- `src/experiments/intent-classifier/eval-harness.ts::runOnce`

## Connected Communities

- **experiments/intent-classifier · scoreCase** (1 cross-edges)
- **experiments/intent-classifier · aggregateRuns** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-149"
smart_context with task: "understand experiments/intent-classifier · runOnce", format: "gcx"
find_usages with id: "src/experiments/intent-classifier/eval-harness.ts::runEval", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
