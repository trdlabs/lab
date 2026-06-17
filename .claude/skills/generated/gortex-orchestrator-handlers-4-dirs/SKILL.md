---
name: gortex-orchestrator-handlers-4-dirs
description: "Work in the orchestrator/handlers +4 dirs area — 197 symbols across 20 files (90% cohesion)"
---

# orchestrator/handlers +4 dirs

197 symbols | 20 files | 90% cohesion

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
- `src/orchestrator/handlers/hypothesis-build.handler.test.ts`
- `src/orchestrator/handlers/hypothesis-build.handler.ts`
- `src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.test.ts`
- `src/orchestrator/handlers/research-run-cycle.handler.ts`
- `src/orchestrator/handlers/resume-platform-backtest.test.ts`
- `src/orchestrator/handlers/resume-platform-backtest.ts`
- `src/orchestrator/handlers/run-platform-backtest.test.ts`
- `src/orchestrator/handlers/run-platform-backtest.ts`
- `src/ports/hypothesis-build.repository.ts`
- `test/support/make-services.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/adapters/repository/drizzle-backtest-run.repository.ts` | id, c, id, markRejected, markCompleted |
| `src/adapters/repository/drizzle-evaluation.repository.ts` | backtestRunId, create, rows, listByBacktestRun, e |
| `src/adapters/repository/drizzle-hypothesis-build.repository.ts` | db, createGenerating, markBuildFailed, markCandidate, issues, ... |
| `src/adapters/repository/in-memory-agent-event.repository.ts` | event, append |
| `src/adapters/repository/in-memory-backtest-run.repository.ts` | listResumablePlatformRuns, r, createSubmitted, run |
| `src/adapters/repository/in-memory-hypothesis-proposal.repository.ts` | listFingerprints, strategyProfileId |
| `src/adapters/repository/in-memory-hypothesis-review.repository.test.ts` | review, hypothesisId, id |
| `src/orchestrator/app-services.ts` | AppServices |
| `src/orchestrator/handlers/backtest-support.ts` | outcome, err, applyPlatformTerminalOutcome, c, evaluation, ... |
| `src/orchestrator/handlers/hypothesis-build.handler.test.ts` | seeded, s, over |
| `src/orchestrator/handlers/hypothesis-build.handler.ts` | hypothesis, baselineRef, parsed, paramsHash, issues, ... |
| `src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts` | over, now, s, now, hypothesis, ... |
| `src/orchestrator/handlers/research-run-cycle.handler.test.ts` | _in, services, propose, seedProfile |
| `src/orchestrator/handlers/research-run-cycle.handler.ts` | now, err, marketRegime, researchRunCycleHandler, review, ... |
| `src/orchestrator/handlers/resume-platform-backtest.test.ts` | r, task, s, seed, over |
| `src/orchestrator/handlers/resume-platform-backtest.ts` | run, o, fresh, resumePendingPlatformRuns, again, ... |
| `src/orchestrator/handlers/run-platform-backtest.test.ts` | baselineRef, b, bundle, buildId, common, ... |
| `src/orchestrator/handlers/run-platform-backtest.ts` | outcome, now, profile, opts, issues, ... |
| `src/ports/hypothesis-build.repository.ts` | HypothesisBuildRepository |
| `test/support/make-services.ts` | hypotheses, makeServices, overrides |

## Entry Points

- `src/orchestrator/handlers/research-run-cycle.handler.ts::researchRunCycleHandler`
- `src/orchestrator/handlers/hypothesis-build.handler.ts::hypothesisBuildHandler`
- `src/orchestrator/handlers/run-platform-backtest.ts::runPlatformBacktest`
- `src/adapters/repository/drizzle-evaluation.repository.ts::DrizzleEvaluationRepository.listByBacktestRun`

## Connected Communities

- **orchestrator/handlers · computeParamsHash** (4 cross-edges)
- **orchestrator/handlers · run** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-193"
smart_context with task: "understand orchestrator/handlers +4 dirs", format: "gcx"
find_usages with id: "src/orchestrator/handlers/research-run-cycle.handler.ts::researchRunCycleHandler", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
