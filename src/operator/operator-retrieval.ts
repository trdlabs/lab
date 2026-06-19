// src/operator/operator-retrieval.ts
import type {
  EvidenceRef,
  OperatorEvidence,
  SimilarStrategyCandidate,
  StrategyCandidateSet,
} from '../domain/strategy-retrieval.ts';
import type {
  OperatorRetrievalInput,
  OperatorRetrievalPort,
} from '../ports/operator-retrieval.port.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import type { EmbeddingPort } from '../ports/embedding.port.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { StrategySimilarityPort } from '../ports/strategy-similarity.port.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';

export const DEFAULT_SOFT_DEADLINE_MS = 5000;
export const DEFAULT_HARD_DEADLINE_MS = 10000;

export const RETRIEVAL_WARNINGS = {
  softDeadline: 'soft_deadline_exceeded',
  hardDeadline: 'hard_deadline_exceeded',
  exactFailed: 'exact_lookup_failed',
  similarityAborted: 'similarity_aborted',
  similarityFailed: 'similarity_failed',
  embedFailed: 'embed_failed',
} as const;

/**
 * A timer abstraction. Production passes a setTimeout-backed scheduler; tests pass a
 * fake scheduler driven by a fake monotonic clock so deadlines are fully deterministic.
 * Returns a cancel function.
 */
export type Scheduler = (delayMs: number, cb: () => void) => () => void;

export const realScheduler: Scheduler = (delayMs, cb) => {
  const handle = setTimeout(cb, delayMs);
  // Do not keep the event loop alive solely for the deadline timer.
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref?: () => void }).unref!();
  }
  return () => clearTimeout(handle);
};

export interface RetrievalBudget {
  readonly startedAtMs: number;
  readonly softDeadlineMs: number;
  readonly hardDeadlineMs: number;
  remaining(nowMs: number): number;
  softExpired(nowMs: number): boolean;
  hardExpired(nowMs: number): boolean;
  /** Aborts at the hard deadline (driven by the injected scheduler). */
  readonly signal: AbortSignal;
  /** Cancels the underlying hard-deadline timer; call when retrieval finishes. */
  dispose(): void;
}

export interface CreateRetrievalBudgetOptions {
  clock: () => number;
  scheduler: Scheduler;
  softDeadlineMs?: number;
  hardDeadlineMs?: number;
}

/**
 * A monotonic deadline budget. The hard-deadline abort is scheduled through the
 * injected scheduler so a fake clock can fire it deterministically in tests. No retries.
 */
export function createRetrievalBudget(opts: CreateRetrievalBudgetOptions): RetrievalBudget {
  const startedAtMs = opts.clock();
  const softDeadlineMs = opts.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS;
  const hardDeadlineMs = opts.hardDeadlineMs ?? DEFAULT_HARD_DEADLINE_MS;
  const controller = new AbortController();

  const cancelTimer = opts.scheduler(hardDeadlineMs, () => {
    if (!controller.signal.aborted) controller.abort();
  });

  return {
    startedAtMs,
    softDeadlineMs,
    hardDeadlineMs,
    remaining: (nowMs) => Math.max(0, startedAtMs + hardDeadlineMs - nowMs),
    softExpired: (nowMs) => nowMs - startedAtMs >= softDeadlineMs,
    hardExpired: (nowMs) => nowMs - startedAtMs >= hardDeadlineMs,
    signal: controller.signal,
    dispose: cancelTimer,
  };
}

export interface OperatorRetrievalDeps {
  embedding: EmbeddingPort;
  strategyProfiles: StrategyProfileRepository;
  similarity: StrategySimilarityPort;
  clock: () => number;
  scheduler: Scheduler;
  /** Wall-clock ISO timestamp for observedAt fields; injected for determinism. */
  isoNow: () => string;
  softDeadlineMs?: number;
  hardDeadlineMs?: number;
  /** Retrieval breadth knobs; sensible defaults for the baseline. */
  lexicalLimit?: number;
  vectorLimit?: number;
  fusedLimit?: number;
}

const isAbortError = (err: unknown): boolean =>
  err instanceof DOMException ? err.name === 'AbortError' : (err as { name?: string })?.name === 'AbortError';

/**
 * Resolves `p`, but if `signal` aborts first, rejects with the abort reason. The
 * underlying promise is left running (the repository/embedding ports take no signal of
 * their own); racing lets the orchestrator honour the hard deadline without blocking.
 */
function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** RRF candidate → the retrieval method that best describes how it surfaced. */
function methodForCandidate(c: SimilarStrategyCandidate): EvidenceRef['retrievalMethod'] {
  const hasLexical = c.lexicalRank !== undefined;
  const hasVector = c.vectorRank !== undefined;
  if (hasLexical && hasVector) return 'rrf';
  if (hasVector) return 'vector';
  if (hasLexical) return 'lexical';
  return 'rrf';
}

/**
 * Deadline-aware operator evidence orchestration.
 *
 * Authority model: an exact fingerprint hit is authoritative and SKIPS hybrid
 * similarity unless the turn explicitly asks to `show_similar`. A miss (or a failed
 * exact lookup, treated like a miss for policy) runs structured + hybrid similarity.
 *
 * Deadline model: no NEW stage starts after the SOFT deadline; at the HARD deadline the
 * budget signal aborts in-flight adapters and whatever evidence exists is returned. A
 * timeout is NEVER reported as an authoritative "nothing found" — it becomes a warning
 * code and the affected stage reflects that it did not complete.
 *
 * Audit safety: the evidence payload carries only hashes, ids, counts, codes, and
 * timings — never raw strategy text or embeddings.
 */
export class OperatorRetrieval implements OperatorRetrievalPort {
  readonly #deps: OperatorRetrievalDeps;

  constructor(deps: OperatorRetrievalDeps) {
    this.#deps = deps;
  }

  async collect(input: OperatorRetrievalInput): Promise<OperatorEvidence> {
    const { turn, message } = input;
    const subjectHash = sourceFingerprint('manual_description', message.trim());
    const startedAtMs = this.#deps.clock();

    // Non-strategy subjects: no exact lookup, no vector query, authoritative-complete.
    if (turn.subject !== 'strategy') {
      return {
        subjectHash,
        status: 'complete',
        exactLookup: 'not_run',
        similarStrategies: [],
        evidenceRefs: [],
        warningCodes: [],
        timingsMs: { totalMs: this.#deps.clock() - startedAtMs },
      };
    }

    const budget = createRetrievalBudget({
      clock: this.#deps.clock,
      scheduler: this.#deps.scheduler,
      softDeadlineMs: this.#deps.softDeadlineMs,
      hardDeadlineMs: this.#deps.hardDeadlineMs,
    });

    const warnings = new Set<string>();
    const evidenceRefs: EvidenceRef[] = [];
    const timingsMs: Record<string, number> = {};

    let exactLookup: OperatorEvidence['exactLookup'] = 'not_run';
    let exactMatch: OperatorEvidence['exactMatch'] | undefined;
    let exactProfile: StrategyProfile | null = null;
    let similarStrategies: SimilarStrategyCandidate[] = [];

    try {
      // ---- Stage 1: exact lookup (raced against the hard deadline) ----
      const exactStart = this.#deps.clock();
      try {
        exactProfile = await raceSignal(
          this.#deps.strategyProfiles.findByFingerprint(subjectHash),
          budget.signal,
        );
        if (exactProfile) {
          exactLookup = 'hit';
          exactMatch = {
            strategyProfileId: exactProfile.id,
            label: labelForProfile(exactProfile),
            observedAt: this.#deps.isoNow(),
          };
          evidenceRefs.push({
            sourceType: 'strategy_profile',
            sourceId: exactProfile.id,
            retrievalMethod: 'exact',
            observedAt: this.#deps.isoNow(),
          });
        } else {
          exactLookup = 'miss';
        }
      } catch (err) {
        exactLookup = 'failed';
        if (isAbortError(err) || budget.hardExpired(this.#deps.clock())) {
          warnings.add(RETRIEVAL_WARNINGS.hardDeadline);
        } else {
          warnings.add(RETRIEVAL_WARNINGS.exactFailed);
        }
      } finally {
        timingsMs.exactMs = this.#deps.clock() - exactStart;
      }

      // ---- Policy: should hybrid similarity run? ----
      const wantSimilar = turn.goal === 'show_similar';
      const exactIsAuthoritativeHit = exactLookup === 'hit' && !wantSimilar;
      const shouldRunHybrid = !exactIsAuthoritativeHit;

      // ---- Deadline gate: no NEW work after the soft (or hard) deadline ----
      if (shouldRunHybrid) {
        const now = this.#deps.clock();
        if (budget.hardExpired(now)) {
          warnings.add(RETRIEVAL_WARNINGS.hardDeadline);
        } else if (budget.softExpired(now)) {
          warnings.add(RETRIEVAL_WARNINGS.softDeadline);
        } else {
          await this.#runHybrid({
            input,
            excludeProfileId: exactProfile?.id,
            budget,
            warnings,
            evidenceRefs,
            timingsMs,
            onCandidates: (c) => { similarStrategies = c; },
          });
        }
      }
    } finally {
      budget.dispose();
    }

    timingsMs.totalMs = this.#deps.clock() - startedAtMs;
    const warningCodes = [...warnings];
    const status: OperatorEvidence['status'] = warningCodes.length > 0 ? 'degraded' : 'complete';

    return {
      subjectHash,
      status,
      exactLookup,
      ...(exactMatch ? { exactMatch } : {}),
      similarStrategies,
      evidenceRefs,
      warningCodes,
      timingsMs,
    };
  }

  async #runHybrid(args: {
    input: OperatorRetrievalInput;
    excludeProfileId: string | undefined;
    budget: RetrievalBudget;
    warnings: Set<string>;
    evidenceRefs: EvidenceRef[];
    timingsMs: Record<string, number>;
    onCandidates: (c: SimilarStrategyCandidate[]) => void;
  }): Promise<void> {
    const { input, excludeProfileId, budget, warnings, evidenceRefs, timingsMs, onCandidates } = args;
    const { turn, message } = input;

    // ---- Stage 2: embed the query text ----
    const embedStart = this.#deps.clock();
    let embedding: readonly number[];
    try {
      const vectors = await raceSignal(
        this.#deps.embedding.embed([message], budget.signal),
        budget.signal,
      );
      embedding = vectors[0] ?? [];
    } catch (err) {
      timingsMs.embedMs = this.#deps.clock() - embedStart;
      if (isAbortError(err) || budget.hardExpired(this.#deps.clock())) {
        warnings.add(RETRIEVAL_WARNINGS.hardDeadline);
        warnings.add(RETRIEVAL_WARNINGS.similarityAborted);
      } else {
        warnings.add(RETRIEVAL_WARNINGS.embedFailed);
      }
      return;
    }
    timingsMs.embedMs = this.#deps.clock() - embedStart;

    // Soft deadline may have arrived during embedding; do not start the similarity query.
    if (budget.hardExpired(this.#deps.clock())) {
      warnings.add(RETRIEVAL_WARNINGS.hardDeadline);
      return;
    }
    if (budget.softExpired(this.#deps.clock())) {
      warnings.add(RETRIEVAL_WARNINGS.softDeadline);
      return;
    }

    // ---- Stage 3: hybrid similarity search ----
    const simStart = this.#deps.clock();
    let result: StrategyCandidateSet;
    try {
      result = await this.#deps.similarity.search({
        text: message,
        embedding,
        filters: {
          ...(turn.constraints.market ? { market: turn.constraints.market } : {}),
          ...(turn.constraints.symbol ? { symbol: turn.constraints.symbol } : {}),
          ...(turn.constraints.timeframe ? { timeframe: turn.constraints.timeframe } : {}),
          ...(turn.constraints.direction ? { direction: turn.constraints.direction } : {}),
        },
        lexicalLimit: this.#deps.lexicalLimit ?? 20,
        vectorLimit: this.#deps.vectorLimit ?? 20,
        fusedLimit: this.#deps.fusedLimit ?? 20,
        ...(excludeProfileId ? { excludeProfileId } : {}),
        signal: budget.signal,
      });
    } catch (err) {
      timingsMs.similarityMs = this.#deps.clock() - simStart;
      if (isAbortError(err) || budget.hardExpired(this.#deps.clock())) {
        warnings.add(RETRIEVAL_WARNINGS.hardDeadline);
        warnings.add(RETRIEVAL_WARNINGS.similarityAborted);
      } else {
        warnings.add(RETRIEVAL_WARNINGS.similarityFailed);
      }
      return;
    }
    timingsMs.similarityMs = this.#deps.clock() - simStart;

    // Carry through the adapter's own degradation codes verbatim.
    for (const code of result.degradedReasonCodes) warnings.add(code);

    const candidates = [...result.candidates];
    onCandidates(candidates);
    for (const c of candidates) {
      evidenceRefs.push({
        sourceType: 'retrieval_projection',
        sourceId: c.strategyProfileId,
        retrievalMethod: methodForCandidate(c),
        observedAt: this.#deps.isoNow(),
      });
    }
  }
}

/**
 * Audit-safe label for an exact-matched profile. The evidence payload is an audit
 * record, so the label must NOT carry raw strategy text (coreIdea, summary, source).
 * The stable profile id is used as the label; the renderer may enrich it from a
 * separate, non-audit projection if richer labelling is ever wanted.
 */
function labelForProfile(profile: StrategyProfile): string {
  return profile.id;
}
