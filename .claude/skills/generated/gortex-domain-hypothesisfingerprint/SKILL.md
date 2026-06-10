---
name: gortex-domain-hypothesisfingerprint
description: "Work in the domain · hypothesisFingerprint area — 21 symbols across 3 files (100% cohesion)"
---

# domain · hypothesisFingerprint

21 symbols | 3 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `src/domain/fingerprint.ts`
- `src/domain/hypothesis.ts`
- `src/domain/strategy-source.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/domain/fingerprint.ts` | sep, canonical, sourceFingerprint, content, canonicalizeContent, ... |
| `src/domain/hypothesis.ts` | value, RuleAction, ruleAction, hex, sep, ... |
| `src/domain/strategy-source.ts` | SourceKind |

## Entry Points

- `src/domain/hypothesis.ts::hypothesisFingerprint`
- `src/domain/fingerprint.ts::sourceFingerprint`
- `src/domain/hypothesis.ts::stableStringify`

## How to Explore

```
get_communities with id: "community-39"
smart_context with task: "understand domain · hypothesisFingerprint", format: "gcx"
find_usages with id: "src/domain/hypothesis.ts::hypothesisFingerprint", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
