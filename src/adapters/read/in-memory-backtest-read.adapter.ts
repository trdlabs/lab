import type { BacktestRun } from '../../domain/backtest-run.ts';
import type { BacktestReadPort, BacktestListQuery } from '../../ports/backtest-read.port.ts';

// DESC by (createdAt, id): newest first.
function cmpDesc(a: BacktestRun, b: BacktestRun): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

export class InMemoryBacktestReadAdapter implements BacktestReadPort {
  private readonly seed: BacktestRun[];

  constructor(seed: BacktestRun[] = []) {
    this.seed = seed;
  }

  async list(q: BacktestListQuery): Promise<BacktestRun[]> {
    let rows = [...this.seed];
    if (q.hypothesisId) rows = rows.filter((r) => r.hypothesisId === q.hypothesisId);
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    rows.sort(cmpDesc);
    if (q.after) {
      const { t, id } = q.after;
      rows = rows.filter((r) => r.createdAt < t || (r.createdAt === t && r.id < id));
    }
    return rows.slice(0, q.limit);
  }

  async getById(id: string): Promise<BacktestRun | null> {
    return this.seed.find((r) => r.id === id) ?? null;
  }
}
