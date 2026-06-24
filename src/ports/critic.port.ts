import type { CriticInput, CriticOutput } from '../domain/critic.ts';

/** Optional per-call hooks. onUsage reports the LLM token usage of this call (0 when unknown). */
export interface AgentCallOpts {
  onUsage?: (totalTokens: number) => void | Promise<void>;
}

export interface CriticPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  review(input: CriticInput, opts?: AgentCallOpts): Promise<CriticOutput>;
}
