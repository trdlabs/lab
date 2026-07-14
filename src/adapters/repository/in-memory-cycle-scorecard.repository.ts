import type { CycleScorecardRepository, CycleScorecardRow } from '../../ports/cycle-scorecard.repository.ts';

export class InMemoryCycleScorecardRepository implements CycleScorecardRepository {
  private readonly byKey = new Map<string, CycleScorecardRow>();

  async upsert(row: CycleScorecardRow): Promise<void> {
    const key = `${row.correlationId}::${row.schemaVersion}`;
    const existing = this.byKey.get(key);
    // Mirror the drizzle onConflictDoUpdate semantics: on a conflicting (correlationId, schemaVersion)
    // the `id` and `createdAt` are preserved from the first insert (they are NOT in the drizzle `set`
    // clause); only payload/strategyProfileId/generatedAt/updatedAt are replaced by the new row.
    this.byKey.set(key, existing
      ? { ...row, id: existing.id, createdAt: existing.createdAt }
      : { ...row });
  }

  async findByCorrelationAndSchema(correlationId: string, schemaVersion: string): Promise<CycleScorecardRow | null> {
    const row = this.byKey.get(`${correlationId}::${schemaVersion}`);
    return row ? { ...row } : null;
  }

  async findByCorrelation(correlationId: string): Promise<CycleScorecardRow[]> {
    return [...this.byKey.values()].filter((row) => row.correlationId === correlationId).map((row) => ({ ...row }));
  }
}
