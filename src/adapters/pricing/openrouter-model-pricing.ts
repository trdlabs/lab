import type { ModelPrice, ModelPricingPort } from '../../ports/model-pricing.port.ts';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

interface ModelsResponse { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> }

/**
 * Prices models from OpenRouter's public /models catalogue (no auth). Fetched once, cached
 * with a TTL, fail-soft: any fetch/parse failure or an unknown id resolves to null so a run
 * never breaks on a pricing miss. fetch + clock are injected for deterministic tests.
 */
export class OpenRouterModelPricing implements ModelPricingPort {
  private readonly fetchFn: typeof fetch;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private cache: Map<string, ModelPrice> | null = null;
  private fetchedAtMs = 0;

  constructor(fetchFn: typeof fetch = fetch, clock: () => number = () => Date.now(), ttlMs: number = DEFAULT_TTL_MS) {
    this.fetchFn = fetchFn;
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  async priceFor(modelId: string): Promise<ModelPrice | null> {
    const map = await this.#ensureCache();
    if (!map) return null;
    const key = modelId.startsWith('openrouter/') ? modelId.slice('openrouter/'.length) : modelId;
    return map.get(key) ?? null;
  }

  async #ensureCache(): Promise<Map<string, ModelPrice> | null> {
    const now = this.clock();
    if (this.cache && now - this.fetchedAtMs < this.ttlMs) return this.cache;
    try {
      const res = await this.fetchFn(OPENROUTER_MODELS_URL, { method: 'GET' });
      if (!res.ok) return this.cache; // keep any prior cache; otherwise null
      const body = (await res.json()) as ModelsResponse;
      const map = new Map<string, ModelPrice>();
      for (const m of body.data ?? []) {
        if (!m.id || !m.pricing) continue;
        const inP = Number.parseFloat(m.pricing.prompt ?? '');
        const outP = Number.parseFloat(m.pricing.completion ?? '');
        if (Number.isFinite(inP) && Number.isFinite(outP)) {
          map.set(m.id, { inputUsdPerToken: inP, outputUsdPerToken: outP });
        }
      }
      this.cache = map;
      this.fetchedAtMs = now;
      return map;
    } catch {
      return this.cache; // fail-soft: null on first failure, stale cache thereafter
    }
  }
}
