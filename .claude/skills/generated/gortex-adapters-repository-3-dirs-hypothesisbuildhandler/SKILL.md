---
name: gortex-adapters-repository-3-dirs-hypothesisbuildhandler
description: "Work in the adapters/repository +3 dirs · hypothesisBuildHandler area — 165 symbols across 15 files (90% cohesion)"
---

# adapters/repository +3 dirs · hypothesisBuildHandler

165 symbols | 15 files | 90% cohesion

## When to Use

Use this skill when working on files in:
- `src/adapters/repository/drizzle-backtest-run.repository.ts`
- `src/adapters/repository/drizzle-evaluation.repository.ts`
- `src/adapters/repository/drizzle-hypothesis-build.repository.ts`
- `src/adapters/repository/in-memory-agent-event.repository.ts`
- `src/adapters/repository/in-memory-backtest-run.repository.ts`
- `src/adapters/repository/in-memory-hypothesis-proposal.repository.ts`
- `src/adapters/repository/in-memory-hypothesis-review.repository.test.ts`
- `src/orchestrator/app-services.ts`
- `src/orchestrator/handlers/backtest-support.ts`
- `src/orchestrator/handlers/hypothesis-build.handler.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.test.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.ts`
- `src/orchestrator/handlers/resume-platform-backtest.ts`
- `src/orchestrator/handlers/run-platform-backtest.ts`
- `test/support/make-services.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-backtest-run.repository.ts` | id, id, markRejected, c, markCompleted |
| `src/adapters/repository/drizzle-evaluation.repository.ts` | listByBacktestRun, rows, backtestRunId |
| `src/adapters/repository/drizzle-hypothesis-build.repository.ts` | markBuildFailed, id, id, markSubmitted, issues |
| `src/adapters/repository/in-memory-agent-event.repository.ts` | event, append |
| `src/adapters/repository/in-memory-backtest-run.repository.ts` | listResumablePlatformRuns |
| `src/adapters/repository/in-memory-hypothesis-proposal.repository.ts` | listFingerprints, strategyProfileId |
| `src/adapters/repository/in-memory-hypothesis-review.repository.test.ts` | hypothesisId, id, review |
| `src/orchestrator/app-services.ts` | AppServices |
| `src/orchestrator/handlers/backtest-support.ts` | stableStringify, platformRun, now, services, c, ... |
| `src/orchestrator/handlers/hypothesis-build.handler.ts` | services, allowedCapabilities, baselineModuleId, hypothesis, err, ... |
| `src/orchestrator/handlers/research-run-cycle.handler.test.ts` | _in, propose |
| `src/orchestrator/handlers/research-run-cycle.handler.ts` | similarHypotheses, drafts, rejected, seen, draft, ... |
| `src/orchestrator/handlers/resume-platform-backtest.ts` | runs, errors, outcomes, result, resumePlatformRun, ... |
| `src/orchestrator/handlers/run-platform-backtest.ts` | runPlatformBacktest, buildId, RunPlatformBacktestInput, handle, opts, ... |
| `test/support/make-services.ts` | overrides, hypotheses, makeServices |

## Entry Points

- `src/orchestrator/handlers/hypothesis-build.handler.ts::hypothesisBuildHandler`
- `src/orchestrator/handlers/research-run-cycle.handler.ts::researchRunCycleHandler`
- `src/orchestrator/handlers/run-platform-backtest.ts::runPlatformBacktest`
- `src/adapters/repository/drizzle-evaluation.repository.ts::DrizzleEvaluationRepository.listByBacktestRun`

## How to Explore

```
get_communities with id: "community-195"
smart_context with task: "understand adapters/repository +3 dirs · hypothesisBuildHandler", format: "gcx"
find_usages with id: "src/orchestrator/handlers/hypothesis-build.handler.ts::hypothesisBuildHandler", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
