// src/experiments/strategy-critic/scoring.ts
import { StrategyRefinementSchema, type StrategyRefinement } from '../../domain/strategy-critic.ts';
import type { CheckResult, CriticEvalCase, Direction, ScoreResult } from './types.ts';

export const DEFAULT_THRESHOLD = 0.6;

// Runner-owned authorities the refinement must NOT prescribe (mirrors the analyst risk gate).
// Leverage requires >=2x OR the explicit word, so DCA size hints (1.2x/1.5x) are NOT flagged.
const FAB_PATTERNS: RegExp[] = [
  /(?<![.\d])\b(?:[2-9]|\d{2,})(?:\.\d+)?\s*[x×]\b/i, // leverage >= 2x
  /leverage\s*[:=]?\s*\d/i,
  /плеч[\p{L}]*\s*[:=]?\s*\d/iu,
  /\$\s*\d|\b\d+\s*(?:usd|usdt|dollars?)\b|base[ _]?order\s*[:=]?\s*\d/i,
  /\b\d+(?:\.\d+)?\s*%\s*(?:of\s+)?(?:equity|account|balance|capital|portfolio|deposit|депозит)/i,
];

// \b doesn't work with Cyrillic; use Unicode-letter look-around instead.
const DIRECTION_MARKERS: Record<Direction, RegExp> = {
  long: /(?<!\p{L})(long|лонг|buy)(?!\p{L})/iu,
  short: /(?<!\p{L})(short|шорт|sell)(?!\p{L})/iu,
};

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3));
}

/** Materially different from the case text: length grew >=20% AND >=5 new tokens. */
function nonTrivialChange(improved: string, original: string): boolean {
  if (improved.trim().length < original.trim().length * 1.2) return false;
  const before = tokenize(original);
  const added = [...tokenize(improved)].filter((t) => !before.has(t));
  return added.length >= 5;
}

export function scoreRefinement(
  refinement: StrategyRefinement,
  evalCase: CriticEvalCase,
  opts?: { threshold?: number },
): ScoreResult {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const improved = refinement.improvedStrategyText;

  const schemaValid = StrategyRefinementSchema.safeParse(refinement).success;
  const directionPreserved = DIRECTION_MARKERS[evalCase.direction].test(improved);
  const noRunnerOverreach = !FAB_PATTERNS.some((re) => re.test(improved));
  const nonTrivial = nonTrivialChange(improved, evalCase.text);
  const gates = { schemaValid, directionPreserved, noRunnerOverreach, nonTrivialChange: nonTrivial };

  const haystack = [improved, ...refinement.changeLog].join(' • ').toLowerCase();
  const checks: CheckResult[] = evalCase.expectedAspects.map((aspect) => {
    const matched = aspect.any.filter((src) => new RegExp(src, 'iu').test(haystack));
    return { id: aspect.label, weight: aspect.weight, hit: matched.length > 0, matched };
  });

  const totalWeight = evalCase.expectedAspects.reduce((s, a) => s + a.weight, 0);
  const hitWeight = checks.reduce((s, c) => s + (c.hit ? c.weight : 0), 0);
  const score = totalWeight > 0 ? hitWeight / totalWeight : 0;

  const gatesPass = schemaValid && directionPreserved && noRunnerOverreach && nonTrivial;
  const verdict = gatesPass && score >= threshold ? 'PASS' : 'FAIL';
  return { gates, checks, score, threshold, verdict };
}
