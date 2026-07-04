import { describe, it, expect } from 'vitest';
import { buildConsolidator } from './composition.ts';
import { loadEnv } from './config/env.ts';

describe('buildConsolidator — LLM-consolidation adapter selection (slice G3b)', () => {
  it('is off by default (null)', () => {
    expect(buildConsolidator(loadEnv({} as NodeJS.ProcessEnv))).toBeNull();
  });

  it('stays off even when LAB_AGENTS_ADAPTER=mastra (never routed through resolveAdapter)', () => {
    expect(buildConsolidator(loadEnv({ LAB_AGENTS_ADAPTER: 'mastra' } as unknown as NodeJS.ProcessEnv))).toBeNull();
  });

  it('wires the fake consolidator when CONSOLIDATOR_ADAPTER=fake', () => {
    const env = loadEnv({ CONSOLIDATOR_ADAPTER: 'fake' } as unknown as NodeJS.ProcessEnv);
    expect(buildConsolidator(env)?.adapter).toBe('fake');
  });

  it('wires the mastra consolidator when CONSOLIDATOR_ADAPTER=mastra with a resolvable model', () => {
    const env = loadEnv({
      CONSOLIDATOR_ADAPTER: 'mastra',
      CONSOLIDATOR_MODEL: 'anthropic/claude-sonnet-4-6',
      MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'dummy',
    } as unknown as NodeJS.ProcessEnv);
    expect(buildConsolidator(env)?.adapter).toBe('mastra');
  });
});
