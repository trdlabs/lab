import { describe, it, expect } from 'vitest';
import { planDryRun } from './plan.ts';
import { buildCandidates } from './candidates.ts';

describe('planDryRun — round-trip', () => {
  it('counts analyst calls and reports the analyst provider key as missing, constructing nothing', () => {
    const candidates = buildCandidates({ mode: 'single', models: ['openai/gpt-x'] });
    const plan = planDryRun({
      candidates,
      cases: ['pump-short', 'dump-long'],
      judge: false,
      env: { OPENAI_API_KEY: 'present' }, // no OPENROUTER key present
      repeat: 2,
      roundTrip: true,
      analystModel: 'openrouter/x-ai/grok-4.3',
    });
    // 1 candidate × 2 cases × 2 repeat = 4 analyst calls
    expect(plan.analystCalls).toBe(4);
    expect(plan.missingKeys).toContain('OPENROUTER_API_KEY');
    expect(plan.missingKeys).not.toContain('OPENAI_API_KEY'); // present
  });

  it('reports zero analyst calls when round-trip is off', () => {
    const candidates = buildCandidates({ mode: 'single', models: ['anthropic/claude-x'] });
    const plan = planDryRun({ candidates, cases: ['pump-short'], judge: false, env: { ANTHROPIC_API_KEY: 'present' }, repeat: 1 });
    expect(plan.analystCalls).toBe(0);
  });
});

describe('planDryRun', () => {
  it('counts refine + judge paid calls and reports missing keys WITHOUT constructing real adapters', () => {
    const candidates = buildCandidates({ mode: 'two_stage', criticModels: ['anthropic/claude-x'], refinerModels: ['openai/gpt-x', 'anthropic/claude-y'] });
    const plan = planDryRun({
      candidates,
      cases: ['pump-short', 'dump-long'],
      judge: true,
      judgeModel: 'anthropic/claude-opus',
      env: { OPENROUTER_API_KEY: undefined }, // no anthropic/openai keys present
      repeat: 1,
    });
    // 2 candidates × 2 calls-per-run (critic+refiner) × 2 cases × 1 repeat = 8 refine calls
    expect(plan.refineCalls).toBe(8);
    // 2 candidates × 2 cases × 1 repeat = 4 judge calls
    expect(plan.judgeCalls).toBe(4);
    expect(plan.totalPaidCalls).toBe(12);
    expect(plan.perCandidate).toHaveLength(2);
    expect(plan.perCandidate[0]!.callsPerRun).toBe(2);
    expect(plan.missingKeys.sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  });

  it('single mode: one call per run; present key is not reported missing', () => {
    const candidates = buildCandidates({ mode: 'single', models: ['anthropic/claude-x'] });
    const plan = planDryRun({ candidates, cases: ['pump-short'], judge: false, env: { ANTHROPIC_API_KEY: 'present' }, repeat: 3 });
    expect(plan.perCandidate[0]!.callsPerRun).toBe(1);
    expect(plan.refineCalls).toBe(3); // 1 × 1 × 1 × 3
    expect(plan.judgeCalls).toBe(0);
    expect(plan.missingKeys).toEqual([]);
  });
});
