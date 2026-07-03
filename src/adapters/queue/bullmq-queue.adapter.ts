import { Queue, Worker, type JobsOptions } from 'bullmq';
import type { QueueEnvelope } from '../../domain/types.ts';
import type { QueueHandler, TaskQueuePort } from '../../ports/task-queue.port.ts';

/** Parse a `redis://[user:pass@]host:port[/db]` URL into a plain options object
 *  that BullMQ accepts without triggering dual-ioredis-version type conflicts. */
function parseRedisUrl(url: string): { host: string; port: number; password?: string; db?: number } {
  const u = new URL(url);
  const opts: { host: string; port: number; password?: string; db?: number } = {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 6379,
  };
  if (u.password) opts.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db) {
    const parsed = parseInt(db, 10);
    if (Number.isInteger(parsed)) opts.db = parsed;
  }
  return opts;
}

/** BullMQ forbids ":" in a custom job id (it is BullMQ's internal Redis key
 *  separator). dedupeKeys use ":" as a convention separator (e.g. a chat proposal
 *  builds `chat-proposal:<id>`), so any dedupeKey used as a job id must be
 *  sanitized first — otherwise `Queue.add` throws "Custom Id cannot contain :".
 *  DB-level dedup (`findByDedupeKey`) keeps using the raw dedupeKey and is
 *  unaffected; this only rewrites the secondary BullMQ-level job id. */
export function toBullmqJobId(key: string): string {
  return key.replaceAll(':', '_');
}

export class BullMqQueueAdapter implements TaskQueuePort {
  private readonly queue: Queue<QueueEnvelope>;
  private readonly queueName: string;
  private readonly redisOpts: ReturnType<typeof parseRedisUrl>;
  private readonly workerConcurrency: number;
  private worker?: Worker<QueueEnvelope>;

  constructor(redisUrl: string, queueName = 'research-tasks', opts?: { workerConcurrency?: number }) {
    this.queueName = queueName;
    this.redisOpts = parseRedisUrl(redisUrl);
    const workerConcurrency = opts?.workerConcurrency ?? 1;
    if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1) {
      throw new Error(`BullMqQueueAdapter: workerConcurrency must be a positive integer, got ${workerConcurrency}`);
    }
    this.workerConcurrency = workerConcurrency;
    this.queue = new Queue<QueueEnvelope>(this.queueName, {
      connection: { ...this.redisOpts, maxRetriesPerRequest: null },
    });
  }

  async enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }): Promise<void> {
    const jobOpts: JobsOptions = {
      jobId: toBullmqJobId(envelope.dedupeKey ?? envelope.taskId),
      delay: opts?.delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    };
    await this.queue.add(envelope.taskType, envelope, jobOpts);
  }

  process(handler: QueueHandler): void {
    this.worker = new Worker<QueueEnvelope>(
      this.queueName,
      async (job) => { await handler(job.data); },
      { connection: { ...this.redisOpts, maxRetriesPerRequest: null }, concurrency: this.workerConcurrency },
    );
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
