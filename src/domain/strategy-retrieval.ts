// src/domain/strategy-retrieval.ts

export interface StrategyRetrievalMetadata {
  market?: string;
  symbol?: string;
  timeframe?: string;
  direction?: 'long' | 'short' | 'both';
  profileVersion?: number;
  label?: string;
  createdAt?: string;
}

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
  filters: {
    market?: string;
    symbol?: string;
    timeframe?: string;
    direction?: 'long' | 'short' | 'both';
  };
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
  exactMatch?: {
    strategyProfileId: string;
    label: string;
    observedAt: string;
  };
  similarStrategies: readonly SimilarStrategyCandidate[];
  evidenceRefs: readonly EvidenceRef[];
  warningCodes: readonly string[];
  timingsMs: Readonly<Record<string, number>>;
}
