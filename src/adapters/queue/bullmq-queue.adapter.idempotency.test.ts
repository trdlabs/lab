import { describe, it, expect, afterEach } from 'vitest';
import { Queue } from 'bullmq';
import { BullMqQueueAdapter, toBullmqJobId } from './bullmq-queue.adapter.ts';
import type { QueueEnvelope } from '../../domain/types.ts';

const redisUrl = process.env.REDIS_URL;
const d = redisUrl ? describe : describe.skip;

// Test-local Redis connection parser — do NOT reach into the adapter's private redisOpts.
function redisConnection(url: string): { host: string; port: number; password?: string; db?: number } {
  const u = new URL(url);
  const conn: { host: string; port: number; password?: string; db?: number } = {
    host: u.hostname, port: u.port ? parseInt(u.port, 10) : 6379,
  };
  if (u.password) conn.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db && Number.isInteger(parseInt(db, 10))) conn.db = parseInt(db, 10);
  return conn;
}

// Unique per-run queue name so parallel/CI runs never collide; mandatory cleanup.
const QUEUE = `p1-1-idem-${process.pid}-${Date.now()}`;

d('BullMqQueueAdapter jobId idempotency (P1-1)', () => {
  let adapter: BullMqQueueAdapter | undefined;
  let inspect: Queue | undefined;

  afterEach(async () => {
    await adapter?.close();
    await inspect?.obliterate({ force: true }).catch(() => {});
    await inspect?.close();
    adapter = undefined;
    inspect = undefined;
  });

  async function activeCount(): Promise<number> {
    inspect = new Queue(QUEUE, { connection: redisConnection(redisUrl!) });
    return inspect.getJobCountByTypes('waiting', 'delayed', 'active');
  }

  it('same envelope WITH a dedupeKey twice → a single job (jobId = sanitized dedupeKey)', async () => {
    adapter = new BullMqQueueAdapter(redisUrl!, QUEUE);
    const env: QueueEnvelope = { taskId: 't-idem', taskType: 'strategy.onboard', correlationId: 'c', source: 'web', attempt: 1, dedupeKey: 'chat-proposal:p1' };
    await adapter.enqueue(env);
    await adapter.enqueue(env); // reconciliation re-enqueue of an already-active job
    expect(await activeCount()).toBe(1);
    expect(await inspect!.getJob(toBullmqJobId('chat-proposal:p1'))).toBeTruthy();
  });

  it('same KEYLESS envelope twice → a single job (jobId falls back to taskId)', async () => {
    adapter = new BullMqQueueAdapter(redisUrl!, QUEUE);
    const env: QueueEnvelope = { taskId: 't-keyless', taskType: 'strategy.onboard', correlationId: 'c', source: 'web', attempt: 1, dedupeKey: undefined };
    await adapter.enqueue(env);
    await adapter.enqueue(env);
    expect(await activeCount()).toBe(1);
    expect(await inspect!.getJob(toBullmqJobId('t-keyless'))).toBeTruthy();
  });
});
