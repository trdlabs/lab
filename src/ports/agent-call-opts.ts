/** Token usage of one agent LLM call. inputTokens/outputTokens split enables $ pricing. */
export interface AgentCallUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Optional per-call hooks. onUsage reports the call's token usage (counts are 0 when unknown). */
export interface AgentCallOpts {
  onUsage?: (usage: AgentCallUsage) => void | Promise<void>;
  /** Custom metadata forwarded to the agent run's trace span — e.g. the market-context artifact id. */
  tracingMetadata?: Record<string, string | number | boolean>;
}
