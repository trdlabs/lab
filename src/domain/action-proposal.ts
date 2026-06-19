import type { AgentTaskType, TaskSource } from './types.ts';
import type { EvidenceRef } from './strategy-retrieval.ts';

export type ActionProposalStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'superseded';
export type OperatorAction = 'strategy.analyze' | 'research.run_cycle' | 'hypothesis.build' | 'backtest.run';

export interface ProposedChain {
  nextTaskType: 'research.run_cycle';
  resolveProfileByFingerprint: string;
}

export interface ProposedTaskSnapshot {
  taskType: AgentTaskType;
  payload: Record<string, unknown>;
  dedupeKey: string;
  chain?: ProposedChain;
  userGoal: string;
}

export interface ActionProposal {
  id: string;
  sessionId: string;
  subjectHash: string;
  action: OperatorAction;
  source: TaskSource;
  task: ProposedTaskSnapshot;
  status: ActionProposalStatus;
  /** Typed evidence references that justified this proposal (never raw retrieved bodies). */
  evidenceRefs: EvidenceRef[];
  /** Stable degradation/warning codes observed while gathering evidence. */
  evidenceWarnings: string[];
  confirmedTaskId?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
