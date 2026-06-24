/** Optional per-call hooks. onUsage reports the LLM token usage of this call (0 when unknown). */
export interface AgentCallOpts {
  onUsage?: (totalTokens: number) => void | Promise<void>;
}
