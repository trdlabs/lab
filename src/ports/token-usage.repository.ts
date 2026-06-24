/**
 * Cumulative LLM token usage per research chain (correlationId). Retries run as separate
 * worker jobs sharing one correlationId, so the counter is persisted, not in-process.
 */
export interface TokenUsageRepository {
  /** Add tokens to the chain's cumulative total (creates the row on first call). */
  add(correlationId: string, tokens: number): Promise<void>;
  /** Cumulative tokens for the chain; 0 when no usage has been recorded yet. */
  get(correlationId: string): Promise<number>;
  /** Add USD cost to the chain's cumulative total (creates the row on first call). */
  addCost(correlationId: string, costUsd: number): Promise<void>;
  /** Cumulative USD cost for the chain; 0 when none recorded yet. */
  getCost(correlationId: string): Promise<number>;
}
