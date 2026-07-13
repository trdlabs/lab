import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerStreamRoutes } from './stream.ts';
import { encodeCursor } from '../pagination.ts';
import { InMemoryAgentEventReadAdapter } from '../../adapters/read/in-memory-agent-event-read.adapter.ts';
import { InMemoryAgentEventStream } from '../../adapters/read/in-memory-agent-event-stream.ts';
import type { AgentEventReadPort, AgentEventRow } from '../../ports/agent-event-read.port.ts';

const ev = (id: string, type: string): AgentEventRow => ({ id, taskId: 't1', type, payload: {}, createdAt: `2026-01-01T00:00:0${id}.000Z` });

// Read an open SSE response until `marker` appears (or N chunks), then abort.
async function readUntil(res: Response, marker: string, ac: AbortController): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (let i = 0; i < 50 && !buf.includes(marker); i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  ac.abort();
  await reader.cancel().catch(() => {});
  return buf;
}

function appWith(seed: AgentEventRow[], stream: InMemoryAgentEventStream, liveCursor: { t: string; id: string } | null = null): Hono {
  const app = new Hono();
  registerStreamRoutes(app, {
    agentEvents: new InMemoryAgentEventReadAdapter(seed),
    agentStream: stream,
    heartbeatMs: 60_000, // keep heartbeats out of the assertion window
    getLiveCursor: () => liveCursor,
  });
  return app;
}

describe('GET /stream (SSE)', () => {
  it('replays from an explicit ?cursor= as frames', async () => {
    const stream = new InMemoryAgentEventStream();
    await stream.start();
    const app = appWith([ev('1', 'researcher.started'), ev('2', 'researcher.completed')], stream);
    const before = encodeCursor({ t: '2026-01-01T00:00:00.000Z', id: 'a' }); // before e1 (earlier timestamp)
    const ac = new AbortController();
    const res = await app.request(`/stream?cursor=${encodeURIComponent(before)}`, { signal: ac.signal });
    const text = await readUntil(res, 'event: agent_event_appended', ac);
    expect(text).toContain('event: agent_status_changed');
    expect(text).toContain('event: agent_event_appended');
    expect(text).toContain('"agentId":"researcher"');
    expect(text).toMatch(/^id: /m); // appended frames carry a resumable keyset id
    await stream.stop();
  });

  it('defaults to the live tail — no history replay — and delivers live events', async () => {
    const stream = new InMemoryAgentEventStream();
    await stream.start();
    const seeded = ev('1', 'researcher.started');
    const app = appWith([seeded], stream, { t: seeded.createdAt, id: seeded.id }); // live cursor = newest seeded
    const ac = new AbortController();
    const res = await app.request('/stream', { signal: ac.signal });           // no resume token → live tail
    setTimeout(() => stream.push(ev('5', 'critic.failed')), 20);
    const text = await readUntil(res, 'critic', ac);
    expect(text).toContain('"agentId":"critic"');
    expect(text).toContain('"status":"failed"');
    expect(text).not.toContain('"agentId":"researcher"');                      // history NOT replayed
    await stream.stop();
  });

  it('stops replaying once the client has disconnected (does not page the whole table)', async () => {
    // P1-24: a disconnected client with an ancient ?cursor= must not force a full scan of agent_event.
    const stream = new InMemoryAgentEventStream();
    await stream.start();
    const ac = new AbortController();
    // Rows are OLDER than the resume cursor, so emit() dedups them (no writes) — the loop's only
    // stopping condition is then the abort check itself, isolating exactly what we're testing.
    const page = [ev('1', 'researcher.started'), ev('2', 'researcher.completed')];
    let calls = 0;
    const agentEvents = {
      list: async () => {
        calls += 1;
        if (calls === 1) ac.abort(); // client drops mid-replay, right after the first page
        return calls === 1 ? page : []; // a FULL page first (loop would continue), then empty
      },
    } as unknown as AgentEventReadPort;
    const app = new Hono();
    registerStreamRoutes(app, { agentEvents, agentStream: stream, heartbeatMs: 60_000, getLiveCursor: () => null, replayPageSize: page.length });
    const cursor = encodeCursor({ t: '2027-01-01T00:00:00.000Z', id: 'z' }); // after the rows → dedup, no writes
    const res = await app.request(`/stream?cursor=${encodeURIComponent(cursor)}`, { signal: ac.signal });
    res.body?.getReader().read().catch(() => {}); // kick the stream without blocking on it
    await new Promise((r) => setTimeout(r, 40)); // let the server callback settle
    await stream.stop();
    expect(calls).toBe(1); // broke on the abort check, not on the empty second page
  });
});
