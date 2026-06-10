import type { AgentTaskType, ResearchTask } from '../domain/types.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';

export interface HandlerDeps {
  repo: ResearchTaskRepository;
}

export type WorkflowHandler = (task: ResearchTask, deps: HandlerDeps) => Promise<void>;

export class WorkflowRouter {
  private readonly handlers = new Map<AgentTaskType, WorkflowHandler>();

  register(taskType: AgentTaskType, handler: WorkflowHandler): void {
    // Fail loudly on double-registration rather than silently overwriting — a
    // duplicate registration during composition almost always indicates a bug.
    if (this.handlers.has(taskType)) {
      throw new Error(`handler already registered for task type: ${taskType}`);
    }
    this.handlers.set(taskType, handler);
  }

  async dispatch(task: ResearchTask, deps: HandlerDeps): Promise<void> {
    const handler = this.handlers.get(task.taskType);
    if (!handler) throw new Error(`no handler registered for task type: ${task.taskType}`);
    await handler(task, deps);
  }
}
