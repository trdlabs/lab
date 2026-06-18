import { describe, it, expect } from 'vitest';
import { parseIntent } from './guard.ts';

describe('parseIntent — provider null normalization', () => {
  it('treats null optional fields as absent before ChatIntentSchema validation', () => {
    const r = parseIntent({
      intent: 'help',
      confidence: 0.9,
      strategyText: null,
      hypothesisText: null,
      entityRef: null,
      taskIdHint: null,
      requestedOutcome: null,
      rationale: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.intent).toBe('help');
      expect(r.intent.strategyText).toBeUndefined();
    }
  });
});
