import type { CriticInput, CriticOutput } from '../domain/critic.ts';

import type { AgentCallOpts } from './agent-call-opts.ts';
export type { AgentCallOpts };

export interface CriticPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  review(input: CriticInput, opts?: AgentCallOpts): Promise<CriticOutput>;
}
