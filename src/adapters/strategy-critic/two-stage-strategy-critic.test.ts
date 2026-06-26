import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { TwoStageStrategyCritic } from './two-stage-strategy-critic.ts';
import type { AgentCallUsage } from '../../ports/agent-call-opts.ts';

const critique = {
  vulnerabilities: ['no invalidation'],
  selfDeception: ['FOMO'],
  risks: { market: 'm', timing: 't', news: 'n', liquidity: 'l', btcRegime: 'b', exhaustion: 'e' },
  earlyBreakSigns: ['funding flip'],
  preEntryChecks: ['confirm OI'],
  verdict: { mainVulnerability: 'no stop', severity: 'high', badIdeaOrBadTiming: 'bad_timing', whatWouldStrengthen: 'add a regime filter' },
};
const delta = { improvedStrategyText: 'IMPROVED TEXT', changeLog: ['added regime filter', 'added invalidation'] };

describe('TwoStageStrategyCritic', () => {
  it('calls BOTH agents, accrues onUsage twice, and assembles the refinement', async () => {
    const seen: AgentCallUsage[] = [];
    let criticCalls = 0;
    let refinerCalls = 0;
    const criticAgent = {
      generate: async () => { criticCalls += 1; return { object: critique, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; },
    } as unknown as Agent;
    const refinerAgent = {
      generate: async () => { refinerCalls += 1; return { object: delta, usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } }; },
    } as unknown as Agent;

    const a = new TwoStageStrategyCritic(criticAgent, refinerAgent, 'critic-model', 'refiner-model');
    expect(a.mode).toBe('two_stage');
    const out = await a.refine({ kind: 'manual_description', content: 'short after a pump' }, { onUsage: (u) => { seen.push(u); } });

    expect(criticCalls).toBe(1);
    expect(refinerCalls).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.totalTokens).toBe(15);
    expect(seen[1]?.totalTokens).toBe(12);
    // each stage must report its OWN model id (refiner tokens must NOT be billed to the critic model)
    expect(seen[0]?.modelId).toBe('critic-model');
    expect(seen[1]?.modelId).toBe('refiner-model');
    expect(out.verdict.mainVulnerability).toBe('no stop'); // from the critique stage
    expect(out.improvedStrategyText).toBe('IMPROVED TEXT'); // from the refiner stage
    expect(out.changeLog).toEqual(['added regime filter', 'added invalidation']);
  });
});
