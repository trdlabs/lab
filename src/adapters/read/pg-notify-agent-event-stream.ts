// Real stream source: one dedicated LISTEN client + keyset catch-up reads. NOTIFY is only
// a wake-up signal — the canonical rows (and ordering) come from AgentEventReadPort.
import type { Pool, PoolClient } from 'pg';
import type { AgentEventReadPort, AgentEventRow } from '../../ports/agent-event-read.port.ts';
import type { AgentEventStreamPort } from '../../ports/agent-event-stream.port.ts';
import type { Cursor } from '../../ports/keyset.ts';

const CHANNEL = 'trading_lab_agent_event';
const isAfter = (a: Cursor, b: Cursor): boolean => a.t > b.t || (a.t === b.t && a.id > b.id);

export interface PgNotifyOpts {
  safetyTickMs: number;
  pageSize?: number;
  reconnectMs?: number;
}

export class PgNotifyAgentEventStream implements AgentEventStreamPort {
  private client: PoolClient | null = null;
  private readonly subs = new Set<(row: AgentEventRow) => void>();
  private cursor: Cursor | undefined;
  private tick: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private stopped = false;
  private reconnecting = false;

  private readonly pool: Pool;
  private readonly reader: AgentEventReadPort;
  private readonly opts: PgNotifyOpts;

  constructor(pool: Pool, reader: AgentEventReadPort, opts: PgNotifyOpts) {
    this.pool = pool;
    this.reader = reader;
    this.opts = opts;
  }

  // startCursor = the projection's post-rebuild position; catch-up resumes AFTER it.
  // Falsy (null/undefined) → cursor stays unset (catch-up reads from the start of agent_event).
  async start(startCursor?: Cursor | null): Promise<void> {
    this.stopped = false;
    if (startCursor) this.cursor = startCursor;
    await this.connect();
    this.tick = setInterval(() => { void this.catchUp(); }, this.opts.safetyTickMs);
    await this.catchUp();
  }

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    try {
      client.on('notification', () => { void this.catchUp(); });
      client.on('error', (err: Error) => { this.reconnect(err); });
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
    } catch (err) {
      // LISTEN (or setup) failed — the client was checked out of the pool but never
      // became this.client, so nothing else will release it. Destroy it here (pass the
      // error so node-pg discards the socket) instead of leaking a pool connection.
      try { client.release(err instanceof Error ? err : true); } catch { /* ignore */ }
      throw err;
    }
  }

  private reconnect(err?: unknown): void {
    // Guard against overlapping reconnects: a broken client can emit 'error' more than
    // once, and each event must not spawn its own connect() cycle (which would leak all
    // but the last LISTEN client).
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    // Pass the error (or `true`) so node-pg destroys the dead socket rather than
    // returning it to the idle pool for the next query to trip over.
    try { this.client?.release(err instanceof Error ? err : true); } catch { /* ignore */ }
    this.client = null;
    setTimeout(() => {
      if (this.stopped) { this.reconnecting = false; return; }
      void this.connect()
        .then(() => { this.reconnecting = false; return this.catchUp(); })
        .catch(() => { this.reconnecting = false; this.reconnect(); });
    }, this.opts.reconnectMs ?? 1000);
  }

  private async catchUp(): Promise<void> {
    // A wake-up that arrives mid-drain is dropped here on purpose: the events it signals are
    // recovered by the next safety-tick catch-up (NOTIFY is a hint, not the data source).
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      const pageSize = this.opts.pageSize ?? 200;
      for (;;) {
        const rows = await this.reader.list({ after: this.cursor, limit: pageSize });
        if (rows.length === 0) break;
        for (const row of rows) {
          const k: Cursor = { t: row.createdAt, id: row.id };
          if (this.cursor && !isAfter(k, this.cursor)) continue;
          for (const cb of [...this.subs]) cb(row);
          this.cursor = k;
        }
        if (rows.length < pageSize) break;
      }
    } finally {
      this.draining = false;
    }
  }

  subscribe(onEvent: (row: AgentEventRow) => void): () => void {
    this.subs.add(onEvent);
    return () => { this.subs.delete(onEvent); };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    if (this.client) {
      try { await this.client.query(`UNLISTEN ${CHANNEL}`); } catch { /* ignore */ }
      this.client.release();
      this.client = null;
    }
    this.subs.clear();
  }
}
