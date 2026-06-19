// src/adapters/similarity/in-memory-strategy-similarity.adapter.ts

import type { StrategySimilarityPort } from '../../ports/strategy-similarity.port.ts';
import type {
  StrategyCandidateSet,
  SimilarStrategyCandidate,
  StrategySimilarityQuery,
} from '../../domain/strategy-retrieval.ts';

export interface InMemoryStrategySimilarityAdapterOptions {
  /** Fixed candidates returned by every call (before filters/limit). */
  fixtures?: SimilarStrategyCandidate[];
}

export interface RecordedCall {
  query: StrategySimilarityQuery;
  result: StrategyCandidateSet;
}

/**
 * Deterministic test double for StrategySimilarityPort.
 *
 * Returns the fixture candidate list filtered by metadata fields,
 * excludeProfileId, and fusedLimit. Records every call for assertion.
 * Rejects immediately when query.signal is already aborted.
 */
export class InMemoryStrategySimilarityAdapter implements StrategySimilarityPort {
  private readonly fixtures: SimilarStrategyCandidate[];
  readonly calls: RecordedCall[] = [];

  constructor(options: InMemoryStrategySimilarityAdapterOptions = {}) {
    this.fixtures = options.fixtures ?? [];
  }

  async search(query: StrategySimilarityQuery): Promise<StrategyCandidateSet> {
    if (query.signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    const limit = query.fusedLimit ?? 20;
    const { filters, excludeProfileId } = query;

    const candidates = this.fixtures
      .filter((c) => {
        if (excludeProfileId && c.strategyProfileId === excludeProfileId) return false;
        if (filters.market && c.metadata.market !== filters.market) return false;
        if (filters.symbol && c.metadata.symbol !== filters.symbol) return false;
        if (filters.timeframe && c.metadata.timeframe !== filters.timeframe) return false;
        if (filters.direction && c.metadata.direction !== filters.direction) return false;
        return true;
      })
      .slice(0, limit);

    const result: StrategyCandidateSet = {
      candidates,
      degradedReasonCodes: [],
    };

    this.calls.push({ query, result });
    return result;
  }
}
