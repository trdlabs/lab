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
  it('accepts a string-valued parameter and defaults a missing unit to null', () => {
    const r = StrategyParameterSchema.safeParse({ name: 'mode', value: 'aggressive', description: 'x', tunable: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.unit).toBe(null);
  });
  it('defaults a missing value to null (no optional props -> strict-structured-output safe)', () => {
    const r = StrategyParameterSchema.safeParse({ name: 'mode', description: 'x', tunable: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.value).toBe(null);
  });
  it('defaults missing summaries to null (legacy profiles without these fields still parse)', () => {
    const legacy: Record<string, unknown> = { ...validOutput };
    delete legacy.watchLifecycleSummary;
    delete legacy.positionManagementSummary;
    delete legacy.riskManagementSummary;
    const r = AnalystProfileOutputSchema.safeParse(legacy);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.watchLifecycleSummary).toBe(null);
      expect(r.data.positionManagementSummary).toBe(null);
      expect(r.data.riskManagementSummary).toBe(null);
    }
  });
  it('exposes the contract version', () => {
    expect(STRATEGY_PROFILE_CONTRACT_VERSION).toBe('strategy-profile-v1');
  });
});
