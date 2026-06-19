# Operator RAG: Budgeted Hybrid Retrieval Design

- **Date:** 2026-06-19
- **Repository:** `trading-lab`
- **Branch:** `feat/conversational-operator`
- **Status:** design approved; implementation plan pending

## 1. Goal

Add fast, evidence-first retrieval to the conversational Operator so a strategy description can be recognized without magic prefixes, checked against canonical data, compared with similar stored strategies, and presented as a grounded proposal before any task is created.

The service-level objective is:

- target end-to-end Operator response: **p95 at or below 5 seconds**;
- hard deadline: **10 seconds**;
- partial-source failure returns explicitly degraded evidence instead of a false `nothing found` claim.

This feature depends on the confirmation-core slice. Retrieval may inform a proposal, but only the existing deterministic confirmation guard may create a task.

## 2. Approved decisions

1. **Operator lookup first.** Researcher artifact retrieval and Agentic RAG are later independent features.
2. **One mandatory LLM call.** The current intent classifier evolves into a typed `TurnInterpreter`; retrieval and proposal policy remain deterministic.
3. **No mandatory answer-generation call.** An `AnswerSynthesizer` is deferred. First-slice proposal and lookup replies use deterministic rendering.
4. **PostgreSQL remains the retrieval platform.** Canonical tables remain the source of truth; PostgreSQL FTS and pgvector are rebuildable retrieval projections.
5. **Hybrid pipeline:** exact/structured reads plus PostgreSQL FTS and pgvector, fused with RRF; reranking is conditional and fail-soft.
6. **FTS is not called BM25.** Built-in PostgreSQL full-text ranking is used in v1. Strict BM25 would require another extension/service and is out of scope.
7. **Embedding provider is separate from chat provider.** Initial adapter uses OpenRouter Embeddings with `baai/bge-m3`, producing 1024-dimensional multilingual vectors.
8. **Reranker is provider-abstracted.** RRF is the required baseline; the initial optional adapter uses Mastra reranking. It must not be described as a cross-encoder.
9. **TypeScript-native eval first.** Vitest retrieval metrics and Mastra scorers are used before adding Ragas or DeepEval.
10. **Phoenix later.** This feature emits Phoenix/OpenTelemetry-compatible attributes but does not deploy observability infrastructure.

References:

- [pgvector Hybrid Search](https://github.com/pgvector/pgvector#hybrid-search)
- [Mastra RAG](https://mastra.ai/docs/rag/overview)
- [Mastra rerank](https://mastra.ai/reference/rag/rerank)
- [Mastra evals](https://mastra.ai/docs/evals/overview)
- [OpenRouter Embeddings API](https://openrouter.ai/docs/api/reference/embeddings)
- [Phoenix TypeScript tracing](https://arize.com/docs/phoenix/get-started/ts-get-started-tracing)

## 3. Runtime architecture

```text
message + verified session context
  -> TurnInterpreter LLM
  -> OperatorRetrievalPlanner
       -> exact fingerprint lookup
       -> structured repository reads
       -> lexical FTS query       ┐ parallel
       -> pgvector query          ┘
  -> RRF fusion
  -> conditional RerankerPort
  -> EvidencePolicy
  -> deterministic assistant_message + proposed actions
  -> confirmation core
```

### 3.1 TurnInterpreter

The existing classifier is expanded rather than followed by a second interpretation LLM.

```ts
interface InterpretedTurn {
  subject: 'strategy' | 'bot' | 'results' | 'task' | 'hypothesis' | 'unknown';
  goal: 'analyze' | 'research' | 'show_results' | 'show_similar' | null;
  strategyText?: string;
  constraints: {
    market?: string;
    symbol?: string;
    timeframe?: string;
    direction?: 'long' | 'short' | 'both';
  };
  references: readonly string[];
  confidence: number;
}
```

Provider output uses a required-and-nullable wire schema and is normalized before domain validation, following the existing OpenAI-compatible structured-output boundary.

The interpreter performs no reads, writes, retrieval, or task creation.

### 3.2 OperatorRetrievalPlanner

The planner chooses read-only sources from the typed interpretation. It is deterministic and bounded:

- strategy subject: exact/structured plus strategy hybrid search;
- explicit exact ID/fingerprint: exact lookup only unless the user requests alternatives;
- unsupported subject: no vector query;
- low-confidence interpretation: clarification, not speculative retrieval.

Structured, lexical, and vector reads execute in parallel after interpretation. Exact fingerprint identity always outranks semantic similarity.

### 3.3 EvidencePolicy

The policy converts source results into typed evidence and warnings. It never accepts generated prose as a canonical fact.

```ts
interface OperatorEvidence {
  subjectHash: string;
  exactMatch?: StrategyEvidence;
  structuredFacts: readonly StructuredEvidence[];
  similarStrategies: readonly SimilarStrategyEvidence[];
  sources: readonly EvidenceSource[];
  freshness: 'fresh' | 'stale' | 'degraded';
  warnings: readonly EvidenceWarning[];
}
```

Each item contains a canonical source ID, source type, observed timestamp, and retrieval method. A timeout or source error becomes a warning; it is never converted to an empty authoritative result.

## 4. Storage and indexing

Canonical strategy profiles remain in `strategy_profile`. Add a rebuildable retrieval projection with one row per canonical profile:

```text
strategy_retrieval_document
  strategy_profile_id  PK/FK-like canonical reference
  content              normalized retrieval document
  content_hash         detects stale projection
  search_vector        tsvector, GIN indexed
  embedding            vector(1024), HNSW indexed
  embedding_model      text
  index_version        integer
  metadata             jsonb
  indexed_at           timestamptz
```

The projection metadata includes market, symbol, timeframe, direction, profile version, and canonical timestamps. Metadata filters are applied before or with retrieval where supported.

### 4.1 Lexical projection

Use PostgreSQL `simple` text-search configuration in v1 to preserve mixed Russian/English trading terms, tickers, abbreviations, and indicator names. Semantic morphology is handled by the vector branch. The FTS query returns a bounded top 50 ordered by PostgreSQL full-text rank.

### 4.2 Vector projection

Initial embedding configuration:

```text
OPERATOR_EMBEDDING_PROVIDER=openrouter
OPERATOR_EMBEDDING_MODEL=baai/bge-m3
OPERATOR_EMBEDDING_DIMENSIONS=1024
OPERATOR_RETRIEVAL_INDEX_VERSION=1
```

The OpenRouter key is reused for transport authentication, but embedding configuration is independent of `MODEL_PROVIDER` and role chat models.

At startup, configuration fails closed if the configured dimension differs from the schema dimension. Changing model or normalization rules requires a new index version and full reindex; vectors from different models are never mixed in one active index.

### 4.3 Projection updates

Strategy onboarding remains canonical even if indexing fails. After a profile is stored, a retrieval indexer attempts to upsert its projection and emits either:

- `retrieval.strategy_indexed`, or
- `retrieval.strategy_index_failed` with a reason code and profile ID.

Indexing failure does not fail strategy onboarding. A deterministic `operator-rag:reindex` command scans canonical profiles and repairs missing/stale projections by comparing `content_hash`, `embedding_model`, and `index_version`.

The first slice uses this fail-soft synchronous post-persistence attempt plus the repair command; a transactional outbox is deferred until operational evidence shows it is necessary.

## 5. Hexagonal ports

```ts
interface EmbeddingPort {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

interface StrategyRetrievalIndexPort {
  upsert(document: StrategyRetrievalDocument): Promise<void>;
  rebuild(profiles: AsyncIterable<StrategyProfile>): Promise<ReindexSummary>;
}

interface StrategySimilarityPort {
  search(query: StrategySimilarityQuery): Promise<StrategyCandidateSet>;
}

interface RerankerPort {
  rerank(
    query: string,
    candidates: readonly RetrievalCandidate[],
    limit: number,
  ): Promise<readonly RankedCandidate[]>;
}
```

Adapters:

- `OpenRouterEmbeddingAdapter` calls the OpenRouter embeddings endpoint.
- `PgStrategyRetrievalIndexAdapter` owns projection upserts and reindex reads/writes.
- `PgHybridStrategySimilarityAdapter` owns FTS/pgvector queries and RRF.
- `MastraRerankerAdapter` is optional and feature-flagged.
- fake/in-memory adapters provide deterministic tests.

The PostgreSQL adapters use explicit Drizzle/SQL rather than allowing a framework-owned vector schema. This keeps FTS, pgvector, metadata, index versioning, and canonical IDs in one controlled projection. Mastra is used for reranking/scoring where it adds value, not as the owner of domain persistence.

## 6. Hybrid retrieval and RRF

Default candidate limits:

```text
lexical top-K = 50
vector top-K = 50
RRF candidate set = 20
final result set = 5
RRF k = 60
```

RRF score:

```text
score(document) = sum(1 / (60 + rank_in_source))
```

Exact and structured matches do not participate in RRF; they are separate higher-authority evidence.

`PgHybridStrategySimilarityAdapter` returns lexical rank, vector rank/distance, RRF score, metadata, and source profile ID. It must not label a semantic result as an exact duplicate.

## 7. Conditional reranking

RRF-only ordering is the mandatory baseline and fallback. Reranking runs only when all conditions hold:

- at least two fused candidates exist;
- remaining request budget permits the configured reranker timeout;
- no exact match fully answers the lookup; and
- one of these triggers is true:
  - user explicitly requested comparison;
  - top candidates fall within the configured RRF ambiguity margin;
  - fused candidate count exceeds the policy threshold.

Initial configuration:

```text
OPERATOR_RERANKER=mastra | none
OPERATOR_RERANK_TIMEOUT_MS=1500
OPERATOR_RERANK_LIMIT=5
OPERATOR_RERANK_MIN_CANDIDATES=10
OPERATOR_RERANK_RRF_MARGIN=0.002
```

The initial production default is `OPERATOR_RERANKER=none`. The Mastra adapter is enabled only after it passes the eval gates below. The ambiguity trigger applies when the absolute RRF-score difference between the first two candidates is at most `0.002`; the volume trigger applies when the fused set contains at least ten candidates.

`MastraRerankerAdapter` uses Mastra semantic/vector/position scoring. It is not called a cross-encoder. A future `CrossEncoderRerankerAdapter` may replace it only after offline eval proves a meaningful ranking improvement within the latency budget.

Reranker failure or timeout returns the RRF order and adds a degraded warning.

## 8. Deadline and degradation policy

The request owns one monotonic deadline budget:

```text
0–1.5s   TurnInterpreter
1.5–3s   parallel exact/structured/lexical/vector retrieval
3–4.5s   conditional reranker
<=5s     evidence policy and response
5–10s    finish already-started safe response work; start no new model/retrieval calls
10s      abort remaining work and return available degraded evidence
```

Rules:

- every adapter receives an `AbortSignal` or deadline;
- no retry is started after the 5-second soft deadline;
- hard timeout never becomes an empty-success result;
- vector failure falls back to structured plus lexical evidence;
- lexical failure falls back to structured plus vector evidence;
- both similarity branches failing still allow exact/structured answers;
- exact/structured source failure is explicitly disclosed.

## 9. Response behavior

The first slice uses deterministic rendering, for example:

```text
Я понял это как long-стратегию отскока на 1m с DCA.
Точного совпадения нет. Найдены три похожих профиля; два отличаются стоп-логикой.
Предлагаю создать новый профиль и провести анализ.
```

Evidence cards contain profile ID/label, why it matched, source type, and freshness. The user may confirm analysis, inspect similar profiles, refine the strategy, or cancel.

No Answer Synthesizer is used in v1. Complex cross-document prose is deferred to the Artifact RAG slice.

## 10. Evaluation

### 10.1 Golden dataset

Create a versioned Russian/English fixture dataset:

```ts
interface StrategyRetrievalEvalCase {
  id: string;
  query: string;
  language: 'ru' | 'en' | 'mixed';
  filters: StrategySimilarityFilters;
  expectedRelevantIds: readonly string[];
  gradedRelevance: Readonly<Record<string, 0 | 1 | 2 | 3>>;
  expectedExactId?: string;
}
```

The initial dataset contains standalone descriptions, paraphrases, exact copies, misleading shared terminology, mixed-language trading terms, and strategies differing only in risk/exit rules.

### 10.2 CI metrics

Run with Vitest and deterministic fixtures on every PR:

- exact identity accuracy: 100%;
- semantic result falsely marked exact: 0;
- RRF `Recall@20 >= 0.90`;
- report MRR and `nDCG@5`;
- reranker-enabled `nDCG@5` must not regress against RRF baseline;
- reranker becomes default only after at least `+0.02 nDCG@5` improvement on the approved dataset;
- fallback and hard-deadline tests use controlled fake clocks/adapters.

Wall-clock provider latency is measured in a separate live/offline eval, not a flaky PR gate.

### 10.3 Offline answer metrics

Mastra scorers evaluate context precision and context relevance for evidence selection. Faithfulness and answer relevance are added when Answer Synthesizer exists. LLM-as-judge results are calibrated against human-labelled examples and never act as the sole acceptance gate.

Ragas and DeepEval are not dependencies in this slice. They may later be used as an offline Python benchmark only if the TypeScript eval surface lacks a required metric.

## 11. Observability contract

Canonical audit event names (canonical implemented names):

```text
chat.turn.interpreted
chat.retrieval.completed
chat.proposal.created
chat.proposal.confirmed
chat.proposal.cancelled
chat.proposal.expired
chat.proposal.unresolved_reply
chat.task_created
retrieval.strategy_indexed
retrieval.strategy_index_failed
```

Emit audit events now with fields that can later become Phoenix/OpenTelemetry span attributes:

```text
retrievalId
sessionId
subjectHash
indexVersion
embeddingModel
lexicalCandidateCount
vectorCandidateCount
fusedCandidateCount
rerankerUsed
selectedSourceIds
freshness
degradedReasonCodes
interpreterMs / structuredMs / lexicalMs / vectorMs / rerankMs / totalMs
model/provider/token usage where available
```

Raw strategy text, retrieved document bodies, credentials, and embeddings are not written to audit events. Phoenix deployment, dashboards, and trace export are a separate feature.

## 12. Failure, safety, and consistency

- Retrieval is read-only and cannot enqueue a task.
- Proposal creation still requires the confirmation-core policy.
- Fingerprint lookup is the only exact duplicate authority.
- Index rows are invalid when their profile is missing, content hash is stale, or index/model version differs; invalid rows are excluded and reported.
- Provider errors expose stable reason codes, not secret-bearing raw responses.
- Embedding input is bounded and derived from normalized strategy fields.
- Prompt injection inside strategy text remains data; it is never inserted into system/tool instructions.
- Research-only and no-live-trading invariants remain unchanged.

## 13. Delivery order

1. Complete and verify conversational confirmation core.
2. Expand classifier into `TurnInterpreter` while preserving the existing trust boundary.
3. Add retrieval projection schema, embedding/index ports, OpenRouter adapter, and reindex command.
4. Add exact/structured Operator enrichment.
5. Add PostgreSQL FTS and pgvector candidate retrieval.
6. Add RRF baseline and golden retrieval eval.
7. Add evidence policy, deadline budget, deterministic response, and actions.
8. Add optional Mastra reranker behind feature flag and enable only if eval gates pass.
9. Add live latency eval and Phoenix-compatible event fields.

## 14. Non-goals

- Research Artifact Index and document chunk RAG.
- Answer Synthesizer LLM.
- Agentic RAG, query-planner agents, reflection loops, or iterative retrieval.
- Strict BM25 or a new search service/extension.
- Bot catalog/entity disambiguation.
- Phoenix deployment or observability UI.
- Ragas/DeepEval runtime dependencies.
- Replacing canonical repositories with vector search.
- Any live trading or execution capability.
