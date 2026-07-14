import type { CycleScorecard } from '../domain/cycle-scorecard.ts';

export interface CycleScorecardRow {
  id: string;
  correlationId: string;
  strategyProfileId: string;
  schemaVersion: string;
  payload: CycleScorecard;
  generatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CycleScorecardRepository {
  /** Idempotent upsert on UNIQUE(correlationId, schemaVersion). */
  upsert(row: CycleScorecardRow): Promise<void>;
  /** Deterministic single-row lookup for the read-API — the (correlationId, schemaVersion) unique key. */
  findByCorrelationAndSchema(correlationId: string, schemaVersion: string): Promise<CycleScorecardRow | null>;
  /** All schema versions for a correlation (round-trip / diagnostics). */
  findByCorrelation(correlationId: string): Promise<CycleScorecardRow[]>;
}
