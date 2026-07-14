import { describe, it, expect } from 'vitest';
import type { CycleScorecard } from './cycle-scorecard.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from './cycle-scorecard.ts';

describe('CycleScorecard type', () => {
  it('schema version constant is cycle-scorecard-v1', () => {
    expect(CYCLE_SCORECARD_SCHEMA_VERSION).toBe('cycle-scorecard-v1');
  });

  it('constructs a full accepted-champion payload', () => {
    const sc: CycleScorecard = {
      schemaVersion: 'cycle-scorecard-v1',
      correlationId: 'c1', strategyProfileId: 'p1',
      terminalOutcome: { kind: 'accepted', reason: 'pnl_improved' },
      counts: { built: 3, evaluated: 3, eligible: 2, considered: 2, selected: 1, dropped: 1 },
      provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'r1', sourceTaskId: 't1' },
      revisionAssessment: {
        revisionId: 'r1', version: 2, status: 'accepted',
        aggregate: null, tradeSplit: null, robustness: null,
      },
      champion: { revisionId: 'r1', version: 2 },
      selectionBias: { n: 2, considered: 2, selected: 1 },
      roster: [{ hypId: 'h1', lastDecision: 'PASS', terminalStatus: 'merged', considered: true }],
      verdict: { decision: 'accepted', reason: 'pnl_improved' },
    };
    expect(sc.champion?.version).toBe(2);
  });

  it('allows null revisionAssessment/champion + null counts for a before-selection skipped cycle', () => {
    // null sets belong to before-selection terminals (no_baseline / abandoned), NOT no_eligible_hypotheses
    // (which is a KNOWN 0 → empty sets). See §3 / Task 4 terminal table.
    const sc: CycleScorecard = {
      schemaVersion: 'cycle-scorecard-v1', correlationId: 'c1', strategyProfileId: 'p1',
      terminalOutcome: { kind: 'skipped', reason: 'no_baseline' },
      counts: { built: 0, evaluated: 0, eligible: null, considered: null, selected: 0, dropped: 0 },
      eligibleUnavailableReason: 'terminated_before_selection',
      consideredUnavailableReason: 'terminated_before_selection',
      provenance: { mergeAttempted: false, candidateIncluded: 0 },
      revisionAssessment: null, champion: null,
      selectionBias: { n: null, considered: null, selected: 0 },
      roster: [], verdict: { decision: 'skipped', reason: 'no_baseline' },
    };
    expect(sc.revisionAssessment).toBeNull();
  });
});
