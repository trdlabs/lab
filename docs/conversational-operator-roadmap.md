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
| 4 | Bot catalog + entity disambiguation | 🔜 Backlog |
| 5 | Researcher / Artifact RAG | 🔜 Backlog |
| — | Phoenix observability | 🔜 Backlog |
| — | Answer Synthesizer (optional) | 🔜 Backlog |
| — | Agentic RAG (bounded corrective) | 🕓 Later (only if eval justifies) |
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

### 4. Bot catalog + entity disambiguation
A lab-side `BotCatalogReadPort` (stable botId, aliases, strategy ref, market/symbol/
timeframe/direction, status) backed by the platform SDK; `entity_disambiguation`
pending-interaction + ranked candidate selection. If the upstream surface lacks
the identity metadata, extending it is an explicit prerequisite. Reference: design §8.

### 5. Researcher / Artifact RAG
A second index over research-report / hypothesis-rationale / critic-output / notes
chunks (with profileId/taskId/type/timestamp metadata) for explanatory answers
("what was tried before", "why was this hypothesis rejected"). Reference: research §5.

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
