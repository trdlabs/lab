import { randomUUID } from 'node:crypto';
import type { TaskSource } from '../domain/types.ts';
import type { TurnInterpreterPort } from '../ports/turn-interpreter.port.ts';
import type { OperatorRetrievalPort } from '../ports/operator-retrieval.port.ts';
import type { OperatorEvidence } from '../domain/strategy-retrieval.ts';
import type { ChatSessionContext, ChatSessionRepository } from '../ports/chat-session.repository.ts';
import type { ChatPlanRepository } from '../ports/chat-plan.repository.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { HypothesisProposalRepository } from '../ports/hypothesis-proposal.repository.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { ActionProposalRepository } from '../ports/action-proposal.repository.ts';
import type { ActionProposal } from '../domain/action-proposal.ts';
import type { StrategyCriticPort } from '../ports/strategy-critic.port.ts';
import type { StrategyRefinement } from '../domain/strategy-critic.ts';
import { validateWithSchema } from '../validation/validator.ts';
import { StrategyAnalystInputSchema } from '../domain/strategy-source.ts';
import { createAndEnqueueTask } from '../orchestrator/task-intake.ts';
import { parseTurn, planChatAction, type PlanDecision } from './guard.ts';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';
import { buildActionProposal } from './action-proposal.ts';
import { resolveConfirmationReply } from './confirmation-resolver.ts';
import { assertConfirmableProposal, ExecutionAuthorityError } from './confirm-authority.ts';
import {
  assistantMessage, taskCreated, taskStatus, rejected, errorResponse, buildEvidenceCards,
  type ChatResponse, type PlannedNextStep, type ProposedActionView,
} from './response.ts';

export interface ChatHandlerDeps {
  interpreter: TurnInterpreterPort;
  retrieval: OperatorRetrievalPort;
  sessions: ChatSessionRepository;
  plans: ChatPlanRepository;
  researchTasks: ResearchTaskRepository;
  strategyProfiles: StrategyProfileRepository;
  hypotheses: HypothesisProposalRepository;
  events: AgentEventRepository;
  queue: TaskQueuePort;
  proposals: ActionProposalRepository;
  /** Pre-flight strategy critic for chat HITL; null when STRATEGY_PREFLIGHT_CRITIQUE=false. */
  strategyCritic: StrategyCriticPort | null;
  /** Confirmation window for a proposed action — policy, not deployment tuning. */
  proposalTtlMs: number;
  minConfidence: number;
  defaultPlatformRun: PlatformRunConfig;
}

export type ChatEvFn = (type: string, payload: Record<string, unknown>) => Promise<void>;

export interface ConsumeConfirmationArgs {
  proposalId: string;
  decision: 'confirm' | 'accept_as_is' | 'cancel' | 'unresolved';
  session: ChatSessionContext;
}

/**
 * Resolves a pending action proposal deterministically — the single place the
 * confirm/cancel/unresolved outcomes live. Called by the typed-"да" turn in
 * handleChatMessage AND by the structured POST /chat/confirm endpoint, so the
 * two entry points can never drift. The interpreter is never consulted here;
 * a task is created exactly once, only on confirmed_now, via createAndEnqueueTask.
 */
export async function consumeConfirmation(
  args: ConsumeConfirmationArgs,
  deps: ChatHandlerDeps,
  ev: ChatEvFn,
  now: () => string,
  userMessage?: string,
): Promise<ChatResponse> {
  const { proposalId, decision, session } = args;
  const sid = session.sessionId;
  const clearPending = (extra: Partial<ChatSessionContext> = {}): Promise<void> =>
    deps.sessions.upsert({ ...session, ...extra, pendingInteraction: undefined, updatedAt: now() });

  // Operator-facing view of an already-confirmed proposal: its task's status, or a "still confirmed"
  // note when no task is attached yet (confirmed but the create step hasn't landed / crashed).
  const confirmedReply = async (proposal: ActionProposal): Promise<ChatResponse> => {
    const taskId = proposal.confirmedTaskId;
    if (!taskId) return assistantMessage(sid, 'Заявка уже подтверждена. Если задача не появилась — проверьте статус задачи.', { actions: [] });
    const task = await deps.researchTasks.findById(taskId);
    return task
      ? taskStatus(sid, taskId, task.status)
      : taskCreated(sid, taskId, proposal.task.taskType, 'queued');
  };

  if (decision === 'cancel') {
    const cancelled = await deps.proposals.cancelPending(proposalId, sid, now());
    await clearPending(); // pending is terminal either way — never leave the session wedged
    if (cancelled) {
      await ev('chat.proposal.cancelled', { proposalId, sessionId: sid });
      return assistantMessage(sid, 'Отменил. Если нужно — пришлите стратегию или запрос заново.', { actions: [] });
    }
    // Nothing to cancel: the proposal was already confirmed (task running), expired, or gone. Answer
    // honestly instead of claiming a cancellation, and never emit a false chat.proposal.cancelled.
    // findById is unscoped, so re-check session ownership here — a confirmed proposal belonging to
    // ANOTHER session must not leak its task status (the repo already fails cancelPending on mismatch).
    const proposal = await deps.proposals.findById(proposalId);
    if (proposal?.status === 'confirmed' && proposal.sessionId === sid) return confirmedReply(proposal);
    return assistantMessage(sid, 'Нечего отменять — заявка уже неактивна. Пришлите запрос заново.', { actions: [] });
  }

  if (decision === 'unresolved') {
    const evPayload: Record<string, unknown> = { proposalId, sessionId: sid };
    if (userMessage !== undefined) {
      evPayload.messageChars = userMessage.length;
    }
    await ev('chat.proposal.unresolved_reply', evPayload);
    return assistantMessage(sid, 'Не понял ответ. Подтвердите запуск или отмените действие.', {
      actions: PENDING_ACTIONS,
      pendingInteractionId: proposalId,
    });
  }

  // Authority check BEFORE confirmPending (SEC-O4). It runs here, not next to
  // executeConfirmedProposal, because confirmPending is itself a side effect: refusing after it
  // would burn a legitimate proposal into 'confirmed' and wedge the session. findById is
  // unscoped, so only a proposal belonging to THIS session is judged — anything else falls
  // through to confirmPending, which already answers not_found without leaking that it exists.
  const candidate = await deps.proposals.findById(proposalId);
  if (candidate && candidate.sessionId === sid && candidate.status === 'pending') {
    try {
      assertConfirmableProposal(candidate);
    } catch (err) {
      if (err instanceof ExecutionAuthorityError) {
        await ev('chat.proposal.authority_denied', { proposalId, sessionId: sid, action: candidate.action, taskType: candidate.task?.taskType });
      }
      throw err;
    }
  }

  const result = await deps.proposals.confirmPending(proposalId, sid, now());
  switch (result.kind) {
    case 'confirmed_now':
      return executeConfirmedProposal(result.proposal, session, deps, ev, now, decision);
    case 'already_confirmed': {
      // Clear the (possibly stuck) pending state: a crash between confirmPending and task creation
      // could leave the session pointing at a confirmed proposal, trapping it in the "не понял" loop
      // (the interpreter is never consulted while pendingInteraction is set).
      await clearPending();
      return confirmedReply(result.proposal);
    }
    case 'expired':
      await clearPending();
      await ev('chat.proposal.expired', { proposalId, sessionId: sid });
      return assistantMessage(sid, 'Срок подтверждения истёк. Пришлите запрос заново.', { actions: [] });
    case 'not_found':
      await clearPending();
      return assistantMessage(sid, 'Не нашёл активного подтверждения. Пришлите запрос заново.', { actions: [] });
  }
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
  // proposal, the reply is resolved against the STORED snapshot — never reinterpreted.
  // The interpreter is deliberately NOT consulted here, and a task is created exactly
  // once, only on confirmed_now, through the same createAndEnqueueTask chokepoint.
  const pending = input.session.pendingInteraction;
  if (pending?.kind === 'action_confirmation') {
    const reply = resolveConfirmationReply(input.message);
    return consumeConfirmation({ proposalId: pending.proposalId, decision: reply, session: input.session }, deps, ev, now, input.message);
  }

  // ---- Turn interpretation (advisory; the guard's schema gate is the trust boundary) ----
  await ev('chat.turn_interpreter.started', {
    chatRequestId, sessionId: sid, adapter: deps.interpreter.adapter, model: deps.interpreter.model,
    messageChars: input.message.length, // length only — never the raw content
  });

  let raw: unknown;
  try {
    raw = await deps.interpreter.interpret(input.message);
  } catch (err) {
    await ev('chat.turn_interpreter.failed', { chatRequestId, error: err instanceof Error ? err.message : String(err) });
    return errorResponse(sid, 'Не удалось обработать сообщение.');
  }

  const parsed = parseTurn(raw);
  if (!parsed.ok) {
    await ev('chat.turn_guard.rejected', { chatRequestId, reason: 'schema_invalid' });
    return rejected(sid, 'schema_invalid', parsed.issues);
  }
  const turn = parsed.turn;
  // Privacy: subject/goal/confidence + reference COUNT only — never the raw text or strategy body.
  await ev('chat.turn.interpreted', {
    chatRequestId, sessionId: sid, subject: turn.subject, goal: turn.goal ?? null,
    confidence: turn.confidence, referenceCount: turn.references.length,
  });

  const decision = await planChatAction(turn, {
    message: input.message,
    session: input.session,
    minConfidence: deps.minConfidence,
    deps: { researchTasks: deps.researchTasks, strategyProfiles: deps.strategyProfiles, hypotheses: deps.hypotheses },
    defaultPlatformRun: deps.defaultPlatformRun,
  });

  if (decision.kind === 'respond') {
    if (decision.auditReason) {
      await ev('chat.turn_guard.rejected', {
        chatRequestId, reason: decision.auditReason, subject: turn.subject, confidence: turn.confidence,
      });
    }
    return decision.response;
  }

  // ---- Operator retrieval: gather evidence BEFORE the proposal is built ----
  const retrievalId = randomUUID();
  const evidence: OperatorEvidence = await deps.retrieval.collect({
    turn, message: input.message, sessionId: sid, retrievalId,
  });
  // Privacy: hashes/counts/codes/timings only — never the raw text, candidate bodies, or embeddings.
  await ev('chat.retrieval.completed', {
    chatRequestId, retrievalId, sessionId: sid,
    subjectHash: evidence.subjectHash, status: evidence.status, exactLookup: evidence.exactLookup,
    exactMatch: Boolean(evidence.exactMatch), similarCount: evidence.similarStrategies.length,
    evidenceRefCount: evidence.evidenceRefs.length, degradedReasonCodes: [...evidence.warningCodes],
    timingsMs: evidence.timingsMs,
  });

  // Source-aware HITL: for a chat onboard of a strategy, run the pre-flight critic synchronously
  // (fail-soft) so the operator can choose to apply its improvements. Crawler/direct-/tasks onboarding
  // never reaches this path — that critique stays on the worker (auto). Adds one LLM call to this turn.
  let refinement: StrategyRefinement | undefined;
  if (deps.strategyCritic && decision.taskType === 'strategy.onboard') {
    const criticInput = validateWithSchema(StrategyAnalystInputSchema, decision.payload);
    if (criticInput.status === 'valid') {
      await ev('chat.strategy_critic.started', {
        chatRequestId, sessionId: sid, mode: deps.strategyCritic.mode, model: deps.strategyCritic.model,
      });
      try {
        refinement = await deps.strategyCritic.refine(criticInput.data);
        // Privacy: severity / count / mainVulnerability (a short verdict label) only — never raw text.
        await ev('chat.strategy_critic.completed', {
          chatRequestId, sessionId: sid,
          severity: refinement.verdict.severity,
          mainVulnerability: refinement.verdict.mainVulnerability,
          vulnerabilityCount: refinement.vulnerabilities.length,
        });
      } catch (err) {
        await ev('chat.strategy_critic.failed', {
          chatRequestId, sessionId: sid, error: err instanceof Error ? err.message : String(err),
        });
        refinement = undefined; // fail-soft: fall back to the simple two-action onboard confirm
      }
    }
  }

  // Propose-and-confirm: the first turn writes an ActionProposal and asks the operator
  // to confirm. No task is created or enqueued here — that happens on confirmation (a
  // separate turn). The session pendingInteraction points at the proposal.
  const proposalId = randomUUID();
  const expiresAt = new Date(Date.now() + deps.proposalTtlMs).toISOString();
  const proposal = buildActionProposal({
    id: proposalId, sessionId: sid, source: input.source, message: input.message, decision, evidence, refinement, now: now(), expiresAt,
  });
  await deps.proposals.create(proposal);

  await deps.sessions.upsert({
    ...input.session,
    lastUserGoal: decision.userGoal,
    pendingInteraction: { kind: 'action_confirmation', proposalId, expiresAt },
    updatedAt: now(),
  });

  // Privacy: IDs / types / expiry / evidence COUNTS only — never the raw message or strategy text.
  await ev('chat.proposal.created', {
    chatRequestId, proposalId, sessionId: sid, action: decision.action, taskType: decision.taskType, expiresAt,
    evidenceRefCount: proposal.evidenceRefs.length, evidenceWarningCount: proposal.evidenceWarnings.length,
  });

  if (refinement) {
    const message = buildCritiqueMessage(refinement);
    const evidenceCards = buildEvidenceCards(message, evidence);
    return assistantMessage(sid, message, { evidence: evidenceCards, actions: CRITIQUE_ACTIONS, pendingInteractionId: proposalId });
  }
  const interpretation = interpretProposal(decision);
  const evidenceCards = buildEvidenceCards(interpretation, evidence);
  return assistantMessage(sid, interpretation, { evidence: evidenceCards, actions: PENDING_ACTIONS, pendingInteractionId: proposalId });
}

/** The confirm/cancel view pair offered while a proposal awaits the operator. */
const PENDING_ACTIONS: ProposedActionView[] = [
  { id: 'confirm', label: 'Подтвердить', style: 'primary' },
  { id: 'cancel', label: 'Отмена', style: 'secondary' },
];

/** The three-action view offered after a chat-time pre-flight critique. */
const CRITIQUE_ACTIONS: ProposedActionView[] = [
  { id: 'confirm', label: 'Улучшить и анализировать', style: 'primary' },
  { id: 'accept_as_is', label: 'Анализировать как есть', style: 'secondary' },
  { id: 'cancel', label: 'Отмена', style: 'secondary' },
];

/** Deterministic operator-facing problem list: severity + main vulnerability + top-N vulnerabilities. */
function buildCritiqueMessage(refinement: StrategyRefinement, topN = 3): string {
  const sev = { low: 'низкая', medium: 'средняя', high: 'высокая' }[refinement.verdict.severity];
  const lines = [
    `Проверил стратегию перед анализом. Критичность найденных проблем: ${sev}.`,
    `Главная уязвимость: ${refinement.verdict.mainVulnerability}.`,
  ];
  const top = refinement.vulnerabilities.slice(0, topN);
  if (top.length > 0) {
    lines.push('Что ещё нашёл:');
    for (const v of top) lines.push(`• ${v}`);
  }
  lines.push('Улучшить стратегию и анализировать, анализировать как есть, или отменить?');
  return lines.join('\n');
}

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
  chosenAction: 'confirm' | 'accept_as_is' = 'confirm',
): Promise<ChatResponse> {
  const sid = session.sessionId;
  // Snapshot once so plan.createdAt/updatedAt, attachTask, and session.updatedAt
  // all share the same logical timestamp for this single operation.
  const ts = now();
  // One correlationId for the entire turn so the chained plan and its onboard task
  // share the same ID — ConversationFollower in trading-office filters by this value.
  const correlationId = randomUUID();

  // Resolve which candidate text the analyst sees. A chat-time critique means the chat already ran the
  // critic, so set skipPreflightCritique:true (Task 2's worker honors it). confirm → improved text;
  // accept_as_is → the original payload.content. No critique → enqueue the payload unchanged.
  const critique = proposal.task.preflightCritique;
  const payload = critique
    ? {
        ...proposal.task.payload,
        content: chosenAction === 'accept_as_is' ? proposal.task.payload.content : critique.improvedStrategyText,
        skipPreflightCritique: true,
      }
    : proposal.task.payload;

  const intake = await createAndEnqueueTask(
    {
      taskType: proposal.task.taskType,
      source: proposal.source,
      payload,
      correlationId,
      dedupeKey: proposal.task.dedupeKey,
    },
    { repo: deps.researchTasks, queue: deps.queue },
  );

  let pendingPlanId: string | undefined;
  let plannedNextStep: PlannedNextStep | undefined;
  const chain = proposal.task.chain;
  if (chain) {
    const planId = randomUUID();
    await deps.plans.create({
      id: planId, sessionId: sid, afterTaskId: intake.taskId, nextTaskType: chain.nextTaskType,
      resolveProfileByFingerprint: chain.resolveProfileByFingerprint, correlationId,
      status: 'pending', createdAt: ts, updatedAt: ts,
    });
    pendingPlanId = planId;
    plannedNextStep = { taskType: chain.nextTaskType, after: proposal.task.taskType };
  }

  await deps.proposals.attachTask(proposal.id, intake.taskId, ts);

  await deps.sessions.upsert({
    ...session,
    lastResearchTaskId: intake.taskId,
    lastUserGoal: proposal.task.userGoal,
    pendingPlanId,
    pendingInteraction: undefined,
    updatedAt: ts,
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
