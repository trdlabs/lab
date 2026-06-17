---
name: gortex-adapters-platform-1-dirs-runbacktestprobe
description: "Work in the adapters/platform +1 dirs · runBacktestProbe area — 82 symbols across 9 files (92% cohesion)"
---

# adapters/platform +1 dirs · runBacktestProbe

82 symbols | 9 files | 92% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/platform/console-agent-event-sink.ts`
- `src/adapters/platform/discovery-probe.ts`
- `src/adapters/platform/http-backtester.adapter.test.ts`
- `src/adapters/platform/http-backtester.adapter.ts`
- `src/adapters/platform/mcp-research-platform.adapter.ts`
- `src/adapters/platform/research-contract.ts`
- `src/adapters/platform/run-probe.ts`
- `src/adapters/platform/validate-probe.ts`
- `src/ports/research-platform.port.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/platform/console-agent-event-sink.ts` | append |
| `src/adapters/platform/discovery-probe.ts` | probeId, err, deps, runDiscoveryProbe, datasets, ... |
| `src/adapters/platform/http-backtester.adapter.test.ts` | listDatasets, getCapabilities |
| `src/adapters/platform/http-backtester.adapter.ts` | _filter, client, datasets, discover, listDatasets, ... |
| `src/adapters/platform/mcp-research-platform.adapter.ts` | listDatasets, options, discover, descriptor, result, ... |
| `src/adapters/platform/research-contract.ts` | assertContractCompatible, ok, expected, descriptor |
| `src/adapters/platform/run-probe.ts` | probeId, outcome, integration, errMsg, comparison, ... |
| `src/adapters/platform/validate-probe.ts` | runValidateProbe, probeId, ValidateProbeDeps, mkEvent, integration, ... |
| `src/ports/research-platform.port.ts` | ResearchPlatformPort |

## Entry Points

- `src/adapters/platform/run-probe.ts::runBacktestProbe`
- `src/adapters/platform/validate-probe.ts::runValidateProbe`
- `src/adapters/platform/discovery-probe.ts::runDiscoveryProbe`

## Connected Communities

- **adapters/platform · toSubmittedBundle** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-65"
smart_context with task: "understand adapters/platform +1 dirs · runBacktestProbe", format: "gcx"
find_usages with id: "src/adapters/platform/run-probe.ts::runBacktestProbe", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
