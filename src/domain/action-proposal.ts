import type { AgentTaskType, TaskSource } from './types.ts';
import type { EvidenceRef } from './strategy-retrieval.ts';

export type ActionProposalStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'superseded';
export type OperatorAction = 'strategy.analyze' | 'research.run_cycle' | 'hypothesis.build' | 'backtest.run';

export interface ProposedChain {
  nextTaskType: 'research.run_cycle' | 'strategy.baseline';
  resolveProfileByFingerprint: string;
}

export interface PreflightCritiqueSummary {
  /** The refined strategy text the analyst receives if the operator picks "improve & analyze". */
  improvedStrategyText: string;
  severity: 'low' | 'medium' | 'high';
  mainVulnerability: string;
  /** Top critic-found vulnerabilities, for the problem list shown to the operator. */
  vulnerabilities: string[];
}

export interface ProposedTaskSnapshot {
  taskType: AgentTaskType;
  payload: Record<string, unknown>;
  dedupeKey: string;
  chain?: ProposedChain;
  userGoal: string;
  /**
   * Chat HITL pre-flight critique. Present only when a chat-time critic produced a refinement; rides
   * inside the JSONB `task` column (no migration). The confirm step picks improvedStrategyText vs the
   * original payload.content based on the chosen action.
   */
  preflightCritique?: PreflightCritiqueSummary;
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
