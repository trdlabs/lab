// src/experiments/strategy-analyst/eval-harness.ts
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { AnalystProfileOutput, Direction } from '../../domain/strategy-profile.ts';
import { scoreProfile } from './scoring.ts';
import { scoreCompleteness } from './completeness.ts';
import { aggregateRuns } from './aggregate.ts';
import type { CandidateError, CandidateResult, EvalRunResult, JudgeVerdict, ModelAggregate } from './types.ts';

export interface RunEvalInput {
  models: string[];
  fixtureId: string;
  fixtureText: string;
  fixtureFingerprint: string;
  threshold: number;
  direction: Direction;
  repeat?: number; // independent runs per model; default 1, assumed >= 1
  sourceKind?: 'manual_description' | 'bot_code'; // defaults to 'manual_description' for back-compat
}

export interface RunEvalDeps {
  analystFor: (modelId: string) => StrategyAnalystPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  judge?: (profile: AnalystProfileOutput) => Promise<JudgeVerdict>;
}

export function classifyError(err: unknown): CandidateError {
  const message = err instanceof Error ? err.message : String(err);
  let type: CandidateError['type'] = 'unknown';
  if (/timeout|timed out/i.test(message)) type = 'timeout';
  else if (/schema|zod|parse|validation|invalid/i.test(message)) type = 'schema';
  else if (/api key|provider|rate limit|status|fetch|network|econn|unauthorized/i.test(message)) type = 'provider';
  return { type, message };
}

/** One independent run for a model: analyze() -> scoreCompleteness() (+ scoreProfile secondary for long) -> (optional) judge(). Never throws. */
async function runOnce(model: string, input: RunEvalInput, deps: RunEvalDeps): Promise<CandidateResult> {
  const { provider, modelId } = deps.providerOf(model);
  const start = deps.clock();
  try {
    const analyst = deps.analystFor(model);
    const raw = await analyst.analyze({ kind: input.sourceKind ?? 'manual_description', content: input.fixtureText, title: input.fixtureId });
    const latencyMs = deps.clock() - start;
    const score = scoreCompleteness(raw, { expectedDirection: input.direction, threshold: input.threshold });
    const secondaryScore = input.direction === 'long' ? scoreProfile(raw, { threshold: input.threshold }) : null;

    let judge: JudgeVerdict | null = null;
    if (deps.judge) {
      try {
        judge = await deps.judge(raw);
      } catch (judgeErr) {
        // Judge is best-effort and NEVER affects the deterministic verdict.
        process.stderr.write(`judge failed for ${model}: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}\n`);
        judge = null;
      }
    }

    return { model, provider, modelId, latencyMs, verdict: score.verdict, score, secondaryScore, rawOutput: raw, error: null, judge };
  } catch (err) {
    const latencyMs = deps.clock() - start;
    return { model, provider, modelId, latencyMs, verdict: 'FAIL', score: null, secondaryScore: null, rawOutput: null, error: classifyError(err), judge: null };
  }
}

export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const repeat = input.repeat ?? 1;
  const perModel: CandidateResult[] = [];
  const aggregates: ModelAggregate[] = [];

  // Sequential, model-major then run index — no parallelism, to avoid provider rate limits.
  for (const model of input.models) {
    const runs: CandidateResult[] = [];
    for (let k = 0; k < repeat; k++) {
      const r = await runOnce(model, input, deps);
      runs.push(r);
      perModel.push(r);
    }
    aggregates.push(aggregateRuns(runs));
  }

  return {
    fixture: { id: input.fixtureId, fingerprint: input.fixtureFingerprint },
    threshold: input.threshold,
    repeat,
    judgeEnabled: deps.judge != null,
    models: input.models,
    perModel,
    aggregates,
    overallSuccess: perModel.some((r) => r.verdict === 'PASS'),
  };
}
