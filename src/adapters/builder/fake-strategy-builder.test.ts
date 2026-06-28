import { describe, it, expect } from 'vitest';
import { FakeStrategyBuilder } from './fake-strategy-builder.js';
import { SHORT_AFTER_PUMP_SOURCE } from './fixtures/short-after-pump.strategy-source.js';
import type { StrategyBuilderInput } from '../../ports/strategy-builder.port.js';

describe('FakeStrategyBuilder', () => {
  const builder = new FakeStrategyBuilder();
  const input = { spec: {}, authoringDoc: '' };

  it('build() returns SHORT_AFTER_PUMP_SOURCE', async () => {
    const result = await builder.build(input);
    expect(result.source).toBe(SHORT_AFTER_PUMP_SOURCE);
  });

  it('manifestMeta.id is short_after_pump', async () => {
    const result = await builder.build(input);
    expect(result.manifestMeta.id).toBe('short_after_pump');
  });

  it('manifestMeta.hooks includes onBarClose', async () => {
    const result = await builder.build(input);
    expect(result.manifestMeta.hooks).toContain('onBarClose');
  });

  // Enriched port — Task 1
  it('adapter is "fake"', () => {
    expect(builder.adapter).toBe('fake');
  });

  it('model is "fake"', () => {
    expect(builder.model).toBe('fake');
  });

  it('build() ignores profile/feedback/opts and returns fixed output', async () => {
    const enrichedInput: StrategyBuilderInput = {
      spec: {},
      authoringDoc: '',
      profile: undefined,
      feedback: undefined,
    };
    const result = await builder.build(enrichedInput, { onUsage: () => {} });
    expect(result.source).toBe(SHORT_AFTER_PUMP_SOURCE);
    expect(result.manifestMeta.id).toBe('short_after_pump');
  });
});
