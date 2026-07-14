import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { cycleScorecard } from '../../db/schema.ts';
import type { CycleScorecardRepository, CycleScorecardRow } from '../../ports/cycle-scorecard.repository.ts';

export type CycleScorecardDbRow = typeof cycleScorecard.$inferSelect;

// Exported so other adapters can reuse the SAME mapper — single source of truth.
export function cycleScorecardToDomain(r: CycleScorecardDbRow): CycleScorecardRow {
  return {
    id: r.id,
    correlationId: r.correlationId,
    strategyProfileId: r.strategyProfileId,
    schemaVersion: r.schemaVersion,
    payload: r.payload,
    generatedAt: r.generatedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export class DrizzleCycleScorecardRepository implements CycleScorecardRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async upsert(row: CycleScorecardRow): Promise<void> {
    await this.db.insert(cycleScorecard).values({
      id: row.id,
      correlationId: row.correlationId,
      strategyProfileId: row.strategyProfileId,
      schemaVersion: row.schemaVersion,
      payload: row.payload,
      generatedAt: new Date(row.generatedAt),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }).onConflictDoUpdate({
      target: [cycleScorecard.correlationId, cycleScorecard.schemaVersion],
      set: {
        payload: row.payload,
        strategyProfileId: row.strategyProfileId,
        generatedAt: new Date(row.generatedAt),
        updatedAt: new Date(row.updatedAt),
      },
    });
  }

  async findByCorrelationAndSchema(correlationId: string, schemaVersion: string): Promise<CycleScorecardRow | null> {
    const rows = await this.db.select().from(cycleScorecard)
      .where(and(eq(cycleScorecard.correlationId, correlationId), eq(cycleScorecard.schemaVersion, schemaVersion)))
      .limit(1);
    return rows[0] ? cycleScorecardToDomain(rows[0]) : null;
  }

  async findByCorrelation(correlationId: string): Promise<CycleScorecardRow[]> {
    const rows = await this.db.select().from(cycleScorecard)
      .where(eq(cycleScorecard.correlationId, correlationId));
    return rows.map(cycleScorecardToDomain);
  }
}
