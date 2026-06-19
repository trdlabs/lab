import { describe, it, expect } from 'vitest';
import { FakeTurnInterpreter } from './fake-turn-interpreter.ts';
import { normalizeTurnOutput } from '../../chat/normalize-turn-output.ts';
import { TurnInterpretationSchema } from '../../chat/turn-interpretation.ts';

function interpret(message: string) {
  const raw = new FakeTurnInterpreter().interpretSync(message);
  const normalized = normalizeTurnOutput(raw);
  return TurnInterpretationSchema.parse(normalized);
}

describe('FakeTurnInterpreter (rule-based)', () => {
  it('exposes adapter/model metadata', () => {
    const f = new FakeTurnInterpreter();
    expect(f.adapter).toBe('fake');
    expect(f.model).toBe('fake');
  });

  it('standalone strategy description → subject:strategy, goal:undefined, strategyText===message', () => {
    const message = 'Лонг на 1m свечах. Вход при росте open interest и падении цены. Стоп -10%.';
    const r = interpret(message);
    expect(r.subject).toBe('strategy');
    expect(r.goal).toBeUndefined();
    expect(r.strategyText).toBe(message);
    expect(r.references).toEqual([]);
    expect(r.confidence).toBe(0.9);
  });

  it('extracts timeframe from message (1m token)', () => {
    const message = 'Торгуем на таймфрейме 1m. Вход по открытому интересу.';
    const r = interpret(message);
    expect(r.constraints.timeframe).toBe('1m');
  });

  it('extracts timeframe from message (5m token)', () => {
    const message = 'Стратегия на 5m свечах с лонг позицией.';
    const r = interpret(message);
    expect(r.constraints.timeframe).toBe('5m');
  });

  it('extracts direction long from лонг keyword', () => {
    const message = 'Открываем лонг при пробое уровня.';
    const r = interpret(message);
    expect(r.constraints.direction).toBe('long');
  });

  it('extracts direction long from long keyword', () => {
    const message = 'Enter a long position on breakout.';
    const r = interpret(message);
    expect(r.constraints.direction).toBe('long');
  });

  it('extracts direction short from шорт keyword', () => {
    const message = 'Входим в шорт на пробое поддержки.';
    const r = interpret(message);
    expect(r.constraints.direction).toBe('short');
  });

  it('extracts direction short from short keyword', () => {
    const message = 'Enter a short position at resistance.';
    const r = interpret(message);
    expect(r.constraints.direction).toBe('short');
  });

  it('проанализируй эту стратегию: ... → goal:analyze', () => {
    const strategyPart = 'купить на дне и продать на вершине';
    const message = `проанализируй эту стратегию: ${strategyPart}`;
    const r = interpret(message);
    expect(r.subject).toBe('strategy');
    expect(r.goal).toBe('analyze');
  });

  it('исследуй ... → goal:research', () => {
    const message = 'исследуй эту стратегию: лонг при росте OI';
    const r = interpret(message);
    expect(r.subject).toBe('strategy');
    expect(r.goal).toBe('research');
  });

  it('async interpret returns the same shape', async () => {
    const message = 'Лонг на 1m. Вход при росте открытого интереса.';
    const raw = await new FakeTurnInterpreter().interpret(message);
    const normalized = normalizeTurnOutput(raw);
    const parsed = TurnInterpretationSchema.parse(normalized);
    expect(parsed.subject).toBe('strategy');
    expect(parsed.confidence).toBe(0.9);
  });
});
