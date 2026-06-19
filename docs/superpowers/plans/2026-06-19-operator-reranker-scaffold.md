# Operator Reranker Scaffold — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conditional reranker to the operator retrieval pipeline as a **scaffold** — wired behind `OPERATOR_RERANKER` (default `none`, no behaviour change), with the §7 gate/triggers, deadline-aware execution + RRF fallback, a `MastraRerankerAdapter`, a deterministic `FakeReranker`, and an RRF-vs-reranker eval comparison (CI no-regression gate). Not enabled now.

**Architecture:** Reuse the existing `RerankerPort` seam (`src/ports/strategy-similarity.port.ts`). Insert a pure decision (`shouldRerank`) + a deadline-bounded rerank step into `OperatorRetrieval.#runHybrid` after RRF fusion; on any failure/timeout/abort keep the RRF order + a warning. Compose the Mastra adapter only when the flag is `mastra`.

**Tech Stack:** TypeScript ESM under `node --experimental-strip-types` (NO TS parameter properties — guarded by `src/strip-types-no-param-properties.test.ts`), Vitest, hexagonal ports/adapters, Mastra (adapter construction under `src/mastra/**`).

**Spec:** `docs/superpowers/specs/2026-06-19-operator-reranker-scaffold-design.md` (implements operator-rag design §5/§7/§10).

---

## Verified facts (gortex-extracted)

- **Existing port (USE THIS, don't create a new one):** `src/ports/strategy-similarity.port.ts` —
  `interface RerankerPort { rerank(query: string, candidates: readonly SimilarStrategyCandidate[], limit: number, signal?: AbortSignal): Promise<readonly SimilarStrategyCandidate[]> }`.
- **Domain:** `SimilarStrategyCandidate { strategyProfileId; lexicalRank?; lexicalScore?; vectorRank?; vectorDistance?; rrfScore; metadata }`; `StrategyCandidateSet { candidates; degradedReasonCodes }` (`src/domain/strategy-retrieval.ts`).
- **Pipeline:** `OperatorRetrieval` (`src/operator/operator-retrieval.ts`). In `#runHybrid`, after the similarity search: `const candidates = [...result.candidates]; onCandidates(candidates); …`. **Insert reranking between those two lines.** Available there: `input` (`{ turn, message, sessionId, retrievalId }`), `budget` (`RetrievalBudget` with `signal`, `remaining(now)`, `softExpired`/`hardExpired`), `warnings: Set<string>`, `timingsMs`, `this.#deps.clock`, `this.#deps.scheduler`. `RETRIEVAL_WARNINGS` is an exported const map in the same file.
- **Trigger source:** `input.turn` is an `InterpretedTurn` with `goal?: 'analyze' | 'research' | 'show_results' | 'show_similar'`. Explicit-comparison trigger = `turn.goal === 'show_similar'`.
- **Config:** `src/config/env.ts` — `Env` interface + `loadRagEnv(source)` (uses `parsePositiveInt`, `source.X === 'true'`). Existing `OPERATOR_*` entries are the pattern.
- **Mastra adapter template:** `src/adapters/intent/mastra-turn-interpreter.ts` (`class … implements Port; constructor(agent, label)`) + agent factory `src/mastra/agents/turn-interpreter.agent.ts` (`createTurnInterpreterAgent(model)`); composed in `src/mastra/**`. Mastra rerank API (semantic/vector/position scoring) — confirm via context7 during Task 4; keep it behind `RerankerPort`.
- **Composition:** `buildOperatorRag(env, db, strategyProfiles, events)` in `src/composition.ts` constructs `OperatorRetrieval({ embedding, strategyProfiles, similarity, clock, scheduler, isoNow, …limits })`. Thread `reranker` + rerank config here.
- **Eval:** `src/experiments/operator-rag/eval-harness.ts` — `runRetrieval(cases, port: RetrievalPort)`, `RetrievalPort.retrieve(caseId, query, filters): Promise<string[]>` (ordered profile ids); `computeCaseMetrics` uses `ndcgAtK(retrievedIds, gradedRelevance, k)` (`metrics.ts`). `scripts/operator-rag-eval.ts` builds a `port` over `similarityAdapter.search` → `candidates.map(c => c.strategyProfileId)`.

## File Structure

- **Create** `src/operator/rerank-policy.ts` — `RerankConfig` type + pure `shouldRerank(...)` decision (§7 gate/triggers) + `RERANK_WARNING` code. Focused, fully unit-testable, no I/O.
- **Create** `test/support/fake-reranker.ts` — deterministic `FakeReranker` implementing `RerankerPort`.
- **Modify** `src/operator/operator-retrieval.ts` — `OperatorRetrievalDeps` gains `reranker?: RerankerPort` + `rerankConfig?: RerankConfig`; `#runHybrid` runs the deadline-bounded rerank step; add `RETRIEVAL_WARNINGS.rerankFailed`.
- **Create** `src/mastra/agents/reranker.agent.ts` + `src/adapters/reranker/mastra-reranker.adapter.ts` — the flagged Mastra impl of `RerankerPort`.
- **Modify** `src/config/env.ts` — `OPERATOR_RERANKER` + `OPERATOR_RERANK_*` in `Env` + `loadRagEnv`.
- **Modify** `src/composition.ts` — compose the reranker (gated on `OPERATOR_RERANKER==='mastra'`) + thread into `buildOperatorRag`.
- **Create** `src/experiments/operator-rag/rerank-compare.test.ts` — RRF-only vs reranker-enabled (FakeReranker) nDCG@5 comparison + no-regression assertion.

---

### Task 1: Config flags

**Files:** Modify `src/config/env.ts`; Test `src/config/env.test.ts` (append if present)

- [ ] **Step 1: Write the failing test** (append; mirror existing env tests)

```ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';

describe('reranker env', () => {
  const base = { DATABASE_URL: 'x', REDIS_URL: 'y' } as NodeJS.ProcessEnv; // mirror existing required-env stubs
  it('defaults reranker off with §7 defaults', () => {
    const env = loadEnv(base);
    expect(env.OPERATOR_RERANKER).toBe('none');
    expect(env.OPERATOR_RERANK_TIMEOUT_MS).toBe(1500);
    expect(env.OPERATOR_RERANK_LIMIT).toBe(5);
    expect(env.OPERATOR_RERANK_MIN_CANDIDATES).toBe(10);
    expect(env.OPERATOR_RERANK_RRF_MARGIN).toBe(0.002);
  });
  it('parses mastra + overrides', () => {
    const env = loadEnv({ ...base, OPERATOR_RERANKER: 'mastra', OPERATOR_RERANK_TIMEOUT_MS: '800' });
    expect(env.OPERATOR_RERANKER).toBe('mastra');
    expect(env.OPERATOR_RERANK_TIMEOUT_MS).toBe(800);
  });
});
```
(Confirm the exact `loadEnv` test-stub shape from the existing `env.test.ts`.)

- [ ] **Step 2: Run → fail** — `npx vitest run src/config/env.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `Env` add:
```ts
  OPERATOR_RERANKER: 'mastra' | 'none';
  OPERATOR_RERANK_TIMEOUT_MS: number;
  OPERATOR_RERANK_LIMIT: number;
  OPERATOR_RERANK_MIN_CANDIDATES: number;
  OPERATOR_RERANK_RRF_MARGIN: number;
```
In `loadRagEnv`'s returned object (and its `Pick<…>` return type), add:
```ts
    OPERATOR_RERANKER: source.OPERATOR_RERANKER === 'mastra' ? 'mastra' : 'none',
    OPERATOR_RERANK_TIMEOUT_MS: parsePositiveInt(source.OPERATOR_RERANK_TIMEOUT_MS, 1500),
    OPERATOR_RERANK_LIMIT: parsePositiveInt(source.OPERATOR_RERANK_LIMIT, 5),
    OPERATOR_RERANK_MIN_CANDIDATES: parsePositiveInt(source.OPERATOR_RERANK_MIN_CANDIDATES, 10),
    OPERATOR_RERANK_RRF_MARGIN: parseFloatOr(source.OPERATOR_RERANK_RRF_MARGIN, 0.002),
```
Add a small `parseFloatOr(raw, def)` helper next to `parsePositiveInt` if none exists (`const n = Number(raw); return Number.isFinite(n) && n >= 0 ? n : def;`).

- [ ] **Step 4: Run → pass.** **Step 5: Commit** `feat(config): OPERATOR_RERANKER + rerank tuning flags (default none)`.

---

### Task 2: `rerank-policy.ts` — pure decision + config type + FakeReranker

**Files:** Create `src/operator/rerank-policy.ts`, `test/support/fake-reranker.ts`; Test `src/operator/rerank-policy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { shouldRerank, type RerankConfig } from './rerank-policy.ts';
import type { SimilarStrategyCandidate } from '../domain/strategy-retrieval.ts';

const cfg: RerankConfig = { timeoutMs: 1500, limit: 5, minCandidates: 10, rrfMargin: 0.002 };
const cand = (id: string, rrf: number): SimilarStrategyCandidate => ({ strategyProfileId: id, rrfScore: rrf, metadata: {} as never });
const many = (n: number) => Array.from({ length: n }, (_, i) => cand(`p${i}`, 1 - i * 0.1));

describe('shouldRerank', () => {
  it('false with <2 candidates', () => {
    expect(shouldRerank({ candidates: [cand('a', 1)], goal: 'show_similar', remainingMs: 5000, cfg })).toBe(false);
  });
  it('false when remaining budget < timeout', () => {
    expect(shouldRerank({ candidates: many(12), goal: 'show_similar', remainingMs: 1000, cfg })).toBe(false);
  });
  it('true on explicit show_similar trigger', () => {
    expect(shouldRerank({ candidates: many(3), goal: 'show_similar', remainingMs: 5000, cfg })).toBe(true);
  });
  it('true on RRF ambiguity margin (top-two gap <= margin)', () => {
    const c = [cand('a', 0.5), cand('b', 0.4995), cand('c', 0.1)];
    expect(shouldRerank({ candidates: c, goal: 'analyze', remainingMs: 5000, cfg })).toBe(true);
  });
  it('true on volume trigger (count >= minCandidates)', () => {
    expect(shouldRerank({ candidates: many(10), goal: 'analyze', remainingMs: 5000, cfg })).toBe(true);
  });
  it('false when no trigger fires (few candidates, clear gap, no show_similar)', () => {
    const c = [cand('a', 0.9), cand('b', 0.1), cand('c', 0.05)];
    expect(shouldRerank({ candidates: c, goal: 'analyze', remainingMs: 5000, cfg })).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `src/operator/rerank-policy.ts`:
```ts
import type { SimilarStrategyCandidate } from '../domain/strategy-retrieval.ts';

export interface RerankConfig {
  timeoutMs: number; limit: number; minCandidates: number; rrfMargin: number;
}

/** §7 gate + triggers. Pure: no clock, no I/O. `remainingMs` is the budget left for the rerank step. */
export function shouldRerank(args: {
  candidates: readonly SimilarStrategyCandidate[];
  goal: string | undefined;
  remainingMs: number;
  cfg: RerankConfig;
}): boolean {
  const { candidates, goal, remainingMs, cfg } = args;
  if (candidates.length < 2) return false;                 // minimum to reorder
  if (remainingMs < cfg.timeoutMs) return false;           // budget must permit the timeout
  // triggers (any):
  if (goal === 'show_similar') return true;                // explicit comparison
  if (candidates.length >= cfg.minCandidates) return true; // volume
  const [a, b] = candidates;                               // RRF ambiguity (top-two gap)
  if (a && b && Math.abs(a.rrfScore - b.rrfScore) <= cfg.rrfMargin) return true;
  return false;
}
```
Then `test/support/fake-reranker.ts`:
```ts
import type { RerankerPort } from '../../src/ports/strategy-similarity.port.ts';
import type { SimilarStrategyCandidate } from '../../src/domain/strategy-retrieval.ts';

/** Deterministic reranker for tests/CI: reorders by a provided key fn (default: reverse rrf to prove
 *  the reorder happened), takes the top `limit`. No network. Optionally throws / delays for fault tests. */
export class FakeReranker implements RerankerPort {
  readonly #key: (c: SimilarStrategyCandidate) => number;
  readonly #behavior: 'ok' | 'throw';
  constructor(opts?: { key?: (c: SimilarStrategyCandidate) => number; behavior?: 'ok' | 'throw' }) {
    this.#key = opts?.key ?? ((c) => -c.rrfScore);
    this.#behavior = opts?.behavior ?? 'ok';
  }
  async rerank(_query: string, candidates: readonly SimilarStrategyCandidate[], limit: number, signal?: AbortSignal): Promise<readonly SimilarStrategyCandidate[]> {
    if (this.#behavior === 'throw') throw new Error('fake reranker failure');
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return [...candidates].sort((a, b) => this.#key(a) - this.#key(b)).slice(0, limit);
  }
}
```

- [ ] **Step 4: Run → pass.** **Step 5: Commit** `feat(operator): rerank decision policy (§7) + FakeReranker test double`.

---

### Task 3: Integrate reranking into `OperatorRetrieval.#runHybrid`

**Files:** Modify `src/operator/operator-retrieval.ts`; Test `src/operator/operator-retrieval.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (use the existing test harness `makeRetrieval` + fake clock/scheduler; mirror the existing deadline tests)

Cover, with a `FakeReranker` + the existing fake clock:
- reranker reorders the fused candidates when a trigger fires (e.g. `goal: 'show_similar'`) — assert the emitted candidate order changed + top-`limit`;
- no reranker dep → candidates unchanged (RRF order), no warning;
- reranker throws → RRF order preserved + `warnings` contains `rerank_failed`;
- reranker timeout (fake clock advances past `timeoutMs`) → RRF order + `rerank_failed` warning, and no hang;
- exact-hit path → `#runHybrid` not run → never reranks (existing exact test still green).

```ts
// sketch — fill in against the file's existing makeRetrieval(...) harness:
it('reranks fused candidates when a trigger fires', async () => {
  const reranker = new FakeReranker(); // reverses rrf order
  const r = makeRetrieval({ reranker, rerankConfig: { timeoutMs: 100, limit: 5, minCandidates: 10, rrfMargin: 0.002 }, /* similarity returns >=2 candidates */ });
  const ev = await r.collect(inputWith({ goal: 'show_similar' }));
  // assert the evidence/candidate order reflects the FakeReranker reorder (top of list flipped) and length <= limit
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

1. Add to `RETRIEVAL_WARNINGS`: `rerankFailed: 'rerank_failed',`.
2. Imports: `import { shouldRerank, type RerankConfig } from './rerank-policy.ts'; import type { RerankerPort } from '../ports/strategy-similarity.port.ts';`
3. `OperatorRetrievalDeps`: add `reranker?: RerankerPort;` and `rerankConfig?: RerankConfig;`.
4. In `#runHybrid`, replace:
```ts
  const candidates = [...result.candidates];
  onCandidates(candidates);
```
with:
```ts
  let candidates = [...result.candidates];

  // §7 conditional reranking — RRF order is the baseline + the fallback.
  const reranker = this.#deps.reranker;
  const rcfg = this.#deps.rerankConfig;
  if (reranker && rcfg) {
    const remainingMs = budget.remaining(this.#deps.clock());
    if (shouldRerank({ candidates, goal: input.turn.goal, remainingMs, cfg: rcfg })) {
      const rerankStart = this.#deps.clock();
      try {
        const reranked = await this.#withTimeout(
          (signal) => reranker.rerank(message, candidates, rcfg.limit, signal),
          Math.min(rcfg.timeoutMs, remainingMs),
          budget,
        );
        candidates = [...reranked];
      } catch (err) {
        warnings.add(RETRIEVAL_WARNINGS.rerankFailed);
        if (isAbortError(err) || budget.hardExpired(this.#deps.clock())) warnings.add(RETRIEVAL_WARNINGS.hardDeadline);
        // candidates keeps the RRF order
      }
      timingsMs.rerankMs = this.#deps.clock() - rerankStart;
    }
  }

  onCandidates(candidates);
```
5. Add a private `#withTimeout` helper that races the rerank against a scheduler-driven timeout AND the budget signal, using `this.#deps.scheduler` + an `AbortController` linked to `budget.signal` (mirror the existing `raceSignal` pattern + a scheduler-fired abort):
```ts
  #withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, budget: RetrievalBudget): Promise<T> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(budget.signal.reason);
    if (budget.signal.aborted) ctl.abort(budget.signal.reason);
    else budget.signal.addEventListener('abort', onAbort, { once: true });
    const cancel = this.#deps.scheduler(ms, () => ctl.abort(new DOMException('rerank timeout', 'AbortError')));
    return raceSignal(fn(ctl.signal), ctl.signal).finally(() => {
      cancel();
      budget.signal.removeEventListener('abort', onAbort);
    });
  }
```
(Confirm `raceSignal`/`isAbortError` are in-scope module functions — they are, in this file.)

- [ ] **Step 4: Run → pass** (`npx vitest run src/operator/operator-retrieval.test.ts`). **Step 5: Commit** `feat(operator): conditional reranking in #runHybrid (deadline-aware, RRF fallback)`.

---

### Task 4: `MastraRerankerAdapter` (flagged) + agent factory

**Files:** Create `src/mastra/agents/reranker.agent.ts`, `src/adapters/reranker/mastra-reranker.adapter.ts`; Test `src/adapters/reranker/mastra-reranker.adapter.test.ts`

- [ ] **Step 1:** Confirm the Mastra rerank API via context7 (`mastra rerank` — semantic/vector/position scoring; per §7 NOT a cross-encoder). Decide the concrete mechanism (Mastra `rerank()` from `@mastra/rag`, or an embedding-cosine re-score). Keep it strictly behind the `RerankerPort`.

- [ ] **Step 2: Write the failing test** — construct the adapter with a STUB of the Mastra primitive (injected), assert it implements `RerankerPort.rerank` (maps candidates → query-scored order → top `limit`), honors `signal` (aborted → throws), and is strip-types-safe (plain class, fields assigned in ctor, no parameter properties). Do NOT call a live model in the test.

- [ ] **Step 3: Implement** — `MastraRerankerAdapter implements RerankerPort` (template: `MastraTurnInterpreter` — `constructor(deps...) { this.x = ... }`, no parameter properties). `createRerankerAgent(model)` under `src/mastra/agents/` (template: `createTurnInterpreterAgent`) only if an Agent is needed; if using `@mastra/rag` `rerank()`, the adapter takes the model/scorer config instead. Export from `src/mastra/index.ts` / the adapter barrel as the siblings do.

- [ ] **Step 4: Run → pass; typecheck.** **Step 5: Commit** `feat(reranker): MastraRerankerAdapter (RerankerPort, flagged)`.

---

### Task 5: Compose the reranker (gated) + thread into OperatorRetrieval

**Files:** Modify `src/composition.ts`

- [ ] **Step 1:** In `buildOperatorRag`, after `const similarity = new PgHybridStrategySimilarityAdapter(db);`, construct the reranker only when enabled:
```ts
  const reranker = env.OPERATOR_RERANKER === 'mastra'
    ? new MastraRerankerAdapter(/* agent/model from the mastra runtime, per Task 4 */)
    : undefined;
  const rerankConfig = {
    timeoutMs: env.OPERATOR_RERANK_TIMEOUT_MS, limit: env.OPERATOR_RERANK_LIMIT,
    minCandidates: env.OPERATOR_RERANK_MIN_CANDIDATES, rrfMargin: env.OPERATOR_RERANK_RRF_MARGIN,
  };
```
Pass `...(reranker ? { reranker } : {}), rerankConfig` into the `new OperatorRetrieval({ … })` deps. (Default `none` → `reranker` undefined → `OperatorRetrieval` behaves exactly as today.)

- [ ] **Step 2: Typecheck** (`pnpm typecheck`) clean. **Step 3: Commit** `feat(composition): wire reranker behind OPERATOR_RERANKER (default off)`.

---

### Task 6: Eval comparison — RRF-only vs reranker-enabled (CI, deterministic)

**Files:** Create `src/experiments/operator-rag/rerank-compare.test.ts` (deterministic, fake reranker)

- [ ] **Step 1: Write the test** — build two `RetrievalPort`s over the golden fixtures: (a) RRF-only (existing fixture/fake similarity order), (b) reranker-enabled = wrap (a) and apply `FakeReranker` to the candidate order. Run both through `runRetrieval`, compute `ndcgAtK(ids, gradedRelevance, 5)` per case, aggregate. Assert: reranker-enabled aggregate nDCG@5 **does not regress** (`>= rrfOnly - epsilon`); log both + the delta + the `+0.02` enable-threshold (measured, not enforced). Use the existing fixtures + a fixture similarity/order source so it's fully deterministic (no embedding/db).

- [ ] **Step 2: Run → green.** **Step 3: Commit** `test(eval): RRF-vs-reranker nDCG@5 comparison + no-regression gate (fake reranker)`.

---

### Task 7: Full gate

- [ ] **Step 1:** `pnpm check` (typecheck + full suite incl. `strip-types-no-param-properties.test.ts`) — clean/green.
- [ ] **Step 2:** `timeout 12 node --experimental-strip-types src/ingress/server.ts 2>&1 | head -5` — reaches the runtime `DATABASE_URL` check (no parse error; the new reranker code is strip-types-safe).
- [ ] **Step 3: Commit** any fixups: `chore(reranker): scaffold green (typecheck + suite + strip-types)`.

---

## Notes for the implementer

- **Reuse the existing `RerankerPort`** in `src/ports/strategy-similarity.port.ts` — do NOT create a new port. Its signature is `rerank(query, candidates, limit, signal?)`.
- **RRF is the mandatory baseline + fallback.** Any rerank failure/timeout/abort must keep the pre-rerank `candidates` order and add `RETRIEVAL_WARNINGS.rerankFailed`. Never ship an empty/worse result from a reranker error.
- **Default OFF** — `OPERATOR_RERANKER=none` ⇒ `reranker` undefined ⇒ zero behaviour change. No production path enables it in this slice.
- **No TS parameter properties** (strip-types); ESM `.ts` imports; Mastra construction only under `src/mastra/**`.
- **Determinism:** all reranker tests use `FakeReranker` + the existing injected `clock`/`scheduler`. No live model in any PR-gate test.
- **Audit safety:** do not add raw candidate/strategy text to audit events; the rerank step only affects ordering + a timing/warning.
- Confirm the exact `loadEnv` test-stub shape, the `makeRetrieval` test harness signature, and `raceSignal`/`isAbortError` scope by reading the real files before coding each task.
