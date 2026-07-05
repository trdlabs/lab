import { describe, it, expect } from 'vitest';
import { assembleStrategyBundle } from '../../domain/strategy-bundle.ts';
import { SHORT_AFTER_PUMP_META } from '../builder/fake-strategy-builder.ts';
import { FakeStrategyConsolidator } from './fake-strategy-consolidator.ts';

describe('FakeStrategyConsolidator', () => {
  it('produces an assemblable single-module strategy output', async () => {
    const c = new FakeStrategyConsolidator();
    const out = await c.consolidate({ stackedSource: 'irrelevant', manifestMeta: SHORT_AFTER_PUMP_META, mergedRuleSet: { order: [], rules: [] } });
    const bundle = await assembleStrategyBundle(out);
    expect(bundle.bundleHash).toMatch(/^sha256:/);
  });
});
