import type { CreateModuleManifestInput } from '@trading-backtester/sdk/builder';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { AgentCallOpts } from './agent-call-opts.ts';

/** Strategy authoring request — describes what to build; unused by FakeStrategyBuilder. */
export interface StrategyAuthoringSpec {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
}

/** Required inputs for createModuleManifest minus `kind` (supplied by Task 4 as 'strategy'). */
export type StrategyManifestMeta = Omit<CreateModuleManifestInput, 'kind'>;

/** Feedback from a previous build attempt: validation violations or parity diff. */
export type BuildFeedback =
  | { kind: 'validation'; violations: string[] }
  | { kind: 'parity'; diff: { bar: number; field: string; expected: unknown; actual: unknown } };

export interface StrategyBuilderInput {
  readonly spec: StrategyAuthoringSpec;
  readonly authoringDoc: string;
  readonly profile?: StrategyProfile;
  readonly feedback?: BuildFeedback;
}

export interface StrategyBuilderOutput {
  readonly source: string;
  readonly manifestMeta: StrategyManifestMeta;
}

export interface StrategyBuilder {
  readonly adapter: string;
  readonly model: string;
  build(i: StrategyBuilderInput, opts?: AgentCallOpts): Promise<StrategyBuilderOutput>;
}
