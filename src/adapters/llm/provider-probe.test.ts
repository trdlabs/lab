// src/adapters/llm/provider-probe.test.ts
import { describe, it, expect } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

// Offline: building a provider model + a Mastra Agent does NOT hit the network.
// This proves the three providers construct and are assignable to Agent's `model`.
describe('provider probe (offline)', () => {
  it('anthropic model constructs and is Agent-assignable', () => {
    const model = createAnthropic({ apiKey: 'dummy' })('claude-sonnet-4-6');
    const agent = new Agent({ id: 'p-anthropic', name: 'p', instructions: 'x', model });
    expect(agent).toBeDefined();
  });

  it('openai model constructs and is Agent-assignable', () => {
    const model = createOpenAI({ apiKey: 'dummy' })('gpt-4o');
    const agent = new Agent({ id: 'p-openai', name: 'p', instructions: 'x', model });
    expect(agent).toBeDefined();
  });

  it('openrouter model constructs and is Agent-assignable', () => {
    const model = createOpenRouter({ apiKey: 'dummy' })('meta-llama/llama-3.1-70b-instruct');
    const agent = new Agent({ id: 'p-openrouter', name: 'p', instructions: 'x', model });
    expect(agent).toBeDefined();
  });
});
