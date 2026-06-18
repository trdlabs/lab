import type { TurnInterpreterPort } from '../../ports/turn-interpreter.port.ts';

/**
 * Test / key-free-demo adapter only — NOT product logic. Keyword rules imitate the
 * LLM in key-free mode; the real path is MastraTurnInterpreter. Injection text is
 * ignored because rules match keywords, never instructions inside the message.
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

function interpretByRules(message: string): unknown {
  const lower = message.toLowerCase();

  const timeframe = extractTimeframe(lower);
  const direction = extractDirection(lower);

  // Build constraints (may contain undefined values — normalizeTurnOutput will clean up).
  const constraints: Record<string, unknown> = {};
  if (timeframe !== undefined) constraints['timeframe'] = timeframe;
  if (direction !== undefined) constraints['direction'] = direction;

  // Determine goal from explicit command verbs.
  let goal: string | undefined;
  if (lower.includes('проанализируй') || lower.includes('analyze')) {
    goal = 'analyze';
  } else if (lower.includes('исследуй') || lower.includes('research')) {
    goal = 'research';
  }

  return {
    subject: 'strategy',
    ...(goal !== undefined ? { goal } : {}),
    strategyText: message,
    constraints,
    references: [],
    confidence: 0.9,
  };
}
