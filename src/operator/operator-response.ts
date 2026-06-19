// src/operator/operator-response.ts
import type {
  OperatorEvidence,
  SimilarStrategyCandidate,
} from '../domain/strategy-retrieval.ts';
import type { InterpretedTurn } from '../chat/turn-interpretation.ts';
import type { OperatorAction } from '../domain/action-proposal.ts';

const MAX_SIMILAR = 5;

export interface RenderOperatorResponseInput {
  turn: InterpretedTurn;
  evidence: OperatorEvidence;
  proposedAction: OperatorAction;
}

/**
 * Deterministic (NO LLM) operator response renderer. Produces four labelled blocks
 * from the evidence + proposed action:
 *   1. interpretation of the turn,
 *   2. exact-match status,
 *   3. up to five similar profiles with match reasons,
 *   4. the proposed next action.
 *
 * Honesty rules:
 *  - A database-absence claim ("точного совпадения нет") is made ONLY for a real
 *    `miss`. For `not_run` / `failed` the renderer says the check did not run / failed
 *    and makes no absence claim.
 *  - When the evidence is degraded, an explicit limitation sentence is appended naming
 *    the degradation codes.
 */
export function renderOperatorResponse(input: RenderOperatorResponseInput): string {
  const { turn, evidence, proposedAction } = input;
  const blocks: string[] = [];

  blocks.push(renderInterpretation(turn));
  blocks.push(renderExactStatus(evidence));
  blocks.push(renderSimilar(evidence));
  blocks.push(renderNextAction(proposedAction));

  if (evidence.status === 'degraded') {
    blocks.push(renderLimitation(evidence));
  }

  return blocks.join('\n\n');
}

function renderInterpretation(turn: InterpretedTurn): string {
  const lines = ['Как я понял запрос:'];
  lines.push(`- предмет: ${subjectLabel(turn.subject)}`);
  if (turn.goal) lines.push(`- цель: ${goalLabel(turn.goal)}`);

  const c = turn.constraints;
  const constraintParts: string[] = [];
  if (c.market) constraintParts.push(`рынок ${c.market}`);
  if (c.symbol) constraintParts.push(`инструмент ${c.symbol}`);
  if (c.timeframe) constraintParts.push(`таймфрейм ${c.timeframe}`);
  if (c.direction) constraintParts.push(`направление ${c.direction}`);
  if (constraintParts.length > 0) {
    lines.push(`- фильтры: ${constraintParts.join(', ')}`);
  }
  return lines.join('\n');
}

function renderExactStatus(evidence: OperatorEvidence): string {
  const header = 'Точное совпадение:';
  switch (evidence.exactLookup) {
    case 'hit': {
      const m = evidence.exactMatch;
      const label = m?.label ?? m?.strategyProfileId ?? '';
      const id = m?.strategyProfileId ?? '';
      return `${header}\n- найден дубликат: ${label} (id ${id}). Эта стратегия уже есть в базе.`;
    }
    case 'miss':
      return `${header}\n- точного совпадения нет — такой стратегии в базе ещё нет.`;
    case 'failed':
      return `${header}\n- проверку точного совпадения не удалось выполнить (ошибка поиска); наличие дубликата неизвестно.`;
    case 'not_run':
    default:
      return `${header}\n- проверка точного совпадения не выполнялась.`;
  }
}

function renderSimilar(evidence: OperatorEvidence): string {
  const header = 'Похожие стратегии:';
  const shown = evidence.similarStrategies.slice(0, MAX_SIMILAR);
  if (shown.length === 0) {
    return `${header}\n- похожих стратегий не найдено.`;
  }
  const lines = [header];
  for (const c of shown) {
    lines.push(renderCandidate(c));
  }
  return lines.join('\n');
}

function renderCandidate(c: SimilarStrategyCandidate): string {
  const meta = c.metadata;
  const label = meta.label ?? c.strategyProfileId;
  const why = whyMatched(c);
  const source = sourceDescriptor(c);
  const freshness = meta.createdAt ? `, создана ${formatDate(meta.createdAt)}` : '';
  return `- ${label} (id ${c.strategyProfileId}): ${why}; источник: ${source}${freshness}.`;
}

function whyMatched(c: SimilarStrategyCandidate): string {
  const reasons: string[] = [];
  if (c.lexicalRank !== undefined) reasons.push(`текстовое совпадение (#${c.lexicalRank})`);
  if (c.vectorRank !== undefined) reasons.push(`семантическая близость (#${c.vectorRank})`);
  if (reasons.length === 0) reasons.push('гибридное совпадение');
  return `${reasons.join(' + ')}, RRF ${c.rrfScore.toFixed(3)}`;
}

function sourceDescriptor(c: SimilarStrategyCandidate): string {
  const m = c.metadata;
  const parts: string[] = [];
  if (m.market) parts.push(m.market);
  if (m.symbol) parts.push(m.symbol);
  if (m.timeframe) parts.push(m.timeframe);
  if (m.direction) parts.push(m.direction);
  return parts.length > 0 ? parts.join('/') : 'профиль стратегии';
}

function renderNextAction(action: OperatorAction): string {
  return `Предлагаю следующий шаг: ${action} (${actionLabel(action)}).`;
}

function renderLimitation(evidence: OperatorEvidence): string {
  const codes = evidence.warningCodes.length > 0 ? ` (${evidence.warningCodes.join(', ')})` : '';
  return `Важно: результат поиска ограничен — часть источников отработала неполно${codes}. Учитывайте это при принятии решения.`;
}

function subjectLabel(subject: InterpretedTurn['subject']): string {
  switch (subject) {
    case 'strategy': return 'стратегия';
    case 'bot': return 'бот';
    case 'results': return 'результаты';
    case 'task': return 'задача';
    case 'hypothesis': return 'гипотеза';
    case 'unknown':
    default: return 'не определён';
  }
}

function goalLabel(goal: NonNullable<InterpretedTurn['goal']>): string {
  switch (goal) {
    case 'analyze': return 'разобрать';
    case 'research': return 'исследовать';
    case 'show_results': return 'показать результаты';
    case 'show_similar': return 'показать похожие';
    default: return goal;
  }
}

function actionLabel(action: OperatorAction): string {
  switch (action) {
    case 'strategy.analyze': return 'разобрать стратегию';
    case 'research.run_cycle': return 'запустить цикл исследования';
    case 'hypothesis.build': return 'построить гипотезу';
    case 'backtest.run': return 'запустить бэктест';
    default: return action;
  }
}

/** Render an ISO timestamp as a date (YYYY-MM-DD); fall back to the raw value. */
function formatDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1]! : iso;
}
