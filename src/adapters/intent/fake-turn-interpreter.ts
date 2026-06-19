import type { TurnInterpreterPort } from '../../ports/turn-interpreter.port.ts';

/**
 * Test / key-free-demo adapter only — NOT product logic. Keyword rules imitate the
 * LLM in key-free mode; the real path is MastraTurnInterpreter. Injection text is
 * ignored because rules match keywords, never instructions inside the message.
 *
 * Mirrors the subject routing the guard expects: weather/off-domain -> unknown,
 * trading/backtest results -> results, status -> task, hypothesis -> hypothesis,
 * everything strategy-shaped -> strategy (with goal analyze/research when asked).
 */
export class FakeTurnInterpreter implements TurnInterpreterPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';

  async interpret(message: string): Promise<unknown> {
    return this.interpretSync(message);
  }

  /** Synchronous rule evaluation, exposed for deterministic unit tests. */
  interpretSync(message: string): unknown {
    return interpretByRules(message);
  }
}

function extractTimeframe(lower: string): string | undefined {
  // Match common timeframe tokens: 1m, 5m, 15m, 30m, 1h, 4h, 1d
  const m = lower.match(/\b(\d+m|\d+h|\d+d)\b/);
  return m ? m[1] : undefined;
}

function extractDirection(lower: string): 'long' | 'short' | undefined {
  if (lower.includes('лонг') || lower.includes('long')) return 'long';
  if (lower.includes('шорт') || lower.includes('short')) return 'short';
  return undefined;
}

function constraintsFor(lower: string): Record<string, unknown> {
  const timeframe = extractTimeframe(lower);
  const direction = extractDirection(lower);
  const constraints: Record<string, unknown> = {};
  if (timeframe !== undefined) constraints['timeframe'] = timeframe;
  if (direction !== undefined) constraints['direction'] = direction;
  return constraints;
}

function interpretByRules(message: string): unknown {
  const lower = message.toLowerCase();
  const has = (...ks: string[]): boolean => ks.some((k) => lower.includes(k));

  // Off-domain / meaningless -> unknown (the guard maps this to out_of_scope).
  if (has('погод', 'weather', 'новост', 'news', 'анекдот', 'joke', 'курс доллар', 'медицин')) {
    return { subject: 'unknown', constraints: {}, references: [], confidence: 0.95 };
  }

  // Trading / backtest results -> results (capability_not_available).
  if (has('торговл', 'торгов', 'trading', 'бэктест', 'бектест', 'backtest')) {
    return { subject: 'results', constraints: {}, references: [], confidence: 0.9 };
  }

  // Status question -> task (resolved via session pointer / reference).
  if (has('статус', 'status')) {
    return { subject: 'task', constraints: {}, references: [], confidence: 0.9 };
  }

  // Hypothesis build/backtest -> hypothesis (resolved via session).
  if (has('гипотез', 'hypothesis')) {
    return { subject: 'hypothesis', constraints: {}, references: [], confidence: 0.9 };
  }

  // Everything else is treated as a strategy turn. goal is research/analyze when asked.
  let goal: string | undefined;
  if (has('исследу', 'исследован', 'research')) goal = 'research';
  else if (has('проанализируй', 'analyze')) goal = 'analyze';

  return {
    subject: 'strategy',
    ...(goal !== undefined ? { goal } : {}),
    strategyText: message,
    constraints: constraintsFor(lower),
    references: [],
    confidence: 0.9,
  };
}
