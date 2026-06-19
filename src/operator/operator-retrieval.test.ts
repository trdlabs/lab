import { describe, it, expect } from 'vitest';
import { OperatorRetrieval, createRetrievalBudget } from './operator-retrieval.ts';
import type { Scheduler } from './operator-retrieval.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import { InMemoryStrategySimilarityAdapter } from '../adapters/similarity/in-memory-strategy-similarity.adapter.ts';
import { InMemoryStrategyProfileRepository } from '../adapters/repository/in-memory-strategy-profile.repository.ts';
import type { EmbeddingPort } from '../ports/embedding.port.ts';
import type {
  SimilarStrategyCandidate,
  StrategyCandidateSet,
  StrategySimilarityQuery,
  OperatorEvidence,
} from '../domain/strategy-retrieval.ts';
import type { StrategySimilarityPort } from '../ports/strategy-similarity.port.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { InterpretedTurn } from '../chat/turn-interpretation.ts';

// ---------- fakes ----------

class FakeEmbedding implements EmbeddingPort {
  readonly model = 'fake-embed';
  readonly dimensions = 3;
  readonly calls: string[][] = [];
  async embed(texts: readonly string[], _signal?: AbortSignal): Promise<readonly number[][]> {
    this.calls.push([...texts]);
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
}

function makeProfile(over: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    id: 'p-exact',
    version: 1,
    sourceKind: 'manual_description',
    sourceFingerprint: 'sha256:placeholder',
    direction: 'long',
    coreIdea: 'Buy capitulation wicks on high OI',
    requiredMarketFeatures: ['oi'],
    confidence: 0.6,
    unknowns: [],
    profile: {} as never,
    sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...over,
  };
}

function simCandidate(over: Partial<SimilarStrategyCandidate> = {}): SimilarStrategyCandidate {
  return {
    strategyProfileId: 'p-sim-1',
    lexicalRank: 1,
    lexicalScore: 0.7,
    vectorRank: 1,
    vectorDistance: 0.3,
    rrfScore: 0.5,
    metadata: { market: 'crypto', symbol: 'BTCUSDT', timeframe: '1m', direction: 'long', label: 'Similar one', createdAt: '2026-06-12T00:00:00.000Z' },
    ...over,
  };
}

const strategyTurn: InterpretedTurn = {
  subject: 'strategy',
  goal: 'analyze',
  constraints: { market: 'crypto', symbol: 'BTCUSDT', timeframe: '1m', direction: 'long' },
  references: [],
  confidence: 0.9,
};

// A controllable monotonic clock + a fake scheduler bound to it.
function fakeClock(start = 1000) {
  let now = start;
  const timers: { at: number; cb: () => void; cancelled: boolean }[] = [];
  const clock = () => now;
  const scheduler: Scheduler = (delayMs, cb) => {
    const entry = { at: now + delayMs, cb, cancelled: false };
    timers.push(entry);
    return () => { entry.cancelled = true; };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers) {
      if (!t.cancelled && t.at <= now) {
        t.cancelled = true;
        t.cb();
      }
    }
  };
  return { clock, scheduler, advance };
}

const message = 'buy capitulation wicks on high OI';
const subjectHash = sourceFingerprint('manual_description', message);

function makeRetrieval(opts: {
  embedding?: EmbeddingPort;
  profiles?: InMemoryStrategyProfileRepository;
  similarity?: StrategySimilarityPort;
  clock: () => number;
  scheduler: Scheduler;
  isoNow?: () => string;
  softDeadlineMs?: number;
  hardDeadlineMs?: number;
}) {
  return new OperatorRetrieval({
    embedding: opts.embedding ?? new FakeEmbedding(),
    strategyProfiles: opts.profiles ?? new InMemoryStrategyProfileRepository(),
    similarity: opts.similarity ?? new InMemoryStrategySimilarityAdapter(),
    clock: opts.clock,
    scheduler: opts.scheduler,
    isoNow: opts.isoNow ?? (() => '2026-06-19T00:00:00.000Z'),
    softDeadlineMs: opts.softDeadlineMs,
    hardDeadlineMs: opts.hardDeadlineMs,
  });
}

// ---------- budget unit tests ----------

describe('createRetrievalBudget', () => {
  it('reports remaining/soft/hard against an injected clock and aborts at hard deadline', () => {
    const { clock, scheduler, advance } = fakeClock(0);
    const budget = createRetrievalBudget({ clock, scheduler, softDeadlineMs: 5000, hardDeadlineMs: 10000 });

    expect(budget.startedAtMs).toBe(0);
    expect(budget.remaining(0)).toBe(10000);
    expect(budget.softExpired(4999)).toBe(false);
    expect(budget.softExpired(5000)).toBe(true);
    expect(budget.hardExpired(9999)).toBe(false);
    expect(budget.signal.aborted).toBe(false);

    advance(10000);
    expect(budget.hardExpired(10000)).toBe(true);
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  it('uses defaults of 5000 / 10000', () => {
    const { clock, scheduler } = fakeClock(0);
    const budget = createRetrievalBudget({ clock, scheduler });
    expect(budget.softDeadlineMs).toBe(5000);
    expect(budget.hardDeadlineMs).toBe(10000);
    budget.dispose();
  });
});

// ---------- orchestration tests ----------

describe('OperatorRetrieval (strategy turn)', () => {
  it('exact hit has authority and SKIPS hybrid similarity (goal !== show_similar)', async () => {
    const profiles = new InMemoryStrategyProfileRepository();
    await profiles.create(makeProfile({ id: 'p-exact', sourceFingerprint: subjectHash }));
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [simCandidate()] });
    const embedding = new FakeEmbedding();
    const { clock, scheduler } = fakeClock();

    const retrieval = makeRetrieval({ profiles, similarity, embedding, clock, scheduler });
    const evidence = await retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });

    expect(evidence.exactLookup).toBe('hit');
    expect(evidence.exactMatch?.strategyProfileId).toBe('p-exact');
    expect(evidence.similarStrategies).toEqual([]);
    expect(similarity.calls).toHaveLength(0); // hybrid skipped
    expect(embedding.calls).toHaveLength(0); // no embedding when hybrid skipped
    expect(evidence.status).toBe('complete');
    expect(evidence.evidenceRefs.some((r) => r.retrievalMethod === 'exact')).toBe(true);
  });

  it('exact hit STILL runs hybrid when goal === show_similar, excluding the exact id', async () => {
    const profiles = new InMemoryStrategyProfileRepository();
    await profiles.create(makeProfile({ id: 'p-exact', sourceFingerprint: subjectHash }));
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [simCandidate(), simCandidate({ strategyProfileId: 'p-exact' })] });
    const embedding = new FakeEmbedding();
    const { clock, scheduler } = fakeClock();

    const retrieval = makeRetrieval({ profiles, similarity, embedding, clock, scheduler });
    const evidence = await retrieval.collect({
      turn: { ...strategyTurn, goal: 'show_similar' },
      message, sessionId: 's1', retrievalId: 'r1',
    });

    expect(evidence.exactLookup).toBe('hit');
    expect(similarity.calls).toHaveLength(1);
    expect(similarity.calls[0]!.query.excludeProfileId).toBe('p-exact');
    expect(embedding.calls).toHaveLength(1);
    // The exact id is excluded by the adapter; only the genuine similar remains.
    expect(evidence.similarStrategies.map((c) => c.strategyProfileId)).toEqual(['p-sim-1']);
  });

  it('no exact hit (miss) runs structured + similarity', async () => {
    const profiles = new InMemoryStrategyProfileRepository(); // empty
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [simCandidate()] });
    const embedding = new FakeEmbedding();
    const { clock, scheduler } = fakeClock();

    const retrieval = makeRetrieval({ profiles, similarity, embedding, clock, scheduler });
    const evidence = await retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });

    expect(evidence.exactLookup).toBe('miss');
    expect(evidence.exactMatch).toBeUndefined();
    expect(similarity.calls).toHaveLength(1);
    expect(embedding.calls).toHaveLength(1);
    expect(evidence.similarStrategies.map((c) => c.strategyProfileId)).toEqual(['p-sim-1']);
    // Filters passed through from constraints.
    expect(similarity.calls[0]!.query.filters).toMatchObject({ market: 'crypto', symbol: 'BTCUSDT', timeframe: '1m', direction: 'long' });
    expect(similarity.calls[0]!.query.excludeProfileId).toBeUndefined();
  });

  it('subjectHash matches the manual_description fingerprint of the trimmed message', async () => {
    const { clock, scheduler } = fakeClock();
    const retrieval = makeRetrieval({ clock, scheduler });
    const evidence = await retrieval.collect({ turn: strategyTurn, message: `  ${message}  `, sessionId: 's1', retrievalId: 'r1' });
    expect(evidence.subjectHash).toBe(subjectHash);
  });

  it('preserves vector/lexical degradation as warning codes and marks status degraded', async () => {
    const profiles = new InMemoryStrategyProfileRepository();
    const degradingSimilarity: StrategySimilarityPort = {
      async search(_q: StrategySimilarityQuery): Promise<StrategyCandidateSet> {
        return { candidates: [simCandidate()], degradedReasonCodes: ['vector_failed'] };
      },
    };
    const { clock, scheduler } = fakeClock();
    const retrieval = makeRetrieval({ profiles, similarity: degradingSimilarity, clock, scheduler });
    const evidence = await retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });

    expect(evidence.warningCodes).toContain('vector_failed');
    expect(evidence.status).toBe('degraded');
    // Candidates that DID come back are still preserved.
    expect(evidence.similarStrategies).toHaveLength(1);
  });

  it('exact lookup error becomes a warning code (failed), NOT an empty authoritative result', async () => {
    const failingProfiles: InMemoryStrategyProfileRepository = Object.assign(
      new InMemoryStrategyProfileRepository(),
      { findByFingerprint: async () => { throw new Error('db down'); } },
    );
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [simCandidate()] });
    const { clock, scheduler } = fakeClock();
    const retrieval = makeRetrieval({ profiles: failingProfiles, similarity, clock, scheduler });
    const evidence = await retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });

    expect(evidence.exactLookup).toBe('failed');
    expect(evidence.exactMatch).toBeUndefined();
    expect(evidence.warningCodes).toContain('exact_lookup_failed');
    expect(evidence.status).toBe('degraded');
    // A failed exact lookup still permits structured + similarity (treated like a miss for policy).
    expect(similarity.calls).toHaveLength(1);
  });

  it('source ids and freshness are present on similar evidence refs', async () => {
    const profiles = new InMemoryStrategyProfileRepository();
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [simCandidate({ strategyProfileId: 'p-sim-7' })] });
    const { clock, scheduler } = fakeClock();
    const retrieval = makeRetrieval({ profiles, similarity, clock, scheduler });
    const evidence = await retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });

    const ref = evidence.evidenceRefs.find((r) => r.sourceId === 'p-sim-7');
    expect(ref).toBeDefined();
    expect(ref!.observedAt).toBe('2026-06-19T00:00:00.000Z');
    expect(['rrf', 'lexical', 'vector']).toContain(ref!.retrievalMethod);
    // Candidate freshness (createdAt) is carried in metadata for the renderer.
    expect(evidence.similarStrategies[0]!.metadata.createdAt).toBe('2026-06-12T00:00:00.000Z');
  });

  it('records per-stage timings (exactMs/embedMs/similarityMs/totalMs)', async () => {
    const profiles = new InMemoryStrategyProfileRepository();
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [] });
    // Advance the clock inside each stage to produce non-trivial timings.
    const { clock, scheduler, advance } = fakeClock();
    const embedding: EmbeddingPort = {
      model: 'm', dimensions: 3,
      async embed(t) { advance(3); return t.map(() => [0, 0, 0]); },
    };
    const profilesSpy = Object.assign(profiles, {
      findByFingerprint: async (fp: string) => { advance(2); return InMemoryStrategyProfileRepository.prototype.findByFingerprint.call(profiles, fp); },
    });
    const retrieval = makeRetrieval({ profiles: profilesSpy, similarity, embedding, clock, scheduler });
    const evidence = await retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });

    expect(evidence.timingsMs.exactMs).toBeGreaterThanOrEqual(2);
    expect(evidence.timingsMs.embedMs).toBeGreaterThanOrEqual(3);
    expect(typeof evidence.timingsMs.similarityMs).toBe('number');
    expect(evidence.timingsMs.totalMs).toBeGreaterThanOrEqual(5);
  });

  it('NON-strategy subject does NO vector query and returns not_run/empty/complete', async () => {
    const embedding = new FakeEmbedding();
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [simCandidate()] });
    const profiles = new InMemoryStrategyProfileRepository();
    const { clock, scheduler } = fakeClock();
    const retrieval = makeRetrieval({ profiles, similarity, embedding, clock, scheduler });

    for (const subject of ['bot', 'results', 'task', 'hypothesis', 'unknown'] as const) {
      const evidence = await retrieval.collect({
        turn: { ...strategyTurn, subject },
        message, sessionId: 's1', retrievalId: 'r1',
      });
      expect(evidence.exactLookup).toBe('not_run');
      expect(evidence.similarStrategies).toEqual([]);
      expect(evidence.status).toBe('complete');
    }
    expect(embedding.calls).toHaveLength(0);
    expect(similarity.calls).toHaveLength(0);
  });

  // ---------- deadline semantics ----------

  it('SOFT deadline: starts NO new work (skips similarity) but returns the exact-lookup result', async () => {
    const profiles = new InMemoryStrategyProfileRepository(); // miss
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [simCandidate()] });
    const embedding = new FakeEmbedding();
    // Exact lookup consumes past the soft deadline, so similarity must NOT launch.
    const { clock, scheduler, advance } = fakeClock(0);
    const slowExact = Object.assign(profiles, {
      findByFingerprint: async () => { advance(6000); return null; }, // soft=5000
    });
    const retrieval = makeRetrieval({ profiles: slowExact, similarity, embedding, clock, scheduler, softDeadlineMs: 5000, hardDeadlineMs: 10000 });
    const evidence = await retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });

    expect(evidence.exactLookup).toBe('miss'); // exact ran and is reported
    expect(similarity.calls).toHaveLength(0); // no NEW work after soft deadline
    expect(embedding.calls).toHaveLength(0);
    expect(evidence.warningCodes).toContain('soft_deadline_exceeded');
    expect(evidence.status).toBe('degraded');
  });

  it('HARD deadline: aborts the in-flight similarity adapter and returns available evidence (never "nothing found")', async () => {
    const profiles = new InMemoryStrategyProfileRepository(); // miss
    const embedding = new FakeEmbedding();
    const { clock, scheduler, advance } = fakeClock(0);

    // Similarity hangs until aborted; when the hard timer fires the budget signal aborts it.
    const hangingSimilarity: StrategySimilarityPort = {
      search(query: StrategySimilarityQuery): Promise<StrategyCandidateSet> {
        return new Promise((_resolve, reject) => {
          const signal = query.signal!;
          if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      },
    };

    const retrieval = makeRetrieval({ profiles, similarity: hangingSimilarity, embedding, clock, scheduler, softDeadlineMs: 5000, hardDeadlineMs: 10000 });
    const promise = retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });
    // Let microtasks settle so the orchestrator reaches the awaited similarity call, then fire the hard deadline.
    await Promise.resolve();
    await Promise.resolve();
    advance(10000);
    const evidence = await promise;

    expect(evidence.exactLookup).toBe('miss'); // exact result preserved
    expect(evidence.similarStrategies).toEqual([]); // similarity aborted -> none, but...
    expect(evidence.warningCodes).toContain('hard_deadline_exceeded');
    // CRITICAL: a timeout is NOT rendered as an authoritative "nothing found".
    expect(evidence.warningCodes).toContain('similarity_aborted');
    expect(evidence.status).toBe('degraded');
  });

  it('HARD deadline backstop: raceSignal aborts similarity even when the adapter NEVER resolves and IGNORES query.signal', async () => {
    const profiles = new InMemoryStrategyProfileRepository(); // miss
    const embedding = new FakeEmbedding();
    const { clock, scheduler, advance } = fakeClock(0);

    // This adapter returns a promise that never settles AND does not listen to query.signal.
    const signalIgnoringSimilarity: StrategySimilarityPort = {
      search(_query: StrategySimilarityQuery): Promise<StrategyCandidateSet> {
        return new Promise(() => { /* intentionally never resolves or rejects */ });
      },
    };

    const retrieval = makeRetrieval({
      profiles, similarity: signalIgnoringSimilarity, embedding,
      clock, scheduler, softDeadlineMs: 5000, hardDeadlineMs: 10000,
    });
    const promise = retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });
    // Let microtasks settle so the orchestrator reaches the awaited similarity call.
    await Promise.resolve();
    await Promise.resolve();
    // Fire the hard deadline timer via the fake clock.
    advance(10000);
    const evidence = await promise;

    expect(evidence.exactLookup).toBe('miss');
    expect(evidence.similarStrategies).toEqual([]);
    expect(evidence.warningCodes).toContain('hard_deadline_exceeded');
    expect(evidence.warningCodes).toContain('similarity_aborted');
    expect(evidence.status).toBe('degraded');
  });

  it('timeout never renders the exact lookup as a clean miss when it did not complete', async () => {
    const embedding = new FakeEmbedding();
    const { clock, scheduler, advance } = fakeClock(0);
    // Exact lookup hangs forever; the repository port has no signal, so the orchestrator
    // must race it against its own hard-deadline abort and report a timeout rather than block.
    const hangingProfiles = Object.assign(new InMemoryStrategyProfileRepository(), {
      findByFingerprint: (_fp: string) => new Promise<StrategyProfile | null>(() => {}),
    });

    const retrieval = makeRetrieval({ profiles: hangingProfiles, embedding, clock, scheduler, softDeadlineMs: 5000, hardDeadlineMs: 10000 });
    const promise = retrieval.collect({ turn: strategyTurn, message, sessionId: 's1', retrievalId: 'r1' });
    await Promise.resolve();
    await Promise.resolve();
    advance(10000);
    const evidence = await promise;

    // The exact lookup did not complete; it must NOT be reported as a clean 'miss'.
    expect(evidence.exactLookup).not.toBe('miss');
    expect(evidence.exactLookup).toBe('failed');
    expect(evidence.warningCodes).toContain('hard_deadline_exceeded');
    expect(evidence.status).toBe('degraded');
  });

  // ---------- audit safety ----------

  it('never puts raw strategy text in the evidence payload (hashes/ids/counts/codes/timings only)', async () => {
    const profiles = new InMemoryStrategyProfileRepository();
    await profiles.create(makeProfile({ id: 'p-exact', sourceFingerprint: subjectHash, coreIdea: 'SECRET-CORE-IDEA-TEXT' }));
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [] });
    const { clock, scheduler } = fakeClock();
    const retrieval = makeRetrieval({ profiles, similarity, clock, scheduler });
    const rawMessage = 'PROPRIETARY-STRATEGY-DESCRIPTION buy the dip on capitulation';
    const evidence: OperatorEvidence = await retrieval.collect({ turn: strategyTurn, message: rawMessage, sessionId: 's1', retrievalId: 'r1' });

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('PROPRIETARY-STRATEGY-DESCRIPTION');
    expect(serialized).not.toContain('buy the dip on capitulation');
    expect(serialized).not.toContain('SECRET-CORE-IDEA-TEXT');
    // The subject is represented only as a hash.
    expect(evidence.subjectHash.startsWith('sha256:')).toBe(true);
  });
});

// ---------- reranking tests ----------

import { FakeReranker } from '../../test/support/fake-reranker.ts';
import type { RerankConfig } from './rerank-policy.ts';

/** Extends the base makeRetrieval harness with reranker deps. */
function makeRetrievalWithReranker(opts: {
  embedding?: EmbeddingPort;
  profiles?: InMemoryStrategyProfileRepository;
  similarity?: StrategySimilarityPort;
  clock: () => number;
  scheduler: Scheduler;
  isoNow?: () => string;
  softDeadlineMs?: number;
  hardDeadlineMs?: number;
  reranker?: FakeReranker;
  rerankConfig?: RerankConfig;
}) {
  return new OperatorRetrieval({
    embedding: opts.embedding ?? new FakeEmbedding(),
    strategyProfiles: opts.profiles ?? new InMemoryStrategyProfileRepository(),
    similarity: opts.similarity ?? new InMemoryStrategySimilarityAdapter(),
    clock: opts.clock,
    scheduler: opts.scheduler,
    isoNow: opts.isoNow ?? (() => '2026-06-19T00:00:00.000Z'),
    softDeadlineMs: opts.softDeadlineMs,
    hardDeadlineMs: opts.hardDeadlineMs,
    reranker: opts.reranker,
    rerankConfig: opts.rerankConfig,
  });
}

const defaultRerankConfig: RerankConfig = {
  timeoutMs: 500,
  limit: 5,
  minCandidates: 10,
  rrfMargin: 0.002,
};

describe('OperatorRetrieval — reranking', () => {
  it('reranks fused candidates when show_similar trigger fires (FakeReranker reverses RRF order)', async () => {
    // Two candidates: p-sim-1 (rrfScore 0.9) and p-sim-2 (rrfScore 0.5).
    // FakeReranker default key is -rrfScore, so sorted ascending = [0.9→-0.9, 0.5→-0.5]
    // which means p-sim-2 comes first (higher -rrfScore → lower sort value → wait, key = -rrf)
    // Actually: sort key for p-sim-1 = -0.9, p-sim-2 = -0.5. Ascending sort: -0.9 < -0.5 → p-sim-1 first.
    // So FakeReranker with default key (-rrfScore) sorts by HIGHEST rrfScore first — same as RRF.
    // To prove reorder, use a key that reverses: (c) => c.rrfScore (ascending → lowest first).
    const c1 = simCandidate({ strategyProfileId: 'p-high', rrfScore: 0.9 });
    const c2 = simCandidate({ strategyProfileId: 'p-low', rrfScore: 0.1 });
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [c1, c2] });
    // key = c.rrfScore ascending => lowest rrfScore first => p-low first, p-high second
    const reranker = new FakeReranker({ key: (c) => c.rrfScore });
    const { clock, scheduler } = fakeClock();

    const retrieval = makeRetrievalWithReranker({
      similarity, clock, scheduler, reranker, rerankConfig: defaultRerankConfig,
    });
    const evidence = await retrieval.collect({
      turn: { ...strategyTurn, goal: 'show_similar' },
      message, sessionId: 's1', retrievalId: 'r1',
    });

    // After rerank the order is reversed: p-low before p-high.
    expect(evidence.similarStrategies.map((c) => c.strategyProfileId)).toEqual(['p-low', 'p-high']);
    // No rerank_failed warning on success.
    expect(evidence.warningCodes).not.toContain('rerank_failed');
    // rerankMs timing recorded.
    expect(typeof evidence.timingsMs.rerankMs).toBe('number');
    expect(evidence.status).toBe('complete');
  });

  it('does NOT rerank when no reranker dep is configured (RRF order preserved, no warning)', async () => {
    const c1 = simCandidate({ strategyProfileId: 'p-first', rrfScore: 0.9 });
    const c2 = simCandidate({ strategyProfileId: 'p-second', rrfScore: 0.5 });
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [c1, c2] });
    const { clock, scheduler } = fakeClock();

    // No reranker passed — use base makeRetrieval.
    const retrieval = makeRetrieval({ similarity, clock, scheduler });
    const evidence = await retrieval.collect({
      turn: { ...strategyTurn, goal: 'show_similar' },
      message, sessionId: 's1', retrievalId: 'r1',
    });

    // RRF order unchanged: p-first before p-second.
    expect(evidence.similarStrategies.map((c) => c.strategyProfileId)).toEqual(['p-first', 'p-second']);
    expect(evidence.warningCodes).not.toContain('rerank_failed');
    expect(evidence.timingsMs.rerankMs).toBeUndefined();
    expect(evidence.status).toBe('complete');
  });

  it('reranker throws → RRF order preserved + rerank_failed warning', async () => {
    const c1 = simCandidate({ strategyProfileId: 'p-first', rrfScore: 0.9 });
    const c2 = simCandidate({ strategyProfileId: 'p-second', rrfScore: 0.5 });
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [c1, c2] });
    const reranker = new FakeReranker({ behavior: 'throw' });
    const { clock, scheduler } = fakeClock();

    const retrieval = makeRetrievalWithReranker({
      similarity, clock, scheduler, reranker, rerankConfig: defaultRerankConfig,
    });
    const evidence = await retrieval.collect({
      turn: { ...strategyTurn, goal: 'show_similar' },
      message, sessionId: 's1', retrievalId: 'r1',
    });

    // RRF order preserved: p-first before p-second.
    expect(evidence.similarStrategies.map((c) => c.strategyProfileId)).toEqual(['p-first', 'p-second']);
    expect(evidence.warningCodes).toContain('rerank_failed');
    expect(evidence.status).toBe('degraded');
  });

  it('reranker timeout → RRF order preserved + rerank_failed warning, no hang', { timeout: 10000 }, async () => {
    // A reranker that hangs until aborted via its signal.
    const hangingReranker: FakeReranker = Object.assign(new FakeReranker(), {
      rerank: (_q: string, _candidates: readonly SimilarStrategyCandidate[], _limit: number, signal?: AbortSignal): Promise<readonly SimilarStrategyCandidate[]> => {
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) return void reject(new DOMException('aborted', 'AbortError'));
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      },
    });

    const c1 = simCandidate({ strategyProfileId: 'p-first', rrfScore: 0.9 });
    const c2 = simCandidate({ strategyProfileId: 'p-second', rrfScore: 0.5 });
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [c1, c2] });
    const { clock, scheduler, advance } = fakeClock(0);

    const rerankConfig: RerankConfig = { timeoutMs: 200, limit: 5, minCandidates: 10, rrfMargin: 0.002 };
    const retrieval = makeRetrievalWithReranker({
      similarity, clock, scheduler,
      reranker: hangingReranker,
      rerankConfig,
      softDeadlineMs: 5000,
      hardDeadlineMs: 10000,
    });

    const promise = retrieval.collect({
      turn: { ...strategyTurn, goal: 'show_similar' },
      message, sessionId: 's1', retrievalId: 'r1',
    });

    // Settle microtasks so the orchestrator reaches and is suspended at the reranker await.
    // The chain: collect → #runHybrid → embed(sync tick) → similarity(sync tick) → #withTimeout → rerank await.
    // Each await adds a microtask tick; flush generously.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Fire the rerank timeout (200ms) via the fake scheduler — aborts the reranker signal.
    advance(200);

    // After abort fires synchronously, microtasks propagate the rejection through raceSignal.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const evidence = await promise;

    // RRF order preserved: p-first before p-second.
    expect(evidence.similarStrategies.map((c) => c.strategyProfileId)).toEqual(['p-first', 'p-second']);
    expect(evidence.warningCodes).toContain('rerank_failed');
    expect(evidence.status).toBe('degraded');
  });

  it('exact-hit path (goal !== show_similar) → #runHybrid never runs → no rerank called', async () => {
    const profiles = new InMemoryStrategyProfileRepository();
    await profiles.create(makeProfile({ id: 'p-exact', sourceFingerprint: subjectHash }));
    let rerankCalled = false;
    const spyReranker: FakeReranker = Object.assign(new FakeReranker(), {
      rerank: async (...args: Parameters<FakeReranker['rerank']>) => {
        rerankCalled = true;
        return new FakeReranker().rerank(...args);
      },
    });
    const similarity = new InMemoryStrategySimilarityAdapter({ fixtures: [simCandidate()] });
    const { clock, scheduler } = fakeClock();

    const retrieval = makeRetrievalWithReranker({
      profiles, similarity, clock, scheduler,
      reranker: spyReranker,
      rerankConfig: defaultRerankConfig,
    });
    // goal: 'analyze' (default) → exact-hit is authoritative, hybrid + reranker skipped.
    const evidence = await retrieval.collect({
      turn: { ...strategyTurn, goal: 'analyze' },
      message, sessionId: 's1', retrievalId: 'r1',
    });

    expect(evidence.exactLookup).toBe('hit');
    expect(evidence.similarStrategies).toEqual([]);
    expect(rerankCalled).toBe(false);
    expect(evidence.warningCodes).not.toContain('rerank_failed');
    expect(evidence.status).toBe('complete');
  });
});
