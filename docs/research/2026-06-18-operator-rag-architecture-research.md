# Operator RAG Architecture Research

- **Date:** 2026-06-18
- **Repository:** `trading-lab`
- **Status:** research note; Operator RAG selected as the first delivery target

## 1. Questions

This note records the investigation behind four architecture decisions:

1. Does conversational Operator require a second LLM call after intent classification?
2. Should retrieval use the already planned PostgreSQL/pgvector stack?
3. Should Hybrid Search, reranking, and evals use frameworks or custom code?
4. Is full Agentic RAG justified for the first Operator implementation?

## 2. Current repository context

- Chat currently uses a Mastra-backed intent classifier with schema-validated structured output.
- Analyst, Researcher, Critic, and Builder are already separate role-specific agents. Therefore, the system already contains multiple LLM roles; the design question is whether every chat turn needs multiple serial LLM calls.
- `docker-compose.yml` already runs `pgvector/pgvector:pg16`.
- `SimilarHypothesisSearchPort` was deliberately introduced as a seam for a future pgvector adapter. Runtime similarity is currently lexical Jaccard token overlap.
- Exact identity and deduplication remain deterministic fingerprint operations. Semantic similarity is advisory only.
- Mastra is already the main TypeScript agent framework and the codebase already has deterministic Vitest-based eval harnesses.
- A central Mastra runtime exists as the future observability attachment point. Phoenix/Langfuse-style tracing has not been implemented yet.

## 3. LLM topology

### Recommendation

Do not run two LLM calls for every chat turn. Replace the narrow intent classifier with a richer structured `Turn Interpreter`, then use deterministic retrieval and policy code.

```text
Turn Interpreter LLM
  -> deterministic Evidence Enricher
  -> deterministic Proposal Policy
  -> template-based confirmation response
```

The interpreter returns a typed result such as:

```ts
interface InterpretedTurn {
  subject: 'strategy' | 'bot' | 'results' | 'task' | 'unknown';
  goal: 'analyze' | 'research' | 'show_results' | null;
  constraints: Record<string, unknown>;
  references: readonly string[];
  confidence: number;
}
```

A second `Answer Synthesizer` LLM is conditional. It is useful only when a read-only answer must combine and explain several evidence items, for example comparing a strategy with prior research. It is not needed for confirmation copy or deterministic status/result rendering.

This creates two logical LLM roles without creating a mandatory two-model chain:

- **Turn Interpreter:** small/fast structured extraction on the initial message.
- **Answer Synthesizer:** optional grounded prose for complex read-only answers.

Analyst and Researcher remain asynchronous domain agents outside this per-turn chat path.

## 4. Retrieval storage

### Recommendation

Use the existing PostgreSQL deployment as the first retrieval platform:

- canonical structured data remains in normal relational tables;
- exact duplicate lookup remains fingerprint-based;
- PostgreSQL full-text search supplies lexical candidates;
- pgvector supplies semantic candidates;
- retrieval tables store source IDs, metadata, embeddings, and freshness, not canonical business truth.

This follows the original project architecture and avoids introducing Qdrant, Pinecone, or OpenSearch before there is evidence that PostgreSQL is insufficient.

### Important terminology

PostgreSQL built-in full-text ranking such as `ts_rank_cd` is lexical full-text search, but it is not BM25. The first implementation should be described accurately as:

```text
PostgreSQL FTS + pgvector + RRF + reranking
```

If strict BM25 becomes a requirement, it requires another component, for example a PostgreSQL search extension or an external search engine. That added infrastructure is not justified for the first Operator slice.

The pgvector project explicitly recommends combining vector search with PostgreSQL full-text search and mentions Reciprocal Rank Fusion or a cross-encoder for result combination: [pgvector Hybrid Search](https://github.com/pgvector/pgvector#hybrid-search).

## 5. Hybrid retrieval pipeline

Initial candidate pipeline:

```text
metadata filters
  -> PostgreSQL FTS top Klex
  -> pgvector/HNSW top Kvec
  -> Reciprocal Rank Fusion top Krff
  -> reranker top N
  -> typed evidence with sources and freshness
```

Values such as `50 / 50 / 20 / 5` are starting parameters, not product requirements. They must be tuned against an offline relevance dataset and p95 latency.

Use two indexes with different document granularity:

1. **Strategy Profile Index**
   - one document per canonical strategy profile;
   - normalized market, timeframe, direction, entry, exit, and risk attributes;
   - used for advisory similar-strategy retrieval.

2. **Research Artifact Index**
   - chunks of reports, hypothesis rationale, critic output, and notes;
   - metadata includes `profileId`, `taskId`, artifact type, timestamp, and access scope;
   - used for explanations such as `what was tried before` and `why was this hypothesis rejected`.

The first Operator slice needs the Strategy Profile Index. Artifact RAG can follow after the basic lookup flow is measurable.

## 6. Framework versus custom implementation

### Use framework primitives for

- document chunking and embedding;
- PG vector-store integration;
- reranking primitives;
- standard answer/context scorers;
- model-provider abstraction.

Mastra already exposes RAG, PG Vector Store, retrieval, reranking, and eval/scorer APIs:

- [Mastra RAG overview](https://mastra.ai/docs/rag/overview)
- [Mastra PG Vector Store](https://mastra.ai/reference/vectors/pg)
- [Mastra rerank](https://mastra.ai/reference/rag/rerank)
- [Mastra evals](https://mastra.ai/docs/evals/overview)

### Keep domain-specific code in trading-lab

- `StrategySimilarityPort` and `ArtifactRetrievalPort` contracts;
- metadata and authority rules;
- exact fingerprint lookup;
- source/freshness mapping;
- Reciprocal Rank Fusion;
- thresholds, result caps, and fallback behavior;
- deterministic decision about which evidence may affect a proposal.

RRF is a small transparent rank-fusion algorithm and does not justify a framework dependency by itself. Frameworks should not own canonical persistence or the decision that a semantic match is a duplicate.

## 7. Reranking options

The reranker operates only on the fused candidate set. It must support mixed Russian/English trading vocabulary.

Possible implementations:

- Mastra scorer/rerank integration;
- a hosted cross-encoder/rerank API;
- a local cross-encoder behind a separate adapter if offline operation becomes a requirement.

The domain port should hide the provider:

```ts
interface RerankerPort {
  rerank(query: string, candidates: readonly RetrievalCandidate[], limit: number): Promise<readonly RankedCandidate[]>;
}
```

This lets eval evidence decide whether a hosted provider, an LLM scorer, or a local cross-encoder is appropriate.

## 8. Evaluation strategy

Ragas and DeepEval are capable evaluation frameworks, but their primary open-source workflows are Python-based:

- [Ragas](https://github.com/vibrantlabsai/ragas) installs through `pip` and provides RAG metrics and test-data generation.
- [DeepEval](https://github.com/confident-ai/deepeval) is positioned as a pytest-like framework with RAG, agent, tool, and multi-turn metrics.

Adding a Python eval subsystem to a TypeScript codebase is not justified for the first slice. Use the existing test stack and Mastra scorers first.

### Retrieval evals

Run deterministic metrics over a human-labelled query/relevance dataset:

- `Recall@20` after RRF;
- `MRR`;
- `nDCG@5` after reranking;
- `Precision@5`;
- false exact-duplicate rate, which must remain zero because semantic retrieval cannot assert identity;
- p50/p95 retrieval and reranking latency.

### Generated-answer evals

Use Mastra/custom scorers for:

- context precision;
- context relevance;
- faithfulness;
- answer relevance;
- source attribution completeness.

LLM-as-judge is an additional quality signal, not the sole acceptance gate. Judge outputs must be calibrated against a small manually reviewed set.

Ragas or DeepEval can later run as an offline Python benchmark if the built-in TypeScript evaluation becomes insufficient. They should not be introduced merely to duplicate metrics already available in Mastra/Vitest.

## 9. Phoenix and observability

Phoenix remains a separate delivery task and does not block Operator RAG. The retrieval implementation should emit stable trace/event attributes now so Phoenix can ingest them later:

- query/subject hash, never raw sensitive content by default;
- lexical/vector candidate counts;
- RRF and reranker top-K;
- selected source IDs and freshness;
- model/provider and token usage;
- per-stage latency;
- fallback/degradation reason;
- proposal/session correlation IDs.

Phoenix supports TypeScript tracing, evaluations, datasets, and experiments through its current TypeScript SDK surface: [Phoenix TypeScript tracing](https://arize.com/docs/phoenix/get-started/ts-get-started-tracing), [Phoenix TypeScript evaluations](https://arize.com/docs/phoenix/get-started/ts-get-started-evaluations).

Phoenix is observability and experiment storage, not a canonical business-data repository or a runtime policy engine.

## 10. Agentic RAG assessment

### Full Agentic RAG is not recommended for the first Operator slice

An autonomous planner/retriever/reflection loop adds:

- serial LLM latency and cost;
- nondeterministic source selection;
- more failure and retry states;
- harder regression testing;
- a risk that self-critique is mistaken for factual validation;
- unnecessary complexity for confirmation and straightforward lookup questions.

Cross-system retrieval alone does not require Agentic RAG. The deterministic `Evidence Enricher` can query repositories, read APIs, vector search, and RAG adapters in parallel and apply explicit authority rules.

### Recommended intermediate pattern: bounded corrective retrieval

```text
retrieve once
  -> deterministic coverage checks
  -> if evidence is insufficient, rewrite the query once
  -> retrieve a second time
  -> stop and disclose remaining gaps
```

The loop is capped at two retrieval attempts. Query rewriting may use an LLM, but the retry decision and maximum iteration count are deterministic.

### Where Agentic RAG may become useful

Agentic retrieval is a better fit for a later Researcher enhancement that must connect:

- strategy profiles;
- several bot runs;
- backtests;
- prior hypotheses;
- critic reports;
- research artifacts.

That later feature should be justified by eval cases where single-shot or bounded retrieval demonstrably fails on multi-hop questions.

## 11. Decision and delivery order

The first RAG scenario is **fast Operator lookup** because it is the entry point for the conversational workflow.

Recommended delivery sequence:

1. Finish confirmation core: proposal, explicit confirmation, deterministic enqueue.
2. Add Operator structured enrichment and exact strategy lookup.
3. Add Strategy Profile Index with PostgreSQL FTS + pgvector.
4. Add RRF and optional reranking behind ports.
5. Add Operator retrieval eval dataset and CI metrics.
6. Add optional Answer Synthesizer for complex read-only responses.
7. Add Phoenix tracing/experiments as a separate observability feature.
8. Add Research Artifact Index.
9. Evaluate bounded corrective retrieval for Researcher.
10. Consider full Agentic RAG only if multi-hop eval failures justify it.

This order keeps the Operator useful early, preserves deterministic safety boundaries, and produces evaluation evidence before increasing agent autonomy.
