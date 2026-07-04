import type { StrategyBuilderOutput, StrategyManifestMeta } from './strategy-builder.port.ts';
import type { AgentCallOpts } from './agent-call-opts.ts';

export interface StrategyConsolidateArgs {
  readonly stackedSource: string;
  readonly manifestMeta: StrategyManifestMeta;
  readonly mergedRuleSet: Record<string, unknown>;
  readonly theses?: Record<string, string>;
}

export interface StrategyConsolidatorPort {
  readonly adapter: string;
  readonly model: string;
  consolidate(args: StrategyConsolidateArgs, opts?: AgentCallOpts): Promise<StrategyBuilderOutput>;
}
