# Platform handoff prompt — auto-start (host pickup) after paper promotion

> Paste this into the **trading-platform** instance. It owns the implementation; trading-lab consumes the outcome as "the paper run now appears without lab doing anything." (This file lives in trading-lab only as the agreed handoff record, per the convention of [2026-06-30-platform-close-reason-enum-handoff.md](2026-06-30-platform-close-reason-enum-handoff.md).)
>
> Companion doc: [2026-07-03-platform-candidate-run-link-handoff.md](2026-07-03-platform-candidate-run-link-handoff.md) (candidateId/bundleId → bot_run link). Both gaps were found while building trading-lab's `paper.monitor` slice (G4): `docs/superpowers/specs/2026-07-03-paper-monitor-design.md` §2.

## Task: start the paper bot host automatically when a candidate is promoted, instead of requiring a manual/out-of-band `HOST_BOTS` restart

### Why
trading-lab's paper-bridge (G2b) submits a proven WFO champion via `PaperIntakePort.submitProvenCandidate` → platform admits it → `bot_bundle` is created (`bundleId == candidateId`, confirmed in `specs/062-intake-identity/plan.md:31`). At that point the candidate is **admitted but not running**: the paper host only picks up a bundle when it is (re)started with `HOST_BOTS=bundle:<candidateId>` in its env (`src/runtime/host/host_config.ts:57-136`, `parseHostConfig` — `HOST_BOTS` is read once at process start from `env.HOST_BOTS`; there is no dynamic registry the host polls, and a partially-started host is explicitly forbidden — "a partially-started host is forbidden (FR-011)"). Nothing in the promotion path (`admission_smoke.ts` / the intake service) touches the running host process or its env.

trading-lab's `paper.monitor` task (slice G4) is built to be tolerant of this: it polls ops-read for the live run and, if none appears within `PAPER_MONITOR_MAX_WAIT_DAYS` (default 7), it gives up and marks the ledger `stalled` with a `paper.run_not_found` event — no crash, no infinite retry, but also no Cycle 2 trigger, because there is no paper data to observe. Today this means **every** promoted candidate needs someone to manually restart the host with the new bundle in `HOST_BOTS` before the observation window can ever start.

### Investigate first
- What triggers host restarts today in the operated deployment (systemd unit, docker-compose restart policy, a supervisor script)? Whatever mechanism currently regenerates the `HOST_BOTS` value on restart is the natural place to hook a "pick up new admitted bundles" step.
- `parseHostConfig` (`src/runtime/host/host_config.ts:74`) already accepts multiple `bundle:<id>[:suffix]` entries and enforces uniqueness — a running host does not need architectural changes to *host* more bundles, only a way to be told about a new one without a full process restart, or a cheap enough restart path that promotion can trigger.
- 057 (`specs/057-bundle-host-instances/`) already does isolated-vm bundle instantiation at host start; whatever auto-start mechanism is chosen should reuse `resolveBundle` → `materializeBot`, not reimplement bundle loading.

### Two shapes to consider (platform decides)
1. **Promotion-triggered restart**: the admission/promotion path (wherever `bot_bundle` rows for admitted candidates are written) enqueues a host restart/reload with the new bundle appended to `HOST_BOTS` (or a persisted "active bundles" registry the host re-reads on start).
2. **Host-side watcher**: the host polls (or subscribes to) newly-admitted `bot_bundle` rows on an interval and dynamically starts a new bundle instance in-process, without a full restart — closer to a live "add instance" operation on top of 056/057's per-instance instantiation.

Either is acceptable to lab; lab's contract is purely observational (below).

### Acceptance
- A candidate that reaches `admissionStatus: 'admitted'` results in a live `mode: 'paper'` `bot_run` (visible via `/ops/runs?mode=paper`) within a bounded, documented time window — no manual `HOST_BOTS` edit or process restart required by an operator.
- The time-to-live-run bound should be short relative to trading-lab's `PAPER_MONITOR_MAX_WAIT_DAYS` (default 7 days) — ideally minutes, so the monitor's `stalled`/`paper.run_not_found` path only fires for genuine failures, not routine promotion lag.
- Existing manual `HOST_BOTS=bundle:<id>` startup keeps working (backward compatible) for local/dev use.

### NOT in scope
- No change to the intake/admission decision logic itself (smoke-gate 060, admission thresholds) — this is purely "what happens to an already-admitted bundle."
- No change to isolated-vm execution (054) or per-instance resource limits (057).

### Lab-side contract (for reference — how lab bridges this gap today)
trading-lab's `paper.monitor` handler (`src/orchestrator/handlers/paper-monitor.handler.ts`) is written to be tolerant of this gap by design ("tolerant monitor + handoff", not a hard block — user-reviewed decision, spec §2): it locates the live run via `PaperRunLocatorPort.locate({ strategyName, submittedAtMs })` on every poll until found or `maxWaitDays` elapses. The only adapter today is `HeuristicPaperRunLocator` (`src/adapters/platform/heuristic-paper-run-locator.ts`) — a best-effort name+time-proximity join over `listBotRuns({ mode: 'paper' })`, explicitly documented as "TEMPORARY heuristic join... seam isolated here by design." Once auto-start lands, no lab-side code changes are needed — the locator will simply start succeeding faster because the run appears sooner. The swap-in point for the *other* handoff (candidateId→runId link, see the companion doc) is the same class; auto-start alone does not remove the heuristic, it just shortens the wait.
