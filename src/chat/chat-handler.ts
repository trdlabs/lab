import { randomUUID } from 'node:crypto';
import type { TaskSource } from '../domain/types.ts';
import type { IntentClassifierPort } from '../ports/intent-classifier.port.ts';
import type { ChatSessionContext, ChatSessionRepository } from '../ports/chat-session.repository.ts';
import type { ChatPlanRepository } from '../ports/chat-plan.repository.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { HypothesisProposalRepository } from '../ports/hypothesis-proposal.repository.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { ActionProposalRepository } from '../ports/action-proposal.repository.ts';
import type { ActionProposal } from '../domain/action-proposal.ts';
import { createAndEnqueueTask } from '../orchestrator/task-intake.ts';
import { parseIntent, planChatAction, type PlanDecision } from './guard.ts';
import { buildActionProposal } from './action-proposal.ts';
import { resolveConfirmationReply } from './confirmation-resolver.ts';
import {
  assistantMessage, taskCreated, taskStatus, rejected, errorResponse,
  type ChatResponse, type EvidencePresentation, type PlannedNextStep, type ProposedActionView,
} from './response.ts';

export interface ChatHandlerDeps {
  classifier: IntentClassifierPort;
  sessions: ChatSessionRepository;
  plans: ChatPlanRepository;
  researchTasks: ResearchTaskRepository;
  strategyProfiles: StrategyProfileRepository;
  hypotheses: HypothesisProposalRepository;
  events: AgentEventRepository;
  queue: TaskQueuePort;
  proposals: ActionProposalRepository;
  /** Confirmation window for a proposed action — policy, not deployment tuning. */
  proposalTtlMs: number;
  minConfidence: number;
}

export interface HandleChatInput {
  message: string;
  session: ChatSessionContext;
  source: TaskSource;
}

export async function handleChatMessage(input: HandleChatInput, deps: ChatHandlerDeps): Promise<ChatResponse> {
  const sid = input.session.sessionId;
  const chatRequestId = randomUUID();
  const now = (): string => new Date().toISOString();
  const ev = (type: string, payload: Record<string, unknown>): Promise<void> =>
    deps.events.append({ id: randomUUID(), taskId: chatRequestId, type, payload, createdAt: now() });

  // Confirmation consumption (second turn): when the session already holds a pending
  // proposal, the reply is resolved against the STORED snapshot — never reclassified.
  // The classifier is deliberately NOT consulted here, and a task is created exactly
  // once, only on confirmed_now, through the same createAndEnqueueTask chokepoint.
  const pending = input.session.pendingInteraction;
  if (pending?.kind === 'action_confirmation') {
    const proposalId = pending.proposalId;
    const clearPending = (extra: Partial<ChatSessionContext> = {}): Promise<void> =>
      deps.sessions.upsert({ ...input.session, ...extra, pendingInteraction: undefined, updatedAt: now() });
    const reply = resolveConfirmationReply(input.message);

    if (reply === 'cancel') {
      await deps.proposals.cancelPending(proposalId, sid, now());
      await clearPending();
      await ev('chat.proposal.cancelled', { chatRequestId, proposalId, sessionId: sid });
      return assistantMessage(sid, 'Отменил. Если нужно — пришлите стратегию или запрос заново.', { actions: [] });
    }

    if (reply === 'unresolved') {
      // Stay parked on the proposal: do not classify and do not mutate any state.
      return assistantMessage(sid, 'Не понял ответ. Подтвердите запуск или отмените действие.', {
        actions: PENDING_ACTIONS,
        pendingInteractionId: proposalId,
      });
    }

    // confirm
    const result = await deps.proposals.confirmPending(proposalId, sid, now());
    switch (result.kind) {
      case 'confirmed_now':
        return executeConfirmedProposal(result.proposal, input.session, deps, ev, now);
      case 'already_confirmed': {
        // Replay: never enqueue again. Surface the already-created task's status.
        const taskId = result.proposal.confirmedTaskId;
        if (!taskId) return assistantMessage(sid, 'Подтверждение уже обрабатывается.', { actions: [] });
        const task = await deps.researchTasks.findById(taskId);
        return task
          ? taskStatus(sid, taskId, task.status)
          : taskCreated(sid, taskId, result.proposal.task.taskType, 'queued');
      }
      case 'expired':
        await clearPending();
        await ev('chat.proposal.expired', { chatRequestId, proposalId, sessionId: sid });
        return assistantMessage(sid, 'Срок подтверждения истёк. Пришлите запрос заново.', { actions: [] });
      case 'not_found':
        await clearPending();
        return assistantMessage(sid, 'Не нашёл активного подтверждения. Пришлите запрос заново.', { actions: [] });
    }
  }

  await ev('chat.intent_classifier.started', {
    chatRequestId, sessionId: sid, adapter: deps.classifier.adapter, model: deps.classifier.model,
    messageChars: input.message.length, // length only — never the raw content
  });

  let raw: unknown;
  try {
    raw = await deps.classifier.classify(input.message);
  } catch (err) {
    await ev('chat.intent_classifier.failed', { chatRequestId, error: err instanceof Error ? err.message : String(err) });
    return errorResponse(sid, 'Не удалось обработать сообщение.');
  }

  const parsed = parseIntent(raw);
  if (!parsed.ok) {
    await ev('chat.intent_guard.rejected', { chatRequestId, reason: 'schema_invalid' });
    return rejected(sid, 'schema_invalid', parsed.issues);
  }
  await ev('chat.intent_classifier.completed', { chatRequestId, intent: parsed.intent.intent, confidence: parsed.intent.confidence });

  const decision = await planChatAction(parsed.intent, {
    message: input.message,
    session: input.session,
    minConfidence: deps.minConfidence,
    deps: { researchTasks: deps.researchTasks, strategyProfiles: deps.strategyProfiles, hypotheses: deps.hypotheses },
  });

  if (decision.kind === 'respond') {
    if (decision.auditReason) {
      await ev('chat.intent_guard.rejected', {
        chatRequestId, reason: decision.auditReason, intent: parsed.intent.intent, confidence: parsed.intent.confidence,
      });
    }
    return decision.response;
  }

  // Propose-and-confirm: the first turn writes an ActionProposal and asks the operator
  // to confirm. No task is created or enqueued here — that happens on confirmation (a
  // separate turn). The session pendingInteraction points at the proposal.
  const proposalId = randomUUID();
  const expiresAt = new Date(Date.now() + deps.proposalTtlMs).toISOString();
  const proposal = buildActionProposal({
    id: proposalId, sessionId: sid, source: input.source, message: input.message, decision, now: now(), expiresAt,
  });
  await deps.proposals.create(proposal);

  await deps.sessions.upsert({
    ...input.session,
    lastUserGoal: decision.userGoal,
    pendingInteraction: { kind: 'action_confirmation', proposalId, expiresAt },
    updatedAt: now(),
  });

  // Privacy: IDs / types / expiry only — never the raw message or strategy text.
  await ev('chat.proposal.created', {
    chatRequestId, proposalId, sessionId: sid, action: decision.action, taskType: decision.taskType, expiresAt,
  });

  const interpretation = interpretProposal(decision);
  const evidence: EvidencePresentation[] = [{ kind: 'interpretation', text: interpretation }];
  return assistantMessage(sid, interpretation, { evidence, actions: PENDING_ACTIONS, pendingInteractionId: proposalId });
}

/** The confirm/cancel view pair offered while a proposal awaits the operator. */
const PENDING_ACTIONS: ProposedActionView[] = [
  { id: 'confirm', label: 'Подтвердить', style: 'primary' },
  { id: 'cancel', label: 'Отмена', style: 'secondary' },
];

/**
 * The single place a confirmed proposal turns into a task. Runs the STORED snapshot
 * through createAndEnqueueTask, recreates the auto-chain ChatPlan when the snapshot
 * carried one, links the task back to the proposal, and clears the pending state.
 * Keeping enqueue + chain creation here means the confirm path cannot drift from the
 * behavior the proposal promised on turn one.
 */
async function executeConfirmedProposal(
  proposal: ActionProposal,
  session: ChatSessionContext,
  deps: ChatHandlerDeps,
  ev: (type: string, payload: Record<string, unknown>) => Promise<void>,
  now: () => string,
): Promise<ChatResponse> {
  const sid = session.sessionId;
  const intake = await createAndEnqueueTask(
    {
      taskType: proposal.task.taskType,
      source: proposal.source,
      payload: proposal.task.payload,
      correlationId: randomUUID(),
      dedupeKey: proposal.task.dedupeKey,
    },
    { repo: deps.researchTasks, queue: deps.queue },
  );

  let pendingPlanId: string | undefined;
  let plannedNextStep: PlannedNextStep | undefined;
  const chain = proposal.task.chain;
  if (chain) {
    const planId = randomUUID();
    const ts = now();
    await deps.plans.create({
      id: planId, sessionId: sid, afterTaskId: intake.taskId, nextTaskType: chain.nextTaskType,
      resolveProfileByFingerprint: chain.resolveProfileByFingerprint, correlationId: randomUUID(),
      status: 'pending', createdAt: ts, updatedAt: ts,
    });
    pendingPlanId = planId;
    plannedNextStep = { taskType: chain.nextTaskType, after: proposal.task.taskType };
  }

  await deps.proposals.attachTask(proposal.id, intake.taskId, now());

  await deps.sessions.upsert({
    ...session,
    lastResearchTaskId: intake.taskId,
    lastUserGoal: proposal.task.userGoal,
    pendingPlanId,
    pendingInteraction: undefined,
    updatedAt: now(),
  });

  await ev('chat.proposal.confirmed', { proposalId: proposal.id, taskId: intake.taskId, sessionId: sid });
  await ev('chat.task_created', { taskId: intake.taskId, taskType: proposal.task.taskType, sessionId: sid });
  if (chain) {
    await ev('chat.plan.created', { planId: pendingPlanId, afterTaskId: intake.taskId, nextTaskType: chain.nextTaskType });
  }

  return taskCreated(sid, intake.taskId, proposal.task.taskType, intake.status, plannedNextStep);
}

/** Deterministic operator-facing interpretation, keyed by the proposed action / chain. */
function interpretProposal(decision: Extract<PlanDecision, { kind: 'propose_task' }>): string {
  switch (decision.action) {
    case 'strategy.analyze':
      return 'Вижу, что вы прислали стратегию и хотите провести анализ. Подтвердите запуск анализа.';
    case 'research.run_cycle':
      return decision.chain
        ? 'Вижу стратегию и запрос на исследование. Сначала будет создан и проанализирован профиль, затем запущен исследовательский цикл. Подтвердите этот план.'
        : 'Вижу запрос на исследование выбранной стратегии. Подтвердите запуск исследовательского цикла.';
    case 'hypothesis.build':
      return 'Вижу запрос на проверку гипотезы. Подтвердите запуск сборки и бэктеста гипотезы.';
    // backtest.run is a valid OperatorAction but is not yet routed by planChatAction (CC-5): no propose_task path emits it.
    default:
      return 'Подтвердите запуск предложенного действия.';
  }
}
