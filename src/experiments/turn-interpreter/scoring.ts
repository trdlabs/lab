import { normalizeTurnOutput } from '../../chat/normalize-turn-output.ts';
import { TurnInterpretationSchema } from '../../chat/turn-interpretation.ts';
import type { EvalCase, CaseResult, ScoreResult, ScoredField } from './types.ts';

export const DEFAULT_THRESHOLD = 0.75;
export const FABRICATION_PENALTY = 0.25;
export const WEIGHTS: Record<ScoredField, number> = {
  subject: 0.20, goal: 0.15, direction: 0.10,
  market: 0.10, symbol: 0.10, timeframe: 0.10,
  strategyText: 0.15, references: 0.10,
};

function normToken(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[\s/_-]+/g, '');
}
function setEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a), sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
export function bestEffortSubject(raw: unknown): string {
  const v = (raw as { subject?: unknown })?.subject;
  return typeof v === 'string' ? v : 'unknown';
}

export function scoreCase(raw: unknown, c: EvalCase, latencyMs: number): CaseResult {
  const parsed = TurnInterpretationSchema.safeParse(normalizeTurnOutput(raw));
  if (!parsed.success) {
    return { id: c.id, lang: c.lang, schemaValid: false, score: 0, latencyMs, fields: {}, fabricatedCount: 0, subject: bestEffortSubject(raw) };
  }
  const out = parsed.data;
  const e = c.expect;
  const fields: Partial<Record<ScoredField, number>> = {};

  fields.subject = out.subject === e.subject ? 1 : 0;
  if (e.goal !== undefined) {
    fields.goal = e.goal === 'none' ? (out.goal === undefined ? 1 : 0) : (out.goal === e.goal ? 1 : 0);
  }
  const ec = e.constraints ?? {};
  if (ec.direction !== undefined) fields.direction = out.constraints.direction === ec.direction ? 1 : 0;
  for (const k of ['market', 'symbol', 'timeframe'] as const) {
    if (ec[k] !== undefined) fields[k] = normToken(out.constraints[k]) === normToken(ec[k]) ? 1 : 0;
  }
  if (e.hasStrategyText !== undefined) fields.strategyText = Boolean(out.strategyText) === e.hasStrategyText ? 1 : 0;
  if (e.references !== undefined) {
    fields.references = setEqual(out.references.map(normToken), e.references.map(normToken)) ? 1 : 0;
  }

  const declared = Object.keys(fields) as ScoredField[];
  const wsum = declared.reduce((a, k) => a + WEIGHTS[k], 0) || 1;
  const weighted = declared.reduce((a, k) => a + WEIGHTS[k] * (fields[k] as number), 0) / wsum;

  let fabricatedCount = 0;
  for (const f of e.absentConstraints ?? []) {
    if ((out.constraints as Record<string, unknown>)[f] !== undefined) fabricatedCount += 1;
  }
  const score = Math.max(0, Math.min(1, weighted - fabricatedCount * FABRICATION_PENALTY));
  return { id: c.id, lang: c.lang, schemaValid: true, score, latencyMs, fields, fabricatedCount, subject: out.subject };
}

export function scoreRun(cases: CaseResult[], opts?: { threshold?: number }): ScoreResult {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const n = cases.length || 1;
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const fieldAccuracies: Partial<Record<ScoredField, number>> = {};
  for (const k of Object.keys(WEIGHTS) as ScoredField[]) {
    const vals = cases.map((c) => c.fields[k]).filter((v): v is number => v !== undefined);
    if (vals.length) fieldAccuracies[k] = mean(vals);
  }
  const score = mean(cases.map((c) => c.score));
  return {
    schemaValidRate: cases.filter((c) => c.schemaValid).length / n,
    subjectAccuracy: fieldAccuracies.subject ?? 0,
    fieldAccuracies,
    fabricationRate: cases.filter((c) => c.fabricatedCount > 0).length / n,
    score,
    threshold,
    verdict: score >= threshold ? 'PASS' : 'FAIL',
    cases,
  };
}
