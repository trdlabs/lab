import { describe, it, expect } from 'vitest';
import { normalizeTurnOutput } from './normalize-turn-output.ts';
import { TurnInterpretationSchema } from './turn-interpretation.ts';

describe('normalizeTurnOutput', () => {
  it('strips null values inside nested constraints object', () => {
    const raw = {
      subject: 'strategy',
      constraints: { market: null, timeframe: '1m', direction: null },
      references: [],
      confidence: 0.9,
    };
    const normalized = normalizeTurnOutput(raw);
    const parsed = TurnInterpretationSchema.parse(normalized);
    expect(parsed.subject).toBe('strategy');
    expect(parsed.constraints).toEqual({ timeframe: '1m' });
    expect('market' in parsed.constraints).toBe(false);
    expect('direction' in parsed.constraints).toBe(false);
  });

  it('strips top-level null optional fields (e.g. goal: null)', () => {
    const raw = {
      subject: 'strategy',
      goal: null,
      strategyText: 'buy low sell high',
      constraints: {},
      references: [],
      confidence: 0.8,
    };
    const normalized = normalizeTurnOutput(raw) as Record<string, unknown>;
    expect('goal' in normalized).toBe(false);
    const parsed = TurnInterpretationSchema.parse(normalized);
    expect(parsed.goal).toBeUndefined();
    expect(parsed.strategyText).toBe('buy low sell high');
  });

  it('passes through non-null constraint values intact', () => {
    const raw = {
      subject: 'strategy',
      goal: 'analyze',
      constraints: { market: 'crypto', timeframe: '5m', direction: 'long' },
      references: ['ref1'],
      confidence: 0.95,
    };
    const normalized = normalizeTurnOutput(raw);
    const parsed = TurnInterpretationSchema.parse(normalized);
    expect(parsed.constraints).toEqual({ market: 'crypto', timeframe: '5m', direction: 'long' });
    expect(parsed.goal).toBe('analyze');
    expect(parsed.references).toEqual(['ref1']);
  });

  it('preserves arrays without modification', () => {
    const raw = {
      subject: 'results',
      constraints: {},
      references: ['a', 'b'],
      confidence: 0.7,
    };
    const normalized = normalizeTurnOutput(raw);
    const parsed = TurnInterpretationSchema.parse(normalized);
    expect(parsed.references).toEqual(['a', 'b']);
  });

  it('returns non-object values unchanged', () => {
    expect(normalizeTurnOutput(null)).toBe(null);
    expect(normalizeTurnOutput(42)).toBe(42);
    expect(normalizeTurnOutput('string')).toBe('string');
    expect(normalizeTurnOutput([1, 2])).toEqual([1, 2]);
  });
});
