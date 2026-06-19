import { eq, and, or, lt, desc, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { hypothesisProposal } from '../../db/schema.ts';
import type { HypothesisProposal, HypothesisStatus, RuleAction, ExpectedEffect, HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import type { HypothesisReadPort, HypothesisListQuery } from '../../ports/hypothesis-read.port.ts';

type Row = typeof hypothesisProposal.$inferSelect;

// Own row→domain mapping inside the read boundary (do NOT import the write adapter — import guard).
function toDomain(row: Row): HypothesisProposal {
  return {
    id: row.id, strategyProfileId: row.strategyProfileId, thesis: row.thesis, targetBehavior: row.targetBehavior,
    ruleAction: row.ruleAction as RuleAction, requiredFeatures: row.requiredFeatures, validationPlan: row.validationPlan,
    expectedEffect: row.expectedEffect as ExpectedEffect, invalidationCriteria: row.invalidationCriteria, confidence: row.confidence,
    status: row.status as HypothesisStatus, fingerprint: row.fingerprint, proposal: row.proposal as HypothesisProposalDraft,
    issues: row.issues as ValidationIssue[], contractVersion: row.contractVersion,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleHypothesisReadAdapter implements HypothesisReadPort {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async list(q: HypothesisListQuery): Promise<HypothesisProposal[]> {
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(hypothesisProposal.status, q.status));
    if (q.profileId) conds.push(eq(hypothesisProposal.strategyProfileId, q.profileId));
    if (q.after) {
      const d = new Date(q.after.t);
      conds.push(or(lt(hypothesisProposal.createdAt, d), and(eq(hypothesisProposal.createdAt, d), lt(hypothesisProposal.id, q.after.id)))!);
    }
    const rows = await this.db.select().from(hypothesisProposal)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(hypothesisProposal.createdAt), desc(hypothesisProposal.id))
      .limit(q.limit);
    return rows.map(toDomain);
  }

  async getById(id: string): Promise<HypothesisProposal | null> {
    const rows = await this.db.select().from(hypothesisProposal).where(eq(hypothesisProposal.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }
}
