// src/adapters/repository/in-memory-evaluation.repository.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryEvaluationRepository } from './in-memory-evaluation.repository.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../../validation/evaluator.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';

const summary: ComparisonSummary = {
  baseline: { netPnlUsd: 100, netPnlPct: 1, totalTrades: 28, winRate: 0.5, profitFactor: 1.2, maxDrawdownPct: 7, expectancyUsd: 3, sharpe: 0.8, topTradeContributionPct: 20 },
  variant: { netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.6, profitFactor: 2, maxDrawdownPct: 8, expectancyUsd: 8, sharpe: 1.4, topTradeContributionPct: 22 },
  sampleSize: { baselineTrades: 28, variantTrades: 30 }, platformContractVersion: 'mock-0',
};
function evaluation(id: string): Evaluation {
  return { id, backtestRunId: 'r1', hypothesisId: 'h1', decision: 'PAPER_CANDIDATE', reasons: ['strong_robust_edge'], metricsSnapshot: summary, thresholds: DEFAULT_EVALUATOR_THRESHOLDS, createdAt: '2026-01-01T00:00:00Z' };
}

describe('InMemoryEvaluationRepository', () => {
  it('create then findById', async () => {
    const repo = new InMemoryEvaluationRepository();
    await repo.create(evaluation('e1'));
    expect((await repo.findById('e1'))?.decision).toBe('PAPER_CANDIDATE');
  });

  it('throws on duplicate id', async () => {
    const repo = new InMemoryEvaluationRepository();
    await repo.create(evaluation('e1'));
    await expect(repo.create(evaluation('e1'))).rejects.toThrow(/already exists/);
  });

  it('listByBacktestRun returns matches', async () => {
    const repo = new InMemoryEvaluationRepository();
    await repo.create(evaluation('e1'));
    expect(await repo.listByBacktestRun('r1')).toHaveLength(1);
    expect(await repo.listByBacktestRun('other')).toHaveLength(0);
  });
});
