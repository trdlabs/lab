// Калибровочное окно T2 (cc runbook battery-t2): порог trade_based-сплита должен быть
// переопределяем env'ом ОПЕРАТОРСКОГО скрипта — иначе 42-дневный срез (~32 сделки) никогда
// не достигает батареи (DEFAULT 50/30 требует 80). Прод-дефолт не меняется: без env — undefined.
import { describe, expect, it } from 'vitest';
import { holdoutPolicyFromEnv } from './holdout-policy-env.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../domain/research-experiment.ts';

describe('holdoutPolicyFromEnv', () => {
  it('без переменных → undefined (вызывающий падает на DEFAULT — поведение не меняется)', () => {
    expect(holdoutPolicyFromEnv({})).toBeUndefined();
  });
  it('переопределяет только заданные поля поверх DEFAULT', () => {
    const p = holdoutPolicyFromEnv({ HOLDOUT_MIN_TRADES_TRAIN: '20', HOLDOUT_MIN_TRADES_HOLDOUT: '10' });
    expect(p).toEqual({ ...DEFAULT_HOLDOUT_POLICY, minTradesTrain: 20, minTradesHoldout: 10 });
  });
  it('невалидное значение → бросает (fail-fast, а не тихий дефолт)', () => {
    expect(() => holdoutPolicyFromEnv({ HOLDOUT_MIN_TRADES_TRAIN: 'abc' })).toThrow(/HOLDOUT_MIN_TRADES_TRAIN/);
    expect(() => holdoutPolicyFromEnv({ HOLDOUT_MIN_TRADES_HOLDOUT: '0' })).toThrow(/HOLDOUT_MIN_TRADES_HOLDOUT/);
  });
});
