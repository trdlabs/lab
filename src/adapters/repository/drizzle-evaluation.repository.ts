// src/adapters/repository/drizzle-evaluation.repository.ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { evaluation } from '../../db/schema.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';
import type { EvaluationDecision, EvaluatorThresholds } from '../../validation/evaluator.ts';
import type { EvaluationRepository } from '../../ports/evaluation.repository.ts';

type Row = typeof evaluation.$inferSelect;

function toDomain(row: Row): Evaluation {
  return {
    id: row.id, backtestRunId: row.backtestRunId, hypothesisId: row.hypothesisId,
    decision: row.decision as EvaluationDecision, reasons: row.reasons,
    metricsSnapshot: row.metricsSnapshot as ComparisonSummary, thresholds: row.thresholds as EvaluatorThresholds,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleEvaluationRepository implements EvaluationRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async create(e: Evaluation): Promise<void> {
    await this.db.insert(evaluation).values({
      id: e.id, backtestRunId: e.backtestRunId, hypothesisId: e.hypothesisId, decision: e.decision,
      reasons: e.reasons, metricsSnapshot: e.metricsSnapshot, thresholds: e.thresholds, createdAt: new Date(e.createdAt),
    });
  }

  async findById(id: string): Promise<Evaluation | null> {
    const rows = await this.db.select().from(evaluation).where(eq(evaluation.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async listByBacktestRun(backtestRunId: string): Promise<Evaluation[]> {
    const rows = await this.db.select().from(evaluation).where(eq(evaluation.backtestRunId, backtestRunId));
    return rows.map(toDomain);
  }
}
