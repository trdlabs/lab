import { describe, it, expect } from 'vitest';
import { validateWithSchema } from './validator.ts';
import { QueueEnvelopeSchema } from '../domain/schemas.ts';

describe('validateWithSchema', () => {
  it('returns valid for conforming input', () => {
    const r = validateWithSchema(QueueEnvelopeSchema, {
      taskId: 't1', taskType: 'backtest.submit', correlationId: 'c1', source: 'platform', attempt: 1,
    });
    expect(r.status).toBe('valid');
    expect(r.issues).toEqual([]);
  });

  it('returns invalid with stable issue codes for bad input', () => {
    const r = validateWithSchema(QueueEnvelopeSchema, { taskId: '', taskType: 'nope', source: 'platform', attempt: 0 });
    expect(r.status).toBe('invalid');
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.every((i) => i.code === 'schema_violation' && i.severity === 'error')).toBe(true);
    // issues are sorted by path for determinism
    const paths = r.issues.map((i) => i.path);
    expect([...paths].sort()).toEqual(paths);
  });
});
