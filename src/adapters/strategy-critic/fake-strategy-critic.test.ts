import { describe, it, expect } from 'vitest';
import { FakeStrategyCritic } from './fake-strategy-critic.ts';
import { StrategyRefinementSchema } from '../../domain/strategy-critic.ts';
import type { AgentCallUsage } from '../../ports/agent-call-opts.ts';

describe('FakeStrategyCritic', () => {
  it('reports adapter/model and the mode from its ctor', () => {
    expect(new FakeStrategyCritic().mode).toBe('two_stage');
    expect(new FakeStrategyCritic('single').mode).toBe('single');
    const f = new FakeStrategyCritic();
    expect(f.adapter).toBe('fake');
    expect(f.model).toBe('fake');
  });

  it('echoes input.content as improvedStrategyText and returns a schema-valid refinement', async () => {
    const f = new FakeStrategyCritic();
    const out = await f.refine({ kind: 'manual_description', content: 'short after a pump' });
    expect(StrategyRefinementSchema.safeParse(out).success).toBe(true);
    expect(out.improvedStrategyText).toBe('short after a pump');
  });

  it('forwards a zero-usage call to opts.onUsage', async () => {
    const seen: AgentCallUsage[] = [];
    const f = new FakeStrategyCritic();
    await f.refine({ kind: 'article', content: 'x' }, { onUsage: (u) => { seen.push(u); } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.totalTokens).toBe(0);
  });
});
