import { describe, it, expect } from 'vitest';
import { buildStrategyUserMessage } from './strategy-user-message.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { BuildFeedback } from '../../ports/strategy-builder.port.ts';

const PROFILE: AnalystProfileOutput = {
  direction: 'long',
  coreIdea: 'Buy when open interest spikes above the 20-bar mean.',
  summary: 'A long-only strategy that enters when OI momentum is strong.',
  requiredMarketFeatures: ['oi', 'funding'],
  entryConditions: ['OI > 20-bar mean * 1.05', 'Price above EMA20'],
  exitConditions: ['Stop-loss at -2%', 'Take-profit at +4%'],
  timeframes: ['5m'],
  indicators: ['EMA20'],
  parameters: [{ name: 'oiMultiplier', value: 1.05, unit: null, description: 'OI threshold multiplier', tunable: true }],
  watchLifecycleSummary: 'Scan every bar for OI spike',
  positionManagementSummary: 'Partial exit at TP1',
  riskManagementSummary: 'Fixed stop at -2%',
  runnerOwnedAuthorities: ['position sizing', 'fills'],
  confidence: 0.8,
  unknowns: ['Slippage model'],
  evidence: ['OI spike precedes price move (backtested 3 months)'],
};

describe('buildStrategyUserMessage', () => {
  it('includes coreIdea in output', () => {
    const msg = buildStrategyUserMessage(PROFILE);
    expect(msg).toContain(PROFILE.coreIdea);
  });

  it('includes direction in output', () => {
    const msg = buildStrategyUserMessage(PROFILE);
    expect(msg).toContain('long');
  });

  it('includes entryConditions in output', () => {
    const msg = buildStrategyUserMessage(PROFILE);
    for (const cond of PROFILE.entryConditions) {
      expect(msg).toContain(cond);
    }
  });

  it('includes exitConditions in output', () => {
    const msg = buildStrategyUserMessage(PROFILE);
    for (const cond of PROFILE.exitConditions) {
      expect(msg).toContain(cond);
    }
  });

  it('includes a TASK instruction mentioning createStrategyModule', () => {
    const msg = buildStrategyUserMessage(PROFILE);
    expect(msg).toContain('createStrategyModule');
  });

  it('includes a TASK instruction mentioning the return shape', () => {
    const msg = buildStrategyUserMessage(PROFILE);
    expect(msg).toMatch(/manifest|source/i);
  });

  it('with validation feedback includes violations', () => {
    const feedback: BuildFeedback = { kind: 'validation', violations: ['missing onBarClose hook'] };
    const msg = buildStrategyUserMessage(PROFILE, feedback);
    expect(msg).toContain('missing onBarClose hook');
  });

  it('with parity feedback includes bar and field', () => {
    // bar=42 is chosen so '42' is not a substring of any other serialized number
    // (expected=100 / actual=95) — a vacuous toContain('5') would pass via '95'.
    const feedback: BuildFeedback = {
      kind: 'parity',
      diff: { bar: 42, field: 'pnl', expected: 100, actual: 95 },
    };
    const msg = buildStrategyUserMessage(PROFILE, feedback);
    expect(msg).toContain('42');
    expect(msg).toContain('pnl');
  });

  it('with parity feedback includes expected and actual values', () => {
    const feedback: BuildFeedback = {
      kind: 'parity',
      diff: { bar: 42, field: 'pnl', expected: 100, actual: 95 },
    };
    const msg = buildStrategyUserMessage(PROFILE, feedback);
    expect(msg).toContain('100');
    expect(msg).toContain('95');
  });

  it('without feedback has no feedback section', () => {
    const msg = buildStrategyUserMessage(PROFILE);
    expect(msg).not.toContain('FEEDBACK');
  });
});
