import { eq, and, desc, asc } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { hypothesisProposal } from '../../db/schema.ts';
import type {
  HypothesisProposal, HypothesisStatus, RuleAction, ExpectedEffect, HypothesisProposalDraft,
} from '../../domain/hypothesis.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import type { HypothesisProposalRepository } from '../../ports/hypothesis-proposal.repository.ts';

type Row = typeof hypothesisProposal.$inferSelect;

function toDomain(row: Row): HypothesisProposal {
  return {
    id: row.id,
    strategyProfileId: row.strategyProfileId,
    thesis: row.thesis,
    targetBehavior: row.targetBehavior,
    ruleAction: row.ruleAction as RuleAction,
    requiredFeatures: row.requiredFeatures,
    validationPlan: row.validationPlan,
    expectedEffect: row.expectedEffect as ExpectedEffect,
    invalidationCriteria: row.invalidationCriteria,
    confidence: row.confidence,
    status: row.status as HypothesisStatus,
    fingerprint: row.fingerprint,
    proposal: row.proposal as HypothesisProposalDraft,
    issues: row.issues as ValidationIssue[],
    contractVersion: row.contractVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleHypothesisProposalRepository implements HypothesisProposalRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async create(p: HypothesisProposal): Promise<void> {
    await this.db.insert(hypothesisProposal).values({
      id: p.id, strategyProfileId: p.strategyProfileId, thesis: p.thesis, targetBehavior: p.targetBehavior,
      ruleAction: p.ruleAction, requiredFeatures: p.requiredFeatures, validationPlan: p.validationPlan,
      expectedEffect: p.expectedEffect, invalidationCriteria: p.invalidationCriteria, confidence: p.confidence,
      status: p.status, fingerprint: p.fingerprint, proposal: p.proposal, issues: p.issues,
      contractVersion: p.contractVersion, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
    });
  }

  async findById(id: string): Promise<HypothesisProposal | null> {
    const rows = await this.db.select().from(hypothesisProposal).where(eq(hypothesisProposal.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async listByStrategyProfile(strategyProfileId: string): Promise<HypothesisProposal[]> {
    const rows = await this.db
      .select().from(hypothesisProposal)
      .where(eq(hypothesisProposal.strategyProfileId, strategyProfileId))
      .orderBy(asc(hypothesisProposal.createdAt));
    return rows.map(toDomain);
  }

  async listFingerprints(strategyProfileId: string): Promise<string[]> {
    const rows = await this.db
      .select({ fingerprint: hypothesisProposal.fingerprint })
      .from(hypothesisProposal)
      .where(eq(hypothesisProposal.strategyProfileId, strategyProfileId));
    return rows.map((r) => r.fingerprint);
  }

  async findLatestValidatedByProfile(strategyProfileId: string): Promise<HypothesisProposal | null> {
    const rows = await this.db
      .select()
      .from(hypothesisProposal)
      .where(and(
        eq(hypothesisProposal.strategyProfileId, strategyProfileId),
        eq(hypothesisProposal.status, 'validated'),
      ))
      .orderBy(desc(hypothesisProposal.createdAt), desc(hypothesisProposal.id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }
}
