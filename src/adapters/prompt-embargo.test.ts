// src/adapters/prompt-embargo.test.ts
import { describe, it, expect } from 'vitest';
import { buildPrompt as researcherPrompt } from './researcher/mastra-researcher.ts';
import { buildPromptFor as builderPrompt } from './builder/mastra-builder.ts';
import { buildPrompt as criticPrompt } from './critic/mastra-critic.ts';
import { renderConsolidationPrompt } from './consolidator/mastra-strategy-consolidator.ts';
import { buildStrategyUserMessage } from './builder/strategy-user-message.ts';
import { buildPrompt as analystPrompt } from './analyst/mastra-strategy-analyst.ts';
import type { ResearcherInput } from '../ports/researcher.port.ts';
import type { StrategyProfile, AnalystProfileOutput } from '../domain/strategy-profile.ts';

const SENTINEL = 987654.321;
const EXTRAS = {
  holdoutValidation: { holdoutSharpe: SENTINEL, holdoutDecision: 'FAIL' },
  promotion: { verdict: 'passed' },
  evaluationWindow: { from: '2031-12-31', to: '2031-12-31' },
};

/** Minimal valid researcher input (mirrors mastra-researcher.test.ts baseInput). */
const researcherInput: ResearcherInput = {
  profile: {
    coreIdea: 'idea', direction: 'long', requiredMarketFeatures: [],
    profile: {
      summary: 'Enter after a dump when OI recovers.',
      entryConditions: ['Dump >=10%'], exitConditions: ['TP +3.5%'],
      parameters: [{ name: 'dump.minDropPct', value: 10, unit: '%', description: 'min dump', tunable: true }],
      positionManagementSummary: 'One position.', riskManagementSummary: 'Overlays only.',
      unknowns: [], evidence: [],
    },
  } as unknown as StrategyProfile,
  marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: {} },
  marketRegime: 'ranging',
  similarHypotheses: [],
  maxHypotheses: 2,
  focus: 'loss_reduction',
};

describe('outcome embargo — generation prompt builders are explicit projections', () => {
  it('researcher prompt ignores runtime embargo extras on profile and input', () => {
    const dirty = {
      ...researcherInput,
      ...EXTRAS,
      profile: { ...researcherInput.profile, ...EXTRAS } as unknown as StrategyProfile,
    } as ResearcherInput;
    expect(researcherPrompt(dirty)).toBe(researcherPrompt(researcherInput));
    expect(researcherPrompt(dirty)).not.toContain(String(SENTINEL));
  });

  it('hypothesis-builder prompt ignores runtime embargo extras', () => {
    const hypothesis = {
      id: 'h1', thesis: 't', targetBehavior: 'b',
      ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
      requiredFeatures: ['oi'], expectedEffect: { metric: 'win_rate', direction: 'increase' },
    };
    const profile = { direction: 'long', requiredMarketFeatures: ['oi'] };
    const clean = { hypothesis, profile, sdkDoc: 'SDK DOC' };
    const dirty = {
      hypothesis: { ...hypothesis, ...EXTRAS },
      profile: { ...profile, ...EXTRAS },
      sdkDoc: 'SDK DOC',
    };
    type BI = Parameters<typeof builderPrompt>[0];
    expect(builderPrompt(dirty as unknown as BI)).toBe(builderPrompt(clean as unknown as BI));
  });

  it('critic prompt ignores runtime embargo extras', () => {
    const clean = {
      proposal: {
        thesis: 't', targetBehavior: 'b',
        ruleAction: { appliesTo: 'long', rules: [] },
        validationPlan: 'p', invalidationCriteria: ['x'],
      },
      profile: { coreIdea: 'idea' },
    };
    const dirty = {
      proposal: { ...clean.proposal, ...EXTRAS },
      profile: { ...clean.profile, ...EXTRAS },
    };
    type CI = Parameters<typeof criticPrompt>[0];
    expect(criticPrompt(dirty as unknown as CI)).toBe(criticPrompt(clean as unknown as CI));
  });

  it('consolidation prompt ignores runtime embargo extras on args', () => {
    const clean = { stackedSource: 'export default function () {}', mergedRuleSet: { rules: [], theses: [] } };
    const dirty = { ...clean, ...EXTRAS };
    type AR = Parameters<typeof renderConsolidationPrompt>[0];
    expect(renderConsolidationPrompt(dirty as unknown as AR)).toBe(renderConsolidationPrompt(clean as unknown as AR));
  });

  it('strategy-builder user message ignores runtime embargo extras on the analyst profile', () => {
    // buildStrategyUserMessage(profile: AnalystProfileOutput, feedback?: BuildFeedback)
    const cleanAnalystProfile: AnalystProfileOutput = {
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
    const dirtyProfile = { ...cleanAnalystProfile, ...EXTRAS } as AnalystProfileOutput;
    expect(buildStrategyUserMessage(dirtyProfile)).toBe(buildStrategyUserMessage(cleanAnalystProfile));
    expect(buildStrategyUserMessage(dirtyProfile)).not.toContain(String(SENTINEL));
  });

  it('strategy-analyst prompt renders only the operator-supplied source (no outcome path)', () => {
    // StrategyAnalyst input = the raw strategy source the operator submitted (kind/title/uri/
    // content). It has no automated outcome-bearing input; this guard freezes that property.
    const clean = { kind: 'article', title: 'OI strategy', uri: 'memory://src', content: 'Buy on OI spike.' };
    const dirty = { ...clean, ...EXTRAS };
    type AI = Parameters<typeof analystPrompt>[0];
    expect(analystPrompt(dirty as unknown as AI)).toBe(analystPrompt(clean as unknown as AI));
    expect(analystPrompt(dirty as unknown as AI)).not.toContain(String(SENTINEL));
  });
});
