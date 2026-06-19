// src/experiments/operator-rag/eval-harness.test.ts
// Unit tests for the pure gate logic + report assembly.
// NO network, NO DB — all results are canned in-test.
import { describe, it, expect, vi } from 'vitest';
import {
  computeCaseMetrics,
  evaluateGates,
  assembleResult,
  runRetrieval,
  RECALL_GATE_THRESHOLD,
  type RetrievalPort,
} from './eval-harness.ts';
import type { StrategyRetrievalEvalCase, CaseRetrievalResult } from './types.ts';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const exactCase: StrategyRetrievalEvalCase = {
  id: 'exact-1',
  query: 'BTC OI strategy',
  language: 'en',
  filters: {},
  expectedRelevantIds: ['strat-001'],
  gradedRelevance: { 'strat-001': 3, 'strat-002': 1 },
  expectedExactId: 'strat-001',
};

const semanticCase: StrategyRetrievalEvalCase = {
  id: 'semantic-1',
  query: 'open interest momentum crypto',
  language: 'en',
  filters: {},
  expectedRelevantIds: ['strat-002', 'strat-003'],
  gradedRelevance: { 'strat-002': 3, 'strat-003': 2, 'strat-004': 1 },
};

const noMatchCase: StrategyRetrievalEvalCase = {
  id: 'no-match-1',
  query: 'obscure zigzag oscillator',
  language: 'en',
  filters: {},
  expectedRelevantIds: [],
  gradedRelevance: {},
};

// ─── computeCaseMetrics ────────────────────────────────────────────────────────

describe('computeCaseMetrics', () => {
  it('perfect exact-identity hit: rank-1 = expectedExactId', () => {
    const retrieved: CaseRetrievalResult = {
      id: 'exact-1',
      query: 'BTC OI strategy',
      retrievedIds: ['strat-001', 'strat-002', 'strat-010'],
      error: null,
    };
    const metrics = computeCaseMetrics(retrieved, exactCase);

    expect(metrics.hasRelevantDocs).toBe(true); // exactCase has expectedRelevantIds
    expect(metrics.exactIdentityHit).toBe(true);
    expect(metrics.recallAt20).toBe(1.0); // strat-001 in top-20
    expect(metrics.reciprocalRank).toBe(1.0); // rank 1
    expect(metrics.ndcgAt5).toBeGreaterThan(0);
    expect(metrics.falseSemanticExact).toBe(false);
  });

  it('exact-identity miss: rank-1 is not expectedExactId', () => {
    const retrieved: CaseRetrievalResult = {
      id: 'exact-1',
      query: 'BTC OI strategy',
      retrievedIds: ['strat-002', 'strat-001'],
      error: null,
    };
    const metrics = computeCaseMetrics(retrieved, exactCase);

    expect(metrics.exactIdentityHit).toBe(false);
    // strat-001 still in list, so recall=1 and RR=0.5
    expect(metrics.recallAt20).toBe(1.0);
    // retrievedIds = ['strat-002', 'strat-001'], expectedRelevantIds = ['strat-001']
    // strat-002 is NOT in expectedRelevantIds; first relevant is strat-001 at rank 2
    // RR = 1/2 = 0.5
    expect(metrics.reciprocalRank).toBe(0.5);
  });

  it('exactIdentityHit is null when expectedExactId is absent', () => {
    const retrieved: CaseRetrievalResult = {
      id: 'semantic-1',
      query: 'open interest momentum crypto',
      retrievedIds: ['strat-002', 'strat-003'],
      error: null,
    };
    const metrics = computeCaseMetrics(retrieved, semanticCase);
    expect(metrics.hasRelevantDocs).toBe(true); // semanticCase has expectedRelevantIds
    expect(metrics.exactIdentityHit).toBeNull();
  });

  it('no-match case: hasRelevantDocs=false, all IR metrics 0, no exactIdentityHit, no falseSemanticExact', () => {
    const retrieved: CaseRetrievalResult = {
      id: 'no-match-1',
      query: 'obscure zigzag oscillator',
      retrievedIds: ['strat-999', 'strat-888'],
      error: null,
    };
    const metrics = computeCaseMetrics(retrieved, noMatchCase);

    expect(metrics.hasRelevantDocs).toBe(false); // no relevant docs → excluded from IR means
    expect(metrics.recallAt20).toBe(0); // no relevant docs
    expect(metrics.reciprocalRank).toBe(0);
    expect(metrics.ndcgAt5).toBe(0); // gradedRelevance empty → IDCG=0
    expect(metrics.exactIdentityHit).toBeNull();
    expect(metrics.falseSemanticExact).toBe(false);
  });

  it('falseSemanticExact = true when top-1 has grade 3 but is NOT in expectedRelevantIds', () => {
    // Scenario: semantic case has strat-004 at grade 1, but strat-099 is grade 3 and not expected
    const caseWithUnexpectedGrade3: StrategyRetrievalEvalCase = {
      id: 'false-semantic-1',
      query: 'query',
      language: 'en',
      filters: {},
      expectedRelevantIds: ['strat-002', 'strat-003'],
      gradedRelevance: { 'strat-002': 3, 'strat-003': 2, 'strat-unexpected': 3 },
    };
    const retrieved: CaseRetrievalResult = {
      id: 'false-semantic-1',
      query: 'query',
      retrievedIds: ['strat-unexpected', 'strat-002'],
      error: null,
    };
    const metrics = computeCaseMetrics(retrieved, caseWithUnexpectedGrade3);
    expect(metrics.falseSemanticExact).toBe(true);
  });

  it('falseSemanticExact = false when top-1 is in expectedRelevantIds (even grade 3)', () => {
    const retrieved: CaseRetrievalResult = {
      id: 'semantic-1',
      query: 'open interest momentum crypto',
      retrievedIds: ['strat-002', 'strat-003'],
      error: null,
    };
    const metrics = computeCaseMetrics(retrieved, semanticCase);
    // strat-002 is grade 3 AND in expectedRelevantIds → NOT false semantic exact
    expect(metrics.falseSemanticExact).toBe(false);
  });

  it('error result: empty retrievedIds, all metrics 0', () => {
    const retrieved: CaseRetrievalResult = {
      id: 'exact-1',
      query: 'BTC OI strategy',
      retrievedIds: [],
      error: 'connection refused',
    };
    const metrics = computeCaseMetrics(retrieved, exactCase);
    expect(metrics.recallAt20).toBe(0);
    expect(metrics.reciprocalRank).toBe(0);
    expect(metrics.exactIdentityHit).toBe(false); // expectedExactId present but list is empty
  });
});

// ─── evaluateGates ─────────────────────────────────────────────────────────────

describe('evaluateGates', () => {
  it('all gates pass with perfect results', () => {
    const metrics = [
      { id: 'c1', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: true, falseSemanticExact: false },
      { id: 'c2', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 0.5, ndcgAt5: 0.9, exactIdentityHit: true, falseSemanticExact: false },
      { id: 'c3', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: false },
    ];
    const gates = evaluateGates(metrics);
    expect(gates.gateExactIdentity).toBe(true);
    expect(gates.gateFalseSemanticExact).toBe(true);
    expect(gates.gateRecallAt20).toBe(true);
    expect(gates.overallPass).toBe(true);
    expect(gates.exactIdentityAccuracy).toBe(1.0);
    expect(gates.falseSemanticExactCount).toBe(0);
  });

  it('gateExactIdentity fails when any exact-identity case misses', () => {
    const metrics = [
      { id: 'c1', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: true, falseSemanticExact: false },
      { id: 'c2', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: false, falseSemanticExact: false },
    ];
    const gates = evaluateGates(metrics);
    expect(gates.gateExactIdentity).toBe(false);
    expect(gates.exactIdentityAccuracy).toBe(0.5);
    expect(gates.overallPass).toBe(false);
  });

  it('gateFalseSemanticExact fails when any case has a false semantic exact', () => {
    const metrics = [
      { id: 'c1', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: true },
    ];
    const gates = evaluateGates(metrics);
    expect(gates.gateFalseSemanticExact).toBe(false);
    expect(gates.falseSemanticExactCount).toBe(1);
    expect(gates.overallPass).toBe(false);
  });

  it(`gateRecallAt20 fails when mean recall is below ${RECALL_GATE_THRESHOLD}`, () => {
    const metrics = [
      { id: 'c1', hasRelevantDocs: true, recallAt20: 0.8, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: false },
      { id: 'c2', hasRelevantDocs: true, recallAt20: 0.6, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: false },
    ];
    const gates = evaluateGates(metrics);
    // mean = (0.8 + 0.6) / 2 = 0.7 < 0.9
    expect(gates.gateRecallAt20).toBe(false);
    expect(gates.overallPass).toBe(false);
  });

  it('gateRecallAt20 passes exactly at threshold boundary', () => {
    // 3 cases: 1.0 + 0.8 + 0.9 = 2.7 / 3 = 0.9
    const metrics = [
      { id: 'c1', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: false },
      { id: 'c2', hasRelevantDocs: true, recallAt20: 0.8, reciprocalRank: 0.5, ndcgAt5: 0.7, exactIdentityHit: null, falseSemanticExact: false },
      { id: 'c3', hasRelevantDocs: true, recallAt20: 0.9, reciprocalRank: 1.0, ndcgAt5: 0.9, exactIdentityHit: null, falseSemanticExact: false },
    ];
    const gates = evaluateGates(metrics);
    expect(gates.recallAt20).toBe(0.9);
    expect(gates.gateRecallAt20).toBe(true);
  });

  it('no exact-identity cases → exactIdentityAccuracy = 1.0 (vacuously true)', () => {
    const metrics = [
      { id: 'c1', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: false },
    ];
    const gates = evaluateGates(metrics);
    expect(gates.exactIdentityAccuracy).toBe(1.0);
    expect(gates.gateExactIdentity).toBe(true);
  });

  it('computes MRR correctly', () => {
    // RR values: [1.0, 0.5, 0.333333]
    // MRR = (1.0 + 0.5 + 0.333333) / 3 ≈ 0.611111
    const metrics = [
      { id: 'c1', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: false },
      { id: 'c2', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 0.5, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: false },
      { id: 'c3', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1 / 3, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: false },
    ];
    const gates = evaluateGates(metrics);
    expect(gates.mrr).toBeCloseTo(0.6111, 3);
  });
});

// ─── assembleResult ────────────────────────────────────────────────────────────

describe('assembleResult', () => {
  const cases = [exactCase, semanticCase, noMatchCase];

  it('assembles result with correct dataset metadata', () => {
    const retrievalResults: CaseRetrievalResult[] = [
      { id: 'exact-1', query: exactCase.query, retrievedIds: ['strat-001', 'strat-002'], error: null },
      { id: 'semantic-1', query: semanticCase.query, retrievedIds: ['strat-002', 'strat-003', 'strat-004'], error: null },
      { id: 'no-match-1', query: noMatchCase.query, retrievedIds: [], error: null },
    ];
    const result = assembleResult('strategy-retrieval-v1', 'sha256:abc123', cases, retrievalResults);

    expect(result.dataset.id).toBe('strategy-retrieval-v1');
    expect(result.dataset.fingerprint).toBe('sha256:abc123');
    expect(result.dataset.caseCount).toBe(3);
    expect(result.caseMetrics).toHaveLength(3);
  });

  it('no-match case (hasRelevantDocs=false) is excluded from recall/MRR/nDCG means', () => {
    // One scored case with perfect recall, one no-match case with recall=0.
    // Without exclusion: mean = (1.0 + 0) / 2 = 0.5 → gate FAILS.
    // With exclusion:    mean = 1.0 / 1      = 1.0 → gate PASSES.
    const metrics = [
      { id: 'scored', hasRelevantDocs: true, recallAt20: 1.0, reciprocalRank: 1.0, ndcgAt5: 1.0, exactIdentityHit: null, falseSemanticExact: false },
      { id: 'no-match', hasRelevantDocs: false, recallAt20: 0, reciprocalRank: 0, ndcgAt5: 0, exactIdentityHit: null, falseSemanticExact: false },
    ];
    const gates = evaluateGates(metrics);
    expect(gates.recallAt20).toBe(1.0); // no-match excluded → only scored case counts
    expect(gates.mrr).toBe(1.0);
    expect(gates.ndcgAt5).toBe(1.0);
    expect(gates.gateRecallAt20).toBe(true);
  });

  it('handles missing retrieval result for a case with error fallback', () => {
    // No result for semantic-1
    const retrievalResults: CaseRetrievalResult[] = [
      { id: 'exact-1', query: exactCase.query, retrievedIds: ['strat-001'], error: null },
      { id: 'no-match-1', query: noMatchCase.query, retrievedIds: [], error: null },
    ];
    // semantic-1 is in cases but not in retrievalResults — should fall back to error
    const result = assembleResult('strategy-retrieval-v1', 'sha256:abc123', cases, retrievalResults);
    const semanticMetrics = result.caseMetrics.find((m) => m.id === 'semantic-1');
    expect(semanticMetrics).toBeDefined();
    expect(semanticMetrics!.recallAt20).toBe(0); // missing result treated as empty
  });

  it('overallPass is true when all gates pass', () => {
    // All cases with perfect retrieval
    const retrievalResults: CaseRetrievalResult[] = [
      // exact-1: exact hit + full recall
      { id: 'exact-1', query: exactCase.query, retrievedIds: ['strat-001', 'strat-002'], error: null },
      // semantic-1: relevant ids in top-20
      { id: 'semantic-1', query: semanticCase.query, retrievedIds: ['strat-002', 'strat-003', 'strat-004'], error: null },
      // no-match-1: nothing returned (correct, and EXCLUDED from recall mean)
      { id: 'no-match-1', query: noMatchCase.query, retrievedIds: [], error: null },
    ];
    const result = assembleResult('strategy-retrieval-v1', 'sha256:abc123', cases, retrievalResults);
    // exact-1: recall=1, exact=true (hasRelevantDocs=true)
    // semantic-1: recall=1 (hasRelevantDocs=true)
    // no-match-1: hasRelevantDocs=false → EXCLUDED from recall mean
    // mean recall over scored cases = (1 + 1) / 2 = 1.0 >= 0.9 → gateRecallAt20 = true
    expect(result.gates.gateExactIdentity).toBe(true);
    expect(result.gates.gateFalseSemanticExact).toBe(true);
    expect(result.gates.gateRecallAt20).toBe(true);
    expect(result.overallPass).toBe(true);
  });
});

// ─── runRetrieval (adapter injection) ────────────────────────────────────────

describe('runRetrieval', () => {
  it('calls retrieve for each case and returns results', async () => {
    const retrieve = vi.fn().mockImplementation(async (caseId: string) => {
      if (caseId === 'exact-1') return ['strat-001', 'strat-002'];
      if (caseId === 'semantic-1') return ['strat-002', 'strat-003'];
      return [];
    });
    const port: RetrievalPort = { retrieve };
    const cases = [exactCase, semanticCase, noMatchCase];

    const results = await runRetrieval(cases, port);

    expect(results).toHaveLength(3);
    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(results.find((r) => r.id === 'exact-1')?.retrievedIds).toEqual(['strat-001', 'strat-002']);
    expect(results.find((r) => r.id === 'no-match-1')?.retrievedIds).toEqual([]);
  });

  it('captures errors per case without aborting the run', async () => {
    let callCount = 0;
    const retrieve = vi.fn().mockImplementation(async (caseId: string) => {
      callCount++;
      if (caseId === 'semantic-1') throw new Error('retrieval failed for semantic-1');
      return ['strat-001'];
    });
    const port: RetrievalPort = { retrieve };
    const cases = [exactCase, semanticCase, noMatchCase];

    const results = await runRetrieval(cases, port);

    expect(callCount).toBe(3); // all cases attempted
    const errResult = results.find((r) => r.id === 'semantic-1');
    expect(errResult?.error).toContain('retrieval failed');
    expect(errResult?.retrievedIds).toEqual([]);
    // Other cases are unaffected
    expect(results.find((r) => r.id === 'exact-1')?.error).toBeNull();
  });
});
