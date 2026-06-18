# Conversational Operator: evidence-first confirmation

- **Date:** 2026-06-18
- **Repo:** `trading-lab`
- **Status:** design approved; implementation plan pending

## 1. Goal

Replace the current command-router experience with a subject-aware operator that can recognize a strategy or bot without magic prefixes, enrich the turn with verified system facts, explain what it understood, and ask for explicit confirmation before creating any task.

The target interaction is:

```text
understand subject and goal
  -> collect read-only evidence
  -> present interpretation, facts, proposed action, and alternatives
  -> wait for explicit confirmation
  -> deterministic guard creates exactly the confirmed task
```

This preserves the core safety rule: the LLM can understand and phrase, but it cannot enqueue work or trade. Live execution remains physically unavailable.

## 2. Current-state findings

- `handleChatMessage` currently classifies every message into one `ChatIntent`, passes it to `planChatAction`, and may immediately call `createAndEnqueueTask`.
- Recognition of a subject and selection of an action are therefore coupled. A misclassified strategy description can become `hypothesis.build` and produce an irrelevant clarification.
- `ChatSessionContext` stores canonical-entity pointers and `pendingPlanId`, but has no representation for a pending conversational interaction or unconfirmed action.
- Exact strategy lookup already exists through `StrategyProfileRepository.findByFingerprint`.
- Live bot run data already exists behind `BotResultsReadPort`, but `listBotRuns` filters only by mode/status. It is a run-results surface, not a bot identity catalog.
- The guard is already the deterministic policy boundary and task intake is already the write chokepoint. The design extends these boundaries rather than replacing them with an LLM tool loop.

## 3. Approved product rules

1. A strategy description does not require `Стратегия:` or another prefix.
2. Any task-producing or compute-producing action requires a separate confirmation turn, even when the first message explicitly says `проанализируй`, `исследуй`, or `запусти бэктест`.
3. Confirmation is evidence-first: the operator shows what it understood, what it found, the exact proposed action, and relevant alternatives before asking.
4. Read-only questions can be answered immediately. For example, showing existing bot results does not require confirmation; proposing a new research cycle after the answer does.
5. A short answer such as `да` is resolved against one stored, current proposal. It is not reclassified as a fresh command by the LLM.
6. Exact duplicate detection uses fingerprint lookup only. Semantic similarity is advisory and must be described as `similar`, never `the same`.
7. Missing or degraded evidence is disclosed. Failure to query a source must never be represented as absence of data.

## 4. Architecture

Introduce an `OperatorTurnPlanner` between chat ingress and the existing deterministic task intake. It coordinates four focused components.

### 4.1 Turn Interpreter

Input: current message plus verified session pointers.

Output: a typed interpretation containing:

- subject kind: strategy, bot, task, result, hypothesis, or unknown;
- a subject draft or entity query;
- requested goal, if explicit;
- extracted constraints and references;
- confidence and ambiguities.

The interpreter performs no reads or writes. An LLM may extract meaning, but provider output is schema-validated and normalized at the trust boundary.

### 4.2 Evidence Enricher

Input: typed subject/query.

Output: `OperatorEvidence`, assembled through read-only ports. It contains authoritative structured facts, advisory similarity results, RAG excerpts, source references, freshness, and warnings.

The enricher does not decide which task to create and does not turn missing results into negative facts.

### 4.3 Proposal Policy

Input: interpretation and evidence.

Output: either a read-only answer, a clarification interaction, or an immutable `ActionProposal`.

The policy is deterministic. It maps known states to allowed actions, alternatives, and payload previews. The LLM may render user-facing prose from the policy result, but it cannot add an action that the policy did not allow.

### 4.4 Confirmation Guard

Input: a follow-up message and the current pending interaction.

The guard resolves exact buttons, option numbers, explicit action labels, cancel, and narrow affirmative forms. A valid confirmation consumes the saved proposal and sends its saved payload to the existing task-intake chokepoint. It does not regenerate the payload from the follow-up message.

The guard rejects expired, superseded, already-consumed, or stale proposals. Task creation remains idempotent through the existing dedupe mechanism.

## 5. Conversational state model

Replace the single-purpose notion of `pendingPlanId` as conversational state with a typed pending interaction. `pendingPlanId` may remain for post-task orchestration.

```ts
type PendingOperatorInteraction =
  | {
      kind: 'action_confirmation';
      proposalId: string;
      expiresAt: string;
    }
  | {
      kind: 'entity_disambiguation';
      entityType: 'bot' | 'strategy';
      query: EntityQuery;
      candidateIds: readonly string[];
      cursor?: string;
      expiresAt: string;
    }
  | {
      kind: 'subject_clarification';
      draftId: string;
      missingFields: readonly string[];
      expiresAt: string;
    };
```

`ActionProposal` is persisted separately so it is auditable and consumable exactly once:

```ts
interface ActionProposal {
  id: string;
  sessionId: string;
  subjectSnapshot: OperatorSubject;
  subjectHash: string;
  evidenceRefs: readonly EvidenceRef[];
  action: 'strategy.analyze' | 'research.run_cycle' | 'hypothesis.build' | 'backtest.run';
  payloadPreview: unknown;
  alternatives: readonly ProposedAlternative[];
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'superseded';
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
```

`strategy.analyze` is the operator-facing action name. In the existing worker model it maps to the `strategy.onboard` task, whose handler produces the strategy profile through the analyst. It does not imply `research.run_cycle` or backtesting.

A new subject supersedes the previous pending proposal. Editing material strategy fields creates a new subject hash, reruns enrichment, and creates a new proposal. Confirmation events must reference the proposal ID.

## 6. Evidence model and source priority

Evidence is gathered in this order:

1. **Exact lookup:** IDs, fingerprints, task state, and canonical entity existence.
2. **Structured reads:** strategy profiles, hypotheses, backtests, bot runs, summaries, and active tasks through repositories/read ports.
3. **Similarity retrieval:** advisory search for related strategies.
4. **RAG retrieval:** explanatory excerpts from research reports, critic output, hypotheses, notes, and artifacts.

```ts
interface OperatorEvidence {
  subject: OperatorSubject;
  exactMatch?: EntityRef;
  similarStrategies: readonly SimilarStrategyEvidence[];
  analysis?: StrategyAnalysisSummary;
  hypotheses: readonly HypothesisSummary[];
  backtests: readonly BacktestSummary[];
  botResults?: BotResultsSummary;
  activeTasks: readonly TaskSummary[];
  sources: readonly EvidenceSource[];
  warnings: readonly EvidenceWarning[];
}
```

Every evidence item carries a source ID/type and freshness marker. Numerical metrics, task status, and entity existence always come from typed repositories/read ports, never from generated prose or a retrieved document fragment.

## 7. Hybrid retrieval and reranking

Use the course-recommended pipeline as the retrieval baseline:

```text
metadata filters
  -> BM25 top Klex + vector search top Kvec
  -> Reciprocal Rank Fusion candidate set
  -> multilingual cross-encoder reranking
  -> final top N with source references
```

Initial values such as `50 / 50 / 20 / 5` are configuration defaults, not requirements. Tune them using an offline relevance set and latency measurements.

Maintain two distinct indexes:

- **Strategy profile index:** one document per canonical strategy profile plus normalized market, timeframe, direction, entry, exit, and risk attributes. It powers advisory strategy similarity.
- **Research artifact index:** chunks of reports, hypothesis rationale, critic output, and notes with `profileId`, `taskId`, artifact type, timestamps, and access metadata. It powers explanatory RAG answers.

RRF is preferred for initial fusion because BM25 and vector scores are not directly comparable. The cross-encoder must support Russian/English mixed domain language. Cache retrieval by subject hash and corpus version where useful.

Retrieval evaluation covers `Recall@20` after fusion, `nDCG@5` and `Precision@5` after reranking, false-duplicate rate, and p95 latency. Exact duplicate claims are outside this evaluation because only fingerprint lookup can make that claim.

## 8. Bot entity resolution

`bot`, `strategy`, and `run` are different entities. A question such as `Как торгует лонг-бот?` must first resolve a bot identity and only then load its relevant runs and summaries.

The current `BotResultsReadPort` is insufficient for this because it lists runs and filters only by mode/status. Introduce a dedicated lab-side `BotCatalogReadPort` backed by the platform SDK/read surface. If that upstream surface does not yet expose the required identity metadata, extending its contract is an explicit prerequisite to the bot-resolution delivery slice; run records must not be repurposed as a partial catalog.

The catalog needs stable `botId`, display name, aliases, strategy reference/version, market/symbol, timeframe, direction, lifecycle status, and enough recent-run metadata to render a useful label.

Resolution policy:

- Zero candidates: ask for another identifying attribute.
- One verified candidate: answer the read-only question immediately.
- Multiple candidates: create `entity_disambiguation` and show at most four ranked candidates, plus `show more` and `none of these`.
- Many candidates: paginate ranked candidates or ask for a narrowing attribute; never dump the full catalog.

Candidate ordering is deterministic: exact ID/name, alias or name prefix, structured strategy attributes, active/recent status, and verified session recency. `lastBotId` is a hint that must be checked against the catalog.

Each option label includes distinguishing information, for example:

```text
Long Rebound · BTCUSDT · 1m · v3 · active · ID ...7A2F
```

An answer such as `2` resolves against the stored candidate snapshot without a new LLM call. `none of these` moves to clarification. A new bot query supersedes the old candidate list.

## 9. Interaction examples

### New strategy without magic words

```text
User: Входим в лонг после резкого пролива ...
Operator: Я понял это как long mean-reversion стратегию на 1m с DCA и двумя тейками.
          Точного совпадения нет; найдены две похожие стратегии.
          Предлагаю создать профиль и провести первичный анализ.
          [Подтвердить анализ] [Показать похожие] [Уточнить] [Отмена]
```

No task exists before confirmation.

### Explicit analysis request

```text
User: Проанализируй эту стратегию: ...
Operator: Вижу стратегию и ваш запрос на анализ. В базе уже есть похожий профиль ...
          Запланировано: создать новый профиль и провести первичный анализ; research и backtest не входят.
          [Подтвердить анализ] [Использовать существующий профиль] [Отмена]
```

The explicit verb changes the proposed goal, not the confirmation requirement.

### Bot ambiguity

```text
User: Как торгует лонг-бот?
Operator: Нашёл несколько подходящих ботов. Какой вы имеете в виду?
          1. Long Rebound · BTCUSDT · 1m · v3 · ...7A2F
          2. Long Rebound · ETHUSDT · 5m · v2 · ...19C0
          3. Long DCA · BTCUSDT · 1m · v5 · ...B441
          4. Показать ещё
          5. Нет в списке
```

After selection, existing results are shown immediately. Any proposed research action requires a new action confirmation.

## 10. Failure and consistency handling

- **Structured source unavailable:** disclose that history could not be checked. Do not say no history exists.
- **Similarity/RAG unavailable:** continue with exact and structured evidence, mark similarity evidence as unavailable, and allow the user to decide whether to proceed.
- **Stale evidence:** revalidate mutable entity references and task state at confirmation. If the material plan changed, supersede the proposal and show an updated one.
- **Classifier/schema failure:** return a specific recoverable clarification; never fall through to an unrelated allowed action.
- **Expired proposal:** ask the user to restate or refresh the action; a late `да` creates nothing.
- **Repeated confirmation:** return the existing task/result for the consumed proposal rather than enqueueing again.
- **Too many candidates:** ask for market, symbol, timeframe, status, name fragment, or ID suffix; support `show more` with a stored cursor.

## 11. Response contracts and UI

Add a backward-compatible assistant response carrying structured actions:

```ts
interface AssistantMessageResponse {
  kind: 'assistant_message';
  sessionId: string;
  message: string;
  evidence?: readonly EvidencePresentation[];
  actions?: readonly ProposedActionView[];
  pendingInteractionId?: string;
}
```

The office renders actions as buttons but plain-text clients can answer with an option number or exact action label. The final worker completion should render a domain summary rather than the generic `Done`, with links/IDs for the resulting profile, hypotheses, or run.

## 12. Observability and privacy

Emit the lifecycle:

```text
chat.turn.understood
chat.evidence.collected
chat.proposal.created
chat.proposal.confirmed | changed | cancelled | expired | superseded
chat.entity_disambiguation.created | resolved
chat.task_created
```

Events store entity IDs, proposal IDs, counts, adapter/model identifiers, latency, hashes, and warning codes. They do not store raw strategy text, retrieved private document bodies, credentials, or secrets.

Track product metrics:

- standalone strategy recognition rate;
- clarification and correction rate;
- proposal confirmation/cancellation rate;
- wrong-action rate after confirmation;
- bot disambiguation resolution rate and turns-to-resolution;
- retrieval quality and p95 latency;
- number of task creations lacking a confirmation event, which must remain zero for chat-originated actions.

## 13. Testing contract

### Unit

- interpreter schema normalization and subject extraction;
- proposal-policy branches for new, exact, similar, and degraded evidence;
- pending-interaction resolution, supersession, cancellation, and expiry;
- bot candidate ranking and snapshot option resolution;
- RRF and evidence mapping with deterministic fixtures.

### Integration

- standalone strategy creates a proposal but no task;
- explicit `проанализируй` also creates a proposal but no task;
- valid confirmation creates exactly the stored task once;
- edited strategy invalidates the previous proposal;
- read-only bot result questions do not require confirmation after unambiguous resolution;
- multiple bots produce disambiguation and option selection loads the chosen bot only;
- unavailable DB/RAG sources produce warnings rather than false absence claims.

### E2E and eval

- chat-to-proposal-to-task flow through ingress, session persistence, queue, and office buttons;
- transcript rendering of evidence and completion summaries;
- Russian/English intent and entity-reference eval sets;
- retrieval relevance set for strategy similarity and artifact RAG;
- invariant test: no chat-originated analysis/research/backtest task exists without a matching consumed proposal and confirmation event.

## 14. Delivery slices

1. **Conversation core:** typed pending interactions, proposal repository, confirmation guard, and assistant response/actions. Keep evidence minimal and structured.
2. **Strategy enrichment:** standalone strategy interpretation, exact lookup, strategy-profile hybrid index, and similarity presentation.
3. **Meaningful completion:** surface analyst/research summaries instead of `Done`.
4. **Bot resolution:** platform bot-catalog contract/port, disambiguation, run-result summaries, and session hint.
5. **Artifact RAG:** research-artifact index, hybrid retrieval, reranker, citations, and offline evaluation.

Each slice retains the existing deterministic guard and research-only invariant. Roll out behind a chat operator feature flag and keep the existing router as a temporary fallback until eval and E2E gates pass.

## 15. Non-goals

- General-purpose assistant behavior outside trading research.
- Direct LLM tool calls that enqueue tasks or mutate repositories.
- Automatic analysis, research, or backtesting without confirmation.
- Treating semantic similarity as identity.
- Live trading or any execution adapter.
- Replacing structured repositories with a vector database.
- Returning hundreds of bots or strategies in one response.
