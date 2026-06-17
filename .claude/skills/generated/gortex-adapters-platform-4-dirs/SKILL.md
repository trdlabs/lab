---
name: gortex-adapters-platform-4-dirs
description: "Work in the adapters/platform +4 dirs area — 39 symbols across 10 files (80% cohesion)"
---

# adapters/platform +4 dirs

39 symbols | 10 files | 80% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/platform/http-backtester.adapter.ts`
- `src/adapters/platform/mcp-research-platform.adapter.test.ts`
- `src/adapters/platform/mcp-research-platform.adapter.ts`
- `src/adapters/platform/mcp-research-transport.ts`
- `src/adapters/platform/mock-research-platform.adapter.ts`
- `src/adapters/read/in-memory-agent-event-stream.ts`
- `src/adapters/read/pg-notify-agent-event-stream.ts`
- `src/domain/module-bundle.ts`
- `src/ingress/server.ts`
- `src/worker/worker.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/platform/http-backtester.adapter.ts` | bundle |
| `src/adapters/platform/mcp-research-platform.adapter.test.ts` | close |
| `src/adapters/platform/mcp-research-platform.adapter.ts` | listDatasets, runId, runId, opts, acceptedContractVersion, ... |
| `src/adapters/platform/mcp-research-transport.ts` | close |
| `src/adapters/platform/mock-research-platform.adapter.ts` | runId, submitOverlayRun, opts, _bundle |
| `src/adapters/read/in-memory-agent-event-stream.ts` | stop |
| `src/adapters/read/pg-notify-agent-event-stream.ts` | client, connect, reconnect |
| `src/domain/module-bundle.ts` | ModuleBundle |
| `src/ingress/server.ts` | shutdown |
| `src/worker/worker.ts` | shutdown |

## Connected Communities

- **adapters/read +1 dirs · catchUp** (2 cross-edges)

## How to Explore

```
get_communities with id: "community-52"
smart_context with task: "understand adapters/platform +4 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
