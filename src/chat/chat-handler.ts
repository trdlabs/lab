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
import { createAndEnqueueTask } from '../orchestrator/task-intake.ts';
import { parseIntent, planChatAction } from './guard.ts';
import {
  taskCreated, rejected, errorResponse, type ChatResponse, type PlannedNextStep,
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

  // create_task: the deterministic write chokepoint.
  const correlationId = randomUUID();
  const intake = await createAndEnqueueTask(
    { taskType: decision.taskType, source: input.source, payload: decision.payload, correlationId, dedupeKey: decision.dedupeKey },
    { repo: deps.researchTasks, queue: deps.queue },
  );
  await ev('chat.task_created', { chatRequestId, sessionId: sid, taskId: intake.taskId, taskType: decision.taskType });

  let pendingPlanId = input.session.pendingPlanId;
  let plannedNextStep: PlannedNextStep | undefined;
  if (decision.chain) {
    const planId = randomUUID();
    await deps.plans.create({
      id: planId, sessionId: sid, afterTaskId: intake.taskId, nextTaskType: decision.chain.nextTaskType,
      resolveProfileByFingerprint: decision.chain.resolveProfileByFingerprint, correlationId,
      status: 'pending', createdAt: now(), updatedAt: now(),
    });
    await ev('chat.plan.created', { chatRequestId, planId, afterTaskId: intake.taskId, nextTaskType: decision.chain.nextTaskType });
    pendingPlanId = planId;
    plannedNextStep = { taskType: decision.chain.nextTaskType, after: decision.taskType };
  }

  await deps.sessions.upsert({
    ...input.session,
    lastResearchTaskId: intake.taskId,
    lastUserGoal: decision.userGoal,
    pendingPlanId,
    updatedAt: now(),
  });

  return taskCreated(sid, intake.taskId, decision.taskType, intake.status, plannedNextStep);
}
