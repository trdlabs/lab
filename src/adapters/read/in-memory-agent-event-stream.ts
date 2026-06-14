import type { AgentEventStreamPort } from '../../ports/agent-event-stream.port.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

export class InMemoryAgentEventStream implements AgentEventStreamPort {
  private readonly subs = new Set<(row: AgentEventRow) => void>();

  async start(): Promise<void> {} // optional resume cursor is ignored — the fake has no catch-up
  async stop(): Promise<void> { this.subs.clear(); }

  subscribe(onEvent: (row: AgentEventRow) => void): () => void {
    this.subs.add(onEvent);
    return () => { this.subs.delete(onEvent); };
  }

  // Test helper: simulate a new event arriving.
  push(row: AgentEventRow): void {
    for (const cb of [...this.subs]) cb(row);
  }
}
