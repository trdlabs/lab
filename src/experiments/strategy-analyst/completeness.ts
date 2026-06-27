// src/experiments/strategy-analyst/completeness.ts
import { AnalystProfileOutputSchema, type AnalystProfileOutput, type Direction } from '../../domain/strategy-profile.ts';
import type { CheckResult, ScoreResult } from './types.ts';
import { DEFAULT_THRESHOLD } from './scoring.ts';
import { detectFabrication } from './fabrication.ts';

/** Max number of declared unknowns before the structural check considers the profile under-committed. */
export const UNKNOWNS_CAP = 4;

/** Direction-aware structural-completeness scorer. Strategy-agnostic: works for any direction. */
export function scoreCompleteness(
  raw: unknown,
  opts: { expectedDirection: Direction; threshold?: number },
): ScoreResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const parsed = AnalystProfileOutputSchema.safeParse(raw);

  if (!parsed.success) {
    return { gates: { schemaValid: false, directionMatches: false }, checks: [], score: 0, threshold, verdict: 'FAIL' };
  }

  const profile = parsed.data;
  const gates = { schemaValid: true, directionMatches: profile.direction === opts.expectedDirection };

  const checks: CheckResult[] = [];
  const push = (id: string, weight: number, ok: boolean, matched: string[] = []): void => {
    checks.push({ id, weight, bucketsHit: ok ? 1 : 0, bucketCount: 1, contribution: ok ? weight : 0, matched });
  };

  // Five equally-weighted structural checks; a fully-complete profile scores 1.0.
  push('has_market_features', 0.2, profile.requiredMarketFeatures.length > 0);
  push('has_entry', 0.2, profile.entryConditions.length > 0);
  push('has_exit', 0.2, profile.exitConditions.length > 0);
  push('unknowns_bounded', 0.2, profile.unknowns.length <= UNKNOWNS_CAP);
  const fab = detectFabrication(profile);
  push('no_fabrication', 0.2, fab.length === 0, fab);

  const score = checks.reduce((sum, c) => sum + c.contribution, 0);
  const verdict = gates.schemaValid && gates.directionMatches && score >= threshold ? 'PASS' : 'FAIL';
  return { gates, checks, score, threshold, verdict };
}
