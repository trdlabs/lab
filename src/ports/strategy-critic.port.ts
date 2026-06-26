import type { StrategyCriticInput, StrategyRefinement } from '../domain/strategy-critic.ts';
import type { AgentCallOpts } from './agent-call-opts.ts';
export type { AgentCallOpts };

export interface StrategyCriticPort {
  readonly adapter: 'fake' | 'mastra';
  readonly mode: 'single' | 'two_stage';
  readonly model: string;
  refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement>;
}
