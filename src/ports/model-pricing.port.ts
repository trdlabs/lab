/** Per-token USD prices for one model. */
export interface ModelPrice {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
}

/** Resolves model pricing. priceFor returns null when the model is unknown or pricing is
 *  unavailable (fail-soft) — callers must treat null as "cost unknown", never as an error. */
export interface ModelPricingPort {
  priceFor(modelId: string): Promise<ModelPrice | null>;
}
