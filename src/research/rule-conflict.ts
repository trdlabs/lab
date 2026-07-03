// src/research/rule-conflict.ts
//
// Pure, deterministic conflict detector over already score-ordered HypothesisProposal records
// (see hypothesis-score.ts's sortEligible — winner = earlier in the input array). Consumed by the
// (future) revision.build handler to prune a merge batch down to a mutually-consistent set before
// a strategy revision is assembled (spec: docs/superpowers/specs/2026-07-03-strategy-revisions-design.md §4).
//
// No I/O. No imports beyond domain types.
import type { HypothesisProposal, HypothesisRule } from '../domain/hypothesis.ts';
import type { OverlayAction } from '../domain/hypothesis-rules.ts';

export interface RuleConflict {
  winnerId: string;
  loserId: string;
  key: string;
  detail: string;
}

/**
 * Action pairs that are contradictory regardless of their params — one hypothesis wants to skip
 * entries where another wants to allow them, or tighten a stop where another wants to widen it.
 * Order within each pair doesn't matter for detection (checked both ways below); the pair's own
 * order fixes the `key`/`detail` wording deterministically.
 */
export const CONTRADICTORY_PAIRS: ReadonlyArray<readonly [OverlayAction, OverlayAction]> = [
  ['skip_entry', 'allow_entry'],
  ['tighten_stop', 'widen_stop'],
];

function formatParamValue(v: string | number | boolean | null | undefined): string {
  return JSON.stringify(v) ?? 'undefined';
}

function findContradictoryPair(
  actionA: OverlayAction,
  actionB: OverlayAction,
): readonly [OverlayAction, OverlayAction] | undefined {
  return CONTRADICTORY_PAIRS.find(
    ([a, b]) => (a === actionA && b === actionB) || (a === actionB && b === actionA),
  );
}

interface ConflictMatch {
  key: string;
  detail: string;
}

/**
 * Checks one (winnerRule, loserRule) pair for a conflict. Two independent triggers, checked in
 * this order:
 *   1. Same action AND a shared param key whose values differ -> param-value conflict. `key` is
 *      `${action}.${paramKey}` so the same key name under a different action never collides.
 *   2. The two rules' actions form a CONTRADICTORY_PAIRS entry (order-independent) -> contradictory
 *      conflict, regardless of params. `key` is the pair joined in its canonical (pair-array) order.
 */
function conflictBetweenRules(winnerRule: HypothesisRule, loserRule: HypothesisRule): ConflictMatch | null {
  if (winnerRule.action === loserRule.action) {
    for (const paramKey of Object.keys(winnerRule.params)) {
      if (!(paramKey in loserRule.params)) continue;
      const winnerVal = winnerRule.params[paramKey];
      const loserVal = loserRule.params[paramKey];
      if (winnerVal !== loserVal) {
        return {
          key: `${winnerRule.action}.${paramKey}`,
          detail:
            `param conflict on ${winnerRule.action}.${paramKey}: ` +
            `winner=${formatParamValue(winnerVal)} loser=${formatParamValue(loserVal)}`,
        };
      }
    }
    return null;
  }

  const pair = findContradictoryPair(winnerRule.action, loserRule.action);
  if (pair) {
    return {
      key: `${pair[0]}|${pair[1]}`,
      detail:
        `contradictory actions on same direction: winner rule "${winnerRule.action}" ` +
        `vs loser rule "${loserRule.action}" (pair ${pair[0]}/${pair[1]})`,
    };
  }

  return null;
}

/**
 * Checks whether `candidate` conflicts with an already-kept `winner`. Both hypotheses' rule sets
 * are only compared when their ruleAction.appliesTo (direction) matches — rules scoped to
 * different directions never conflict. Returns the first conflicting rule pair found, scanning
 * winner's rules outer / candidate's rules inner, both in their declared array order (deterministic).
 */
function conflictBetweenHypotheses(
  winner: HypothesisProposal,
  candidate: HypothesisProposal,
): ConflictMatch | null {
  if (winner.ruleAction.appliesTo !== candidate.ruleAction.appliesTo) return null;

  for (const winnerRule of winner.ruleAction.rules) {
    for (const candidateRule of candidate.ruleAction.rules) {
      const match = conflictBetweenRules(winnerRule, candidateRule);
      if (match) return match;
    }
  }

  return null;
}

/**
 * Walks `ordered` (winner = earlier, per hypothesis-score.ts's sortEligible) and greedily keeps
 * each hypothesis unless it conflicts with one already kept. A dropped loser is removed from
 * consideration entirely — it never gets a chance to drop a later hypothesis in turn; every
 * comparison is candidate-vs-kept-set only, never candidate-vs-dropped.
 */
export function detectConflicts(ordered: HypothesisProposal[]): {
  kept: HypothesisProposal[];
  conflicts: RuleConflict[];
} {
  const kept: HypothesisProposal[] = [];
  const conflicts: RuleConflict[] = [];

  for (const candidate of ordered) {
    let droppedBy: { winner: HypothesisProposal; match: ConflictMatch } | null = null;
    for (const winner of kept) {
      const match = conflictBetweenHypotheses(winner, candidate);
      if (match) {
        droppedBy = { winner, match };
        break;
      }
    }

    if (droppedBy) {
      conflicts.push({
        winnerId: droppedBy.winner.id,
        loserId: candidate.id,
        key: droppedBy.match.key,
        detail: droppedBy.match.detail,
      });
    } else {
      kept.push(candidate);
    }
  }

  return { kept, conflicts };
}
