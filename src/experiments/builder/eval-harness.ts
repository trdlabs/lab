import type { BuilderPort } from '../../ports/builder.port.ts';
import { BUILDER_SDK_DOC } from '../../adapters/builder/builder-sdk-doc.ts';
import { scoreBuilderOutput } from './scoring.ts';
import type {
  BuilderEvalInput,
  BuilderEvalRunResult,
  CandidateError,
  CandidateResult,
  ModelAggregate,
} from './types.ts';

export interface RunBuilderEvalDeps {
  builderFor: (modelId: string) => BuilderPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
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
    return { model, provider, modelId, hypothesisId: hypothesis.id, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null };
  } catch (err) {
    return {
      model, provider, modelId, hypothesisId: hypothesis.id,
      latencyMs: deps.clock() - start,
      verdict: 'FAIL', score: null, rawOutput: null, error: classifyError(err),
    };
  }
}

function aggregateRuns(runs: CandidateResult[], model: string): ModelAggregate {
  const ok = runs.filter((r) => r.verdict === 'PASS').length;
  const scores = runs.filter((r) => r.score !== null).map((r) => r.score!.score);
  const latencies = runs.map((r) => r.latencyMs);
  return {
    model,
    passRate: runs.length > 0 ? ok / runs.length : 0,
    scoreMean: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    latencyMeanMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
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
