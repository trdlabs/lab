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
| 3 | Meaningful completion replies | ⏳ Next |
| — | Reranker follow-up | ⏳ Next (baseline eval now exists) |
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

### 3. Meaningful completion replies  — HIGH (the "Done" problem)
Replace the generic `Done` worker-completion in Office with a domain summary
(profile/hypotheses/run links + key metrics). The current two slices do NOT solve
this. Needs its own design + plan. Reference: design §11 (final completion should
render a domain summary, not `Done`).

### Reranker follow-up  — now unblocked
A baseline eval exists, so the conditional `MastraRerankerAdapter` (the
`RerankerPort` seam is already in place) can be added behind `OPERATOR_RERANKER`
and enabled only if it shows ≥ +0.02 nDCG@5 over the RRF baseline within the
latency budget. Needs its own design/plan. Reference: operator-rag design §7.

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

### TurnInterpreter live-model eval
Measure real-model interpretation quality (subject/goal/constraint extraction)
with a labelled set, mirroring the intent-classifier eval harness. The current
mastra adapter has a correct prompt but its live quality is unmeasured.

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
