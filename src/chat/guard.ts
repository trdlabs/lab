import type { AgentTaskType } from '../domain/types.ts';
import type { ValidationIssue } from '../domain/schemas.ts';
import type { ChatSessionContext } from '../ports/chat-session.repository.ts';
import { validateWithSchema } from '../validation/validator.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import { StrategyAnalystInputSchema, type SourceKind } from '../domain/strategy-source.ts';
import { ResearchRunCyclePayloadSchema } from '../orchestrator/handlers/research-run-cycle.handler.ts';
import { HypothesisBuildPayloadSchema } from '../orchestrator/handlers/hypothesis-build.handler.ts';
import { ChatIntentSchema, type ChatIntent, type AllowedIntent } from './intent.ts';
import { withoutNullProps } from './normalize-intent-output.ts';
import {
  outOfScope, help, capabilityNotAvailable, needsClarification, taskStatus, type ChatResponse,
} from './response.ts';
import {
  resolveStatusTask, resolveResearchProfile, resolveBuildableHypothesis, type RefResolverDeps,
} from './ref-resolver.ts';

export type ParseResult =
  | { ok: true; intent: ChatIntent }
  | { ok: false; issues: ValidationIssue[] };

/** Schema gate: the single trust boundary for advisory classifier output. */
export function parseIntent(raw: unknown): ParseResult {
  const v = validateWithSchema(ChatIntentSchema, withoutNullProps(raw));
  return v.status === 'valid' ? { ok: true, intent: v.data } : { ok: false, issues: v.issues };
}

export interface ChainSpec {
  nextTaskType: 'research.run_cycle';
  resolveProfileByFingerprint: string;
}

export type PlanDecision =
  | {
      kind: 'create_task';
      intent: AllowedIntent;
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

function buildOnboardDecision(sid: string, intent: AllowedIntent, text: string, withResearch: boolean): PlanDecision {
  const kind: SourceKind = 'manual_description';
  const payload = { kind, content: text };
  const v = validateWithSchema(StrategyAnalystInputSchema, payload);
  if (v.status === 'invalid') {
    return { kind: 'respond', response: needsClarification(sid, 'Не удалось разобрать текст стратегии.', v.issues.map((i) => i.path)) };
  }
  const chain: ChainSpec | undefined = withResearch
    ? { nextTaskType: 'research.run_cycle', resolveProfileByFingerprint: sourceFingerprint(kind, text) }
    : undefined;
  return { kind: 'create_task', intent, taskType: 'strategy.onboard', payload: v.data, chain, userGoal: intent };
}

/**
 * Deterministic guard + planner. Gates: confidence -> allowlist (enum) -> required
 * fields / ref resolution -> capability -> payload validation. Returns a decision;
 * it performs NO writes. Static intents bypass the confidence gate.
 */
export async function planChatAction(intent: ChatIntent, args: PlanArgs): Promise<PlanDecision> {
  const { session, minConfidence, deps } = args;
  const sid = session.sessionId;

  if (intent.intent === 'out_of_scope') return { kind: 'respond', response: outOfScope(sid) };
  if (intent.intent === 'help') return { kind: 'respond', response: help(sid) };

  if (intent.confidence < minConfidence) {
    return {
      kind: 'respond',
      response: needsClarification(sid, 'Не уверен, что понял запрос. Уточните, пожалуйста.', ['confidence']),
      auditReason: 'low_confidence',
    };
  }

  switch (intent.intent) {
    case 'results.trading':
      return { kind: 'respond', response: capabilityNotAvailable(sid, 'results.trading', 'Результаты торговли пока недоступны.') };

    case 'results.backtest':
      return { kind: 'respond', response: capabilityNotAvailable(sid, 'results.backtest', 'Сводка по бэктестам пока недоступна.') };

    case 'task.status': {
      const t = await resolveStatusTask(intent, session, deps);
      if (!t) return { kind: 'respond', response: needsClarification(sid, 'Какую задачу показать? Уточните идентификатор задачи.', ['taskId']) };
      return { kind: 'respond', response: taskStatus(sid, t.id, t.status) };
    }

    case 'strategy.onboard': {
      const text = (intent.strategyText ?? '').trim();
      if (!text) return { kind: 'respond', response: needsClarification(sid, 'Пришлите текст стратегии для онбординга.', ['strategyText']) };
      return buildOnboardDecision(sid, 'strategy.onboard', text, intent.requestedOutcome === 'research');
    }

    case 'research.run_cycle': {
      const text = (intent.strategyText ?? '').trim();
      if (text) return buildOnboardDecision(sid, 'research.run_cycle', text, true);
      const profile = await resolveResearchProfile(session, deps);
      if (!profile) return { kind: 'respond', response: needsClarification(sid, 'По какой стратегии запустить исследование? Сначала пришлите стратегию.', ['strategyProfileId']) };
      const payload = { strategyProfileId: profile.id };
      const v = validateWithSchema(ResearchRunCyclePayloadSchema, payload);
      if (v.status === 'invalid') return { kind: 'respond', response: needsClarification(sid, 'Не удалось подготовить запуск исследования.', v.issues.map((i) => i.path)) };
      return { kind: 'create_task', intent: 'research.run_cycle', taskType: 'research.run_cycle', payload: v.data, userGoal: 'research.run_cycle' };
    }

    case 'hypothesis.build': {
      const hyp = await resolveBuildableHypothesis(session, deps);
      if (!hyp) return { kind: 'respond', response: needsClarification(sid, 'Какую гипотезу проверить? Сначала проведите исследование стратегии.', ['hypothesisId']) };
      const payload = { hypothesisId: hyp.id };
      const v = validateWithSchema(HypothesisBuildPayloadSchema, payload);
      if (v.status === 'invalid') return { kind: 'respond', response: needsClarification(sid, 'Не удалось подготовить проверку гипотезы.', v.issues.map((i) => i.path)) };
      return { kind: 'create_task', intent: 'hypothesis.build', taskType: 'hypothesis.build', payload: v.data, userGoal: 'hypothesis.build' };
    }

    case 'needs_clarification':
      return { kind: 'respond', response: needsClarification(sid, 'Уточните запрос, пожалуйста.', []), auditReason: 'classifier_needs_clarification' };

    default:
      return { kind: 'respond', response: outOfScope(sid) };
  }
}
