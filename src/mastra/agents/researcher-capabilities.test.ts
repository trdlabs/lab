import { describe, it, expect } from 'vitest';
import { RESEARCHER_CAPABILITIES } from './researcher-capabilities.ts';
import { RESEARCHER_INSTRUCTIONS } from './researcher.agent.ts';

describe('RESEARCHER_CAPABILITIES', () => {
  it('lists the data dimensions and the indicator vocabulary', () => {
    for (const marker of ['open interest', 'liquidations', 'funding', 'taker', 'EMA', 'RSI', 'ATR', 'MACD', 'Bollinger', 'Stochastic', 'ADX', 'Fibonacci', 'Pivots', 'Squeeze', 'Pressure']) {
      expect(RESEARCHER_CAPABILITIES).toContain(marker);
    }
  });
  it('keeps the runner-owned execution guard', () => {
    expect(RESEARCHER_CAPABILITIES.toLowerCase()).toContain('runner-owned');
  });
});

describe('RESEARCHER_CAPABILITIES exit-quality framing', () => {
  it('frames the @entry/@exit/@post per-trade slices and exit-quality reasoning', () => {
    for (const marker of ['@entry', '@exit', '@post', 'exit quality', 'tighten_stop', 'widen_stop']) {
      expect(RESEARCHER_CAPABILITIES).toContain(marker);
    }
  });
});

describe('RESEARCHER_INSTRUCTIONS', () => {
  it('embeds the capability menu and keeps the falsifiable-hypothesis guidance', () => {
    expect(RESEARCHER_INSTRUCTIONS).toContain(RESEARCHER_CAPABILITIES);
    expect(RESEARCHER_INSTRUCTIONS).toContain('FALSIFIABLE');
  });
});
