# Platform handoff prompt — link `candidateId`/`bundleId` to the live `bot_run` on ops-read

> Paste this into the **trading-platform** instance. It owns the implementation; trading-lab consumes the contract below. (This file lives in trading-lab only as the agreed handoff record, per the convention of [2026-06-30-platform-close-reason-enum-handoff.md](2026-06-30-platform-close-reason-enum-handoff.md).)
>
> Companion doc: [2026-07-03-platform-auto-start-handoff.md](2026-07-03-platform-auto-start-handoff.md) (host pickup after promotion). Both gaps were found while building trading-lab's `paper.monitor` slice (G4): `docs/superpowers/specs/2026-07-03-paper-monitor-design.md` §2.

## Task: expose an explicit `candidateId` (or `bundleId`) field on `bot_run` / `/ops/runs`, so a paper submission can be joined to its live run by identity, not by heuristic

### Why
trading-lab submits a proven WFO champion via paper-intake and gets back an opaque `candidateId` (`PaperIntakePort.submitProvenCandidate` → `{ candidateId, admissionStatus }`). On admission, the platform creates a `bot_bundle` with `bundleId == candidateId` (`specs/062-intake-identity/plan.md:31`). But there is **no surfaced link from that identity to the eventual live paper `bot_run`** on the read surfaces lab consumes:

- `BotRunRecord` (`src/operations/dto.ts:103-113`) — the row shape returned by `/ops/runs` / `listBotRuns` — carries `runId`, `mode`, `status`, `strategy` (a name/id ref), `startedAtMs`, `finishedAtMs`, `lastSeenMs`, `symbols`. **No `bundleId` or `candidateId` field.**
- `PaperCandidateReadView` (`src/operations/dto.ts:393-408`) — the row shape returned by `/ops/candidates/{id}` — carries `candidateId`, `source`, `agentDecision`, admission fields, `evidenceRefs`, timestamps. **No `runId` field.**

The only field common to both surfaces today is `strategy.name` on the run side (`BotRunStrategyRef`, sourced from `bot_bundle.metadata` at materialize time) versus `identity.strategyName` on the lab intake side (== `bundle.manifest.id`, the LLM-builder's module id). That name is a reasonable-but-imperfect join key: it is unique per *profile*, but a re-submitted profile (e.g. an updated champion for the same strategy family) would mint a second candidate/run pair with the **same** `strategy.name`, making the join ambiguous between concurrent runs of the same name.

### Investigate first
- `rowToBotRunRecord` (`src/canonical/writers/trade_journal_writer.ts:241`) is where the canonical `bot_run` row becomes the read-surface `BotRunRecord` — check whether the canonical `bot_run` table already stores a bundle/candidate reference (materialization already knows the bundle it started from — 057's `resolveBundle`/`materializeBot` path) even if it isn't projected onto the DTO. If it does, this is a pure DTO-projection change (Change A below); if it doesn't, the bundle/candidate id needs to be threaded through bot instantiation into the `bot_run` row at creation time first.
- Confirm whether `bundleId` (bundle-instance case, 057) is the right field to expose, or whether `candidateId` is more directly useful to lab — given `bundleId == candidateId` at promotion (per `specs/062-intake-identity/plan.md:31`), either works as the join key; platform should pick whichever is already closer to hand in the `bot_run` write path.

### Change A — project the identity onto `BotRunRecord`
In `src/operations/dto.ts`, add to `BotRunRecord` (near `strategy`):
```ts
readonly candidateId: string | null; // opaque; null for non-bundle (in-repo) bot types
```
(or `bundleId`, per the investigation above — name it consistently with whatever `bot_bundle`'s own primary key is called elsewhere in ops-read). Populate it in `rowToBotRunRecord` from whatever the canonical `bot_run` row carries once Change A's prerequisite (threading the id through materialization, if not already present) is done.

### Change B — surface it on `/ops/runs` filtering (optional but useful)
If cheap: let `ListRunsQuery` (`src/operations/sources/runs-reader.ts:24`) / `listRuns` (`src/operations/handlers/list-runs.ts:40`) accept an optional `candidateId` filter, so lab can do a direct point lookup (`/ops/runs?mode=paper&candidateId=...`) instead of listing+filtering client-side. Not required for the core acceptance criterion below — the id field alone unblocks lab's join.

### Acceptance
- `/ops/runs` (and `listBotRuns`) rows for `mode: 'paper'` bundle-backed bots carry a non-null `candidateId` (or `bundleId`) equal to the id lab received from paper-intake at submission time.
- Bake into the mock-platform fixture (or the relevant VPS golden fixture) so trading-lab can integration-verify the exact-identity join path, not just the name-based heuristic.
- ops.N contract-version bump; update `@trading-platform/sdk`'s `BotRunRecord` type and cut one SDK release.

### NOT in scope
- No change to non-bundle (in-repo `long_oi`/`short_oi`) bot runs' identity — they have no `candidateId` and the field stays `null` for them.
- No change to the admission/promotion decision logic itself.

### Lab-side contract (for reference — how lab bridges this gap today, and the exact swap-in point)
trading-lab's `paper.monitor` handler locates the live run via `PaperRunLocatorPort` (`src/ports/paper-run-locator.port.ts`):
```ts
export interface PaperRunLocatorPort {
  locate(args: { strategyName: string; submittedAtMs: number }): Promise<{ runId: string; startedAtMs: number } | null>;
}
```
The only implementation today is `HeuristicPaperRunLocator` (`src/adapters/platform/heuristic-paper-run-locator.ts`): it calls `listBotRuns({ mode: 'paper' })`, filters `run.strategy.name === strategyName && run.startedAtMs > submittedAtMs`, and picks the newest match. This is a best-effort name+time-proximity heuristic — explicitly documented in the adapter's header as "TEMPORARY heuristic join — replaced by the platform candidateId→runId link per handoff doc; seam isolated here by design." The `paper_submission` ledger already stores the `candidateId` returned at submission time (`PaperSubmission.candidateId`), so once Change A ships, the swap-in is contained entirely to a new adapter implementing the same `PaperRunLocatorPort.locate` — filter `run.candidateId === <the stored candidateId>` instead of the name+time heuristic — wired in at the same composition point (`src/composition.ts`, where `HeuristicPaperRunLocator` is constructed today). No changes needed to `paperMonitorHandler`, the ledger schema, or any test outside the locator's own unit test.

Mitigates the residual ambiguity risk noted in the design doc (§9): a re-submitted profile under the same `strategyName` currently narrows the collision window only to concurrent same-named runs (via `runId` fixation-once + `startedAtMs > submittedAtMs`); an exact `candidateId` join removes that ambiguity class entirely.
