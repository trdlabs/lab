import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraCritic } from './mastra-critic.ts';

// A fake Agent whose generate returns a usage block; the object is irrelevant because
// onUsage must fire before (failing) schema parsing.
function fakeAgent(totalTokens: number): Agent {
  return { generate: async () => ({ object: {}, usage: { totalTokens } }) } as unknown as Agent;
}

describe('MastraCritic onUsage', () => {
  it('reports result.usage.totalTokens before parsing', async () => {
    let recorded = -1;
    const adapter = new MastraCritic(fakeAgent(789), 'm');
    await adapter.review({} as never, { onUsage: (t) => { recorded = t; } }).catch(() => {});
    expect(recorded).toBe(789);
  });
  it('coerces missing usage to 0', async () => {
    let recorded = -1;
    const agent = { generate: async () => ({ object: {} }) } as unknown as Agent;
    const adapter = new MastraCritic(agent, 'm');
    await adapter.review({} as never, { onUsage: (t) => { recorded = t; } }).catch(() => {});
    expect(recorded).toBe(0);
  });
});
