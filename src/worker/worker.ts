import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { WorkflowRouter } from '../orchestrator/workflow-router.ts';
import type { AppServices } from '../orchestrator/app-services.ts';
import { advanceChatPlan } from '../orchestrator/chain-runner.ts';

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
    // Idempotency fence + claim (P1-3): atomically move the task to 'running' only if it is not
    // already terminal. A stalled redelivery of a completed/rejected task fails the claim — ack it
    // without re-running the handler, or a crash between dispatch and ack would repeat the LLM cycle
    // (fresh fingerprints, a duplicate batch of hypotheses under the same correlationId).
    const claimed = await services.researchTasks.tryStartRun(task.id);
    if (!claimed) {
      await services.events.append({
        id: randomUUID(), taskId: task.id, type: 'task.redelivery_skipped',
        payload: { status: task.status }, createdAt: new Date().toISOString(),
      });
      return;
    }
    // The worker owns the generic lifecycle transition. Handlers signal success by
    // returning (failure by throwing); they do not set completed/failed themselves.
    try {
      await router.dispatch({ ...task, status: 'running' }, services);
      await services.researchTasks.updateStatus(task.id, 'completed');
      // Chat auto-chain: best-effort, internally guarded; never fails the worker.
      await advanceChatPlan({ ...task, status: 'completed' }, {
        researchTasks: services.researchTasks,
        strategyProfiles: services.strategyProfiles,
        events: services.events,
        sessions: services.chatSessions,
        plans: services.chatPlans,
        queue,
      });
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
  const { installProcessSafetyNet } = await import('../process-safety.ts');
  const { queue, router, services, pool } = composeRuntime();
  startWorker({ queue, router, services });
  console.log('worker started, consuming research-tasks');

  const shutdown = async (code = 0) => {
    await queue.close();
    await pool.end();
    process.exit(code);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  installProcessSafetyNet({ onFatal: () => { void shutdown(1); } });
}
