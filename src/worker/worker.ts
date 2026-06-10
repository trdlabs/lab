import { pathToFileURL } from 'node:url';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { WorkflowRouter } from '../orchestrator/workflow-router.ts';
import type { AppServices } from '../orchestrator/app-services.ts';

export interface WorkerDeps {
  queue: TaskQueuePort;
  router: WorkflowRouter;
  services: AppServices;
}

export function startWorker(deps: WorkerDeps): void {
  const { queue, router, services } = deps;
  queue.process(async (envelope) => {
    const task = await services.researchTasks.findById(envelope.taskId);
    if (!task) throw new Error(`research_task not found for envelope: ${envelope.taskId}`);
    // The worker owns the generic lifecycle transition. Handlers signal success by
    // returning (failure by throwing); they do not set completed/failed themselves.
    await services.researchTasks.updateStatus(task.id, 'running');
    try {
      await router.dispatch({ ...task, status: 'running' }, services);
      await services.researchTasks.updateStatus(task.id, 'completed');
    } catch (err) {
      // Best-effort: never let a failure to record 'failed' mask the original error.
      try {
        await services.researchTasks.updateStatus(task.id, 'failed');
      } catch {
        // swallow
      }
      throw err;
    }
  });
}

// Runtime entrypoint: `pnpm worker`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { composeRuntime } = await import('../composition.ts');
  const { queue, router, services, pool } = composeRuntime();
  startWorker({ queue, router, services });
  console.log('worker started, consuming research-tasks');

  const shutdown = async () => {
    await queue.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
