import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentEventReadPort, AgentEventRow } from '../../ports/agent-event-read.port.ts';
import type { AgentEventStreamPort } from '../../ports/agent-event-stream.port.ts';
import type { Cursor } from '../../ports/keyset.ts';
import type { AgentId, AgentLifecycle } from '../agent-taxonomy.ts';
import { agentIdForType } from '../agent-taxonomy.ts';
import { framesForEvent } from '../stream-frames.ts';
import { decodeCursor } from '../pagination.ts';

export interface StreamRouteDeps {
  agentEvents: AgentEventReadPort;
  agentStream: AgentEventStreamPort;
  heartbeatMs: number;
  getLiveCursor: () => Cursor | null; // projection.cursorKey(): default resume = live tail
  replayPageSize?: number;
}

const keyOf = (row: AgentEventRow): Cursor => ({ t: row.createdAt, id: row.id });
const isAfter = (a: Cursor, b: Cursor): boolean => a.t > b.t || (a.t === b.t && a.id > b.id);

export function registerStreamRoutes(app: Hono, deps: StreamRouteDeps): void {
  const pageSize = deps.replayPageSize ?? 200;

  app.get('/stream', (c) => {
    // Resume point: valid Last-Event-ID wins; else valid ?cursor=; else the live tail
    // (projection cursor) so a fresh client does NOT replay all history. A malformed
    // Last-Event-ID is ignored (fall through); a malformed explicit ?cursor= throws → 400.
    const headerId = c.req.header('last-event-id');
    const queryCursor = c.req.query('cursor');
    let after: Cursor | undefined;
    if (headerId) {
      try { after = decodeCursor(headerId); }
      catch { after = queryCursor ? decodeCursor(queryCursor) : (deps.getLiveCursor() ?? undefined); }
    } else if (queryCursor) {
      after = decodeCursor(queryCursor);
    } else {
      after = deps.getLiveCursor() ?? undefined;
    }

    return streamSSE(c, async (stream) => {
      const status = new Map<AgentId, AgentLifecycle>();
      let lastKey: Cursor | undefined = after;
      const signal = c.req.raw.signal;

      const emit = async (row: AgentEventRow): Promise<void> => {
        const k = keyOf(row);
        if (lastKey && !isAfter(k, lastKey)) return; // monotonic dedup (replay/live overlap)
        const agentId = agentIdForType(row.type);
        const { frames, status: s } = framesForEvent(status.get(agentId), row);
        status.set(agentId, s);
        for (const f of frames) {
          await stream.writeSSE({ event: f.event, data: JSON.stringify(f.data), ...(f.id ? { id: f.id } : {}) });
        }
        lastKey = k;
      };

      // 1) Subscribe live first; buffer until replay completes (gapless handover).
      const buffer: AgentEventRow[] = [];
      let live = false;
      let pumping = false;
      const pump = async (): Promise<void> => {
        if (pumping) return;
        pumping = true;
        // finally so a rejected emit (dead socket) can't leave pumping=true and wedge every later
        // pump() at the `if (pumping) return` guard.
        try {
          while (buffer.length) await emit(buffer.shift()!);
        } finally {
          pumping = false;
        }
      };
      // pump()'s writes can reject once the client socket closes. This is a fire-and-forget path
      // (a live event arriving), so swallow the rejection — an escaped one is an unhandled rejection
      // that, with the process safety net (P0-7), can be fatal. The abort listener below tears the
      // stream down cleanly.
      const unsub = deps.agentStream.subscribe((row) => { buffer.push(row); if (live) void pump().catch(() => {}); });

      let hb: ReturnType<typeof setInterval> | undefined;
      try {
        // 2) Replay from the resume cursor up to the current tail. Bail as soon as the client is
        //    gone, so a disconnected client with an ancient ?cursor= can't force a full-table scan.
        let cur = after;
        for (;;) {
          if (signal.aborted) break;
          const rows = await deps.agentEvents.list({ after: cur, limit: pageSize });
          if (rows.length === 0) break;
          for (const row of rows) await emit(row);
          cur = keyOf(rows[rows.length - 1]!);
          if (rows.length < pageSize) break;
        }
        // 3) Go live: drain anything buffered during replay, then stream live.
        live = true;
        await pump();

        // 4) Heartbeat + hold open until the client disconnects. The heartbeat write is fire-and-
        //    forget; swallow its rejection on a closed socket (same unhandled-rejection hazard as pump).
        hb = setInterval(() => { void stream.write(': ping\n\n').catch(() => {}); }, deps.heartbeatMs);
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        if (hb !== undefined) clearInterval(hb);
        unsub();
      }
    });
  });
}
