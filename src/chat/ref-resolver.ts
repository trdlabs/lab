import type { ResearchTask } from '../domain/types.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { HypothesisProposalRepository } from '../ports/hypothesis-proposal.repository.ts';
import type { ChatSessionContext } from '../ports/chat-session.repository.ts';
import type { ChatIntent } from './intent.ts';

export interface RefResolverDeps {
  researchTasks: Pick<ResearchTaskRepository, 'findById'>;
  strategyProfiles: Pick<StrategyProfileRepository, 'findById'>;
  hypotheses: Pick<HypothesisProposalRepository, 'findById' | 'findLatestValidatedByProfile'>;
}

/** Resolve a task for task.status: session pointer first, then the UNTRUSTED taskIdHint
 *  (verified via findById). Returns the verified task or null. */
export async function resolveStatusTask(
  intent: ChatIntent, session: ChatSessionContext, deps: RefResolverDeps,
): Promise<ResearchTask | null> {
  if (session.lastResearchTaskId) {
    const t = await deps.researchTasks.findById(session.lastResearchTaskId);
    if (t) return t;
  }
  if (intent.taskIdHint) {
    const t = await deps.researchTasks.findById(intent.taskIdHint);
    if (t) return t;
  }
  return null;
}

/** Resolve the strategy profile for research.run_cycle from last_strategy. Verified. */
export async function resolveResearchProfile(
  session: ChatSessionContext, deps: RefResolverDeps,
): Promise<StrategyProfile | null> {
  if (!session.lastStrategyProfileId) return null;
  return deps.strategyProfiles.findById(session.lastStrategyProfileId);
}

/** Resolve a buildable (validated) hypothesis: the last_hypothesis pointer if it is
 *  validated, otherwise the latest validated by the session's strategy profile.
 *  A pointed-but-not-validated hypothesis returns null (-> needs_clarification). */
export async function resolveBuildableHypothesis(
  session: ChatSessionContext, deps: RefResolverDeps,
): Promise<HypothesisProposal | null> {
  if (session.lastHypothesisId) {
    const h = await deps.hypotheses.findById(session.lastHypothesisId);
    if (h) return h.status === 'validated' ? h : null;
  }
  if (session.lastStrategyProfileId) {
    return deps.hypotheses.findLatestValidatedByProfile(session.lastStrategyProfileId);
  }
  return null;
}
