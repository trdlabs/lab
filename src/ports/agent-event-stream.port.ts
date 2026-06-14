import type { AgentEventRow } from './agent-event-read.port.ts';
import type { Cursor } from './keyset.ts';

// A source of agent_event rows in keyset order. Lifecycle is part of the contract so
// composition/shutdown/reconnect are explicit, not implementation detail. start() takes
// an optional resume cursor (the projection's post-rebuild position) so catch-up begins
// AFTER what has already been applied — not from the beginning of agent_event. subscribe()
// supports multiple subscribers (the projection + each live SSE connection).
export interface AgentEventStreamPort {
  start(startCursor?: Cursor | null): Promise<void>;
  stop(): Promise<void>;
  subscribe(onEvent: (row: AgentEventRow) => void): () => void; // returns unsubscribe
}
