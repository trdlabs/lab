---
name: gortex-adapters-platform-5-dirs
description: "Work in the adapters/platform +5 dirs area — 69 symbols across 13 files (86% cohesion)"
---

# adapters/platform +5 dirs

69 symbols | 13 files | 86% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/platform/http-backtester.adapter.ts`
- `src/adapters/platform/mcp-research-platform.adapter.test.ts`
- `src/adapters/platform/mcp-research-platform.adapter.ts`
- `src/adapters/platform/mcp-research-transport.ts`
- `src/adapters/platform/mock-research-platform.adapter.ts`
- `src/adapters/read/in-memory-agent-event-read.adapter.ts`
- `src/adapters/read/in-memory-agent-event-stream.ts`
- `src/adapters/read/pg-notify-agent-event-stream.ts`
- `src/domain/module-bundle.ts`
- `src/ingress/server.ts`
- `src/ports/agent-event-read.port.ts`
- `src/ports/agent-event-stream.port.ts`
- `src/worker/worker.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/platform/http-backtester.adapter.ts` | bundle |
| `src/adapters/platform/mcp-research-platform.adapter.test.ts` | close |
| `src/adapters/platform/mcp-research-platform.adapter.ts` | connect, acceptedContractVersion, validateModule, session, getRunStatus, ... |
| `src/adapters/platform/mcp-research-transport.ts` | close |
| `src/adapters/platform/mock-research-platform.adapter.ts` | submitOverlayRun, opts, _bundle, runId |
| `src/adapters/read/in-memory-agent-event-read.adapter.ts` | id, t, q, list, rows |
| `src/adapters/read/in-memory-agent-event-stream.ts` | onEvent, subscribe, start, subs, stop, ... |
| `src/adapters/read/pg-notify-agent-event-stream.ts` | connect, stopped, draining, PgNotifyAgentEventStream, start, ... |
| `src/domain/module-bundle.ts` | ModuleBundle |
| `src/ingress/server.ts` | shutdown |
| `src/ports/agent-event-read.port.ts` | AgentEventListQuery |
| `src/ports/agent-event-stream.port.ts` | AgentEventStreamPort |
| `src/worker/worker.ts` | shutdown |

## Connected Communities

- **adapters/read +3 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-52"
smart_context with task: "understand adapters/platform +5 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
