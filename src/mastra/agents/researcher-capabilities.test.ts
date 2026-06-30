import { describe, it, expect } from 'vitest';
import { RESEARCHER_CAPABILITIES } from './researcher-capabilities.ts';
import { RESEARCHER_INSTRUCTIONS } from './researcher.agent.ts';
import {
  RESEARCHER_PROFIT_FRAMING, RESEARCHER_PROFILE_CRITICAL_FRAMING,
} from './researcher-capabilities.ts';

describe('RESEARCHER_CAPABILITIES', () => {
  it('lists the data dimensions and the indicator vocabulary', () => {
    for (const marker of ['open interest', 'liquidations', 'funding', 'taker', 'EMA', 'RSI', 'ATR', 'MACD', 'Bollinger', 'Stochastic', 'ADX', 'Fibonacci', 'Pivots', 'Squeeze', 'Pressure']) {
      expect(RESEARCHER_CAPABILITIES).toContain(marker);
    }
  });
  it('keeps the runner-owned execution guard', () => {
    expect(RESEARCHER_CAPABILITIES.toLowerCase()).toContain('runner-owned');
  });
  it('requires symbol-agnostic rules generalized to a regime, evidence in rationale not params', () => {
    expect(RESEARCHER_CAPABILITIES).toMatch(/GENERALIZE/);
    expect(RESEARCHER_CAPABILITIES).toMatch(/symbol-agnostic/);
    expect(RESEARCHER_CAPABILITIES).toMatch(/regime/);
    expect(RESEARCHER_CAPABILITIES).toMatch(/rationale/);
    expect(RESEARCHER_CAPABILITIES).toMatch(/keep `params` clean/);
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

describe('researcher capability framings', () => {
  it('profit framing names exit-improvement levers', () => {
    expect(RESEARCHER_PROFIT_FRAMING).toMatch(/take-profit|take profit/i);
    expect(RESEARCHER_PROFIT_FRAMING).toMatch(/trail/i);
    expect(RESEARCHER_PROFIT_FRAMING).toMatch(/@post|after exit|left on the table/i);
  });

  it('profile-critical framing permits relaxing/removing/replacing checks', () => {
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/relax|remove|replace/i);
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/allow_entry/);
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/no_op/);
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/not (only|just) add/i);
  });

  it('base capabilities still carry the runner-owned guard', () => {
    expect(RESEARCHER_CAPABILITIES).toMatch(/runner-owned/);
  });
});
