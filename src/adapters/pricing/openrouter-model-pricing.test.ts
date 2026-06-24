import { describe, it, expect, vi } from 'vitest';
import { OpenRouterModelPricing } from './openrouter-model-pricing.ts';
import { NullModelPricing } from './null-model-pricing.ts';

const MODELS_BODY = {
  data: [
    { id: 'google/gemini-3.1-flash-lite', pricing: { prompt: '0.00000025', completion: '0.0000015' } },
    { id: 'anthropic/claude-sonnet-4.6', pricing: { prompt: '0.000003', completion: '0.000015' } },
  ],
};
function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
}

describe('OpenRouterModelPricing', () => {
  it('prices a model, stripping the openrouter/ prefix', async () => {
    const p = new OpenRouterModelPricing(fakeFetch(MODELS_BODY), () => 0);
    expect(await p.priceFor('openrouter/google/gemini-3.1-flash-lite'))
      .toEqual({ inputUsdPerToken: 0.00000025, outputUsdPerToken: 0.0000015 });
    expect(await p.priceFor('anthropic/claude-sonnet-4.6'))
      .toEqual({ inputUsdPerToken: 0.000003, outputUsdPerToken: 0.000015 });
  });

  it('returns null for an unknown model', async () => {
    const p = new OpenRouterModelPricing(fakeFetch(MODELS_BODY), () => 0);
    expect(await p.priceFor('made-up/model')).toBeNull();
  });

  it('caches within the TTL and re-fetches after it expires', async () => {
    const spy = vi.fn(fakeFetch(MODELS_BODY));
    let now = 0;
    const p = new OpenRouterModelPricing(spy as unknown as typeof fetch, () => now, 1000);
    await p.priceFor('google/gemini-3.1-flash-lite');
    await p.priceFor('google/gemini-3.1-flash-lite');
    expect(spy).toHaveBeenCalledTimes(1); // cached
    now = 1001;
    await p.priceFor('google/gemini-3.1-flash-lite');
    expect(spy).toHaveBeenCalledTimes(2); // TTL expired -> refetch
  });

  it('fail-soft: a non-ok response yields null and does not throw', async () => {
    const p = new OpenRouterModelPricing(fakeFetch({}, false), () => 0);
    expect(await p.priceFor('google/gemini-3.1-flash-lite')).toBeNull();
  });

  it('fail-soft: a thrown fetch yields null and does not throw', async () => {
    const throwing = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const p = new OpenRouterModelPricing(throwing, () => 0);
    expect(await p.priceFor('google/gemini-3.1-flash-lite')).toBeNull();
  });
});

describe('NullModelPricing', () => {
  it('always returns null', async () => {
    expect(await new NullModelPricing().priceFor('anything')).toBeNull();
  });
});
