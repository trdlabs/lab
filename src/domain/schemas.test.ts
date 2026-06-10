import { describe, it, expect } from 'vitest';
import { IngressTaskRequestSchema, QueueEnvelopeSchema } from './schemas.ts';

describe('IngressTaskRequestSchema', () => {
  it('accepts a valid request', () => {
    const r = IngressTaskRequestSchema.safeParse({
      taskType: 'strategy.onboard', source: 'web', payload: { foo: 1 },
    });
    expect(r.success).toBe(true);
  });
  it('rejects an unknown taskType', () => {
    const r = IngressTaskRequestSchema.safeParse({ taskType: 'nope', source: 'web', payload: {} });
    expect(r.success).toBe(false);
  });
  it('rejects an unknown source', () => {
    const r = IngressTaskRequestSchema.safeParse({ taskType: 'strategy.onboard', source: 'sms', payload: {} });
    expect(r.success).toBe(false);
  });
});

describe('QueueEnvelopeSchema', () => {
  it('round-trips a valid envelope', () => {
    const env = { taskId: 't1', taskType: 'backtest.submit', correlationId: 'c1', source: 'platform', attempt: 1 };
    expect(QueueEnvelopeSchema.parse(env)).toEqual(env);
  });
  it('rejects an envelope with attempt < 1 and a missing taskId', () => {
    const r = QueueEnvelopeSchema.safeParse({
      taskId: '', taskType: 'backtest.submit', correlationId: 'c1', source: 'platform', attempt: 0,
    });
    expect(r.success).toBe(false);
  });
});
