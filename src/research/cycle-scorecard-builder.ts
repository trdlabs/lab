import type { StrategyRevision } from '../domain/strategy-revision.ts';
import type { EvaluationDecision } from '../validation/evaluator.ts';
import {
  CYCLE_SCORECARD_SCHEMA_VERSION,
  type CycleScorecard, type TerminalKind, type RevisionAssessment, type ScorecardAggregate,
} from '../domain/cycle-scorecard.ts';

const DROPPED_STATUSES = new Set(['dropped_merge_conflict', 'dropped_combo_fail', 'dropped_unsupported_shape']);

export interface CycleScorecardSnapshot {
  correlationId: string;
  strategyProfileId: string;
  sourceTaskId: string;
  terminalOutcome: { kind: TerminalKind; reason: string };
  eligibleHypIds: string[] | null;
  consideredHypIds: string[] | null;
  revision: StrategyRevision | null;
  hypotheses: Array<{ hypId: string; status: string; lastDecision: EvaluationDecision | null; evaluated: boolean }>;
}

function buildAggregate(rev: StrategyRevision): ScorecardAggregate | null {
  const se = rev.selectionEvaluation;
  if (!se) return null; // final attempt had no comparison, or kind:'consolidated'
  return {
    evaluatorVersion: se.evaluatorVersion,
    baselineMetrics: se.baselineMetrics,
    candidateMetrics: se.candidateMetrics,
    deltas: {
      netPnlUsd: se.candidateMetrics.netPnlUsd - se.baselineMetrics.netPnlUsd,
      maxDrawdownPct: se.candidateMetrics.maxDrawdownPct - se.baselineMetrics.maxDrawdownPct,
      totalTrades: se.candidateMetrics.totalTrades - se.baselineMetrics.totalTrades,
    },
    thresholds: se.thresholds,
    decision: se.decision,
    reasons: se.reasons,
  };
}

export function buildCycleScorecard(s: CycleScorecardSnapshot): CycleScorecard {
  const rev = s.revision;
  const accepted = rev?.status === 'accepted';

  const built = s.hypotheses.length;
  const evaluated = s.hypotheses.filter((h) => h.evaluated).length;
  const eligible = s.eligibleHypIds === null ? null : s.eligibleHypIds.length;
  const considered = s.consideredHypIds === null ? null : s.consideredHypIds.length;
  const selected = accepted && rev ? new Set(rev.hypothesisIds).size : 0;

  const droppedIds = new Set<string>();
  for (const h of s.hypotheses) if (DROPPED_STATUSES.has(h.status)) droppedIds.add(h.hypId);
  for (const d of rev?.dropped ?? []) droppedIds.add(d.hypothesisId);
  const dropped = droppedIds.size;

  const candidateIncluded = rev ? new Set(rev.hypothesisIds).size : 0;
  const mergeAttempted = rev !== null && s.terminalOutcome.kind !== 'skipped';

  const consideredSet = new Set(s.consideredHypIds ?? []);
  const revisionAssessment: RevisionAssessment | null = rev
    ? {
        revisionId: rev.id, version: rev.version,
        status: accepted ? 'accepted' : 'rejected',
        aggregate: buildAggregate(rev),
        tradeSplit: rev.preservationGate ?? null,
        robustness: rev.holdoutValidation ?? null,
      }
    : null;

  return {
    schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
    correlationId: s.correlationId,
    strategyProfileId: s.strategyProfileId,
    terminalOutcome: s.terminalOutcome,
    counts: { built, evaluated, eligible, considered, selected, dropped },
    ...(eligible === null ? { eligibleUnavailableReason: 'terminated_before_selection' } : {}),
    ...(considered === null ? { consideredUnavailableReason: 'terminated_before_selection' } : {}),
    provenance: {
      mergeAttempted, candidateIncluded,
      ...(rev ? { revisionId: rev.id } : {}),
      sourceTaskId: s.sourceTaskId,
    },
    revisionAssessment,
    champion: accepted && rev ? { revisionId: rev.id, version: rev.version } : null,
    selectionBias: { n: eligible, considered, selected },
    roster: s.hypotheses.map((h) => ({
      hypId: h.hypId, lastDecision: h.lastDecision, terminalStatus: h.status, considered: consideredSet.has(h.hypId),
    })),
    verdict: { decision: s.terminalOutcome.kind, reason: s.terminalOutcome.reason },
  };
}
