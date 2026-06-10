---
name: gortex-validation-validatehypothesis
description: "Work in the validation · validateHypothesis area — 20 symbols across 2 files (98% cohesion)"
---

# validation · validateHypothesis

20 symbols | 2 files | 98% cohesion

## When to Use

Use this skill when working on files in:
- `src/validation/hypothesis-validator.ts`
- `src/validation/validator.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/validation/hypothesis-validator.ts` | ctx, issues, lookaheadHits, normalizedFeatures, draft, ... |
| `src/validation/validator.ts` | schema, validateWithSchema, issues, input, compareStrings, ... |

## Entry Points

- `src/validation/hypothesis-validator.ts::validateHypothesis`
- `src/validation/validator.ts::validateWithSchema`

## How to Explore

```
get_communities with id: "community-51"
smart_context with task: "understand validation · validateHypothesis", format: "gcx"
find_usages with id: "src/validation/hypothesis-validator.ts::validateHypothesis", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
