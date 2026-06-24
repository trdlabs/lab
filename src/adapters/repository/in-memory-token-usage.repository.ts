import type { TokenUsageRepository } from '../../ports/token-usage.repository.ts';

export class InMemoryTokenUsageRepository implements TokenUsageRepository {
  readonly #totals = new Map<string, number>();
  readonly #costs = new Map<string, number>();

  async add(correlationId: string, tokens: number): Promise<void> {
    this.#totals.set(correlationId, (this.#totals.get(correlationId) ?? 0) + tokens);
  }

  async get(correlationId: string): Promise<number> {
    return this.#totals.get(correlationId) ?? 0;
  }

  async addCost(correlationId: string, costUsd: number): Promise<void> {
    this.#costs.set(correlationId, (this.#costs.get(correlationId) ?? 0) + costUsd);
  }

  async getCost(correlationId: string): Promise<number> {
    return this.#costs.get(correlationId) ?? 0;
  }
}
