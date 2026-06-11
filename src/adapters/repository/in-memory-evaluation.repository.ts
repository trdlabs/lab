// src/adapters/repository/in-memory-evaluation.repository.ts
import type { Evaluation } from '../../domain/evaluation.ts';
import type { EvaluationRepository } from '../../ports/evaluation.repository.ts';

export class InMemoryEvaluationRepository implements EvaluationRepository {
  private readonly byId = new Map<string, Evaluation>();

  async create(evaluation: Evaluation): Promise<void> {
    if (this.byId.has(evaluation.id)) throw new Error(`evaluation already exists: ${evaluation.id}`);
    this.byId.set(evaluation.id, { ...evaluation });
  }

  async findById(id: string): Promise<Evaluation | null> {
    return this.byId.get(id) ?? null;
  }

  async listByBacktestRun(backtestRunId: string): Promise<Evaluation[]> {
    return [...this.byId.values()].filter((e) => e.backtestRunId === backtestRunId);
  }
}
