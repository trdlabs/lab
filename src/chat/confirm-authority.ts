import type { ActionProposal } from '../domain/action-proposal.ts';

/**
 * Authority boundary for chat confirmations (SEC-O4).
 *
 * A confirmation is the one place where an operator turn crosses from talking into launching
 * work, and the caller on the other side of `/chat/confirm` — trading-office — cannot make this
 * decision: the DTO it holds carries only an opaque `pendingInteractionId`, never the class of
 * action behind it. The real `ActionProposal` lives here, so the check lives here too.
 *
 * The lists are ALLOWLISTS, deliberately: an action or task type that is not named below is
 * refused, including one added later. That is the point — a future execution-capable proposal
 * (`paper.start` and friends already exist in AGENT_TASK_TYPES) must not become confirmable by
 * a chat turn just because someone taught the planner to propose it. Widening the boundary has
 * to be a deliberate edit to this file, reviewed as such.
 *
 * This is not a restatement of a schema check. A proposal is rehydrated from a JSONB column, so
 * `action` / `task.taskType` / `task.chain` are untrusted strings at runtime whatever their
 * compile-time types claim.
 */

/** Research-side actions a chat confirmation may launch. */
export const CONFIRMABLE_ACTIONS: readonly string[] = [
  'strategy.analyze',
  'research.run_cycle',
  'hypothesis.build',
  'backtest.run',
];

/** Task types the chat planner is allowed to enqueue on confirmation. */
export const CONFIRMABLE_TASK_TYPES: readonly string[] = ['strategy.onboard', 'hypothesis.build'];

/** Follow-up task types a confirmed proposal may chain into. */
export const CONFIRMABLE_CHAIN_TASK_TYPES: readonly string[] = ['research.run_cycle', 'strategy.baseline'];

/**
 * Thrown when a proposal asks for more authority than a chat confirmation carries. Callers map
 * it to a typed 403; `reason` is a stable code, and the message names only the refused type —
 * never the payload.
 */
export class ExecutionAuthorityError extends Error {
  readonly reason = 'execution_authority_denied';

  constructor(message: string) {
    super(message);
    this.name = 'ExecutionAuthorityError';
  }
}

/**
 * Refuses a proposal that exceeds chat-confirmation authority. Performs NO side effects and
 * touches no repository: callers must run it BEFORE confirming the proposal, so a refusal
 * leaves the proposal pending rather than burning it.
 */
export function assertConfirmableProposal(proposal: ActionProposal): void {
  if (!CONFIRMABLE_ACTIONS.includes(proposal.action)) {
    throw new ExecutionAuthorityError(`action '${proposal.action}' may not be confirmed from chat`);
  }
  const taskType = proposal.task?.taskType;
  if (!CONFIRMABLE_TASK_TYPES.includes(taskType)) {
    throw new ExecutionAuthorityError(`task type '${taskType}' may not be confirmed from chat`);
  }
  const chained = proposal.task.chain?.nextTaskType;
  if (chained !== undefined && !CONFIRMABLE_CHAIN_TASK_TYPES.includes(chained)) {
    throw new ExecutionAuthorityError(`chained task type '${chained}' may not be confirmed from chat`);
  }
}
