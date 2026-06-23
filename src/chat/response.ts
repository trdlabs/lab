import type { AgentTaskType, TaskStatus } from '../domain/types.ts';
import type { ValidationIssue } from '../domain/schemas.ts';
import type { OperatorEvidence } from '../domain/strategy-retrieval.ts';
/** Human-readable labels for the subjects the turn interpreter handles. */
const SUPPORTED_SUBJECTS = ['strategy.onboard', 'research.run_cycle', 'hypothesis.build', 'task.status', 'help', 'out_of_scope'] as const;

export interface PlannedNextStep {
  taskType: AgentTaskType;
  after: AgentTaskType;
}

export interface ProposedActionView {
  id: 'confirm' | 'cancel';
  label: string;
  style: 'primary' | 'secondary';
}

export interface EvidencePresentation {
  kind: 'interpretation' | 'warning' | 'exact_duplicate' | 'similar';
  text: string;
  sourceId?: string;
}

/**
 * Typed evidence cards for an assistant proposal message, built from the deterministic
 * interpretation text plus the Operator retrieval result. Card order is stable:
 *   1. interpretation (always)
 *   2. exact_duplicate (only when an exact fingerprint hit was found)
 *   3. similar          (one card per similar candidate)
 *   4. warning          (one card per degradation/warning code)
 * Cards carry only ids/labels/codes — never raw strategy text or embeddings.
 */
export function buildEvidenceCards(interpretation: string, evidence?: OperatorEvidence): EvidencePresentation[] {
  const cards: EvidencePresentation[] = [{ kind: 'interpretation', text: interpretation }];
  if (!evidence) return cards;

  if (evidence.exactLookup === 'hit' && evidence.exactMatch) {
    cards.push({
      kind: 'exact_duplicate',
      text: 'Похоже, такая стратегия уже есть (точное совпадение).',
      sourceId: evidence.exactMatch.strategyProfileId,
    });
  }

  for (const candidate of evidence.similarStrategies) {
    cards.push({ kind: 'similar', text: 'similar', sourceId: candidate.strategyProfileId });
  }

  for (const code of evidence.warningCodes) {
    cards.push({ kind: 'warning', text: code });
  }

  return cards;
}

export type ChatResponse =
  | { kind: 'task_created'; sessionId: string; taskId: string; taskType: AgentTaskType; status: TaskStatus; plannedNextStep?: PlannedNextStep }
  | { kind: 'task_status'; sessionId: string; taskId: string; status: TaskStatus }
  | { kind: 'needs_clarification'; sessionId: string; question: string; missing: string[] }
  | { kind: 'out_of_scope'; sessionId: string; message: string }
  | { kind: 'capability_not_available'; sessionId: string; capability: string; message: string }
  | { kind: 'help'; sessionId: string; message: string; supportedIntents: string[] }
  | { kind: 'rejected'; sessionId: string; reason: string; issues?: ValidationIssue[] }
  | { kind: 'error'; sessionId: string; message: string }
  | {
      kind: 'assistant_message';
      sessionId: string;
      message: string;
      evidence: EvidencePresentation[];
      actions: ProposedActionView[];
      pendingInteractionId?: string;
    };

export function outOfScope(sessionId: string): Extract<ChatResponse, { kind: 'out_of_scope' }> {
  return {
    kind: 'out_of_scope', sessionId,
    message: 'Я помогаю только с задачами Trading Lab: онбординг стратегий, исследование, гипотезы и статусы задач.',
  };
}

export function help(sessionId: string): Extract<ChatResponse, { kind: 'help' }> {
  return {
    kind: 'help', sessionId,
    message: 'Я понимаю запросы Trading Lab: пришлите стратегию для онбординга/исследования, спросите статус задачи или последнюю гипотезу.',
    supportedIntents: [...SUPPORTED_SUBJECTS],
  };
}

export function capabilityNotAvailable(sessionId: string, capability: string, message: string): Extract<ChatResponse, { kind: 'capability_not_available' }> {
  return { kind: 'capability_not_available', sessionId, capability, message };
}

export function needsClarification(sessionId: string, question: string, missing: string[]): Extract<ChatResponse, { kind: 'needs_clarification' }> {
  return { kind: 'needs_clarification', sessionId, question, missing };
}

export function taskCreated(
  sessionId: string, taskId: string, taskType: AgentTaskType, status: TaskStatus, plannedNextStep?: PlannedNextStep,
): Extract<ChatResponse, { kind: 'task_created' }> {
  return { kind: 'task_created', sessionId, taskId, taskType, status, plannedNextStep };
}

export function taskStatus(sessionId: string, taskId: string, status: TaskStatus): Extract<ChatResponse, { kind: 'task_status' }> {
  return { kind: 'task_status', sessionId, taskId, status };
}

export function rejected(sessionId: string, reason: string, issues?: ValidationIssue[]): Extract<ChatResponse, { kind: 'rejected' }> {
  return { kind: 'rejected', sessionId, reason, issues };
}

export function errorResponse(sessionId: string, message: string): Extract<ChatResponse, { kind: 'error' }> {
  return { kind: 'error', sessionId, message };
}

export function assistantMessage(
  sessionId: string,
  message: string,
  opts: { evidence?: EvidencePresentation[]; actions?: ProposedActionView[]; pendingInteractionId?: string } = {},
): Extract<ChatResponse, { kind: 'assistant_message' }> {
  return {
    kind: 'assistant_message',
    sessionId,
    message,
    evidence: opts.evidence ?? [],
    actions: opts.actions ?? [],
    pendingInteractionId: opts.pendingInteractionId,
  };
}
