import type { HypothesisReadPort } from '../ports/hypothesis-read.port.ts';
import type { BacktestReadPort } from '../ports/backtest-read.port.ts';
import type { AgentEventReadPort } from '../ports/agent-event-read.port.ts';
import type { AgentEventStreamPort } from '../ports/agent-event-stream.port.ts';
import type { AgentActivityProjection } from './projection.ts';

export interface ReadApiDeps {
  hypotheses: HypothesisReadPort;
  backtests: BacktestReadPort;
  agentEvents: AgentEventReadPort;
  projection: AgentActivityProjection;
  agentStream: AgentEventStreamPort;
  streamHeartbeatMs: number;
  checkReadiness: () => Promise<boolean>;
  token: string;
}
