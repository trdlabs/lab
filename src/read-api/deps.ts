import type { HypothesisReadPort } from '../ports/hypothesis-read.port.ts';
import type { BacktestReadPort } from '../ports/backtest-read.port.ts';
import type { AgentEventReadPort } from '../ports/agent-event-read.port.ts';
import type { AgentEventStreamPort } from '../ports/agent-event-stream.port.ts';
import type { AgentActivityProjection } from './projection.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { TokenUsageRepository } from '../ports/token-usage.repository.ts';
import type { PhoenixTraceReader } from './phoenix/phoenix-trace-reader.ts';
import type { ExperimentReadPort } from '../ports/experiment-read.port.ts';

export interface ReadApiDeps {
  hypotheses: HypothesisReadPort;
  backtests: BacktestReadPort;
  agentEvents: AgentEventReadPort;
  projection: AgentActivityProjection;
  agentStream: AgentEventStreamPort;
  streamHeartbeatMs: number;
  checkReadiness: () => Promise<boolean>;
  token: string;
  // Read-only slice (findById) — keeps the read-API within its import boundary; composition passes the
  // full repositories, which satisfy these structurally.
  researchTasks: Pick<ResearchTaskRepository, 'findById'>;
  strategyProfiles: Pick<StrategyProfileRepository, 'findById'>;
  tokenUsage: Pick<TokenUsageRepository, 'getCost'>;
  phoenixTraces: Pick<PhoenixTraceReader, 'getAgentTraces'>;
  experiments: ExperimentReadPort;
}
