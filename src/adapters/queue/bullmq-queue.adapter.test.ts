import { describe, it, expect } from 'vitest';
import { BullMqQueueAdapter, toBullmqJobId } from './bullmq-queue.adapter.ts';
import type { QueueEnvelope } from '../../domain/types.ts';

// Pure unit — runs in CI without Redis (the integration block below is gated on REDIS_URL).
describe('toBullmqJobId', () => {
  it('replaces ":" (forbidden in BullMQ custom ids) so chat-proposal dedupeKeys are legal', () => {
    // Chat proposals build dedupeKey `chat-proposal:<id>`; BullMQ rejects ":" in a custom job id,
    // which crashed confirm -> enqueue with a 500 until this sanitization was added.
    expect(toBullmqJobId('chat-proposal:p1')).toBe('chat-proposal_p1');
  });
  it('leaves a colon-free id (e.g. a task UUID) untouched', () => {
    expect(toBullmqJobId('7202dc09-7083-4d54-8b59-483133e59461')).toBe('7202dc09-7083-4d54-8b59-483133e59461');
  });
  it('never returns a value containing ":"', () => {
    expect(toBullmqJobId('a:b:c')).not.toContain(':');
  });
});

const redisUrl = process.env.REDIS_URL;
const d = redisUrl ? describe : describe.skip;

const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 't1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

d('BullMqQueueAdapter (integration)', () => {
  it('delivers an enqueued envelope to the worker', async () => {
    const a = new BullMqQueueAdapter(redisUrl!, `test-${Date.now()}`);
    const received = new Promise<QueueEnvelope>((resolve) => {
      a.process(async (e) => { resolve(e); });
    });
    await a.enqueue(env({ taskId: 'x', dedupeKey: 'dk-1' }));
    const got = await received;
    expect(got.taskId).toBe('x');
    await a.close();
  });
});
