import type { ActionProposal } from '../domain/action-proposal.ts';

export type ConfirmProposalResult =
  | { kind: 'confirmed_now'; proposal: ActionProposal }
  | { kind: 'already_confirmed'; proposal: ActionProposal }
  | { kind: 'expired'; proposal: ActionProposal }
  | { kind: 'not_found' };

export interface ActionProposalRepository {
  create(proposal: ActionProposal): Promise<void>;
  findById(id: string): Promise<ActionProposal | null>;
  confirmPending(id: string, sessionId: string, now: string): Promise<ConfirmProposalResult>;
  cancelPending(id: string, sessionId: string, now: string): Promise<boolean>;
  attachTask(id: string, taskId: string, now: string): Promise<void>;
}
