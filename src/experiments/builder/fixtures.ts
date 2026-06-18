import { createHash } from 'node:crypto';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import { hypothesisFingerprint } from '../../domain/hypothesis.ts';
import { longOiStrategyProfile } from '../researcher/fixtures.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BuilderEvalInput } from './types.ts';

export const BUILDER_FIXTURES = {
  'long-oi-skip-entry': {
    id: 'long-oi-skip-entry',
    description: 'Two validated hypotheses from long-OI strategy (skip_entry + tighten_stop)',
  },
} as const;

export type BuilderFixtureId = keyof typeof BUILDER_FIXTURES;

export function resolveBuilderFixture(id: string): (typeof BUILDER_FIXTURES)[BuilderFixtureId] {
  const fixture = BUILDER_FIXTURES[id as BuilderFixtureId];
  if (!fixture) throw new Error(`unknown builder fixture "${id}" (known: ${Object.keys(BUILDER_FIXTURES).join(', ')})`);
  return fixture;
}

/** Two representative hypotheses from the long-OI bake-off */
export function longOiHypotheses(): readonly HypothesisProposal[] {
  const now = '2026-06-18T00:00:00Z';
  const make = (
    id: string,
    thesis: string,
    targetBehavior: string,
    rules: HypothesisProposal['ruleAction']['rules'],
    action: HypothesisProposal['ruleAction']['appliesTo'],
  ): HypothesisProposal => {
    const ruleAction = { appliesTo: action, rules };
    const fp = hypothesisFingerprint(thesis, ruleAction);
    const draft = {
      thesis, targetBehavior, ruleAction,
      requiredFeatures: ['open_interest', 'volume'],
      validationPlan: 'Run backtest on 2026-05 data; compare winrate and avg-loss vs baseline.',
      expectedEffect: { metric: 'winrate', direction: 'increase' as const },
      invalidationCriteria: ['winrate < baseline', 'avg loss worsens'],
      confidence: 0.75,
    };
    return {
      id, strategyProfileId: 'long-oi-profile',
      thesis, targetBehavior, ruleAction,
      requiredFeatures: ['open_interest', 'volume'],
      validationPlan: draft.validationPlan,
      expectedEffect: draft.expectedEffect,
      invalidationCriteria: draft.invalidationCriteria,
      confidence: 0.75,
      status: 'validated',
      fingerprint: fp,
      proposal: draft,
      issues: [],
      contractVersion: 'hypothesis-proposal-v1',
      createdAt: now, updatedAt: now,
    };
  };

  return [
    make(
      'hyp-skip-entry-oi-dump',
      'Skip long entry when OI drops sharply (>10%) within 3 bars before signal — indicates retail long flush, not a real bounce.',
      'Reduce entries during OI-driven flush events',
      [{
        when: 'OI decreases more than 10% over last 3 bars and price drops more than 2%',
        action: 'skip_entry',
        params: { oiDeltaPct: -10, priceDeltaPct: -2, lookback: 3 },
        rationale: 'Forensic evidence shows hard_stop losses cluster after DCA into OI-dump windows',
      }],
      'long',
    ),
    make(
      'hyp-tighten-stop-liquidation-spike',
      'Tighten stop-loss to -5% (from default -12%) when liquidationsLong spike exceeds 3× average in the last 10 bars.',
      'Limit drawdown in liquidation cascade scenarios',
      [{
        when: 'liquidationsLong > 3x 10-bar average',
        action: 'tighten_stop',
        params: { stopPct: -5, liquidationsMultiplier: 3, lookback: 10 },
        rationale: 'EDGEUSDT and COAIUSDT losses followed liquidation spikes; tighter stop cuts max loss',
      }],
      'long',
    ),
  ];
}

export function fingerprintFixture(fixtureId: string, hypotheses: readonly HypothesisProposal[]): string {
  const content = JSON.stringify({ fixtureId, ids: hypotheses.map((h) => h.id) });
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export function buildBuilderEvalInput(
  fixtureId: string,
  models: string[],
  threshold: number,
  repeat: number,
  hypotheses: readonly HypothesisProposal[],
  profile: StrategyProfile,
): BuilderEvalInput {
  return {
    models,
    fixtureId,
    fixtureFingerprint: fingerprintFixture(fixtureId, hypotheses),
    hypotheses,
    profile,
    threshold,
    repeat,
  };
}

/** Convenience: default long-OI fixture */
export function defaultBuilderEvalInput(models: string[], threshold = 0.7, repeat = 1): BuilderEvalInput {
  const hypotheses = longOiHypotheses();
  return buildBuilderEvalInput('long-oi-skip-entry', models, threshold, repeat, hypotheses, longOiStrategyProfile());
}
