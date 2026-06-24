import type { ModelPrice, ModelPricingPort } from '../../ports/model-pricing.port.ts';

/** No-op pricing: always "unknown". The default until OpenRouter pricing is wired. */
export class NullModelPricing implements ModelPricingPort {
  async priceFor(_modelId: string): Promise<ModelPrice | null> {
    return null;
  }
}
