import { Hono } from 'hono';
import { IngressTaskRequestSchema } from '../domain/schemas.ts';
import { validateWithSchema } from '../validation/validator.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import { createAndEnqueueTask } from '../orchestrator/task-intake.ts';

export interface IngressDeps {
  repo: ResearchTaskRepository;
  queue: TaskQueuePort;
  /** SP-6.2: service-to-service token for POST /tasks (unset => 503). */
  taskToken?: string;
  /** SP-6.2: service-to-service token for POST /callbacks/backtest-completed (unset => 503). */
  callbackToken?: string;
}

export function createIngressApp(deps: IngressDeps): Hono {
  const app = new Hono();

  app.post('/tasks', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const validation = validateWithSchema(IngressTaskRequestSchema, raw);
    if (validation.status === 'invalid') {
      return c.json({ status: 'rejected', issues: validation.issues }, 400);
    }
    const req = validation.data;

    const result = await createAndEnqueueTask(
      {
        taskType: req.taskType,
        source: req.source,
        payload: req.payload,
        correlationId: req.correlationId,
        dedupeKey: req.dedupeKey,
      },
      deps,
    );

    return c.json({ taskId: result.taskId, status: result.status }, 202);
  });

  // SP-1 stub: resume callback endpoint. Real suspend/resume wiring lands in SP-4/SP-5.
  app.post('/callbacks/backtest-completed', (c) => c.json({ status: 'accepted' }, 202));

  return app;
}
