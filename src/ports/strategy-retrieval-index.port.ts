// src/ports/strategy-retrieval-index.port.ts
import type { StrategyRetrievalDocument } from '../domain/strategy-retrieval.ts';

export interface StrategyRetrievalIndexPort {
  findByProfileId(profileId: string): Promise<StrategyRetrievalDocument | null>;
  upsert(document: StrategyRetrievalDocument): Promise<void>;
  delete(profileId: string): Promise<void>;
}
