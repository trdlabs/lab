import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { Gate1Output, ProfileParam, ResultInterpretOutput, SweepDesignOutput } from '../domain/wfo.ts';
import type { RankedPoint } from '../research/top-n-prefilter.ts';

import type { AgentCallOpts } from './agent-call-opts.ts';
import type { BacktestMetricBlock } from './platform-gateway.port.ts';
export type { AgentCallOpts };

export interface Gate1Input {
  profile: StrategyProfile;
  baselineMetrics: BacktestMetricBlock;
  entryAffecting: string[];
  hasEntrySignalEvidence: boolean;
}

export interface SweepInput {
  profile: StrategyProfile;
  baselineTrainSummary: BacktestMetricBlock;
  tunableParams: ProfileParam[];
  restrictToEntryParams: boolean;
  maxPoints: number;
}

export interface InterpretInput {
  topN: RankedPoint[];
  roundsSoFar: number;
  maxRounds: number;
}

export interface Gate1DecisionPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  decide(input: Gate1Input, opts?: AgentCallOpts): Promise<Gate1Output>;
}

export interface SweepDesignerPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  design(input: SweepInput, opts?: AgentCallOpts): Promise<SweepDesignOutput>;
}

export interface ResultInterpreterPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  interpret(input: InterpretInput, opts?: AgentCallOpts): Promise<ResultInterpretOutput>;
}
