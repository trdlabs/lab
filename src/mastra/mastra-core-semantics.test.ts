// src/mastra/mastra-core-semantics.test.ts
// Locks the @mastra/core runtime contract the Mastra composition layer relies on.
import { describe, it, expect } from 'vitest';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createAnthropic } from '@ai-sdk/anthropic';

function dummyAgent(id: string, name: string): Agent {
  const model = createAnthropic({ apiKey: 'dummy' })('claude-sonnet-4-6');
  return new Agent({ id, name, instructions: 'x', model });
}

describe('@mastra/core runtime semantics', () => {
  it('Agent exposes id and name', () => {
    const a = dummyAgent('researcher', 'Researcher');
    expect(a.id).toBe('researcher');
    expect(a.name).toBe('Researcher');
  });

  it('new Mastra({ agents }) registers and getAgent retrieves by map key', () => {
    const mastra = new Mastra({ agents: { researcher: dummyAgent('researcher', 'Researcher') } });
    const got = mastra.getAgent('researcher');
    expect(got).toBeDefined();
    expect(got.name).toBe('Researcher');
  });

  it('getAgent returns the same registered agent object (in-place wiring)', () => {
    const a = dummyAgent('researcher', 'Researcher');
    const mastra = new Mastra({ agents: { researcher: a } });
    expect(mastra.getAgent('researcher')).toBe(a);
  });

  it('supports an empty agents registry (all-fake path)', () => {
    expect(new Mastra({ agents: {} })).toBeDefined();
  });
});
