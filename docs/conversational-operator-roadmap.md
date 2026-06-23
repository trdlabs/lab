# Conversational Operator — Roadmap

Living roadmap for the conversational operator workstream. We follow this doc:
each future slice gets its own design + plan under `docs/superpowers/` before
implementation, and must preserve the invariants below.

**Target experience:** `understand → enrich with verified evidence → propose action → explicit confirmation → deterministic enqueue.`
The LLM understands and phrases; it never creates tasks or trades. Side effects
stay behind the deterministic guard. Research-only — no live trading / execution adapter.

## Status

| # | Slice | State |
|---|-------|-------|
| 1 | Confirmation core | ✅ Shipped (branch `feat/conversational-operator`) |
| 2 | Operator RAG baseline | ✅ Shipped |
| 3 | Meaningful completion replies | ✅ Shipped (lab #50 + office #11) |
| — | PR2b — downstream backtest surfacing | ✅ Shipped + live-verified + demo-enabled (lab #67 + office #16; flag `OPERATOR_DOWNSTREAM_BACKTESTS`) |
| — | Operator confirmation UI (office) | ✅ Shipped (lab #59 PR-L + office #12 PR-O1 + #13 PR-O2; live-verified 2026-06-21; all follow-ups shipped — office #14 + lab #65 + office #15) |
| — | Reranker follow-up | ✅ Scaffold shipped (#52; default OFF, enable deferred to independent corpus) |
| — | TurnInterpreter model env + IntentClassifier cleanup | ✅ Shipped (#69 eval + #71 dataset/prompt fixes → `gemini-3.1-flash-lite` selected; `TURN_INTERPRETER_MODEL` decoupled; legacy IntentClassifier removed) |
| 4 | Bot catalog + entity disambiguation | ⛔ Deferred — needs platform SDK + bot-identity DTO (see SDK initiative) |
| 5 | Researcher / Artifact RAG | ⛔ Deferred — needs backtester SDK artifact API (see SDK initiative) |
| — | Phoenix observability | 🔜 Backlog |
| — | Answer Synthesizer (optional) | 🔜 Backlog |
| — | Agentic RAG (bounded corrective) | 🕓 Later (only if eval justifies) |
| — | SDK boundaries + distribution (cross-cutting) | 🔬 Researched — own brainstorm/spec pending |
| — | Tech debt: strip-types boot fix | ✅ Shipped (branch `fix/strip-types-boot`) |

## Shipped

### Slice 1 — Confirmation core
Two-turn chat: a strategy message (no magic prefix) → `assistant_message` with
interpretation + confirm/cancel + a persisted `ActionProposal` (no task/queue);
`да` → CAS `confirmPending` → task via the single `createAndEnqueueTask`
chokepoint → worker auto-chains research. Confirmation is resolved **before** the
LLM. Migration `0009`. Design: `docs/superpowers/specs/2026-06-18-conversational-operator-evidence-confirmation-design.md`;
plan: `docs/superpowers/plans/2026-06-18-conversational-operator-confirmation-core.md`.

### Slice 2 — Operator RAG baseline
`IntentClassifier` → typed `TurnInterpreter` (one LLM call). Evidence collected
before the proposal: exact fingerprint + structured reads + PostgreSQL FTS +
pgvector, fused with RRF (k=60), under a 5s soft / 10s hard deadline budget;
evidence cards on the proposal + message; fail-soft onboarding indexing. Behind
`OPERATOR_RAG_ENABLED` (default **false** → `DisabledOperatorRetrieval`, zero
embedding calls). Migration `0010` (pgvector + generated tsvector + GIN/HNSW).
Design: `docs/superpowers/specs/2026-06-19-operator-rag-design.md`; plan:
`docs/superpowers/plans/2026-06-19-operator-rag-baseline.md`; research:
`docs/research/2026-06-18-operator-rag-architecture-research.md`.

**Baseline eval (live `--run`, `baai/bge-m3`, golden dataset `strategy-retrieval-v1`, 17 cases):**
exact-identity accuracy **1.0**, false-semantic-exact **0**, MRR **1.0**,
nDCG@5 **0.967**, recall@20 1.0 (trivial — corpus < 20). Deterministic gate suite
runs in CI (`pnpm operator-rag:eval` dry-run by default).
Caveat: the eval corpus is curated to the golden labels — it validates the live
pipeline + bge-m3 ranking on a small set, not an independent benchmark. A larger
independent corpus + live latency eval is future work.

## Invariants (must hold for every future slice)

- **Research-only**: no order execution; generated code runs only in the platform sandbox.
- **Confirmation gate**: every task-/compute-producing action needs a separate explicit confirmation, even when the first message says "проанализируй"/"исследуй". The LLM never enqueues; only the deterministic guard does.
- **Confirmation before interpretation**: a pending reply (`да`/`нет`/…) is resolved against the stored proposal, never re-sent to the LLM.
- **Exact duplicate = fingerprint only**; semantic similarity is advisory and labelled "similar", never "the same".
- **No false absence**: a source that wasn't queried or failed is disclosed as such, never rendered as "nothing found".
- **PostgreSQL FTS is not BM25** (`ts_rank_cd` lexical ranking; strict BM25 is out of scope).
- **Embeddings locked**: `baai/bge-m3`, 1024 dims (config fails closed on mismatch). New index version + full reindex required to change the model.
- **Latency**: p95 ≤ 5s (soft), 10s hard deadline; degrade, don't hang.
- **Privacy**: audit events carry IDs/hashes/counts/codes/timings — never raw strategy text, retrieved bodies, embeddings, or secrets.
- **Mastra**: new `Agent` construction lives only under `src/mastra/` (import-boundary guard).
- **Runtime**: code runs via `node --experimental-strip-types` — no TS parameter properties.

## Next (prioritized)

### 3. Meaningful completion replies  — ✅ SHIPPED (the "Done" problem)
Done end-to-end in the followed-terminal scope. **lab PR #50** (→ main `e7f1bb2`): read-API
`GET /v1/tasks/:taskId/completion-summary` → structured `CompletionSummary`
(`strategy.onboard` / `research.run_cycle` / `backtest.completed`) + observable graceful degradation
(`warnings` codes + `console.warn`); side-effect-free read. **office PR #11** (→ main `e61ee56`):
`getCompletionSummary` client + `renderCompletionSummary` markdown + async `ConversationFollower`
completion replacing `Done.`, behind `OPERATOR_COMPLETION_SUMMARY` (default on) with graceful fallback.
Spec: `docs/superpowers/specs/2026-06-19-meaningful-completion-replies-design.md`; plan:
`docs/superpowers/plans/2026-06-19-meaningful-completion-replies-pr1-lab.md` (office PR2 plan lives in
the trading-office repo).

**PR2b — downstream `backtest.completed` surfacing — ✅ SHIPPED + live-verified + enabled (demo).**
The run_cycle turn completes immediately ("N backtests enqueued"); per-hypothesis backtest results arrive
later as downstream tasks (same `correlationId`, different `taskId`) the one-turn `ConversationFollower`
never watched. Now surfaced incrementally as **proactive assistant messages**. Three layers, cross-repo:
(a) **lab** emits a hand-authored terminal event `backtest.result_ready` from `backtestCompletedHandler`
(symmetric with `research.run_cycle.completed`) — **lab PR #67** (→ main `846965a`); (b) **office** adds a
process-lifetime `DownstreamBacktestWatcher` (subscribes the shared `StreamBridge`, resolves correlationId
via the bootstrap-poll, dedups by taskId, fetches `completion-summary` with bounded retry + generic
fallback, idle+hard-cap teardown) + a new `operator_assistant_message` gateway event + an `assistant_turn`
web transcript turn (Q4 reducer untouched) + a `ChatTurn` render with no user bubble — **office PR #16**
(→ main `b138441`). Behind `OPERATOR_DOWNSTREAM_BACKTESTS` (default OFF; **enabled in the demo stack**).
Spec: `docs/superpowers/specs/2026-06-22-pr2b-downstream-backtest-surfacing-design.md`; plans:
`docs/superpowers/plans/2026-06-22-pr2b-lab-backtest-result-ready.md` (office plan in the trading-office repo).
**Live-verified 2026-06-22** on the demo stack end-to-end (chat → confirm → run_cycle → a `backtest.completed`
task → real `backtest.result_ready` → watcher → visible proactive assistant message in the browser, with
graceful metric degradation). Note: the demo backtester sandbox cannot execute nested-Docker backtests on
WSL2 (`spawn docker ENOENT`, no DinD), so the terminal backtest result was injected via the internal
`/tasks` ingress to stand in for the engine — every line of the PR2b path ran live; only the backtest's
numeric outcome was simulated. Real organic backtest completion is blocked by the demo DinD gap, not PR2b.

### Operator confirmation UI (office)  — ✅ SHIPPED (incl. all follow-ups)
The two-turn proposal/confirm flow is now usable in the trading-office web UI. **lab PR #59 (PR-L)**
(→ main `2ee5aa4`): `POST /chat/confirm {pendingInteractionId, sessionId, decision}` reusing the
`confirmPending` + `createAndEnqueueTask` chokepoint. **office PR #12 (PR-O1)** (→ main `da1ceb1`):
server learns the lab's `assistant_message` proposal (shared `emitFromLabResponse` mapper +
`assistant_message` case → terminal `operator_message_completed` carrying evidence/actions/ids) +
`TradingLabChatConnector.confirm()` + `POST /api/office/operator/confirm`. **office PR #13 (PR-O2)**
(→ main `b30ff51`): web renders clickable evidence badges + Подтвердить/Отмена; `confirmAction` reuses
the submit→accepted→events wire model; badge click → left-dock `OperatorEvidencePanel` (local
`FloorScreen` state, no router). Live-verified 2026-06-21 end-to-end on the docker demo stack
(web → office-server `trading-lab` mode → ingress → BullMQ `chat-proposal_*` `strategy.onboard` job,
`source:"web"`, completed).

**Follow-ups (found during the 2026-06-21 live verify — office/lab zone, NOT PR-O2 web bugs) — ✅ ALL SHIPPED.**
Q1/Q3/Q4 landed together in **office PR #14** (→ main `0e63f22`); Q2 split across **lab PR #65**
(→ main `8cd98e6`, Defect A) + **office PR #15** (→ main `a6a9ce3`, Defect B). Spec/plan:
`docs/superpowers/specs/2026-06-21-operator-confirmation-ui-followups-design.md` +
`docs/superpowers/plans/2026-06-21-operator-confirmation-ui-followups.md` (in trading-office).

- **Confirm completion overwrote the proposal turn (office-server)** — ✅ **fixed (office #14).** Root
  cause: `defaultNewIds()` minted a per-instance counter starting at `m1`; the message responder and the
  confirm responder were built independently with no shared `newIds`, so both first turns got
  `operatorMessageId = "m1"` and the confirm completion overwrote the proposal turn (the web reducer keys
  by `operatorMessageId`). Fixed by switching `defaultNewIds()` to `crypto.randomUUID()` so the two
  responders cannot collide. Unit tests passed a shared deterministic `newIds`, which hid the collision —
  only the real wiring triggered it.
- **Interpretation rendered twice (office mapper)** — ✅ **fixed (office #14).** `toBadges` now filters
  `kind: 'interpretation'` cards before mapping, so the interpretation appears only as the proposal
  message — not also as a wide clickable badge. Real evidence (`exact_duplicate` / `similar` / `warning`)
  is unaffected.
- **Reducer ordering-contract hardening (office-web)** — ✅ **fixed (office #14).** `OperatorTranscriptState`
  gained a `pendingCompleted` buffer: an `operator_message_completed` whose `operatorMessageId` has no turn
  yet is held and flushed when the matching `accepted` action binds the turn, instead of being dropped by
  `mapById`. Defense-in-depth against any gateway/fake that emits `completed` before `accepted` resolves;
  the in-order path is unchanged.
- **`strategy.onboard` confirm fell back to "Done." (vs Slice 3)** — ✅ **fixed (Q2: lab #65 + office #15).**
  Root cause (found via systematic-debugging + a live `GET /v1/tasks/:id/completion-summary` trace that
  returned a real onboard summary — the endpoint was never the problem) was two defects: **Defect A (live,
  lab #65)** — the confirm path minted *two different* `correlationId`s (one for the onboard task, one for
  the auto-chained `research.run_cycle` ChatPlan), so the office `ConversationFollower` (filtering by the
  onboard correlationId) never matched the chained completion; fixed by hoisting one `correlationId` shared
  by both the task and the plan (invariant: one conversation turn = one correlationId). **Defect B (latent,
  office #15)** — the lab emits `strategy.onboard.deduped` on a duplicate, which was missing from the
  office `successTypes`; added it to the terminal taxonomy. Now the confirm-path follower surfaces the
  domain `CompletionSummary` instead of `Done.`.

### Reranker follow-up  — ✅ SCAFFOLD SHIPPED (default OFF)
Shipped via **#52** (→ main `ffb68af`): the conditional `MastraRerankerAdapter` (`RerankerPort` impl
over `@mastra/core/relevance`), the §7 gate/triggers (`shouldRerank`), deadline-bounded reranking in
`OperatorRetrieval.#runHybrid` with RRF as the baseline + fallback, config behind `OPERATOR_RERANKER`
(default `none`), and a deterministic RRF-vs-reranker nDCG@5 eval comparison + no-regression CI gate.
**Not enabled** — the curated corpus has no headroom for the `+0.02 nDCG@5` gate. Spec:
`docs/superpowers/specs/2026-06-19-operator-reranker-scaffold-design.md`; plan:
`docs/superpowers/plans/2026-06-19-operator-reranker-scaffold.md`.

**Enable-slice (later)** — gated on the independent eval corpus (tech debt below): finalize a dedicated
reranker model + richer candidate text (candidates carry IDs/scores/metadata, not full strategy text
today), run the live `--run` Mastra comparison, and flip `OPERATOR_RERANKER=mastra` only if it clears
`+0.02 nDCG@5` within the latency budget.

### 4. Bot catalog + entity disambiguation  — ⛔ DEFERRED (SDK dependency)
A lab-side `BotCatalogReadPort` (stable botId, aliases, strategy ref, market/symbol/
timeframe/direction, status) backed by the platform SDK; `entity_disambiguation`
pending-interaction + ranked candidate selection. If the upstream surface lacks
the identity metadata, extending it is an explicit prerequisite. Reference: design §8.
**Deferred** until the new `@trading-platform/sdk` lands with a stable bot-identity DTO —
the catalog should bind to that surface, not the legacy vendored SDK. See *SDK boundaries
+ distribution* below.

### 5. Researcher / Artifact RAG  — ⛔ DEFERRED (SDK dependency)
A second index over research-report / hypothesis-rationale / critic-output / notes
chunks (with profileId/taskId/type/timestamp metadata) for explanatory answers
("what was tried before", "why was this hypothesis rejected"). Reference: research §5.
**Deferred** until the `@trading-backtester/sdk` artifact API (`/artifacts` descriptors /
references / pagination DTO) is fixed — the index keys off that contract. See *SDK
boundaries + distribution* below.

### Phoenix observability
The audit events already emit Phoenix/OpenTelemetry-compatible attributes; wire the
Phoenix TS SDK for tracing/datasets/experiments. Observability only — not a
canonical store. Reference: research §9.

### Answer Synthesizer (optional)
A second, conditional LLM call only for complex read-only answers that combine
several evidence items. Not needed for confirmation copy or deterministic rendering.

### Agentic RAG — later, only if justified
Bounded corrective retrieval (retrieve → coverage check → at most one query
rewrite → retrieve → disclose gaps), then full agentic only if multi-hop eval
cases demonstrably fail single-shot/bounded retrieval.

### TurnInterpreter live-model eval  — ✅ SHIPPED + env decoupled
Eval shipped (#69) + dataset/prompt fixes (#71) — `gemini-3.1-flash-lite` selected as
the operator interpreter model. The env was decoupled: `TURN_INTERPRETER_MODEL` /
`TURN_INTERPRETER_ADAPTER` / `TURN_INTERPRETER_MIN_CONFIDENCE` replace the legacy
`INTENT_CLASSIFIER_*` names (docker default updated to `openrouter/google/gemini-3.1-flash-lite`).
The legacy `IntentClassifier` component (superseded by the TurnInterpreter in Slice 2, not on
any live path) has been removed.

### Model cascade for hypotheses (cheap-first, escalate-on-failure)  — backlog
Extend the existing research retry loop (`enqueueResearchRetry`, capped `MAX_CYCLE_DEPTH`) into a model
**cascade**: default to the cheap model (grok-4.3) for hypothesis generation, and on a backtest
FAIL/MODIFY escalate to the expensive model (gpt-5.5) for a bounded number of attempts, then stop. The
gate is the deterministic backtest `Evaluation` (not a judge) — aligns with "validation ≠ quality". This
is a **model-cascade + Iterative-Refinement** pattern (NOT agentic RAG — that is a retrieval loop).
Caveats: each attempt costs a full backtest cycle (not just tokens), so the cycle cap + the token/cost
kill-switch bound it; and since the analyst eval showed grok-4.3 ≈ gpt-5.5 on hypothesis quality, an
eval must first confirm escalation actually recovers grok's failures before it's worth the extra cost.
Needs its own design/plan.

## SDK boundaries + distribution (cross-cutting)

A cross-repo architectural initiative to replace the committed, platform-owned vendored
SDK tarball (and the sibling `file:../trading-backtester/...` client dependency) with **two
independently-versioned SDKs by bounded context**, delivered via **GitHub Release assets**
(no npmjs, no sibling checkouts, no registry credentials). Research + conclusions:
`docs/research/2026-06-19-sdk-boundaries-and-distribution.md` (branch
`docs/sdk-boundaries-distribution`). This is **research input, not an approved spec** — it
needs its own `superpowers:brainstorming` → spec → plan, and a re-check of all repos, before
implementation.

**Target split:**
- **`@trading-platform/sdk`** (new public repo `trading-platform-sdk`): platform data /
  catalog, historical-data DTO+client, ops-read (bot/paper/live observations),
  paper-candidate intake, platform capabilities/versioning, platform HTTP/MCP transports.
  Sheds its legacy builder / backtest-lifecycle surface.
- **`@trading-backtester/sdk`** (in the already-public `trading-backtester` as
  `packages/sdk`, subpath exports `/builder` `/client` `/contracts` `/artifacts`): the
  source of truth for module build / validate / run / result / artifacts. The current
  `@trading-backtester/client` stays as a deprecated compat wrapper for one migration window.
- **Delivery:** consumers pin exact GitHub Release `.tgz` URLs (+ SHA-256 checksum / source
  manifest); `pnpm-lock.yaml` records URL + integrity. Replaces `vendor/trading-platform-sdk/*.tgz`
  and the `file:` client dep. Clean-clone install with no sibling checkout is a done-criterion.

**Impact on the operator roadmap:**
- **Independent** of this initiative (can proceed now): Slice 3 (completion replies), the
  Reranker follow-up, Phoenix observability, and the shipped strip-types boot fix.
- **Slice 4 (Bot catalog)** — deferred until the platform SDK + a stable bot-identity DTO land.
- **Slice 5 (Researcher / Artifact RAG)** — deferred until the backtester SDK artifact API lands.
- Do **not** start Slice 4 or Slice 5 until their respective SDK surfaces are fixed.

Out of scope for the initiative itself: npmjs / private registry publication, moving any SDK
into `trading-mock-platform`, a single universal package, live-execution changes, or rewriting
public Git history (see research §11).

## Tech debt

- **strip-types boot fix** ✅ — the parameter-property constructors in runtime code (10
  files: read adapters, platform adapters, the agent-activity projection) were converted to
  explicit field declarations + assignment, so `pnpm ingress` / `pnpm worker` boot under
  `node --experimental-strip-types` (they now reach the runtime `DATABASE_URL` check, not a
  parse error). A TypeScript-compiler-AST guard test
  (`src/strip-types-no-param-properties.test.ts`) fails the suite if a parameter property is
  reintroduced anywhere node strip-types loads (`src/` + `scripts/`, excluding tests).
- **Independent eval corpus**: the golden corpus is curated to labels; build an
  independent corpus + a live latency eval for a rigorous retrieval benchmark before
  promoting any reranker by eval evidence.
- **Builder Reflexion (codegen self-correction)**: `hypothesisBuildHandler` → `MastraBuilder.build`
  → `validateBundle` is a single pass — an invalid/failing bundle errors without self-correction. Add a
  bounded Reflexion loop (validation/sandbox errors → back into the builder context → capped retry) to
  lift codegen yield. Kill-switched on attempt count. (Agent-pattern checkup, 2026-06-19.)
- **Token/cost kill-switch**: we cap *time* (retrieval soft/hard deadlines, reranker timeout) and
  *depth* (`MAX_CYCLE_DEPTH`), but not *tokens/$* per request. Add a cumulative token/cost budget guard
  (mirror `RetrievalBudget`) that aborts over-budget work. Phoenix/Mastra provide the usage *numbers*;
  the *enforcement* (hard abort) is ours. Matters as agentic loops + the discovery floor grow.
