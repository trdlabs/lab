import type { BuilderPort, BuilderOutput } from '../../ports/builder.port.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import { BUILDER_SDK_DOC } from '../../adapters/builder/builder-sdk-doc.ts';
import { scoreBuilderOutput } from './scoring.ts';
import type {
  BuilderEvalInput,
  BuilderEvalRunResult,
  BuilderJudgeVerdict,
  CandidateError,
  CandidateResult,
  ModelAggregate,
} from './types.ts';

export interface RunBuilderEvalDeps {
  builderFor: (modelId: string) => BuilderPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  /** Optional LLM-as-a-judge. Failures are logged but never block the deterministic verdict. */
  judge?: (hypothesis: HypothesisProposal, output: BuilderOutput) => Promise<BuilderJudgeVerdict>;
}

export function classifyError(err: unknown): CandidateError {
  const message = err instanceof Error ? err.message : String(err);
  let type: CandidateError['type'] = 'unknown';
  if (/timeout|timed out/i.test(message)) type = 'timeout';
  else if (/schema|zod|parse|validation|invalid/i.test(message)) type = 'schema';
  else if (/api key|provider|rate limit|status|fetch|network|econn|unauthorized/i.test(message)) type = 'provider';
  return { type, message };
}

async function runOnce(
  model: string,
  input: BuilderEvalInput,
  hypothesisIndex: number,
  deps: RunBuilderEvalDeps,
): Promise<CandidateResult> {
  const { provider, modelId } = deps.providerOf(model);
  const hypothesis = input.hypotheses[hypothesisIndex]!;
  const start = deps.clock();
  try {
    const builder = deps.builderFor(model);
    const raw = await builder.build({ hypothesis, profile: input.profile, sdkDoc: BUILDER_SDK_DOC });
    const latencyMs = deps.clock() - start;
    const score = scoreBuilderOutput(raw, hypothesis, input.threshold);
    let judge: BuilderJudgeVerdict | null = null;
    if (deps.judge && score.verdict === 'PASS') {
      try {
        judge = await deps.judge(hypothesis, raw);
      } catch (judgeErr) {
        process.stderr.write(`[builder:eval] judge failed for ${model}: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}\n`);
      }
    }
    return { model, provider, modelId, hypothesisId: hypothesis.id, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null, judge };
  } catch (err) {
    return {
      model, provider, modelId, hypothesisId: hypothesis.id,
      latencyMs: deps.clock() - start,
      verdict: 'FAIL', score: null, rawOutput: null, error: classifyError(err), judge: null,
    };
  }
}

function avg(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function aggregateRuns(runs: CandidateResult[], model: string): ModelAggregate {
  const ok = runs.filter((r) => r.verdict === 'PASS').length;
  const scores = runs.filter((r) => r.score !== null).map((r) => r.score!.score);
  const judgeScores = runs.filter((r) => r.judge !== null).map((r) => r.judge!.overallScore);
  const latencies = runs.map((r) => r.latencyMs);
  return {
    model,
    passRate: runs.length > 0 ? ok / runs.length : 0,
    scoreMean: avg(scores),
    judgeScoreMean: avg(judgeScores),
    latencyMeanMs: avg(latencies) ?? 0,
    runs: { ok, total: runs.length },
  };
}

/**
 * For each model: iterate over all hypotheses × repeat times.
 * Each (hypothesis × attempt) is one CandidateResult.
 */
export async function runBuilderEval(
  input: BuilderEvalInput,
  deps: RunBuilderEvalDeps,
): Promise<BuilderEvalRunResult> {
  const repeat = input.repeat ?? 1;
  const perModel: CandidateResult[] = [];
  const aggregates: ModelAggregate[] = [];

  for (const model of input.models) {
    const runs: CandidateResult[] = [];
    for (let hi = 0; hi < input.hypotheses.length; hi++) {
      for (let ri = 0; ri < repeat; ri++) {
        const result = await runOnce(model, input, hi, deps);
        runs.push(result);
        perModel.push(result);
      }
    }
    aggregates.push(aggregateRuns(runs, model));
  }

  return {
    fixture: { id: input.fixtureId, fingerprint: input.fixtureFingerprint },
    threshold: input.threshold,
    repeat,
    models: input.models,
    perModel,
    aggregates,
    overallSuccess: perModel.some((r) => r.verdict === 'PASS'),
  };
}
