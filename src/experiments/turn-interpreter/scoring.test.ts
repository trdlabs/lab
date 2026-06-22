import { describe, it, expect } from 'vitest';
import { scoreCase, scoreRun, DEFAULT_THRESHOLD } from './scoring.ts';
import type { EvalCase } from './types.ts';

const C = (expect_: EvalCase['expect']): EvalCase => ({ id: 't', lang: 'en', message: 'm', expect: expect_ });

describe('scoreCase', () => {
  it('full marks on exact subject+goal+constraints', () => {
    const raw = { subject: 'strategy', goal: 'research', strategyText: 'x',
      constraints: { symbol: 'BTCUSDT', timeframe: '1h', direction: 'long' }, references: [], confidence: 0.9 };
    const r = scoreCase(raw, C({ subject: 'strategy', goal: 'research', hasStrategyText: true,
      constraints: { symbol: 'BTCUSDT', timeframe: '1h', direction: 'long' } }), 10);
    expect(r.schemaValid).toBe(true);
    expect(r.score).toBeCloseTo(1, 5);
  });

  it('normalizes symbol/timeframe before compare', () => {
    const raw = { subject: 'strategy', constraints: { symbol: 'btc/usdt' }, references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'strategy', constraints: { symbol: 'BTCUSDT' } }), 10);
    expect(r.fields.symbol).toBe(1);
  });

  it('scores strategyText by presence vs expectation', () => {
    const raw = { subject: 'strategy', constraints: {}, references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'strategy', hasStrategyText: false }), 10);
    expect(r.fields.strategyText).toBe(1);
  });

  it('goal:none rewards an absent goal', () => {
    const raw = { subject: 'unknown', constraints: {}, references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'unknown', goal: 'none' }), 10);
    expect(r.fields.goal).toBe(1);
  });

  it('applies the no-fabrication penalty', () => {
    const raw = { subject: 'strategy', constraints: { symbol: 'ETHUSDT' }, references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'strategy', absentConstraints: ['symbol'] }), 10);
    expect(r.fabricatedCount).toBe(1);
    expect(r.score).toBeCloseTo(Math.max(0, 1 - 0.25), 5); // only subject declared (→1), minus one fabrication
  });

  it('schema-invalid raw scores 0 with a best-effort subject', () => {
    const r = scoreCase({ subject: 'strategy', constraints: { bogus: 1 } }, C({ subject: 'strategy' }), 10);
    expect(r.schemaValid).toBe(false);
    expect(r.score).toBe(0);
    expect(r.subject).toBe('strategy');
  });

  it('normalizes weights over declared fields only (sparse case)', () => {
    const raw = { subject: 'bot', constraints: {}, references: [], confidence: 0.5 };
    const r = scoreCase(raw, C({ subject: 'bot' }), 10); // only subject declared
    expect(r.score).toBeCloseTo(1, 5);
  });
});

describe('scoreRun', () => {
  it('aggregates mean score + PASS/FAIL by threshold', () => {
    const good = scoreCase({ subject: 'bot', constraints: {}, references: [], confidence: 0.5 }, C({ subject: 'bot' }), 5);
    const bad = scoreCase({ subject: 'task', constraints: {}, references: [], confidence: 0.5 }, C({ subject: 'bot' }), 5);
    const res = scoreRun([good, bad], { threshold: DEFAULT_THRESHOLD });
    expect(res.subjectAccuracy).toBeCloseTo(0.5, 5);
    expect(res.verdict).toBe('FAIL');
  });
});
