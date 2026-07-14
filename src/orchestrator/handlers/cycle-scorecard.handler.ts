// src/orchestrator/handlers/cycle-scorecard.handler.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { event } from './backtest-support.ts';
import { buildCycleScorecard, type CycleScorecardSnapshot } from '../../research/cycle-scorecard-builder.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from '../../domain/cycle-scorecard.ts';
import type { Evaluation } from '../../domain/evaluation.ts';

// Mirrors FinalizeCycleOutcome (src/orchestrator/finalize-cycle.ts) — the task payload shape
// finalizeCycle enqueues. Kept as an independent zod schema (schema gate #1, design §12) rather
// than importing the interface directly, so the handler validates the payload it actually received
// off the wire instead of trusting the producer's compile-time type.
const TerminalOutcomeSchema = z.object({
  kind: z.enum(['accepted', 'rejected', 'skipped', 'abandoned']),
  reason: z.string(),
});

export const CycleScorecardPayloadSchema = z.object({
  correlationId: z.string().min(1),
  strategyProfileId: z.string().min(1),
  sourceTaskId: z.string().min(1),
  terminalOutcome: TerminalOutcomeSchema,
  revisionId: z.string().optional(),
  eligibleHypIds: z.array(z.string()).optional(),
  consideredHypIds: z.array(z.string()).optional(),
});

const now = () => new Date().toISOString();

/** Deterministic "last completed evaluation": max by (createdAt, id) — a lexicographic id
 *  tiebreak covers equal-timestamp collisions so the pick never depends on array order. */
function lastEvaluation(evals: Evaluation[]): Evaluation | null {
  let best: Evaluation | null = null;
  for (const e of evals) {
    if (!best || e.createdAt > best.createdAt || (e.createdAt === best.createdAt && e.id > best.id)) {
      best = e;
    }
  }
  return best;
}

/**
 * cycle.scorecard consumer (R5b Task 5) — gathers an AUTHORITATIVE, correlation-scoped snapshot of
 * a just-terminated cycle (§5.2) and upserts a CycleScorecard row. Registered in composition.ts;
 * see finalize-cycle.ts for the producer side.
 *
 * At-least-once: this handler is NOT idempotent on the `cycle.scorecard.built` event — a worker
 * retry after a successful upsert but a failed events.append repeats the event (the upsert itself
 * IS idempotent, keyed on (correlationId, schemaVersion)). Any gather/upsert failure propagates
 * (throws) so BullMQ retries the task; there is no generic dead-letter hook here, and this handler
 * does NOT emit a `cycle.scorecard.failed` event.
 */
export const cycleScorecardHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(CycleScorecardPayloadSchema, task.payload);
  if (parsed.status === 'invalid') {
    throw new Error(`invalid cycle.scorecard payload: ${JSON.stringify(parsed.issues)}`);
  }
  const payload = parsed.data;
  const { correlationId, strategyProfileId } = payload;

  // cycleHypothesisIds = unique payload.hypothesisId of every hypothesis.build task in this chain.
  // Sort by id: the repository query has no stable ORDER BY, so its row order is non-deterministic
  // across retries. The scorecard's `roster` carries this order into JSONB, so without a sort the
  // same snapshot could produce different roster orderings on retry — violating the determinism
  // invariant. Sorting the dedup'd ids fixes the roster order regardless of DB physical order.
  const cycleTasks = await services.researchTasks.listByCorrelationAndTypes(correlationId, ['hypothesis.build']);
  const cycleHypothesisIds = [...new Set(
    cycleTasks.map((t) => t.payload.hypothesisId).filter((id): id is string => typeof id === 'string'),
  )].sort();

  const hypotheses: CycleScorecardSnapshot['hypotheses'] = [];
  for (const hypId of cycleHypothesisIds) {
    const hyp = await services.hypotheses.findById(hypId);
    if (!hyp) throw new Error(`cycle.scorecard gather: hypothesis not found: ${hypId}`);

    // Correlation-scoped: only backtest runs launched by THIS cycle's own tasks count toward this
    // hypothesis's roster entry — a run from a different (foreign/old) cycle must never leak in.
    const runs = (await services.backtests.listByHypothesis(hypId))
      .filter((run) => run.correlationId === correlationId);

    const evalsForHyp: Evaluation[] = [];
    for (const run of runs) {
      evalsForHyp.push(...(await services.evaluations.listByBacktestRun(run.id)));
    }
    const last = lastEvaluation(evalsForHyp);

    hypotheses.push({
      hypId, status: hyp.status,
      lastDecision: last ? last.decision : null,
      evaluated: evalsForHyp.length > 0,
    });
  }

  // A present-but-unresolvable/mismatched revisionId is a stale or corrupt pointer — never fold it
  // into a partial snapshot with revision=null; throw so the worker retries the whole gather.
  let revision: CycleScorecardSnapshot['revision'] = null;
  if (payload.revisionId !== undefined) {
    const found = await services.revisions.findById(payload.revisionId);
    if (!found || found.strategyProfileId !== strategyProfileId) {
      throw new Error(
        `cycle.scorecard gather: revisionId=${payload.revisionId} not found or strategyProfileId mismatch (expected ${strategyProfileId})`,
      );
    }
    revision = found;
  }

  const snapshot: CycleScorecardSnapshot = {
    correlationId, strategyProfileId, sourceTaskId: payload.sourceTaskId,
    terminalOutcome: payload.terminalOutcome,
    // undefined (key omitted) -> null; an explicit [] is preserved as-is (distinct "known zero").
    eligibleHypIds: payload.eligibleHypIds ?? null,
    consideredHypIds: payload.consideredHypIds ?? null,
    revision,
    hypotheses,
  };

  const scorecard = buildCycleScorecard(snapshot);
  const ts = now();
  await services.cycleScorecards.upsert({
    id: randomUUID(),
    correlationId,
    strategyProfileId,
    schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
    payload: scorecard,
    generatedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  });

  await services.events.append(event(task.id, 'cycle.scorecard.built', { correlationId }));
};
