import { describe, it, expect } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDbClient } from '../../db/client.ts';
import { agentEvent, researchTask } from '../../db/schema.ts';
import { DrizzleAgentEventReadAdapter } from './drizzle-agent-event-read.adapter.ts';
import { PgNotifyAgentEventStream } from './pg-notify-agent-event-stream.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('PgNotifyAgentEventStream', () => {
  const { db, pool } = createDbClient(url!);
  const taskId = 'sp6task';
  const evId = 'sp6e1';

  it('delivers a freshly inserted agent_event to subscribers via NOTIFY', async () => {
    await db.delete(agentEvent).where(inArray(agentEvent.id, [evId]));
    await db.delete(researchTask).where(eq(researchTask.id, taskId));
    await db.insert(researchTask).values({ id: taskId, taskType: 'research.run_cycle', source: 'web', correlationId: 'corr-sp6', status: 'running', payload: {} });

    const stream = new PgNotifyAgentEventStream(pool, new DrizzleAgentEventReadAdapter(db), { safetyTickMs: 60_000 });
    const got: string[] = [];
    const received = new Promise<void>((resolve) => { stream.subscribe((r: AgentEventRow) => { got.push(r.id); resolve(); }); });
    await stream.start({ t: new Date().toISOString(), id: '' });

    await db.insert(agentEvent).values({ id: evId, taskId, type: 'researcher.started', payload: { secret: 'x' }, createdAt: new Date() });

    await Promise.race([received, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for NOTIFY')), 4000))]);
    expect(got).toContain(evId);

    await stream.stop();
    await db.delete(agentEvent).where(inArray(agentEvent.id, [evId]));
    await db.delete(researchTask).where(eq(researchTask.id, taskId));
    await pool.end();
  });
});
