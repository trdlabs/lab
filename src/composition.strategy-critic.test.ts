import { describe, it, expect } from 'vitest';
import { buildStrategyCritic } from './composition.ts';
import { loadEnv } from './config/env.ts';
import { composeMastra } from './mastra/compose-mastra.ts';

function envWith(over: Record<string, string>) {
  return loadEnv({ ...over } as unknown as NodeJS.ProcessEnv);
}

describe('buildStrategyCritic', () => {
  it('returns null when STRATEGY_PREFLIGHT_CRITIQUE is false (default)', () => {
    const env = envWith({});
    expect(buildStrategyCritic(env, composeMastra(env))).toBeNull();
  });

  it('returns a fake critic carrying the configured mode when enabled with the fake adapter', () => {
    const env = envWith({ STRATEGY_PREFLIGHT_CRITIQUE: 'true', STRATEGY_CRITIC_ADAPTER: 'fake', STRATEGY_CRITIC_MODE: 'single' });
    const c = buildStrategyCritic(env, composeMastra(env));
    expect(c?.adapter).toBe('fake');
    expect(c?.mode).toBe('single');
  });

  it('builds a two-stage mastra critic when enabled with adapter=mastra + two_stage', () => {
    const env = envWith({
      STRATEGY_PREFLIGHT_CRITIQUE: 'true', STRATEGY_CRITIC_ADAPTER: 'mastra', STRATEGY_CRITIC_MODE: 'two_stage',
      MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy',
    });
    const c = buildStrategyCritic(env, composeMastra(env));
    expect(c?.adapter).toBe('mastra');
    expect(c?.mode).toBe('two_stage');
  });

  it('builds a single-stage mastra critic when enabled with adapter=mastra + single', () => {
    const env = envWith({
      STRATEGY_PREFLIGHT_CRITIQUE: 'true', STRATEGY_CRITIC_ADAPTER: 'mastra', STRATEGY_CRITIC_MODE: 'single',
      MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy',
    });
    const c = buildStrategyCritic(env, composeMastra(env));
    expect(c?.adapter).toBe('mastra');
    expect(c?.mode).toBe('single');
  });
});
