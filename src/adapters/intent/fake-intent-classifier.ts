import type { IntentClassifierPort } from '../../ports/intent-classifier.port.ts';
import type { ChatIntent } from '../../chat/intent.ts';

/**
 * Test / key-free-demo adapter only — NOT product logic. Keyword rules imitate the
 * LLM in key-free mode; the real path is MastraIntentClassifier. Injection text is
 * ignored because rules match keywords, never instructions inside the message.
 */
export class FakeIntentClassifier implements IntentClassifierPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  private readonly canned?: ChatIntent;

  constructor(canned?: ChatIntent) {
    this.canned = canned;
  }

  async classify(message: string): Promise<unknown> {
    return this.classifySync(message);
  }

  /** Synchronous rule evaluation, exposed for deterministic unit tests. */
  classifySync(message: string): ChatIntent {
    if (this.canned) return this.canned;
    return classifyByRules(message);
  }
}

function afterColon(message: string): string {
  const i = message.indexOf(':');
  return i >= 0 ? message.slice(i + 1).trim() : '';
}

function looksLikeStandaloneStrategyDescription(message: string): boolean {
  const lower = message.toLowerCase();
  const signals = [
    'лонг',
    'шорт',
    'свеч',
    'тейк',
    'стоп',
    'dca',
    'open interest',
    'oi',
    'ликвидац',
    'входим',
    'вход',
    'выход',
    'добор',
    'безубыт',
  ];
  const hits = signals.filter((token) => lower.includes(token)).length;
  return lower.includes('стратег') && message.trim().length >= 80 && hits >= 3;
}

function classifyByRules(message: string): ChatIntent {
  const lower = message.toLowerCase();
  const has = (...ks: string[]): boolean => ks.some((k) => lower.includes(k));

  if (has('погод', 'weather', 'новост', 'news', 'анекдот', 'joke', 'курс доллар', 'медицин')) {
    return { intent: 'out_of_scope', confidence: 0.95 };
  }
  if (has('что ты умеешь', 'помощь', 'help', 'команды')) {
    return { intent: 'help', confidence: 0.9 };
  }
  if (has('статус', 'status')) {
    return { intent: 'task.status', confidence: 0.9 };
  }
  if (has('торговл', 'торгов', 'trading')) {
    return { intent: 'results.trading', confidence: 0.9 };
  }
  if (has('бэктест', 'бектест', 'backtest')) {
    return { intent: 'results.backtest', confidence: 0.9 };
  }
  if (has('гипотез', 'hypothesis')) {
    const text = afterColon(message);
    return text
      ? { intent: 'hypothesis.build', confidence: 0.9, hypothesisText: text, entityRef: 'from_message_text' }
      : { intent: 'hypothesis.build', confidence: 0.9, entityRef: 'last_hypothesis' };
  }
  if (has('исследу', 'исследован', 'research')) {
    const text = afterColon(message);
    return text
      ? { intent: 'research.run_cycle', confidence: 0.9, strategyText: text, requestedOutcome: 'research' }
      : { intent: 'research.run_cycle', confidence: 0.9, entityRef: 'last_strategy' };
  }
  if (has('стратег', 'strategy', 'онбординг', 'onboard', 'проверь')) {
    const text = afterColon(message);
    if (text) {
      const wantsResearch = has('исследу', 'research');
      return {
        intent: 'strategy.onboard', confidence: 0.9, strategyText: text,
        requestedOutcome: wantsResearch ? 'research' : 'onboard',
      };
    }
    if (looksLikeStandaloneStrategyDescription(message)) {
      const wantsResearch = has('исследу', 'research');
      return {
        intent: 'strategy.onboard',
        confidence: 0.9,
        strategyText: message.trim(),
        requestedOutcome: wantsResearch ? 'research' : 'onboard',
      };
    }
    return { intent: 'strategy.onboard', confidence: 0.5 };
  }
  return { intent: 'needs_clarification', confidence: 0.3 };
}
