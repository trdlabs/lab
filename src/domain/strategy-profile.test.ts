import { describe, it, expect } from 'vitest';
import { AnalystProfileOutputSchema, StrategyParameterSchema, STRATEGY_PROFILE_CONTRACT_VERSION } from './strategy-profile.ts';

const validOutput = {
  direction: 'long', coreIdea: 'buy dips', summary: 'long strat',
  requiredMarketFeatures: ['oi'], entryConditions: ['rsi<30'], exitConditions: ['rsi>70'],
  timeframes: ['1h'], indicators: ['rsi'],
  parameters: [{ name: 'rsiLen', value: 14, unit: null, description: 'RSI length', tunable: true }],
  watchLifecycleSummary: null, positionManagementSummary: null, riskManagementSummary: null,
  runnerOwnedAuthorities: ['fills'], confidence: 0.7, unknowns: [], evidence: ['line 3'],
};

describe('AnalystProfileOutputSchema', () => {
  it('accepts a complete valid output', () => {
    expect(AnalystProfileOutputSchema.safeParse(validOutput).success).toBe(true);
  });
  it('rejects confidence above 1', () => {
    expect(AnalystProfileOutputSchema.safeParse({ ...validOutput, confidence: 1.4 }).success).toBe(false);
  });
  it('rejects an unknown direction', () => {
    expect(AnalystProfileOutputSchema.safeParse({ ...validOutput, direction: 'sideways' }).success).toBe(false);
  });
  it('accepts a parameter with a string value and no unit', () => {
    const r = StrategyParameterSchema.safeParse({ name: 'mode', value: 'aggressive', description: 'x', tunable: false });
    expect(r.success).toBe(true);
  });
  it('exposes the contract version', () => {
    expect(STRATEGY_PROFILE_CONTRACT_VERSION).toBe('strategy-profile-v1');
  });
});
