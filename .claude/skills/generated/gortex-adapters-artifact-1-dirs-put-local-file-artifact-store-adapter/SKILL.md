---
name: gortex-adapters-artifact-1-dirs-put-local-file-artifact-store-adapter
description: "Work in the adapters/artifact +1 dirs · put · local-file-artifact-store.adapter area — 16 symbols across 2 files (86% cohesion)"
---

# adapters/artifact +1 dirs · put · local-file-artifact-store.adapter

16 symbols | 2 files | 86% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/artifact/local-file-artifact-store.adapter.ts`
- `src/domain/types.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/artifact/local-file-artifact-store.adapter.ts` | content, ref, hex, baseDir, LocalFileArtifactStore, ... |
| `src/domain/types.ts` | ArtifactRef |

## Entry Points

- `src/adapters/artifact/local-file-artifact-store.adapter.ts::LocalFileArtifactStore.put`

## How to Explore

```
get_communities with id: "community-10"
smart_context with task: "understand adapters/artifact +1 dirs · put · local-file-artifact-store.adapter", format: "gcx"
find_usages with id: "src/adapters/artifact/local-file-artifact-store.adapter.ts::LocalFileArtifactStore.put", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
