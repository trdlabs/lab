import type { TaskQueuePort, QueueHandler } from '../../ports/task-queue.port.ts';
import type { QueueEnvelope } from '../../domain/types.ts';
import { routeTaskType, type QueueLane } from './route-task-type.ts';

export const DEFAULT_QUEUE_NAME = 'research-tasks';
export const REVISION_QUEUE_NAME = 'research-tasks-revision';

/**
 * TaskQueuePort that fans a single logical queue out to per-lane BullMQ queues.
 * enqueue routes by taskType; process registers ONE handler on every lane; close
 * closes all lanes and aggregates failures. No parameter properties (strip-types).
 */
export class RoutingQueueAdapter implements TaskQueuePort {
  private readonly lanes: Record<QueueLane, TaskQueuePort>;

  constructor(lanes: Record<QueueLane, TaskQueuePort>) {
    this.lanes = lanes;
  }

  async enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }): Promise<void> {
    await this.lanes[routeTaskType(envelope.taskType)].enqueue(envelope, opts);
  }

  // Registers the handler on each lane synchronously. A synchronous registration
  // failure of any lane propagates and fails boot; process() does NOT promise the
  // underlying Redis connection is ready — full async readiness is a later slice.
  process(handler: QueueHandler): void {
    for (const lane of Object.values(this.lanes)) lane.process(handler);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(Object.values(this.lanes).map((lane) => lane.close()));
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, 'RoutingQueueAdapter.close: one or more lanes failed to close');
    }
  }
}

export interface QueueLaneConfig {
  defaultConcurrency: number;
  revisionConcurrency: number;
  createLaneAdapter(queueName: string, workerConcurrency: number): TaskQueuePort;
}

/** Builds the lane map. The createLaneAdapter seam keeps this pure/testable (no Redis). */
export function buildQueueLanes(cfg: QueueLaneConfig): Record<QueueLane, TaskQueuePort> {
  return {
    default: cfg.createLaneAdapter(DEFAULT_QUEUE_NAME, cfg.defaultConcurrency),
    revision: cfg.createLaneAdapter(REVISION_QUEUE_NAME, cfg.revisionConcurrency),
  };
}
