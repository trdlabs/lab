import type { TaskSource } from '../domain/types.ts';
import type { ActionProposal } from '../domain/action-proposal.ts';
import type { OperatorEvidence } from '../domain/strategy-retrieval.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import type { PlanDecision } from './guard.ts';

export function buildActionProposal(input: {
  id: string;
  sessionId: string;
  source: TaskSource;
  message: string;
  decision: Extract<PlanDecision, { kind: 'propose_task' }>;
  /** Operator evidence gathered before the proposal; its refs/warnings ride on the proposal. */
  evidence?: OperatorEvidence;
  now: string;
  expiresAt: string;
}): ActionProposal {
  const { id, sessionId, source, message, decision, evidence, now, expiresAt } = input;

  return {
    id,
    sessionId,
    // Prefer the retrieval's subjectHash so proposal + evidence agree on subject identity.
    subjectHash: evidence?.subjectHash ?? sourceFingerprint('manual_description', message.trim()),
    action: decision.action,
    source,
    task: {
      taskType: decision.taskType,
      payload: decision.payload,
      dedupeKey: `chat-proposal:${id}`,
      chain: decision.chain,
      userGoal: decision.userGoal,
    },
    status: 'pending',
    // Typed evidence references that justified this proposal — never raw retrieved bodies.
    evidenceRefs: evidence ? [...evidence.evidenceRefs] : [],
    evidenceWarnings: evidence ? [...evidence.warningCodes] : [],
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
}
