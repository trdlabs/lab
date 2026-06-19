import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { StrategyRetrievalIndexerPort } from '../orchestrator/app-services.ts';

/**
 * Null-object retrieval indexer for when operator RAG is switched off (or in tests).
 * Performs zero I/O — no embedding calls, no DB writes — so the disabled-RAG path can
 * never touch an embedding provider. Onboarding treats indexing as fire-and-forget,
 * and this implementation simply does nothing.
 */
export class NoopStrategyRetrievalIndexer implements StrategyRetrievalIndexerPort {
  async index(_profile: StrategyProfile): Promise<void> {
    // intentionally empty: RAG indexing disabled
    void _profile;
  }
}
