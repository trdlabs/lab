import { Hono } from 'hono';
import { IngressTaskRequestSchema } from '../domain/schemas.ts';
import { BacktestCompletionCallbackSchema } from '../domain/backtest-callback.schema.ts';
import { validateWithSchema } from '../validation/validator.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import { createAndEnqueueTask } from '../orchestrator/task-intake.ts';
import { bearerAuth } from '../auth/bearer-auth.ts';
import { callbackBearerAuth } from '../auth/callback-auth.ts';
import { handleBacktestCompletionCallback } from './handle-backtest-callback.ts';

export interface IngressDeps {
  repo: ResearchTaskRepository;
  queue: TaskQueuePort;
  /** SP-6.2: service-to-service token for POST /tasks (unset => 503). */
  taskToken?: string;
  /** SP-6.2: service-to-service token for POST /callbacks/backtest-completed (unset => 503). */
  callbackToken?: string;
  /** Lookup a persisted run by platform/backtester run id (webhook path). */
  findRunByPlatformRunId?: (platformRunId: string) => Promise<BacktestRun | null>;
}

export function createIngressApp(deps: IngressDeps): Hono {
  const app = new Hono();

  // Always-on liveness probe on the ingress port. The container healthcheck must target this
  // (not the read API's /readyz on :3100, which only starts when TRADING_LAB_READ_TOKEN is set —
  // an unset token otherwise wedges the container 'unhealthy' and blocks office's depends_on).
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // SP-6.2: fail-closed, per-boundary service-token gates, registered BEFORE the handlers
  // so unauthorized requests never reach JSON parsing / validation / task intake.
  app.use('/tasks', bearerAuth(deps.taskToken, { notConfiguredMessage: 'task ingress not configured' }));
  app.use(
    '/callbacks/backtest-completed',
    callbackBearerAuth(deps.callbackToken, { notConfiguredMessage: 'callback ingress not configured' }),
  );

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

  app.post('/callbacks/backtest-completed', async (c) => {
    if (!deps.findRunByPlatformRunId) {
      return c.json({ error: { code: 'service_unavailable', message: 'callback handler not configured' } }, 503);
    }
    const raw = await c.req.json().catch(() => null);
    const validation = validateWithSchema(BacktestCompletionCallbackSchema, raw);
    if (validation.status === 'invalid') {
      return c.json({ status: 'rejected', issues: validation.issues }, 400);
    }
    const result = await handleBacktestCompletionCallback(validation.data, {
      repo: deps.repo,
      queue: deps.queue,
      findRunByPlatformRunId: deps.findRunByPlatformRunId,
    });
    return c.json(result, 202);
  });

  return app;
}
