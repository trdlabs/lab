import { describe, it, expect } from 'vitest';
import { detectConflicts, CONTRADICTORY_PAIRS } from './rule-conflict.ts';
import type { HypothesisProposal, RuleAction, HypothesisRule } from '../domain/hypothesis.ts';

function rule(overrides: Partial<HypothesisRule> = {}): HypothesisRule {
  return { when: 'w', action: 'no_op', params: {}, ...overrides };
}

function ruleAction(overrides: Partial<RuleAction> & { rules: HypothesisRule[] }): RuleAction {
  return { appliesTo: 'long', ...overrides };
}

function mk(overrides: Partial<HypothesisProposal> & { id: string }): HypothesisProposal {
  return {
    strategyProfileId: 'p1',
    thesis: 't',
    targetBehavior: 'b',
    ruleAction: ruleAction({ rules: [rule()] }),
    requiredFeatures: ['oi'],
    validationPlan: 'p',
    expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'],
    confidence: 0.5,
    status: 'proxy_passed',
    fingerprint: `sha256:${overrides.id}`,
    proposal: {} as never,
    issues: [],
    contractVersion: 'hypothesis-proposal-v1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('detectConflicts — same-param different-value', () => {
  it('drops the later hypothesis when both rules share an action + param key but differ on value', () => {
    const winner = mk({
      id: 'winner',
      ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 1 } })] }),
    });
    const loser = mk({
      id: 'loser',
      ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 2 } })] }),
    });

    const { kept, conflicts } = detectConflicts([winner, loser]);

    expect(kept.map((p) => p.id)).toEqual(['winner']);
    expect(conflicts).toEqual([
      {
        winnerId: 'winner',
        loserId: 'loser',
        key: 'tighten_stop.stop_pct',
        detail: expect.stringContaining('tighten_stop.stop_pct'),
      },
    ]);
    expect(conflicts[0]?.detail).toContain('1');
    expect(conflicts[0]?.detail).toContain('2');
  });

  it('does not conflict when the same action + param key share the same value', () => {
    const winner = mk({
      id: 'winner',
      ruleAction: ruleAction({ rules: [rule({ action: 'adjust_size', params: { size_multiplier: 0.5 } })] }),
    });
    const other = mk({
      id: 'other',
      ruleAction: ruleAction({ rules: [rule({ action: 'adjust_size', params: { size_multiplier: 0.5 } })] }),
    });

    const { kept, conflicts } = detectConflicts([winner, other]);

    expect(kept.map((p) => p.id)).toEqual(['winner', 'other']);
    expect(conflicts).toEqual([]);
  });

  it('does not conflict when the param key differs even under the same action', () => {
    const winner = mk({
      id: 'winner',
      ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 1 } })] }),
    });
    const other = mk({
      id: 'other',
      ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { trail_pct: 1 } })] }),
    });

    const { kept, conflicts } = detectConflicts([winner, other]);

    expect(kept.map((p) => p.id)).toEqual(['winner', 'other']);
    expect(conflicts).toEqual([]);
  });
});

describe('detectConflicts — contradictory action pair', () => {
  it.each(CONTRADICTORY_PAIRS)('drops the later hypothesis for contradictory pair %s/%s', (a, b) => {
    const winner = mk({ id: 'winner', ruleAction: ruleAction({ rules: [rule({ action: a })] }) });
    const loser = mk({ id: 'loser', ruleAction: ruleAction({ rules: [rule({ action: b })] }) });

    const { kept, conflicts } = detectConflicts([winner, loser]);

    expect(kept.map((p) => p.id)).toEqual(['winner']);
    expect(conflicts).toEqual([
      { winnerId: 'winner', loserId: 'loser', key: `${a}|${b}`, detail: expect.stringContaining(a) },
    ]);
    expect(conflicts[0]?.detail).toContain(b);
  });

  it('detects the contradictory pair regardless of which side has which action', () => {
    const winner = mk({ id: 'winner', ruleAction: ruleAction({ rules: [rule({ action: 'allow_entry' })] }) });
    const loser = mk({ id: 'loser', ruleAction: ruleAction({ rules: [rule({ action: 'skip_entry' })] }) });

    const { kept, conflicts } = detectConflicts([winner, loser]);

    expect(kept.map((p) => p.id)).toEqual(['winner']);
    expect(conflicts).toEqual([
      { winnerId: 'winner', loserId: 'loser', key: 'skip_entry|allow_entry', detail: expect.any(String) },
    ]);
  });

  it('does not treat non-contradictory action pairs as conflicting', () => {
    const winner = mk({ id: 'winner', ruleAction: ruleAction({ rules: [rule({ action: 'scale_in' })] }) });
    const other = mk({ id: 'other', ruleAction: ruleAction({ rules: [rule({ action: 'scale_out' })] }) });

    const { kept, conflicts } = detectConflicts([winner, other]);

    expect(kept.map((p) => p.id)).toEqual(['winner', 'other']);
    expect(conflicts).toEqual([]);
  });
});

describe('detectConflicts — disjoint params/actions coexist', () => {
  it('keeps both hypotheses when appliesTo differs, even with the same conflicting-looking rules', () => {
    const winner = mk({
      id: 'winner',
      ruleAction: ruleAction({ appliesTo: 'long', rules: [rule({ action: 'skip_entry' })] }),
    });
    const other = mk({
      id: 'other',
      ruleAction: ruleAction({ appliesTo: 'short', rules: [rule({ action: 'allow_entry' })] }),
    });

    const { kept, conflicts } = detectConflicts([winner, other]);

    expect(kept.map((p) => p.id)).toEqual(['winner', 'other']);
    expect(conflicts).toEqual([]);
  });

  it('keeps both hypotheses with entirely disjoint actions and params on the same direction', () => {
    const winner = mk({
      id: 'winner',
      ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 1 } })] }),
    });
    const other = mk({
      id: 'other',
      ruleAction: ruleAction({ rules: [rule({ action: 'adjust_size', params: { size_multiplier: 0.5 } })] }),
    });

    const { kept, conflicts } = detectConflicts([winner, other]);

    expect(kept.map((p) => p.id)).toEqual(['winner', 'other']);
    expect(conflicts).toEqual([]);
  });

  it('returns an empty conflicts array and identical kept list for a fully disjoint input', () => {
    const proposals = [
      mk({ id: 'a', ruleAction: ruleAction({ rules: [rule({ action: 'scale_in' })] }) }),
      mk({ id: 'b', ruleAction: ruleAction({ rules: [rule({ action: 'scale_out' })] }) }),
      mk({ id: 'c', ruleAction: ruleAction({ rules: [rule({ action: 'no_op' })] }) }),
    ];

    const { kept, conflicts } = detectConflicts(proposals);

    expect(kept).toEqual(proposals);
    expect(conflicts).toEqual([]);
  });
});

describe('detectConflicts — multiple losers vs one winner', () => {
  it('drops every later hypothesis that conflicts with the single winner', () => {
    const winner = mk({
      id: 'winner',
      ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 1 } })] }),
    });
    const loser1 = mk({
      id: 'loser1',
      ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 2 } })] }),
    });
    const loser2 = mk({ id: 'loser2', ruleAction: ruleAction({ rules: [rule({ action: 'widen_stop' })] }) });
    const survivor = mk({
      id: 'survivor',
      ruleAction: ruleAction({ rules: [rule({ action: 'adjust_size', params: { size_multiplier: 0.5 } })] }),
    });

    const { kept, conflicts } = detectConflicts([winner, loser1, loser2, survivor]);

    expect(kept.map((p) => p.id)).toEqual(['winner', 'survivor']);
    expect(conflicts.map((c) => ({ winnerId: c.winnerId, loserId: c.loserId }))).toEqual([
      { winnerId: 'winner', loserId: 'loser1' },
      { winnerId: 'winner', loserId: 'loser2' },
    ]);
  });
});

describe('detectConflicts — a dropped loser cannot itself drop later hypotheses', () => {
  it('compares later entries only against the KEPT set, not against an already-dropped hypothesis', () => {
    // winner and third both use tighten_stop@stop_pct=1 -> no conflict between them.
    // middle conflicts with winner on tighten_stop@stop_pct (different value) -> middle is dropped.
    // If middle (dropped) were still allowed to conflict with third via widen_stop, third would
    // wrongly get dropped too. It must survive because comparisons only ever hit the KEPT set.
    const winner = mk({
      id: 'winner',
      ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 1 } })] }),
    });
    const middle = mk({
      id: 'middle',
      ruleAction: ruleAction({
        rules: [rule({ action: 'tighten_stop', params: { stop_pct: 2 } }), rule({ action: 'widen_stop' })],
      }),
    });
    const third = mk({
      id: 'third',
      ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 1 } })] }),
    });

    const { kept, conflicts } = detectConflicts([winner, middle, third]);

    expect(kept.map((p) => p.id)).toEqual(['winner', 'third']);
    expect(conflicts).toEqual([
      {
        winnerId: 'winner',
        loserId: 'middle',
        key: 'tighten_stop.stop_pct',
        detail: expect.any(String),
      },
    ]);
  });
});

describe('detectConflicts — determinism', () => {
  it('produces the identical kept/conflicts result across repeated calls on the same input', () => {
    const proposals = [
      mk({ id: 'a', ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 1 } })] }) }),
      mk({ id: 'b', ruleAction: ruleAction({ rules: [rule({ action: 'tighten_stop', params: { stop_pct: 2 } })] }) }),
      mk({ id: 'c', ruleAction: ruleAction({ rules: [rule({ action: 'widen_stop' })] }) }),
      mk({ id: 'd', ruleAction: ruleAction({ rules: [rule({ action: 'adjust_size', params: { size_multiplier: 0.3 } })] }) }),
    ];

    const run1 = detectConflicts(proposals);
    const run2 = detectConflicts([...proposals]);

    expect(run2).toEqual(run1);
    expect(run1.kept.map((p) => p.id)).toEqual(['a', 'd']);
  });

  it('does not mutate the input array or its elements', () => {
    const proposals = [
      mk({ id: 'a', ruleAction: ruleAction({ rules: [rule({ action: 'skip_entry' })] }) }),
      mk({ id: 'b', ruleAction: ruleAction({ rules: [rule({ action: 'allow_entry' })] }) }),
    ];
    const snapshot = JSON.stringify(proposals);

    detectConflicts(proposals);

    expect(JSON.stringify(proposals)).toEqual(snapshot);
  });
});
