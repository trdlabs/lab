import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { actionProposal } from '../../db/schema.ts';
import type { ActionProposal } from '../../domain/action-proposal.ts';
import type { ActionProposalRepository, ConfirmProposalResult } from '../../ports/action-proposal.repository.ts';

type Row = typeof actionProposal.$inferSelect;

function rowToDomain(row: Row): ActionProposal {
  return {
    id: row.id,
    sessionId: row.sessionId,
    subjectHash: row.subjectHash,
    action: row.action,
    source: row.source,
    task: row.task,
    status: row.status,
    confirmedTaskId: row.confirmedTaskId ?? undefined,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleActionProposalRepository implements ActionProposalRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async create(proposal: ActionProposal): Promise<void> {
    await this.db.insert(actionProposal).values({
      id: proposal.id,
      sessionId: proposal.sessionId,
      subjectHash: proposal.subjectHash,
      action: proposal.action,
      source: proposal.source,
      task: proposal.task,
      status: proposal.status,
      confirmedTaskId: proposal.confirmedTaskId ?? null,
      expiresAt: new Date(proposal.expiresAt),
      createdAt: new Date(proposal.createdAt),
      updatedAt: new Date(proposal.updatedAt),
    });
  }

  async findById(id: string): Promise<ActionProposal | null> {
    const rows = await this.db
      .select()
      .from(actionProposal)
      .where(eq(actionProposal.id, id))
      .limit(1);
    return rows[0] ? rowToDomain(rows[0]) : null;
  }

  async confirmPending(id: string, sessionId: string, now: string): Promise<ConfirmProposalResult> {
    const nowDate = new Date(now);

    // Attempt atomic conditional update: only pending + not-expired + right session
    const updated = await this.db
      .update(actionProposal)
      .set({ status: 'confirmed', updatedAt: nowDate })
      .where(and(
        eq(actionProposal.id, id),
        eq(actionProposal.sessionId, sessionId),
        eq(actionProposal.status, 'pending'),
        gt(actionProposal.expiresAt, nowDate),
      ))
      .returning();

    if (updated.length > 0) {
      return { kind: 'confirmed_now', proposal: rowToDomain(updated[0]!) };
    }

    // No row updated — diagnose why
    const rows = await this.db
      .select()
      .from(actionProposal)
      .where(eq(actionProposal.id, id))
      .limit(1);

    const row = rows[0];

    // Not found or session mismatch -> not_found
    if (!row || row.sessionId !== sessionId) {
      return { kind: 'not_found' };
    }

    // Already confirmed -> already_confirmed
    if (row.status === 'confirmed') {
      return { kind: 'already_confirmed', proposal: rowToDomain(row) };
    }

    // Pending but expired -> transition to 'expired' and return expired
    if (row.status === 'pending' && row.expiresAt <= nowDate) {
      await this.db
        .update(actionProposal)
        .set({ status: 'expired', updatedAt: nowDate })
        .where(and(
          eq(actionProposal.id, id),
          eq(actionProposal.sessionId, sessionId),
          eq(actionProposal.status, 'pending'),
        ));
      // Return the proposal with the transitioned status regardless of whether the
      // UPDATE landed (concurrent transition is fine — the state is still 'expired').
      return { kind: 'expired', proposal: rowToDomain({ ...row, status: 'expired', updatedAt: nowDate }) };
    }

    // Catch-all: cancelled, expired, superseded, or any other status -> not_found
    // This matches the in-memory adapter's TOTAL semantics exactly.
    return { kind: 'not_found' };
  }

  async cancelPending(id: string, sessionId: string, now: string): Promise<boolean> {
    const nowDate = new Date(now);
    const updated = await this.db
      .update(actionProposal)
      .set({ status: 'cancelled', updatedAt: nowDate })
      .where(and(
        eq(actionProposal.id, id),
        eq(actionProposal.sessionId, sessionId),
        eq(actionProposal.status, 'pending'),
        gt(actionProposal.expiresAt, nowDate),
      ))
      .returning();
    return updated.length > 0;
  }

  async attachTask(id: string, taskId: string, now: string): Promise<void> {
    const nowDate = new Date(now);
    const updated = await this.db
      .update(actionProposal)
      .set({ confirmedTaskId: taskId, updatedAt: nowDate })
      .where(and(
        eq(actionProposal.id, id),
        eq(actionProposal.status, 'confirmed'),
      ))
      .returning();

    if (updated.length === 0) {
      throw new Error(`attachTask failed: action_proposal ${id} not found or not confirmed`);
    }
  }
}
