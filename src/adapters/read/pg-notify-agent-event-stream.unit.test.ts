// Fake-pool unit tests (no live DB) for the LISTEN-client lifecycle: leak on LISTEN
// failure, dead-socket destruction on client 'error', and the in-flight reconnect guard.
// The DB-gated integration test in pg-notify-agent-event-stream.test.ts covers delivery.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentEventReadPort } from '../../ports/agent-event-read.port.ts';
import { PgNotifyAgentEventStream } from './pg-notify-agent-event-stream.ts';

class FakeClient {
  handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  released: unknown[] = [];
  queries: string[] = [];
  listenShouldThrow = false;

  on(ev: string, cb: (...a: unknown[]) => void): this {
    (this.handlers[ev] ??= []).push(cb);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers[ev] ?? []) cb(...args);
  }
  async query(sql: string): Promise<{ rows: unknown[] }> {
    this.queries.push(sql);
    if (this.listenShouldThrow && sql.startsWith('LISTEN')) throw new Error('LISTEN failed');
    return { rows: [] };
  }
  release(arg?: unknown): void {
    this.released.push(arg ?? null);
  }
}

class FakePool {
  clients: FakeClient[] = [];
  connectCount = 0;
  configureNext?: (c: FakeClient) => void;

  async connect(): Promise<FakeClient> {
    this.connectCount += 1;
    const c = new FakeClient();
    this.configureNext?.(c);
    this.clients.push(c);
    return c;
  }
}

const emptyReader: AgentEventReadPort = { list: async () => [] } as unknown as AgentEventReadPort;
const makeStream = (pool: FakePool, reconnectMs = 1000) =>
  // deno-lint/ts: FakePool is structurally compatible with the narrow surface the stream uses.
  new PgNotifyAgentEventStream(pool as never, emptyReader, { safetyTickMs: 60_000, reconnectMs });

afterEach(() => { vi.useRealTimers(); });

describe('PgNotifyAgentEventStream — LISTEN-client lifecycle', () => {
  it('releases the checked-out client when LISTEN fails (no pool-connection leak)', async () => {
    const pool = new FakePool();
    pool.configureNext = (c) => { c.listenShouldThrow = true; };
    const stream = makeStream(pool);

    await expect(stream.start({ t: new Date().toISOString(), id: '' })).rejects.toThrow();

    expect(pool.clients).toHaveLength(1);
    expect(pool.clients[0]!.released).toHaveLength(1); // leaked (0) in the buggy version
    expect(pool.clients[0]!.released[0]).toBeInstanceOf(Error);
  });

  it("destroys the dead socket by passing the error to release() on a client 'error'", async () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    const stream = makeStream(pool, 100_000);
    await stream.start({ t: new Date().toISOString(), id: '' });

    const client = pool.clients[0]!;
    const err = new Error('connection terminated unexpectedly');
    client.emit('error', err);

    expect(client.released).toHaveLength(1);
    // node-pg destroys the client only when release() gets an Error or `true`; a bare
    // release() returns the dead socket to the idle pool.
    expect(client.released[0]).toBeTruthy();

    await stream.stop();
  });

  it('does not spawn a second connect when a client emits error twice before reconnect', async () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    const stream = makeStream(pool, 1000);
    await stream.start({ t: new Date().toISOString(), id: '' });

    const client = pool.clients[0]!;
    client.emit('error', new Error('first'));
    client.emit('error', new Error('second')); // must be ignored while a reconnect is in flight

    await vi.advanceTimersByTimeAsync(1000);

    expect(pool.connectCount).toBe(2); // initial + exactly one reconnect (3 in the buggy version)

    await stream.stop();
  });
});
