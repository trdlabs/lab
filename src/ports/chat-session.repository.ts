/**
 * Session memory: pointers + context only. Canonical entity existence stays in the
 * real repositories — these are HINTS, always verified before use. No secrets.
 */

export interface PendingActionConfirmation {
  kind: 'action_confirmation';
  proposalId: string;
  expiresAt: string;
}

export type PendingOperatorInteraction = PendingActionConfirmation;

export interface ChatSessionContext {
  sessionId: string;
  lastStrategyProfileId?: string;
  lastResearchTaskId?: string;
  lastHypothesisId?: string;
  lastBacktestRunId?: string;
  lastUserGoal?: string;
  pendingPlanId?: string;
  pendingInteraction?: PendingOperatorInteraction;
  updatedAt: string;
}

export interface ChatSessionRepository {
  get(sessionId: string): Promise<ChatSessionContext | null>;
  upsert(ctx: ChatSessionContext): Promise<void>;
}
