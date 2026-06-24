import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraBuilder } from './mastra-builder.ts';

// A fake Agent whose generate returns a usage block; the object is irrelevant because
// onUsage must fire before (failing) schema parsing.
function fakeAgent(totalTokens: number): Agent {
  return { generate: async () => ({ object: {}, usage: { totalTokens } }) } as unknown as Agent;
}

describe('MastraBuilder onUsage', () => {
  it('reports result.usage.totalTokens before parsing', async () => {
    let recorded = -1;
    const adapter = new MastraBuilder(fakeAgent(123), 'm');
    await adapter.build({} as never, { onUsage: (t) => { recorded = t; } }).catch(() => {});
    expect(recorded).toBe(123);
  });
  it('coerces missing usage to 0', async () => {
    let recorded = -1;
    const agent = { generate: async () => ({ object: {} }) } as unknown as Agent;
    const adapter = new MastraBuilder(agent, 'm');
    await adapter.build({} as never, { onUsage: (t) => { recorded = t; } }).catch(() => {});
    expect(recorded).toBe(0);
  });
});
