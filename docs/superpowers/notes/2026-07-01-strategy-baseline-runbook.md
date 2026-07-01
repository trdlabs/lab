# Strategy Baseline lane — real-engine runbook (Slice A / Task 16)

**Date:** 2026-07-01
**Plan:** `docs/superpowers/plans/2026-07-01-strategy-baseline-experiment-lane.md`
**Branch:** `feat/strategy-baseline-experiment-lane`

Runs the Cycle-1 baseline end-to-end on the real `long_oi` strategy: seed the profile → build a standalone strategy bundle → submit `engine:'strategy'` to the real `trading-backtester` over the mock-platform's ~6-day historical slice → read real trades → persist the experiment. **Goal = prove the chain, not a statistically-valid holdout** (the ~6-day slice degrades the holdout to `INCONCLUSIVE` by design — see §5).

---

## 1. Prerequisites

| Need | Why | How |
|---|---|---|
| **Docker daemon reachable via `docker` CLI in the shell** | the backtester runs each `long_oi` (untrusted bundle) run in a `docker run node:24-alpine` sandbox | Docker Desktop → Settings → Resources → WSL Integration → enable for this distro; verify `docker version` works in the WSL shell, then `docker pull node:24-alpine` |
| **Postgres** | lab persists profile / experiment / strategy_backtest_run | `DATABASE_URL=postgres://…`; run `pnpm db:migrate` (migrations incl. `0014`) once |
| **Redis** | `composeRuntime()` wires BullMQ unconditionally (the scripts push no jobs, but the client must construct) | `REDIS_URL=redis://…` |
| **LLM provider + key** | analyst (seed) + strategy builder (trigger) are real LLM calls | `MODEL_PROVIDER=anthropic\|openai\|openrouter` + the matching `*_API_KEY` |
| **Writable artifacts dir** | `LocalFileArtifactStore` | default `.artifacts/` (or set `ARTIFACT_DIR`) |
| **`trading-backtester` sibling repo** | the real engine | `../trading-backtester/apps/backtester` |
| **`trading-mock-platform` sibling** | serves the historical slice the engine simulates over | `../trading-mock-platform` |

> **Known blocker on this dev box (2026-07-02):** the `docker` CLI is **not available in the WSL2 shell** ("could not be found in this WSL 2 distro — activate WSL integration in Docker Desktop"). Until Docker Desktop WSL integration is enabled for this distro, the strategy-bundle run cannot execute here (the engine's per-run `docker run` fails). This is the WSL2 topology gotcha the design anticipated — the backtester must run as a **host process** where `docker` resolves.

---

## 2. Bring up the services

**a. mock-platform** (serves `/historical/rows` over the committed ~6-day fixture `2026-06-12-real-top5`):

```bash
cd ../trading-mock-platform
pnpm install
# start its HTTP server (check its package.json for the exact script; it listens on e.g. :8088)
pnpm start   # note the URL it binds, e.g. http://127.0.0.1:8088
```

**b. trading-backtester as a HOST process** (NOT nested in a container — so its `docker run` hits Docker Desktop natively):

```bash
cd ../trading-backtester/apps/backtester
pnpm install
docker pull node:24-alpine
BACKTESTER_ENABLE_OVERLAY_ENGINE=true \
BACKTESTER_DATA_SOURCE=mock \
BACKTESTER_MOCK_PLATFORM_URL=http://127.0.0.1:8088 \
BACKTESTER_AUTH_TOKEN=dev-token \
pnpm start          # Fastify on 127.0.0.1:8080; auto-runs its in-process worker
```

> **Open item to confirm at run time:** whether `engine:'strategy'` needs its own enable flag (overlay is gated by `BACKTESTER_ENABLE_OVERLAY_ENGINE`). Check `trading-backtester/apps/backtester/src/jobs/submit.ts::validate` for a strategy-engine gate; set whatever it requires. Record the answer here after the first run.

---

## 3. Seed the profile (once)

```bash
cd ../trading-lab
DATABASE_URL=… REDIS_URL=… \
STRATEGY_ANALYST_ADAPTER=mastra MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=… \
STRATEGY_ANALYST_MODEL=anthropic/claude-… \
pnpm tsx scripts/seed-long-oi-profile.mts
# → prints the persisted strategyProfileId (idempotent by sourceFingerprint; re-runs are no-ops)
```

Capture the printed `strategyProfileId`.

---

## 4. Run the baseline (the real chain)

```bash
DATABASE_URL=… REDIS_URL=… \
TRADING_PLATFORM_INTEGRATION=backtester \
BACKTESTER_API_URL=http://127.0.0.1:8080 BACKTESTER_API_TOKEN=dev-token \
BUILDER_ADAPTER=mastra MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=… BUILDER_MODEL=anthropic/claude-… \
STRATEGY_PROFILE_ID=<from step 3> \
pnpm tsx scripts/run-strategy-baseline.mts
# → prints { experimentId, verdict } + per-member { role, tradeCount, strategyBacktestRunId } + sanity metrics
```

`TRADING_PLATFORM_INTEGRATION=backtester` routes BOTH `selectResearchPlatform` (submit) and `selectRunTrades` (trades artifact) to the real `HttpBacktesterAdapter`. The LLM builder is non-deterministic → each run mints a new `bundleHash` → a new experiment (idempotency is per-bundleHash).

---

## 5. Expected outcome & acceptance

- The **sanity** run submits `engine:'strategy'` and executes in a docker sandbox; a completed sanity run yields real `trades` (with `entryTs`/`exitTs`) → its `tradeCount` should be **> 0**.
- On the ~6-day slice, `resolveHoldoutBoundary` returns `mode:'none'` (`minHistoryDays=30`) → the experiment finalizes **`INCONCLUSIVE`** with no train/holdout split. This is the **honest, expected** result — the baseline never reaches `PAPER_CANDIDATE` on short data (§6 of the spec). It proves the chain, not a valid holdout.

**Acceptance (Task 16):** a real run where the **sanity member's `tradeCount` > 0** — proving submit → engine (docker sandbox) → trades artifact (`contentHash`/`page`) → `mapStrategyMetrics` → persisted `strategy_backtest_run` + experiment all work on real data. Verdict `INCONCLUSIVE` is a pass. A full train/holdout split + any `PAPER_CANDIDATE` is a later, ≥30-day, on-server exercise.

---

## 6. Captured run

**Status: PENDING** — not yet executed on this box (docker unavailable in the WSL2 shell, §1). Fill in after the first successful run:

- Date / host:
- `strategyProfileId`:
- strategy `bundleHash`:
- `experimentId`:
- `verdict`: (expected `INCONCLUSIVE` on the 6-day slice)
- sanity `tradeCount`: (acceptance: > 0)
- sanity `metrics` (pnl / sharpe / profit_factor / …):
- `engine:'strategy'` flag needed? (the §2 open item):
- Task-9 note: `getRunTrades` field reads verified correct (`descriptor.contentHash` + `ArtifactPage.page`) — controller-confirmed during implementation, `src/adapters/platform/http-backtester.adapter.ts:433-434`.
