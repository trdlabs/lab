# Outcome Embargo — design (E4b lab obligation)

**Date:** 2026-07-17
**Status:** awaiting user review
**Initiative:** [E4b — held-out promotion enforcement](../../../../control-center/docs/delivery/initiatives/e4b-heldout-promotion-enforcement.md) (lab-owned hard production blocker)
**Related:** `docs/research/2026-07-12-backtester-phase-e-lab-reconciliation.md` §4–§5 (E4 ↔ Outcome Embargo)

## 1. Goal

Guarantee that held-out / qualification outcome data can never enter LLM generation
context in the lab — not directly, and not via retry, requeue, persistence reload,
event payloads, RAG, or summary projections. Without this, the RAG/memory layer is a
test-leak channel and the E4b promotion gate can be gamed by the LLM loop iterating
against the held-out window.

The embargo is **durable policy, not a feature**: always on, no env flag, no rollback
(per the E4b card's rollback sequence, the embargo stays enabled even if the gate is
rolled back).

## 2. Threat model and scope

**Protected surface (generation lane):** every LLM prompt / tool-argument
construction in the research loop — researcher (`mastra-researcher.ts`), hypothesis
builder (`mastra-builder.ts`), full-strategy builder (`mastra-strategy-builder.ts` +
`builder-proof-loop.ts`), critic (`mastra-critic.ts`), analyst
(`mastra-strategy-analyst.ts`), consolidator (`mastra-strategy-consolidator.ts`),
pre-flight strategy critics, WFO agents (`mastra-gate1.ts`, `mastra-sweep-designer.ts`,
`mastra-result-interpreter.ts`), the RAG index content
(`strategy_retrieval_document`), and similar-hypothesis summaries.

**Out of threat model:**

- **Chat turn-interpreter.** It sees only the raw current user message
  (`src/adapters/intent/mastra-turn-interpreter.ts`). A human operator manually
  pasting scorecard text into chat is a deliberate human action outside this
  embargo's scope; guarding it would require content-inspecting user messages and
  widen scope substantially. Recorded as a residual risk, not a requirement.
- **Observability lane** (read-only, not LLM input): cycle scorecard, completion
  summaries, read-API routes, SSE agent events, office chat posts. Explicitly
  preserved unchanged. Verified one-way: the office→lab bridge round-trips only
  user-authored turns, never assistant/system posts.
- **Deterministic orchestration.** Control-plane code may freely branch on embargoed
  outcomes (retry/stop decisions, M3 ratchet, paper.start champion selection). The
  embargo constrains LLM context only.

## 3. Embargo set E (what is embargoed for the generation lane)

Ratified scope: **outcomes AND window boundaries**.

1. **Lab-side holdout/OOS outcomes** (live today):
   - `HoldoutValidation` on `strategy_revision` (train/holdout metric blocks,
     `holdoutDecision`, `holdoutReasons`, policy, `t`, reason) —
     `src/domain/strategy-revision.ts:34`;
   - `research_experiment.verdict` / `verdictReason` / `holdoutBoundary` and
     `experiment_run_member` rows with `role='holdout'` / `oos=true` (their
     `resultSummary` metrics);
   - the deterministic holdout evaluation outputs (`evaluateExperiment`,
     `evaluateStrategyBaseline` verdicts).
2. **Upstream qualification/promotion outcomes** (future SDK contract, E4b):
   - `RunResultSummary.promotion` — every field of `PromotionResult` (`verdict`,
     `reason`, `evaluationWindow`, `attemptNumber`, `evaluatedOn`);
   - `backtest-evidence/v2` body content (holdout metrics, thresholds,
     `qualification{...}`) — already verify-and-forward only (#134/#079: content
     never reaches prompts; the embargo adds a regression guard, not new handling).
3. **Window boundaries as such:** `evaluationWindow`, `holdoutBoundary.t`, holdout
   period start/end (`encodeHoldoutPeriod` outputs), and the WFO train-boundary `T`
   (`SweepInput.periodTo` / `InterpretInput.periodTo`). Knowing the window lets
   generation target it; boundaries stay available to deterministic orchestration.
4. **Pattern rule for untyped metric bags:** any key of a `Record<string, number>`
   metric bag whose name token-matches `holdout | heldout | oos | promotion |
   qualification`, or whose segments contain the sequence `out_of_sample`
   (token-wise on snake_case/camelCase segments, NOT substring — `choose` must not
   match `oos`; `heldoutSharpe` and `outOfSampleSharpe` MUST match).

**Explicitly allowed (must be preserved, positive controls in tests):** train-lane
metrics (WFO Gate1/sweep/interpreter inputs after scrub), paper/live bot-results
digest + trade forensic evidence + decision-log excerpts (W3 by design), proxy-lane
retry feedback reason codes, market context math, similar-hypothesis
`[status] thesis` summaries.

## 4. Invariants

- **I-E1 (prompt purity):** no generation-lane prompt or tool argument ever contains
  a member of E — including after retry (W2), requeue/replay from
  `research_task.payload`, paper→Cycle-2 (W3), and persistence reload.
- **I-E2 (payload discipline):** embargoed windows are ALLOWED in
  orchestration/control-plane payload fields (e.g. `evalPlatformRun` persisted by
  R3b-1 for window immutability across retries) but FORBIDDEN in `feedback` and any
  generation projection. `sanitizeRetryFeedback` touches only the LLM-feedback field,
  never `evalPlatformRun` or other control-plane fields.
- **I-E3 (no off-switch):** the embargo has no config flag; it cannot be disabled.
- **I-E4 (observability intact):** existing payloads and outputs — scorecard,
  completion summary, read-API responses, existing agent events, office chat
  output — are byte-identical to today. One **additive** internal agent event
  (`outcome_embargo.scrubbed`) is allowed; it is not exposed through the read-API
  SSE payload allowlist.
- **I-E5 (fail-closed feedback):** retry-feedback reasons are an allowlist; unknown
  values are dropped, not passed through.

## 5. Verified channel inventory and disposition

| # | Channel | Today | Disposition |
|---|---|---|---|
| 1 | `RunResultSummary.metrics: Record<string, number>` (`src/ports/research-run-lifecycle.ts:142`) → WFO prompts via `JSON.stringify(baselineMetrics/baselineTrainSummary/topN)`. Today `mapStrategyMetrics()` projects a **closed 9-field `BacktestMetricBlock`**, so raw bags do NOT reach prompts — this is future-hardening against SDK/mapper widening, not an open channel | closed by mapper projection | **S1** recursive scrub at WFO egress (defense-in-depth) |
| 2 | WFO `periodTo` (= T) in `SweepInput`/`InterpretInput` (`src/ports/wfo-agents.port.ts:16/25`) rendered into sweep-designer and result-interpreter prompts | **T leaks into LLM today** | **S1** remove field |
| 3 | Retry feedback `payload.feedback.reasons` — free strings persisted in `research_task.payload` JSONB, replayed verbatim on retry/requeue (`enqueueResearchRetry`, `backtest-completed.handler.ts:53`) | proxy-lane enum codes only, by convention | **S2** allowlist at construction |
| 4 | `strategy_revision.holdoutValidation` — richest holdout object in a table also read by researcher context assembly (`findLatestAccepted` → `mergedRuleSet`) | safe by field selection only | **S4** guard test + sentinel |
| 5 | Experiment registry read-backs (`paper-start` reads oos member — params only; offline eval) | safe by field selection | **S4** guard test + sentinel |
| 6 | Similar hypotheses (`SimilarHypothesisSummary` drops `proxyMetrics`) and RAG index (`buildStrategyRetrievalText` embeds descriptive text only) | safe by type shape | **S4** shape guard tests |
| 7 | Bot-results digest — typed `BotRunResultDetail`/`RunSummary` rendered by `buildBotResultsDigestText` (`bot-results-digest.ts:45`) | allowed content (paper/live), safe by explicit rendering | **S3** explicit projection + new-field guard test |
| 8 | Agent events (`experiment.completed` carries verdict; SSE `PAYLOAD_ALLOWLIST`); `cycle.scorecard.built` = `{correlationId}` | observability-only | **S5** regression tests |
| 9 | Signed evidence content (#134) — verify → CAS → attach `content_hash` only | already closed (I3) | sentinel regression |
| 10 | Requeue/persistence replay of task payloads | safe iff S2 holds (nothing embargoed is ever written into feedback) | sentinel covers reload+replay |

## 6. Design

### 6.1 Policy module — `src/research/outcome-embargo.ts`

Single authoritative module, pure functions, no config:

- `isEmbargoedMetricKey(key: string): boolean` — token-wise match of
  snake_case/camelCase segments against `holdout | heldout | oos | promotion |
  qualification` plus the segment sequence `out_of_sample` (§3.4).
- `scrubMetricsBag<T>(bag: T): { scrubbed: T; removedKeys: string[] }` —
  **recursive**: walks nested objects/arrays (comparison blocks, `topN` ranked
  points, future nested SDK fields), removing embargoed keys at any depth. Returns
  removed key names (paths) for the scrub event.
- **No ingress scrub, no summary helper.** The canonical `RunResultSummary` (input
  to deterministic evaluation, persistence, scorecard) is never modified. Scrubbing
  happens only at generation-lane egress (S1); a future `promotion` object arriving
  in a metric/comparison structure is removed there by the `promotion` key token.
- `SAFE_RETRY_REASONS` — allowlist = proxy-lane evaluator codes
  (`insufficient_sample`, `no_improvement_over_baseline`, `drawdown_regression`,
  `fragile_pnl`, `strong_robust_edge`, `positive_edge` — `src/validation/evaluator.ts`)
  ∪ preservation-veto codes (`end_of_data_position`, `abstention_gaming`,
  `winner_degradation` — `src/validation/apply-preservation-gate.ts`).
- `sanitizeRetryFeedback(feedback): Feedback` — keeps `hypothesisId` + `decision` +
  only allowlisted reason codes; drops unknown values (I-E5). Operates on the
  feedback object ONLY (I-E2).
- On every scrub hit: an **additive `AgentEvent`** `outcome_embargo.scrubbed` with
  payload `{ site, removedKeys }` — **key names/paths only, never values** (the lab
  has no shared structured logger; the agent-event ledger is the existing sink).
  The event is internal observability evidence for the E4b card ("Embargo live"
  gate); its payload is **NOT** added to the read-API SSE `PAYLOAD_ALLOWLIST`.

### 6.2 Seams

**S1 — WFO prompt egress (mandatory, includes a port change).**

- Remove `periodTo` from `SweepInput` and `InterpretInput`
  (`src/ports/wfo-agents.port.ts`) and from the corresponding prompt builders
  (`mastra-sweep-designer.ts`, `mastra-result-interpreter.ts`) and fake adapters.
  No replacement field: neither agent needs a calendar date to design a sweep or
  rank grid results; if a later need arises, a date-unbound token (e.g. round
  index, already present as `roundsSoFar`) is the only acceptable substitute.
  Downstream updates: `experiment-service.ts` call sites and the offline
  `experiments/wfo-gate1` harness types/fixtures (offline, paid-gated — no behavior
  change to frozen labels beyond the removed field).
- In `experiment-service.ts`, pass `baselineMetrics` / `baselineTrainSummary` /
  `topN` through `scrubMetricsBag` before invoking `Gate1DecisionPort` /
  `SweepDesignerPort` / `ResultInterpreterPort`. Defense-in-depth: today these
  blocks come from the closed `mapStrategyMetrics` projection (§5 #1); the scrub
  guards against SDK/mapper widening.

**S2 — retry-feedback construction.**

- `enqueueResearchRetry` (`backtest-completed.handler.ts`) applies
  `sanitizeRetryFeedback` **before** the payload is written, so embargoed content is
  never persisted into `research_task.payload.feedback` and therefore cannot return
  via retry, requeue, or replay. `evalPlatformRun` and all other control-plane
  payload fields are untouched (I-E2).
- Add an assertion test that no holdout/experiment-lane code path constructs retry
  feedback (today: only the proxy lane calls `enqueueBacktestCompleted` →
  `enqueueResearchRetry`).

**S3 — bot-results generation projection (no blind scrub).**

`BotRunResultDetail.summary` is a typed `RunSummary`, not a metric bag, and the
prompt is already built through the allowlisted renderer
`buildBotResultsDigestText`. The seam is therefore a **frozen explicit projection**,
not a runtime scrub:

- Introduce (or document in place) the exact field allowlist the digest renders
  (strategy name/version, mode/status, runId, symbols, closedTrades, winratePct,
  pnlUsd, avgPnl, avgHoldingMinutes, exitReasons, worst-trade fields).
- Add a guard test that fails when the digest output ever includes a field outside
  the allowlist — specifically, a `RunSummary` fixture extended with `promotion`,
  `holdout*`, `qualification*` members must render byte-identically to the same
  fixture without them. The DTO is never cast to a generic bag.

**S4 — shape guards (no runtime change).**

- Test: `SimilarHypothesisSummary` contains no metric/outcome fields (type-level
  witness + runtime assertion on the search result shape).
- Test: `buildStrategyRetrievalText(profile)` renders from its explicit field list
  only — a `StrategyProfile` object extended at runtime with extra members
  (`holdoutValidation`, `promotion`, `evaluationWindow`) produces **byte-identical**
  output to the clean profile. Separate test: the indexer
  (`strategy-retrieval-indexer.ts`) passes only the `StrategyProfile` into document
  construction — no experiment/revision/outcome records enter the retrieval
  document.
- Test: researcher context assembly (`research-run-cycle.handler.ts`) reads from
  `strategy_revision` only `mergedRuleSet`-derived fields; a revision fixture with a
  sentinel-filled `holdoutValidation` must produce a researcher prompt without the
  sentinel.

**S5 — event payload regression.**

- Test: `cycle.scorecard.built` payload is exactly `{ correlationId }`.
- Test: SSE `PAYLOAD_ALLOWLIST` (`src/read-api/mappers.ts:46`) unchanged for
  experiment events (observability keeps working; nothing new is exposed).

### 6.3 What deliberately does NOT change

- Scorecard builder/renderer, completion summaries, read-API routes, office chat
  flow — byte-identical (I-E4).
- Deterministic evaluators (`evaluateExperiment`, `evaluateRevision`, M3 ratchet,
  preservation gates) keep full access to holdout data.
- `evalPlatformRun` window-binding persistence (R3b-1) — untouched.
- Signed-evidence handling (#134) — untouched; covered by a sentinel regression
  assertion only.
- No SDK changes, no platform/backtester changes, no rollout flags. Lab still never
  creates or signs promotion evidence.

## 7. Testing plan

Every leak channel from §5 gets a test; the durable properties get a three-layer
sentinel harness.

The sentinel guarantee is delivered by three complementary layers (fake adapters do
not build real prompts, and no single workflow traverses researcher, WFO, builder,
critic, and consolidator — so one monolithic e2e would be dishonest):

1. **Orchestration integration (port-input capture).** Fixture composition with
   capturing fakes at every LLM **port** (researcher, builder, critic, consolidator,
   WFO ports) that record their full inputs. Inject a unique sentinel number (e.g.
   `987654.321`) and a unique sentinel window-boundary date into holdout member
   results, `HoldoutValidation`, and experiment verdict reasons. Assert the
   sentinels appear in ZERO captured port inputs across:
   - the initial `research.run_cycle` pass;
   - the W2 retry pass (feedback threaded through a real persisted payload);
   - a requeue/replay: re-run the handler from the persisted `research_task.payload`
     row with fresh process state (persistence-reload path);
   - the W3 path (`paper.monitor` → Cycle-2 `research.run_cycle`).
   Positive control for I-E2: `evalPlatformRun` remains intact in the persisted
   orchestration payload.
2. **Prompt-capture tests of real Mastra adapters (fake `Agent`).** For each real
   prompt builder (researcher, hypothesis builder, strategy builder, critic,
   consolidator, Gate1/sweep-designer/result-interpreter): instantiate the real
   Mastra adapter with a capturing fake `Agent`, feed inputs carrying
   sentinel/embargo-shaped extras, assert the final prompt string contains neither
   sentinel nor embargo-pattern keys; positive controls — allowed context (train
   metrics, paper digest, similar-hypothesis theses) IS present.
3. **WFO integration (dedicated).** T-removal + recursive scrub end-to-end through
   `experiment-service`: (a) the unique boundary date `T` appears in no captured
   WFO port input or prompt, (b) embargo-pattern keys are scrubbed at any nesting
   depth (nested `topN` case), (c) **positive control** — train metrics (e.g.
   `netPnlUsd`, `sharpe`) survive the scrub.
4. **Unit tests:** `isEmbargoedMetricKey` — positives incl. `heldoutSharpe`,
   `outOfSampleSharpe`, `out_of_sample_sharpe`, `holdout_net_pnl`,
   `promotionVerdict`, `qualificationEpoch`; negatives incl. `choose`-vs-`oos` and
   plain train keys; recursive `scrubMetricsBag` (nested comparison/topN/array
   cases); `sanitizeRetryFeedback` (allowlist pass, unknown-drop, `evalPlatformRun`
   untouched on the payload level).
5. **S3 digest projection guard** (extended-fixture byte-identity, above).
6. **S4 shape guards + S5 event regression** (above).
7. **Observability parity:** scorecard build + markdown render and completion
   summary for a cycle with holdout data — unchanged snapshots (I-E4).
8. `pnpm check` (= `tsc -p tsconfig.json` + `vitest run`) — full typecheck and test
   suite, covering orchestrator handlers, research, validation, adapters, read-api.

## 8. Rollout and evidence (per E4b card, step 2)

- This PR: spec only → review → implementation PR(s) on the same branch family.
- Merge → deploy lab (standard image build; no flags to flip — always-on).
- Evidence for the card's "Embargo live" gate: the test suite above +
  `outcome_embargo.scrubbed` log line demonstrated in staging.
- Later steps (backtester gate ON in staging, platform enforcement) are owned by
  their repos per the card; nothing in this design blocks or reorders them.

## 9. Residual risks / non-goals

- **Human paste vector:** an operator can manually paste scorecard markdown into
  chat as strategy text; out of threat model (§2). Revisit only if chat-driven
  research starts consuming prior chat context.
- **Future prompt sites:** a new LLM adapter could bypass the seams. Mitigation:
  the sentinel harness is structured so new prompt sites plug into the same capture
  fixture; adding an LLM port without wiring it into the harness is flagged in
  review (checklist item in the implementation plan).
- **Backtester SDK bump:** when `RunResultSummary.promotion` lands in the SDK, the
  WFO-egress key patterns (`promotion` token, recursive) and the S3 digest
  projection guard already cover it; the follow-up is extending the capture-test
  fixtures to the real field name — tracked in the implementation plan as a
  TODO-on-SDK-bump test tightening.
