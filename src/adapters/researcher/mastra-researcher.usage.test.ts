import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraResearcher } from './mastra-researcher.ts';

// A fake Agent whose generate returns a usage block; the object is irrelevant because
// onUsage must fire before (failing) schema parsing.
function fakeAgent(totalTokens: number): Agent {
  return { generate: async () => ({ object: {}, usage: { totalTokens } }) } as unknown as Agent;
}

describe('MastraResearcher onUsage', () => {
  it('reports result.usage.totalTokens before parsing', async () => {
    let recorded = -1;
    const adapter = new MastraResearcher(fakeAgent(456), 'm');
    await adapter.propose({} as never, { onUsage: (t) => { recorded = t; } }).catch(() => {});
    expect(recorded).toBe(456);
  });
  it('coerces missing usage to 0', async () => {
    let recorded = -1;
    const agent = { generate: async () => ({ object: {} }) } as unknown as Agent;
    const adapter = new MastraResearcher(agent, 'm');
    await adapter.propose({} as never, { onUsage: (t) => { recorded = t; } }).catch(() => {});
    expect(recorded).toBe(0);
  });
});
