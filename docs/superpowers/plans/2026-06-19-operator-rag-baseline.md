# Operator RAG Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a five-second-budgeted Operator lookup path that interprets strategy messages, enriches them with exact and structured facts, retrieves similar profiles through PostgreSQL FTS plus pgvector, fuses candidates with RRF, and returns evidence-first proposals without creating tasks before confirmation.

**Architecture:** Evolve the existing intent classifier into one schema-validated `TurnInterpreter` call, then run deterministic exact/structured/hybrid retrieval behind hexagonal ports. Store rebuildable 1024-dimensional strategy retrieval projections in PostgreSQL, use RRF as the measured baseline, and integrate typed evidence into the already-implemented confirmation core. This plan intentionally stops before `MastraRerankerAdapter`; reranking gets a separate plan only after baseline eval data exists.

**Tech Stack:** TypeScript ESM, Mastra structured output, OpenRouter Embeddings, PostgreSQL 16 + pgvector, Drizzle ORM, Zod, Hono, Vitest.

---

## Prerequisite

Execute and merge the confirmation-core plan first:

`docs/superpowers/plans/2026-06-18-conversational-operator-confirmation-core.md`

Before Task 1, require these symbols to exist and their tests to pass:

```text
ActionProposalRepository
ChatSessionContext.pendingInteraction
ChatResponse.kind === 'assistant_message'
handleChatMessage confirmation branch
```

Run:

```bash
pnpm typecheck
pnpm vitest run src/chat/chat-handler.test.ts test/e2e/chat-to-task.test.ts
```

Expected: PASS. If the prerequisite is not implemented, stop; do not combine both plans into one change set.

## Scope

Included:

- one richer Turn Interpreter LLM call;
- exact fingerprint and structured profile evidence;
- OpenRouter `baai/bge-m3` embeddings;
- rebuildable strategy retrieval projection;
- PostgreSQL FTS + pgvector candidates;
- pure RRF fusion and golden eval;
- five-second soft and ten-second hard deadlines;
- deterministic evidence-first proposal rendering;
- Phoenix-compatible audit fields.

Excluded:

- Mastra or cross-encoder reranker implementation;
- Answer Synthesizer;
- research-artifact chunk RAG;
- Agentic RAG or query rewriting;
- bot catalog;
- Phoenix deployment;
- Ragas or DeepEval.

## File Map

**Create:**

- `src/chat/turn-interpretation.ts` — trusted domain schema for interpreted turns.
- `src/chat/turn-provider-schema.ts` — required-and-nullable provider wire schema.
- `src/ports/turn-interpreter.port.ts` — advisory interpreter boundary.
- `src/adapters/intent/fake-turn-interpreter.ts` — deterministic adapter.
- `src/adapters/intent/mastra-turn-interpreter.ts` — structured Mastra adapter.
- `src/domain/strategy-retrieval.ts` — retrieval documents, queries, candidates, evidence.
- `src/ports/embedding.port.ts` — embedding boundary.
- `src/ports/strategy-retrieval-index.port.ts` — projection writer boundary.
- `src/ports/strategy-similarity.port.ts` — hybrid search boundary.
- `src/ports/operator-retrieval.port.ts` — chat-facing evidence boundary.
- `src/adapters/embedding/openrouter-embedding.adapter.ts` — OpenRouter embedding transport.
- `src/adapters/repository/pg-strategy-retrieval-index.adapter.ts` — projection persistence.
- `src/adapters/similarity/rrf.ts` — pure rank fusion.
- `src/adapters/similarity/pg-hybrid-strategy-similarity.adapter.ts` — FTS/vector retrieval.
- `src/adapters/similarity/in-memory-strategy-similarity.adapter.ts` — deterministic tests.
- `src/operator/strategy-retrieval-document.ts` — canonical profile-to-document mapping.
- `src/operator/strategy-retrieval-indexer.ts` — fail-soft indexing service.
- `src/operator/operator-retrieval.ts` — deadline-aware evidence orchestration.
- `src/operator/disabled-operator-retrieval.ts` — no-I/O feature-flag adapter.
- `src/operator/operator-response.ts` — deterministic evidence rendering.
- `scripts/operator-rag-reindex.ts` — repair/rebuild CLI.
- `scripts/operator-rag-eval.ts` — dry-run/live eval entrypoint.
- `src/experiments/operator-rag/**` — fixtures, metrics, harness, and reports.
- `src/experiments/operator-rag/__fixtures__/strategy-retrieval-v1.json` — labelled RU/EN/mixed dataset.
- `migrations/0010_operator_rag_baseline.sql` and `migrations/meta/0010_snapshot.json` — named Drizzle migration after confirmation-core migration `0009`.

**Modify:**

- `src/chat/guard.ts` — consume `InterpretedTurn` instead of `ChatIntent`.
- `src/chat/chat-handler.ts` — invoke retrieval before proposal persistence.
- `src/chat/response.ts` — expose typed evidence cards.
- `src/domain/action-proposal.ts` — persist evidence references with proposal.
- `src/ports/action-proposal.repository.ts` and adapters — round-trip evidence references.
- `src/ports/strategy-profile.repository.ts` and adapters — list profiles for reindex.
- `src/db/schema.ts` — retrieval projection and proposal evidence column.
- `src/config/env.ts` — retrieval configuration.
- `src/orchestrator/app-services.ts` — indexing service dependencies.
- `src/orchestrator/handlers/strategy-onboard.handler.ts` — fail-soft projection update.
- `src/composition.ts` and `test/support/make-services.ts` — runtime wiring.
- `package.json` — reindex/eval scripts.
- `src/chat/README.md` — Operator evidence flow.

### Task 1: Replace narrow intent output with a typed Turn Interpreter

**Files:**
- Create: `src/chat/turn-interpretation.ts`
- Create: `src/chat/turn-provider-schema.ts`
- Create: `src/ports/turn-interpreter.port.ts`
- Create: `src/adapters/intent/fake-turn-interpreter.ts`
- Create: `src/adapters/intent/mastra-turn-interpreter.ts`
- Test: `src/adapters/intent/fake-turn-interpreter.test.ts`
- Test: `src/adapters/intent/mastra-turn-interpreter.test.ts`

- [ ] **Step 1: Write failing schema and adapter tests**

Test that a standalone description produces:

```ts
{
  subject: 'strategy',
  goal: undefined,
  strategyText: originalMessage,
  constraints: { timeframe: '1m', direction: 'long' },
  references: [],
  confidence: 0.9,
}
```

Test that `проанализируй эту стратегию: ...` has `goal: 'analyze'`, while `исследуй ...` has `goal: 'research'`. Test that provider output with nullable optional fields is normalized before domain validation.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm vitest run src/adapters/intent/fake-turn-interpreter.test.ts src/adapters/intent/mastra-turn-interpreter.test.ts
```

Expected: FAIL because the new schemas and adapters do not exist.

- [ ] **Step 3: Add the domain schema**

```ts
// src/chat/turn-interpretation.ts
import { z } from 'zod';

export const SUBJECTS = ['strategy', 'bot', 'results', 'task', 'hypothesis', 'unknown'] as const;
export const TURN_GOALS = ['analyze', 'research', 'show_results', 'show_similar'] as const;

export const TurnInterpretationSchema = z.object({
  subject: z.enum(SUBJECTS),
  goal: z.enum(TURN_GOALS).optional(),
  strategyText: z.string().min(1).optional(),
  constraints: z.object({
    market: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    timeframe: z.string().min(1).optional(),
    direction: z.enum(['long', 'short', 'both']).optional(),
  }).strict(),
  references: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
}).strict();

export type InterpretedTurn = z.infer<typeof TurnInterpretationSchema>;
```

Create `TurnProviderSchema` by nullableizing every optional property, including optional fields inside `constraints`, using the same required-and-nullable rule as the current `ChatIntentProviderSchema`.

- [ ] **Step 4: Implement adapters**

```ts
// src/ports/turn-interpreter.port.ts
export interface TurnInterpreterPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  interpret(message: string): Promise<unknown>;
}
```

`MastraTurnInterpreter` sends one prompt and one structured-output request. It has no tools. `FakeTurnInterpreter` extracts standalone strategy descriptions and explicit goals deterministically.

Do not switch `ChatHandlerDeps` or composition in this task. The new seam compiles alongside the current classifier until Task 8 performs one atomic runtime migration; there is still only one active runtime path.

- [ ] **Step 5: Run focused verification**

Run:

```bash
pnpm typecheck
pnpm vitest run src/adapters/intent/fake-turn-interpreter.test.ts src/adapters/intent/mastra-turn-interpreter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/chat/turn-interpretation.ts src/chat/turn-provider-schema.ts \
  src/ports/turn-interpreter.port.ts src/adapters/intent/fake-turn-interpreter.ts \
  src/adapters/intent/fake-turn-interpreter.test.ts src/adapters/intent/mastra-turn-interpreter.ts \
  src/adapters/intent/mastra-turn-interpreter.test.ts
git commit -m "refactor(chat): interpret subjects and goals in one model call"
```

### Task 2: Define retrieval contracts and pure RRF

**Files:**
- Create: `src/domain/strategy-retrieval.ts`
- Create: `src/ports/embedding.port.ts`
- Create: `src/ports/strategy-retrieval-index.port.ts`
- Create: `src/ports/strategy-similarity.port.ts`
- Create: `src/adapters/similarity/rrf.ts`
- Test: `src/adapters/similarity/rrf.test.ts`

- [ ] **Step 1: Write failing RRF tests**

```ts
it('fuses lexical and vector ranks with deterministic id tiebreak', () => {
  const result = reciprocalRankFusion({
    lexical: [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }],
    vector: [{ id: 'b', rank: 1 }, { id: 'c', rank: 2 }],
  }, { k: 60, limit: 20 });
  expect(result.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  expect(result[0]!.score).toBeCloseTo(1 / 62 + 1 / 61);
});
```

Also test empty branches, duplicate IDs inside one branch rejection, limit enforcement, and stable ID ordering for equal scores.

- [ ] **Step 2: Run the test to verify failure**

Run: `pnpm vitest run src/adapters/similarity/rrf.test.ts`

Expected: FAIL because contracts and RRF do not exist.

- [ ] **Step 3: Add complete domain contracts**

Define:

```ts
export interface StrategyRetrievalDocument {
  strategyProfileId: string;
  content: string;
  contentHash: string;
  embedding: readonly number[];
  embeddingModel: string;
  indexVersion: number;
  metadata: StrategyRetrievalMetadata;
  indexedAt: string;
}

export interface StrategySimilarityQuery {
  text: string;
  embedding: readonly number[];
  filters: { market?: string; symbol?: string; timeframe?: string; direction?: 'long' | 'short' | 'both' };
  lexicalLimit: number;
  vectorLimit: number;
  fusedLimit: number;
  excludeProfileId?: string;
  signal?: AbortSignal;
}

export interface SimilarStrategyCandidate {
  strategyProfileId: string;
  lexicalRank?: number;
  lexicalScore?: number;
  vectorRank?: number;
  vectorDistance?: number;
  rrfScore: number;
  metadata: StrategyRetrievalMetadata;
}

export interface EvidenceRef {
  sourceType: 'strategy_profile' | 'retrieval_projection';
  sourceId: string;
  retrievalMethod: 'exact' | 'structured' | 'lexical' | 'vector' | 'rrf';
  observedAt: string;
}

export interface StrategyCandidateSet {
  candidates: readonly SimilarStrategyCandidate[];
  degradedReasonCodes: readonly string[];
}

export interface OperatorEvidence {
  subjectHash: string;
  status: 'disabled' | 'complete' | 'degraded';
  exactLookup: 'not_run' | 'hit' | 'miss' | 'failed';
  exactMatch?: { strategyProfileId: string; label: string; observedAt: string };
  similarStrategies: readonly SimilarStrategyCandidate[];
  evidenceRefs: readonly EvidenceRef[];
  warningCodes: readonly string[];
  timingsMs: Readonly<Record<string, number>>;
}
```

Add the exact port signatures:

```ts
export interface EmbeddingPort {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
}

export interface StrategyRetrievalIndexPort {
  findByProfileId(profileId: string): Promise<StrategyRetrievalDocument | null>;
  upsert(document: StrategyRetrievalDocument): Promise<void>;
  delete(profileId: string): Promise<void>;
}

export interface StrategySimilarityPort {
  search(query: StrategySimilarityQuery): Promise<StrategyCandidateSet>;
}

export interface RerankerPort {
  rerank(query: string, candidates: readonly SimilarStrategyCandidate[], limit: number, signal?: AbortSignal):
    Promise<readonly SimilarStrategyCandidate[]>;
}
```

No reranker implementation is created in this baseline plan; the port preserves the approved seam.

- [ ] **Step 4: Implement RRF**

Implement `reciprocalRankFusion()` as a pure function using `1 / (k + rank)`, sorting by score descending and ID ascending. Preserve source ranks in the output.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run src/adapters/similarity/rrf.test.ts`

Expected: PASS.

```bash
git add src/domain/strategy-retrieval.ts src/ports/embedding.port.ts \
  src/ports/strategy-retrieval-index.port.ts src/ports/strategy-similarity.port.ts \
  src/adapters/similarity/rrf.ts src/adapters/similarity/rrf.test.ts
git commit -m "feat(rag): define strategy retrieval ports and RRF"
```

### Task 3: Add retrieval configuration and OpenRouter embeddings

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Create: `src/adapters/embedding/openrouter-embedding.adapter.ts`
- Test: `src/adapters/embedding/openrouter-embedding.adapter.test.ts`

- [ ] **Step 1: Write failing config and HTTP adapter tests**

Assert defaults:

```ts
expect(env.OPERATOR_RAG_ENABLED).toBe(false);
expect(env.OPERATOR_EMBEDDING_PROVIDER).toBe('openrouter');
expect(env.OPERATOR_EMBEDDING_MODEL).toBe('baai/bge-m3');
expect(env.OPERATOR_EMBEDDING_DIMENSIONS).toBe(1024);
expect(env.OPERATOR_RETRIEVAL_INDEX_VERSION).toBe(1);
expect(env.OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS).toBe(5000);
expect(env.OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS).toBe(10000);
```

Mock `fetch` and assert `POST https://openrouter.ai/api/v1/embeddings`, bearer auth, requested model, ordered batch output, abort forwarding, non-2xx error sanitization, and dimension mismatch rejection.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm vitest run src/config/env.test.ts src/adapters/embedding/openrouter-embedding.adapter.test.ts
```

Expected: FAIL on missing config and adapter.

- [ ] **Step 3: Add strict configuration**

Add the fields above plus fixed candidate limits `50/50/20`. Reject a configured embedding dimension other than `1024`; reject a hard timeout lower than the soft timeout. Keep Operator RAG disabled by default.

- [ ] **Step 4: Implement the adapter**

```ts
export class OpenRouterEmbeddingAdapter implements EmbeddingPort {
  readonly dimensions = 1024;
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]> {
    // POST ordered inputs; validate response item count, index order, finite values, and 1024 dimensions.
  }
}
```

Never log request text, embeddings, API key, or raw provider bodies.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm typecheck
pnpm vitest run src/config/env.test.ts src/adapters/embedding/openrouter-embedding.adapter.test.ts
```

Expected: PASS.

```bash
git add src/config/env.ts src/config/env.test.ts \
  src/adapters/embedding/openrouter-embedding.adapter.ts \
  src/adapters/embedding/openrouter-embedding.adapter.test.ts
git commit -m "feat(rag): configure OpenRouter strategy embeddings"
```

### Task 4: Add the PostgreSQL retrieval projection

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/domain/action-proposal.ts`
- Modify: `src/ports/action-proposal.repository.ts`
- Modify: `src/adapters/repository/in-memory-action-proposal.repository.ts`
- Modify: `src/adapters/repository/drizzle-action-proposal.repository.ts`
- Test: action-proposal repository tests
- Create: `src/adapters/repository/pg-strategy-retrieval-index.adapter.ts`
- Test: `src/adapters/repository/pg-strategy-retrieval-index.adapter.test.ts`
- Generated: `migrations/0010_operator_rag_baseline.sql`
- Generated: `migrations/meta/0010_snapshot.json`
- Modify: `migrations/meta/_journal.json`

- [ ] **Step 1: Write failing adapter integration tests**

With `DATABASE_URL`, test upsert/read replacement, delete, 1024-dimensional validation, metadata round trip, and stale index/model exclusion. Also extend both action-proposal repository suites to round-trip `evidenceRefs` and `evidenceWarnings`. Skip DB suites cleanly without DB config.

- [ ] **Step 2: Add the schema**

Use Drizzle `vector('embedding', { dimensions: 1024 })`, a `customType` for `tsvector`, JSON metadata, and timestamps. Generate a stored `search_vector` from `to_tsvector('simple', content)`. Add:

```text
PRIMARY KEY(strategy_profile_id)
GIN(search_vector)
HNSW(embedding vector_cosine_ops)
INDEX(index_version, embedding_model)
```

The migration must include `CREATE EXTENSION IF NOT EXISTS vector` before the table.

Add `evidenceRefs: EvidenceRef[]` and `evidenceWarnings: string[]` to `ActionProposal`. Add non-null JSONB columns with empty-array defaults to the existing `action_proposal` table, and update both proposal adapters. This keeps all schema changes in migration `0010` before it is generated.

- [ ] **Step 3: Generate and inspect the named migration**

Run:

```bash
pnpm exec drizzle-kit generate --name operator_rag_baseline
```

Expected: `migrations/0010_operator_rag_baseline.sql`. If Drizzle omits the generated `tsvector` expression or extension statement, add those two statements to the generated migration and keep the schema declaration aligned. Verify that no unrelated table is dropped or rebuilt.

- [ ] **Step 4: Implement the projection adapter**

Map domain documents to the table, convert readonly embeddings to arrays, and use `onConflictDoUpdate` keyed by `strategyProfileId`. Reject non-finite/wrong-length vectors before SQL.

- [ ] **Step 5: Run DB/type verification and commit**

Run:

```bash
pnpm typecheck
pnpm vitest run src/adapters/repository/pg-strategy-retrieval-index.adapter.test.ts
```

Expected: typecheck PASS; DB suite PASS with `DATABASE_URL` or skip cleanly.

```bash
git add src/db/schema.ts src/domain/action-proposal.ts src/ports/action-proposal.repository.ts \
  src/adapters/repository/in-memory-action-proposal.repository.ts \
  src/adapters/repository/drizzle-action-proposal.repository.ts \
  src/adapters/repository/*action-proposal*.test.ts \
  src/adapters/repository/pg-strategy-retrieval-index.adapter.ts \
  src/adapters/repository/pg-strategy-retrieval-index.adapter.test.ts migrations
git commit -m "feat(rag): persist strategy retrieval projections"
```

### Task 5: Build and repair strategy projections

**Files:**
- Create: `src/operator/strategy-retrieval-document.ts`
- Test: `src/operator/strategy-retrieval-document.test.ts`
- Create: `src/operator/strategy-retrieval-indexer.ts`
- Test: `src/operator/strategy-retrieval-indexer.test.ts`
- Modify: `src/ports/strategy-profile.repository.ts`
- Modify: `src/adapters/repository/in-memory-strategy-profile.repository.ts`
- Modify: `src/adapters/repository/drizzle-strategy-profile.repository.ts`
- Modify: corresponding repository tests
- Create: `scripts/operator-rag-reindex.ts`
- Modify: `package.json`

- [ ] **Step 1: Write deterministic document tests**

Assert that `buildStrategyRetrievalText(profile)` uses a stable labelled order:

```text
direction
core idea
summary
required market features
entry conditions
exit conditions
risk management
position management
parameters
unknowns
```

Assert that changing a field changes `contentHash`, while object-key order does not.

- [ ] **Step 2: Write indexer failure/repair tests**

Test successful embed/upsert, embedding failure emitting `retrieval.strategy_index_failed` without throwing into onboarding, stale hash reindex, current hash skip, and summary counts `{ indexed, skipped, failed }`.

- [ ] **Step 3: Implement document builder and indexer**

The indexer accepts `EmbeddingPort`, `StrategyRetrievalIndexPort`, model/version config, clock, and event repository. It embeds one normalized document, validates dimensions, and upserts.

- [ ] **Step 4: Add profile listing for repair**

Add `listAll(): Promise<StrategyProfile[]>` to `StrategyProfileRepository`, with deterministic `createdAt ASC, id ASC` ordering in both adapters.

- [ ] **Step 5: Add the CLI**

`pnpm operator-rag:reindex` is dry-run by default and prints counts without embedding calls. `--run` constructs DB/OpenRouter adapters and performs paid embedding calls. Require `DATABASE_URL` and `OPENROUTER_API_KEY` only with `--run`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm typecheck
pnpm vitest run src/operator/strategy-retrieval-document.test.ts \
  src/operator/strategy-retrieval-indexer.test.ts \
  src/adapters/repository/in-memory-strategy-profile.repository.test.ts \
  src/adapters/repository/drizzle-strategy-profile.repository.test.ts
pnpm operator-rag:reindex
```

Expected: tests PASS; CLI prints dry-run plan and makes no provider calls.

```bash
git add src/operator src/ports/strategy-profile.repository.ts \
  src/adapters/repository/in-memory-strategy-profile.repository.ts \
  src/adapters/repository/in-memory-strategy-profile.repository.test.ts \
  src/adapters/repository/drizzle-strategy-profile.repository.ts \
  src/adapters/repository/drizzle-strategy-profile.repository.test.ts \
  scripts/operator-rag-reindex.ts package.json
git commit -m "feat(rag): index and rebuild strategy profiles"
```

### Task 6: Implement PostgreSQL hybrid search and RRF baseline

**Files:**
- Create: `src/adapters/similarity/pg-hybrid-strategy-similarity.adapter.ts`
- Test: `src/adapters/similarity/pg-hybrid-strategy-similarity.adapter.test.ts`
- Create: `src/adapters/similarity/in-memory-strategy-similarity.adapter.ts`
- Test: `src/adapters/similarity/in-memory-strategy-similarity.adapter.test.ts`

- [ ] **Step 1: Write SQL adapter tests**

Seed documents with deterministic 1024-dimensional vectors. Assert:

- lexical-only ranking for exact trading terms;
- vector-only semantic candidate presence;
- RRF fusion and rank provenance;
- metadata filters;
- excluded profile removal;
- limits `50/50/20`;
- abort propagation;
- no semantic candidate has an `exact` flag.

- [ ] **Step 2: Implement parallel candidate queries**

Lexical SQL uses:

```sql
search_vector @@ plainto_tsquery('simple', :query)
ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', :query)) DESC, strategy_profile_id ASC
LIMIT 50
```

Vector SQL uses cosine distance:

```sql
ORDER BY embedding <=> :query_embedding, strategy_profile_id ASC
LIMIT 50
```

Run both with `Promise.allSettled`, fuse successful branches with `reciprocalRankFusion({ k: 60, limit: 20 })`, and return a `StrategyCandidateSet` with per-branch degraded reason codes. When both branches fail, return an empty candidate list plus both reason codes; `OperatorRetrieval` decides how that degraded evidence is presented.

- [ ] **Step 3: Implement deterministic in-memory adapter**

The in-memory adapter returns fixture candidates and recorded calls; it must honor metadata filters, exclusion, limit, and aborted signals for handler tests.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm typecheck
pnpm vitest run src/adapters/similarity/rrf.test.ts \
  src/adapters/similarity/in-memory-strategy-similarity.adapter.test.ts \
  src/adapters/similarity/pg-hybrid-strategy-similarity.adapter.test.ts
```

Expected: PASS or DB suite skipped without `DATABASE_URL`.

```bash
git add src/adapters/similarity/pg-hybrid-strategy-similarity.adapter.ts \
  src/adapters/similarity/pg-hybrid-strategy-similarity.adapter.test.ts \
  src/adapters/similarity/in-memory-strategy-similarity.adapter.ts \
  src/adapters/similarity/in-memory-strategy-similarity.adapter.test.ts
git commit -m "feat(rag): add Postgres hybrid strategy search"
```

### Task 7: Add deadline-aware Operator evidence orchestration

**Files:**
- Create: `src/ports/operator-retrieval.port.ts`
- Create: `src/operator/operator-retrieval.ts`
- Test: `src/operator/operator-retrieval.test.ts`
- Create: `src/operator/disabled-operator-retrieval.ts`
- Test: `src/operator/disabled-operator-retrieval.test.ts`
- Create: `src/operator/operator-response.ts`
- Test: `src/operator/operator-response.test.ts`

- [ ] **Step 1: Write orchestration tests with fake adapters**

Cover:

- exact fingerprint hit has authority over similarity;
- exact hit skips hybrid unless `goal === 'show_similar'`;
- no exact hit launches structured and similarity work;
- vector/lexical degradation is preserved as warnings;
- soft deadline starts no additional work;
- hard deadline aborts remaining adapters and returns available evidence;
- timeout never renders `nothing found`;
- source IDs/freshness are present;
- raw strategy text is absent from audit payloads.

- [ ] **Step 2: Implement a monotonic budget**

```ts
export interface RetrievalBudget {
  readonly startedAtMs: number;
  readonly softDeadlineMs: number;
  readonly hardDeadlineMs: number;
  remaining(nowMs: number): number;
  softExpired(nowMs: number): boolean;
  hardExpired(nowMs: number): boolean;
  readonly signal: AbortSignal;
}
```

Inject clock/timer dependencies in tests. Defaults are 5000/10000 ms. Do not use retries in this slice.

- [ ] **Step 3: Add the chat-facing port and disabled adapter**

```ts
export interface OperatorRetrievalPort {
  collect(input: {
    turn: InterpretedTurn;
    message: string;
    sessionId: string;
    retrievalId: string;
  }): Promise<OperatorEvidence>;
}
```

`DisabledOperatorRetrieval.collect()` performs no I/O and returns `status: 'disabled'`, `exactLookup: 'not_run'`, empty candidates/references/warnings, and a deterministic `subjectHash`. Test it with throwing fake dependencies to prove none are called. The renderer makes no database-absence claim when exact lookup is `not_run` or `failed`.

- [ ] **Step 4: Implement evidence orchestration**

For a strategy turn, compute the canonical source fingerprint, read exact profile, and query hybrid similarity only when policy permits. Convert `Promise.allSettled` results into `OperatorEvidence`, stable warning codes, and per-stage timing fields.

- [ ] **Step 5: Implement deterministic rendering**

Render four blocks: interpretation, exact status, up to five similar profiles with match reasons, and proposed next action. A degraded source adds an explicit limitation sentence. Rendering never invokes an LLM.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm vitest run src/operator/operator-retrieval.test.ts \
  src/operator/disabled-operator-retrieval.test.ts src/operator/operator-response.test.ts
```

Expected: PASS with fake-clock deadline cases.

```bash
git add src/ports/operator-retrieval.port.ts src/operator/operator-retrieval.ts \
  src/operator/operator-retrieval.test.ts src/operator/disabled-operator-retrieval.ts \
  src/operator/disabled-operator-retrieval.test.ts src/operator/operator-response.ts \
  src/operator/operator-response.test.ts
git commit -m "feat(operator): collect budgeted strategy evidence"
```

### Task 8: Integrate evidence into proposals and onboarding indexing

**Files:**
- Modify: `src/chat/response.ts`
- Modify: `src/chat/guard.ts`
- Modify: `src/chat/guard.test.ts`
- Modify: `src/chat/chat-handler.ts`
- Modify: `src/chat/chat-handler.test.ts`
- Modify: `src/orchestrator/app-services.ts`
- Modify: `src/orchestrator/handlers/strategy-onboard.handler.ts`
- Modify: `src/orchestrator/handlers/strategy-onboard.handler.test.ts`
- Modify: `src/composition.ts`
- Modify: `test/support/make-services.ts`

- [ ] **Step 1: Write failing proposal/handler tests**

Assert first-turn response contains typed evidence cards, proposal stores the Task 4 source references/warnings rather than full retrieved bodies, exact duplicate text is shown when fingerprint matches, similar-only results are labelled `similar`, no queue entry exists before confirmation, and confirmation executes the unchanged stored task snapshot.

- [ ] **Step 2: Integrate chat flow**

Replace runtime `classifier` dependency with `interpreter: TurnInterpreterPort` in `ChatHandlerDeps`, composition, and test fixtures. Keep confirmation resolution before interpretation exactly as implemented by confirmation core. After `TurnInterpreter` validation and before proposal creation, call `OperatorRetrieval`; feed evidence into `buildActionProposal` and `assistant_message`.

When `OPERATOR_RAG_ENABLED=false`, composition injects deterministic no-op/in-memory retrieval and makes no embedding call. When enabled, composition requires `DATABASE_URL` and `OPENROUTER_API_KEY`, then constructs the OpenRouter embedding, PostgreSQL index/similarity, and retrieval/indexer services. `makeServices` injects deterministic in-memory adapters.

Modify `planChatAction` to consume `InterpretedTurn`:

```text
strategy + undefined|analyze -> strategy.onboard proposal
strategy + research -> onboard proposal with research chain
task -> task.status behavior
results -> existing read/capability behavior
hypothesis -> existing hypothesis behavior
unknown -> out_of_scope/clarification
```

There must be no active runtime path that classifies the same message again through `IntentClassifierPort`.

Emit:

```text
chat.turn.interpreted
chat.retrieval.completed
chat.proposal.created
```

Event payloads contain hashes, counts, source IDs, reason codes, and timings; never raw strategy text or embeddings.

- [ ] **Step 3: Add fail-soft post-profile indexing**

After `strategyProfiles.create(profile)`, invoke `StrategyRetrievalIndexer.index(profile)`. Catch indexing errors, emit `retrieval.strategy_index_failed`, and allow onboarding to complete. Successful indexing emits `retrieval.strategy_indexed`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm typecheck
pnpm vitest run src/chat/guard.test.ts src/chat/chat-handler.test.ts \
  src/orchestrator/handlers/strategy-onboard.handler.test.ts \
  src/adapters/repository/in-memory-action-proposal.repository.test.ts
```

Expected: PASS; no task before confirmation and onboarding survives embedding/index failure.

```bash
git add src/chat/response.ts src/chat/guard.ts src/chat/guard.test.ts src/chat/chat-handler.ts \
  src/chat/chat-handler.test.ts src/orchestrator/app-services.ts \
  src/orchestrator/handlers/strategy-onboard.handler.ts \
  src/orchestrator/handlers/strategy-onboard.handler.test.ts \
  src/composition.ts test/support/make-services.ts
git commit -m "feat(operator): attach strategy evidence to confirmed proposals"
```

### Task 9: Add the golden retrieval eval harness

**Files:**
- Create: `src/experiments/operator-rag/types.ts`
- Create: `src/experiments/operator-rag/fixtures.ts`
- Create: `src/experiments/operator-rag/metrics.ts`
- Create: `src/experiments/operator-rag/eval-harness.ts`
- Create: matching unit tests
- Create: `src/experiments/operator-rag/__fixtures__/strategy-retrieval-v1.json`
- Create: `scripts/operator-rag-eval.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the labelled fixture schema and cases**

Include exact copies, Russian paraphrases, English paraphrases, mixed RU/EN terms, shared-entry/different-risk negatives, shared-symbol negatives, and no-match cases. Use relevance grades `0..3` and explicit expected exact IDs.

- [ ] **Step 2: Write metric tests**

Test `recallAtK`, reciprocal rank, and `ndcgAtK` with hand-calculated fixtures, including empty relevance sets and deterministic rounding.

- [ ] **Step 3: Implement dry-run/live harness**

Default command reads/validates fixtures and prints planned provider calls with zero network/DB access. `--run` executes the configured adapter and writes JSON plus Markdown under `.artifacts/experiments/operator-rag/<dataset>/<timestamp>`.

Pass gates:

```text
exact identity accuracy = 1.0
false semantic exact count = 0
Recall@20 >= 0.90
report MRR and nDCG@5
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm vitest run src/experiments/operator-rag
pnpm operator-rag:eval
```

Expected: tests PASS; dry-run prints dataset fingerprint, case count, planned calls, and missing keys without paid calls.

```bash
git add src/experiments/operator-rag scripts/operator-rag-eval.ts package.json
git commit -m "test(rag): add strategy retrieval golden eval"
```

### Task 10: Wire runtime, E2E, and documentation

**Files:**
- Modify: `test/e2e/chat-to-task.test.ts`
- Create: `test/e2e/operator-rag-to-proposal.test.ts`
- Modify: `src/chat/README.md`
- Modify: `.env.example`

- [ ] **Step 1: Verify production and test adapter selection**

Add integration assertions that disabled mode makes zero embedding calls and enabled composition rejects missing `OPENROUTER_API_KEY` before serving chat. Verify the in-memory E2E fixture uses deterministic retrieval candidates.

- [ ] **Step 2: Add E2E tests**

Prove:

1. standalone strategy -> one interpreter call -> exact/hybrid evidence -> `assistant_message`;
2. response has confirm/cancel actions and no queued task;
3. `да` bypasses interpreter/retrieval and creates exactly the stored task;
4. exact profile hit is identified as exact;
5. vector failure returns structured/lexical degraded evidence;
6. event order is `chat.turn.interpreted -> chat.retrieval.completed -> chat.proposal.created`;
7. event JSON contains no raw strategy text or embedding values.

- [ ] **Step 3: Document configuration and operations**

Document feature flag, embedding model/dimension lock, reindex dry-run/`--run`, eval dry-run/`--run`, deadlines, fallback semantics, and why FTS is not called BM25.

- [ ] **Step 4: Run focused verification**

Run:

```bash
pnpm typecheck
pnpm vitest run src/chat src/operator src/adapters/embedding \
  src/adapters/similarity src/experiments/operator-rag \
  test/e2e/operator-rag-to-proposal.test.ts test/e2e/chat-to-task.test.ts
```

Expected: PASS; DB suites skip cleanly without `DATABASE_URL`.

- [ ] **Step 5: Run full verification**

Run:

```bash
pnpm check
git diff --check
```

Expected: exit code 0 for both.

- [ ] **Step 6: Commit**

```bash
git add test/e2e src/chat/README.md .env.example
git commit -m "feat(operator): wire hybrid strategy evidence end to end"
```

## Final Acceptance

- [ ] `OPERATOR_RAG_ENABLED=false` preserves confirmation-core behavior and makes no embedding calls.
- [ ] A standalone strategy needs no `Стратегия:` or `исследуй` prefix.
- [ ] Initial turn creates a proposal, never a task.
- [ ] Exact fingerprint is the only duplicate authority.
- [ ] Similar strategies retain lexical/vector/RRF provenance.
- [ ] Vector or lexical failure yields explicit degraded evidence.
- [ ] Hard deadline cancels outstanding work at ten seconds.
- [ ] No raw strategy text, retrieved body, embedding, or credential appears in audit events.
- [ ] RRF baseline meets exact/false-exact/Recall@20 gates on the approved dataset.
- [ ] Reranker remains disabled; create its follow-up plan only after recording baseline `nDCG@5` and latency.
- [ ] Research-only/no-live-trading invariant remains unchanged.
