// src/experiments/strategy-critic/eval-harness.ts
import type { StrategyCriticPort } from '../../ports/strategy-critic.port.ts';
import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import { scoreRefinement } from './scoring.ts';
import { scoreCompleteness } from '../strategy-analyst/completeness.ts';
import { aggregateRuns } from './aggregate.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { ScoreResult as AnalystScoreResult } from '../strategy-analyst/types.ts';
import type { Candidate, CandidateError, CandidateResult, CriticEvalCase, EvalRunResult, JudgeVerdict, ModelAggregate } from './types.ts';

export interface RunEvalInput {
  candidates: Candidate[];
  cases: CriticEvalCase[];
  threshold: number;
  repeat?: number; // independent runs per (candidate, case); default 1, assumed >= 1
  roundTrip: boolean;   // when true, feed improvedStrategyText to the analyst
  analystModel: string; // analyst model id used when roundTrip (e.g. 'openrouter/x-ai/grok-4.3')
}

export interface RunEvalDeps {
  criticFor: (candidate: Candidate) => StrategyCriticPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  judge?: (refinement: StrategyRefinement, evalCase: CriticEvalCase, profile?: AnalystProfileOutput) => Promise<JudgeVerdict>;
  analystFor?: (modelId: string) => StrategyAnalystPort; // only used when roundTrip
}

export function classifyError(err: unknown): CandidateError {
  const message = err instanceof Error ? err.message : String(err);
  let type: CandidateError['type'] = 'unknown';
  if (/timeout|timed out/i.test(message)) type = 'timeout';
  else if (/schema|zod|parse|validation|invalid/i.test(message)) type = 'schema';
  else if (/api key|provider|rate limit|status|fetch|network|econn|unauthorized/i.test(message)) type = 'provider';
  return { type, message };
}

function criticModelOf(c: Candidate): string {
  return c.mode === 'single' ? c.combinedModel : c.criticModel;
}
function refinerModelOf(c: Candidate): string | null {
  return c.mode === 'two_stage' ? c.refinerModel : null;
}

/** One independent run: refine() -> scoreRefinement() -> (optional) judge(). Never throws. */
export async function runOnce(candidate: Candidate, evalCase: CriticEvalCase, input: RunEvalInput, deps: RunEvalDeps): Promise<CandidateResult> {
  const criticModel = criticModelOf(candidate);
  const refinerModel = refinerModelOf(candidate);
  const start = deps.clock();
  try {
    const critic = deps.criticFor(candidate);
    const raw = await critic.refine({ kind: 'manual_description', content: evalCase.text, title: evalCase.id });
    const latencyMs = deps.clock() - start;
    const score = scoreRefinement(raw, evalCase, { threshold: input.threshold });

    let profile: AnalystProfileOutput | null = null;
    let profileScore: AnalystScoreResult | null = null;
    if (input.roundTrip && deps.analystFor) {
      try {
        const analyst = deps.analystFor(input.analystModel);
        profile = await analyst.analyze({ kind: 'manual_description', content: raw.improvedStrategyText });
        profileScore = scoreCompleteness(profile, { expectedDirection: evalCase.direction, threshold: input.threshold });
      } catch (analystErr) {
        // Fail-soft: the analyst is downstream of the critique; its failure must NOT fail the candidate.
        process.stderr.write(`analyst failed for ${candidate.label}/${evalCase.id}: ${analystErr instanceof Error ? analystErr.message : String(analystErr)}\n`);
        profile = null;
        profileScore = null;
      }
    }

    let judge: JudgeVerdict | null = null;
    if (deps.judge) {
      try {
        judge = await deps.judge(raw, evalCase, profile ?? undefined);
      } catch (judgeErr) {
        // Judge is best-effort and NEVER affects the deterministic verdict.
        process.stderr.write(`judge failed for ${candidate.label}/${evalCase.id}: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}\n`);
        judge = null;
      }
    }

    return { label: candidate.label, mode: candidate.mode, criticModel, refinerModel, caseId: evalCase.id, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null, judge, profile, profileScore };
  } catch (err) {
    const latencyMs = deps.clock() - start;
    return { label: candidate.label, mode: candidate.mode, criticModel, refinerModel, caseId: evalCase.id, latencyMs, verdict: 'FAIL', score: null, rawOutput: null, error: classifyError(err), judge: null, profile: null, profileScore: null };
  }
}

export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const repeat = input.repeat ?? 1;
  const perCandidate: CandidateResult[] = [];
  const aggregates: ModelAggregate[] = [];

  // Sequential, candidate-major then case then run index — no parallelism (provider rate limits).
  for (const candidate of input.candidates) {
    const runs: CandidateResult[] = [];
    for (const evalCase of input.cases) {
      for (let k = 0; k < repeat; k++) {
        const r = await runOnce(candidate, evalCase, input, deps);
        runs.push(r);
        perCandidate.push(r);
      }
    }
    aggregates.push(aggregateRuns(runs));
  }

  return {
    threshold: input.threshold,
    repeat,
    judgeEnabled: deps.judge != null,
    candidates: input.candidates,
    cases: input.cases.map((c) => c.id),
    perCandidate,
    aggregates,
    overallSuccess: perCandidate.some((r) => r.verdict === 'PASS'),
  };
}
