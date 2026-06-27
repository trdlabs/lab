import { describe, it, expect } from 'vitest';
import { validateStrategyBundle } from './strategy-bundle-validator.ts';
import { FakeStrategyBuilder } from '../adapters/builder/fake-strategy-builder.ts';
import { assembleStrategyBundle } from '../domain/strategy-bundle.ts';

describe('validateStrategyBundle', () => {
  it('clean shortAfterPump twin → valid', async () => {
    const out = await new FakeStrategyBuilder().build({ spec: {}, authoringDoc: '' });
    const a = await assembleStrategyBundle(out);
    expect(validateStrategyBundle(a)).toEqual({ status: 'valid' });
  });

  it('ambient authority (process.env + eval) → rejected, no throw', async () => {
    const out = await new FakeStrategyBuilder().build({ spec: {}, authoringDoc: '' });
    const a = await assembleStrategyBundle(out);
    const tainted = { ...a, source: `${a.source}\nconst leak = process.env.SECRET; eval('1');` };
    const v = validateStrategyBundle(tainted);
    expect(v.status).toBe('rejected');
    expect(v).toMatchObject({ reason: 'forbidden_ambient_authority' });
    expect(v.status === 'rejected' && v.violations.length).toBeGreaterThan(0);
  });
});
