# CLAUDE.md

## Ecosystem (trdlabs)

This repository is part of the `trdlabs` trading ecosystem.

**Before planning or coding, read `../control-center/` when the task involves:**
- other repositories, system architecture, or integration boundaries
- API, MCP, SDK, or contract changes
- rollout, migration, or cross-repo validation
- local development, Docker, running the full ecosystem stack, or mock-platform data intervals
- fetching a new VPS snapshot and making it the ecosystem default fixture

**Read order when triggered:**
1. `../control-center/repos.yaml`
2. `../control-center/AGENTS.md`
3. `../control-center/repos/trading-lab.md`
4. `../control-center/docs/operations/local-development.md` when starting or debugging the local stack
5. `../control-center/docs/operations/mock-platform-data.md` when historical intervals (1m/1h/1d) or mock fixtures matter
6. `../control-center/docs/operations/mock-platform-snapshot-rollout.md` when ingesting a VPS slice or changing the default fixture across repos
7. `../control-center/ecosystem-defaults.yaml` and skill `mock-snapshot-default-rollout` when making a VPS slice the ecosystem default

If `../control-center` is absent (standalone clone), use local repo docs only.

Repository-specific commands and boundaries: `AGENTS.md` in this repository.

<!-- gortex:communities:start -->
<!-- gortex:skills:start -->
## Community Skills

| Area | Description | Skill |
|------|-------------|-------|
| Orchestrator Handlers 4 Dirs | 197 symbols | `/gortex-orchestrator-handlers-4-dirs` |
| Adapters Platform 1 Dirs Runbacktestprobe | 82 symbols | `/gortex-adapters-platform-1-dirs-runbacktestprobe` |
| Chat 2 Dirs | 71 symbols | `/gortex-chat-2-dirs` |
| Adapters Platform 5 Dirs | 69 symbols | `/gortex-adapters-platform-5-dirs` |
| Adapters Repository 1 Dirs Todomain | 62 symbols | `/gortex-adapters-repository-1-dirs-todomain` |
| Experiments Intent Classifier Runonce | 59 symbols | `/gortex-experiments-intent-classifier-runonce` |
| Adapters Read 3 Dirs | 52 symbols | `/gortex-adapters-read-3-dirs` |
| Experiments Intent Classifier Renderreport | 46 symbols | `/gortex-experiments-intent-classifier-renderreport` |
| Scripts Main Intent Classifier Eval | 44 symbols | `/gortex-scripts-main-intent-classifier-eval` |
| Chat Handlechatmessage | 41 symbols | `/gortex-chat-handlechatmessage` |
| Experiments Strategy Analyst Runonce | 39 symbols | `/gortex-experiments-strategy-analyst-runonce` |
| Adapters Platform 2 Dirs Fixtureplatformgatewayadapter | 38 symbols | `/gortex-adapters-platform-2-dirs-fixtureplatformgatewayadapter` |
| Adapters Read 7 Dirs | 38 symbols | `/gortex-adapters-read-7-dirs` |
| Ports 2 Dirs | 33 symbols | `/gortex-ports-2-dirs` |
| Migrations Backtest Run | 33 symbols | `/gortex-migrations-backtest-run` |
| Orchestrator Handlers 6 Dirs Researchtask | 32 symbols | `/gortex-orchestrator-handlers-6-dirs-researchtask` |
| Experiments Strategy Analyst Scoreprofile | 31 symbols | `/gortex-experiments-strategy-analyst-scoreprofile` |
| Adapters Researcher 3 Dirs | 30 symbols | `/gortex-adapters-researcher-3-dirs` |
| Adapters Repository 1 Dirs Get Drizzle Chat Session Repository | 30 symbols | `/gortex-adapters-repository-1-dirs-get-drizzle-chat-session-repository` |
| Adapters Platform 2 Dirs Getrunresult | 29 symbols | `/gortex-adapters-platform-2-dirs-getrunresult` |
<!-- gortex:skills:end -->

<!-- gortex:communities:end -->
