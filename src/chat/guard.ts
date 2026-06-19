import type { AgentTaskType } from '../domain/types.ts';
import type { OperatorAction } from '../domain/action-proposal.ts';
import type { ValidationIssue } from '../domain/schemas.ts';
import type { ChatSessionContext } from '../ports/chat-session.repository.ts';
import { validateWithSchema } from '../validation/validator.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import { StrategyAnalystInputSchema, type SourceKind } from '../domain/strategy-source.ts';
import { HypothesisBuildPayloadSchema } from '../orchestrator/handlers/hypothesis-build.handler.ts';
import { TurnInterpretationSchema, type InterpretedTurn } from './turn-interpretation.ts';
import { normalizeTurnOutput } from './normalize-turn-output.ts';
import {
  outOfScope, capabilityNotAvailable, needsClarification, taskStatus, type ChatResponse,
} from './response.ts';
import {
  resolveStatusTask, resolveBuildableHypothesis, type RefResolverDeps,
} from './ref-resolver.ts';

export type ParseResult =
  | { ok: true; turn: InterpretedTurn }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Schema gate: the single trust boundary for advisory turn-interpreter output.
 * Mirrors the old parseIntent — normalizeTurnOutput strips provider nulls, then
 * TurnInterpretationSchema re-validates the (untrusted) structured output.
 */
export function parseTurn(raw: unknown): ParseResult {
  const v = validateWithSchema(TurnInterpretationSchema, normalizeTurnOutput(raw));
  return v.status === 'valid' ? { ok: true, turn: v.data } : { ok: false, issues: v.issues };
}

export interface ChainSpec {
  nextTaskType: 'research.run_cycle';
  resolveProfileByFingerprint: string;
}

export type PlanDecision =
  | {
      kind: 'propose_task';
      action: OperatorAction;
      taskType: AgentTaskType;
      payload: Record<string, unknown>;
      dedupeKey?: string;
      chain?: ChainSpec;
      userGoal: string;
    }
  | { kind: 'respond'; response: ChatResponse; auditReason?: string };

export interface PlanArgs {
  message: string;
  session: ChatSessionContext;
  minConfidence: number;
  deps: RefResolverDeps;
}

function buildOnboardDecision(sid: string, userGoal: string, text: string, withResearch: boolean): PlanDecision {
  const kind: SourceKind = 'manual_description';
  const payload = { kind, content: text };
  const v = validateWithSchema(StrategyAnalystInputSchema, payload);
  if (v.status === 'invalid') {
    return { kind: 'respond', response: needsClarification(sid, 'Не удалось разобрать текст стратегии.', v.issues.map((i) => i.path)) };
  }
  const chain: ChainSpec | undefined = withResearch
    ? { nextTaskType: 'research.run_cycle', resolveProfileByFingerprint: sourceFingerprint(kind, text) }
    : undefined;
  const action: OperatorAction = withResearch ? 'research.run_cycle' : 'strategy.analyze';
  return { kind: 'propose_task', action, taskType: 'strategy.onboard', payload: v.data, chain, userGoal };
}

/**
 * Deterministic guard + planner consuming an interpreted turn. Gates: confidence ->
 * subject routing -> required fields / ref resolution -> capability -> payload
 * validation. Returns a decision; it performs NO writes.
 *
 * Subject routing:
 *   strategy + (undefined|analyze)  -> strategy.onboard propose_task (action strategy.analyze)
 *   strategy + research             -> strategy.onboard propose_task WITH research chain
 *   task                            -> task.status read (ref-resolved via references/session)
 *   results                         -> capability_not_available (results.trading)
 *   bot                             -> capability_not_available (bot.status)
 *   hypothesis                      -> hypothesis.build propose_task (resolve buildable hypothesis)
 *   unknown                         -> out_of_scope / needs_clarification
 */
export async function planChatAction(turn: InterpretedTurn, args: PlanArgs): Promise<PlanDecision> {
  const { message, session, minConfidence, deps } = args;
  const sid = session.sessionId;

  // Confidence gate: a low-confidence interpretation never drives a propose/route.
  if (turn.confidence < minConfidence) {
    return {
      kind: 'respond',
      response: needsClarification(sid, 'Не уверен, что понял запрос. Уточните, пожалуйста.', ['confidence']),
      auditReason: 'low_confidence',
    };
  }

  switch (turn.subject) {
    case 'strategy': {
      // strategyText is advisory; fall back to the raw message so an onboard always has a body.
      const text = (turn.strategyText ?? message).trim();
      if (!text) return { kind: 'respond', response: needsClarification(sid, 'Пришлите текст стратегии для онбординга.', ['strategyText']) };
      const wantResearch = turn.goal === 'research';
      return buildOnboardDecision(sid, wantResearch ? 'research.run_cycle' : 'strategy.onboard', text, wantResearch);
    }

    case 'task': {
      // references carry the untrusted task-id hint (verified via findById), as entityRef once did.
      const taskIdHint = turn.references[0];
      const t = await resolveStatusTask(taskIdHint, session, deps);
      if (!t) return { kind: 'respond', response: needsClarification(sid, 'Какую задачу показать? Уточните идентификатор задачи.', ['taskId']) };
      return { kind: 'respond', response: taskStatus(sid, t.id, t.status) };
    }

    // results (trading/backtest summaries) are not yet exposed.
    case 'results':
      return { kind: 'respond', response: capabilityNotAvailable(sid, 'results.trading', 'Результаты торговли пока недоступны.') };

    // bot (deployed-bot status) is not yet exposed.
    case 'bot':
      return { kind: 'respond', response: capabilityNotAvailable(sid, 'bot.status', 'Статус бота пока недоступен.') };

    case 'hypothesis': {
      const hyp = await resolveBuildableHypothesis(session, deps);
      if (!hyp) return { kind: 'respond', response: needsClarification(sid, 'Какую гипотезу проверить? Сначала проведите исследование стратегии.', ['hypothesisId']) };
      const payload = { hypothesisId: hyp.id };
      const v = validateWithSchema(HypothesisBuildPayloadSchema, payload);
      if (v.status === 'invalid') return { kind: 'respond', response: needsClarification(sid, 'Не удалось подготовить проверку гипотезы.', v.issues.map((i) => i.path)) };
      return { kind: 'propose_task', action: 'hypothesis.build', taskType: 'hypothesis.build', payload: v.data, userGoal: 'hypothesis.build' };
    }

    case 'unknown':
      return { kind: 'respond', response: outOfScope(sid), auditReason: 'interpreter_unknown_subject' };

    default:
      return { kind: 'respond', response: outOfScope(sid) };
  }
}
