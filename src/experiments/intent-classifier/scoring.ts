// src/experiments/intent-classifier/scoring.ts
// Deterministic, offline scoring. The single trust boundary is ChatIntentSchema (exactly what the
// chat guard re-validates): the classifier output is parsed before anything is read from it.
// Primary signal = intent match. Secondary signal = key payload-field correctness.
import { ChatIntentSchema } from '../../chat/intent.ts';
import { withoutNullProps } from '../../chat/normalize-intent-output.ts';
import type { CaseResult, EvalCase, EvalCaseExpect, PayloadCheck, ScoreResult } from './types.ts';

export const DEFAULT_THRESHOLD = 0.7;

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Best-effort `intent` from a raw (possibly schema-invalid) output, so a deviation is a visible
 *  miss in the report rather than a bald null. Never trusted — the case is still a schema-invalid miss. */
function bestEffortIntent(raw: unknown): string | null {
  if (raw != null && typeof raw === 'object' && 'intent' in raw) {
    const v = (raw as { intent?: unknown }).intent;
    if (typeof v === 'string') return v;
  }
  return null;
}

type ParsedIntent = ReturnType<typeof ChatIntentSchema.parse>;

/** Build the secondary payload checks for the expectations that the case actually declares. */
function buildPayloadChecks(intent: ParsedIntent, expect: EvalCaseExpect): PayloadCheck[] {
  const checks: PayloadCheck[] = [];
  if (expect.requestedOutcome !== undefined) {
    checks.push({ field: 'requestedOutcome', expected: expect.requestedOutcome, actual: intent.requestedOutcome, ok: intent.requestedOutcome === expect.requestedOutcome });
  }
  if (expect.entityRef !== undefined) {
    checks.push({ field: 'entityRef', expected: expect.entityRef, actual: intent.entityRef, ok: intent.entityRef === expect.entityRef });
  }
  if (expect.hasStrategyText === true) {
    checks.push({ field: 'hasStrategyText', expected: true, actual: nonEmptyString(intent.strategyText), ok: nonEmptyString(intent.strategyText) });
  }
  if (expect.hasHypothesisText === true) {
    checks.push({ field: 'hasHypothesisText', expected: true, actual: nonEmptyString(intent.hypothesisText), ok: nonEmptyString(intent.hypothesisText) });
  }
  return checks;
}

/** Score one classifier output against an expected case. Never throws. */
export function scoreCase(raw: unknown, evalCase: EvalCase, latencyMs: number): CaseResult {
  const candidate = withoutNullProps(raw); // null optional fields (OpenAI nullable outputs) -> absent
  const parsed = ChatIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') || 'schema invalid';
    // Intent accuracy and schema validity are scored SEPARATELY: a deviation in a secondary field
    // (e.g. a bad entityRef enum) fails the strict gate but must not zero a correctly-recognized
    // intent. intentMatch is judged on the best-effort intent; the case stays schemaValid:false and
    // payload is not scored on an object that failed the gate.
    const actualIntent = bestEffortIntent(candidate);
    return {
      id: evalCase.id, lang: evalCase.lang, expectedIntent: evalCase.expect.intent,
      actualIntent, intentMatch: actualIntent === evalCase.expect.intent, schemaValid: false,
      payloadChecks: [], payloadScore: null, latencyMs,
      error: { type: 'schema', message },
    };
  }
  const intent = parsed.data;
  const intentMatch = intent.intent === evalCase.expect.intent;
  const payloadChecks = buildPayloadChecks(intent, evalCase.expect);
  const payloadScore = payloadChecks.length > 0 ? payloadChecks.filter((c) => c.ok).length / payloadChecks.length : null;
  return {
    id: evalCase.id, lang: evalCase.lang, expectedIntent: evalCase.expect.intent,
    actualIntent: intent.intent, intentMatch, schemaValid: true,
    payloadChecks, payloadScore, latencyMs, error: null,
  };
}

/** Aggregate per-case results into one run's score. Primary score == intent accuracy. */
export function scoreRun(cases: CaseResult[], opts?: { threshold?: number }): ScoreResult {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const total = cases.length;
  const correct = cases.filter((c) => c.intentMatch).length;
  const intentAccuracy = total > 0 ? correct / total : 0;

  const payloadScores = cases.filter((c) => c.payloadScore != null).map((c) => c.payloadScore as number);
  const payloadAccuracy = payloadScores.length > 0 ? payloadScores.reduce((a, b) => a + b, 0) / payloadScores.length : null;

  const schemaValidCount = cases.filter((c) => c.schemaValid).length;

  return {
    intentAccuracy,
    payloadAccuracy,
    score: intentAccuracy,
    threshold,
    verdict: intentAccuracy >= threshold ? 'PASS' : 'FAIL',
    cases,
    caseCount: total,
    schemaValidCount,
    schemaValidRate: total > 0 ? schemaValidCount / total : 0, // share that would pass the strict gate (prod-acceptable)
  };
}
