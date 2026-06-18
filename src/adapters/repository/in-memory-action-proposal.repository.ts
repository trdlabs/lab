import type { ActionProposal } from '../../domain/action-proposal.ts';
import type { ActionProposalRepository, ConfirmProposalResult } from '../../ports/action-proposal.repository.ts';

export class InMemoryActionProposalRepository implements ActionProposalRepository {
  private readonly byId = new Map<string, ActionProposal>();

  async create(proposal: ActionProposal): Promise<void> {
    if (this.byId.has(proposal.id)) {
      throw new Error(`action_proposal already exists: ${proposal.id}`);
    }
    this.byId.set(proposal.id, structuredClone(proposal));
  }

  async findById(id: string): Promise<ActionProposal | null> {
    const found = this.byId.get(id);
    return found ? structuredClone(found) : null;
  }

  async confirmPending(id: string, sessionId: string, now: string): Promise<ConfirmProposalResult> {
    const stored = this.byId.get(id);

    // Missing or wrong session -> not_found
    if (!stored || stored.sessionId !== sessionId) {
      return { kind: 'not_found' };
    }

    // Already confirmed -> already_confirmed
    if (stored.status === 'confirmed') {
      return { kind: 'already_confirmed', proposal: structuredClone(stored) };
    }

    // Expired (even if still 'pending')
    if (stored.status === 'pending' && stored.expiresAt <= now) {
      stored.status = 'expired';
      stored.updatedAt = now;
      return { kind: 'expired', proposal: structuredClone(stored) };
    }

    // Live pending — synchronous state change before any await boundary
    stored.status = 'confirmed';
    stored.updatedAt = now;
    return { kind: 'confirmed_now', proposal: structuredClone(stored) };
  }

  async cancelPending(id: string, sessionId: string, now: string): Promise<boolean> {
    const stored = this.byId.get(id);

    if (!stored || stored.sessionId !== sessionId) {
      return false;
    }

    if (stored.status !== 'pending' || stored.expiresAt <= now) {
      return false;
    }

    stored.status = 'cancelled';
    stored.updatedAt = now;
    return true;
  }

  async attachTask(id: string, taskId: string, now: string): Promise<void> {
    const stored = this.byId.get(id);
    if (!stored || stored.status !== 'confirmed') {
      return;
    }
    stored.confirmedTaskId = taskId;
    stored.updatedAt = now;
  }
}
