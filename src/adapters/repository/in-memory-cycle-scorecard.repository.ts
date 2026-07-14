import type { CycleScorecardRepository, CycleScorecardRow } from '../../ports/cycle-scorecard.repository.ts';

export class InMemoryCycleScorecardRepository implements CycleScorecardRepository {
  private readonly byKey = new Map<string, CycleScorecardRow>();

  async upsert(row: CycleScorecardRow): Promise<void> {
    const key = `${row.correlationId}::${row.schemaVersion}`;
    this.byKey.set(key, { ...row });
  }

  async findByCorrelationAndSchema(correlationId: string, schemaVersion: string): Promise<CycleScorecardRow | null> {
    const row = this.byKey.get(`${correlationId}::${schemaVersion}`);
    return row ? { ...row } : null;
  }

  async findByCorrelation(correlationId: string): Promise<CycleScorecardRow[]> {
    return [...this.byKey.values()].filter((row) => row.correlationId === correlationId).map((row) => ({ ...row }));
  }
}
