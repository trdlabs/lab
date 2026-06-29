import type { ResearcherPort } from '../../ports/researcher.port.ts';
import { scoreResearcherOutput } from './scoring.ts';
import { aggregateRuns } from './aggregate.ts';
import type { CandidateError, CandidateResult, EvalRunResult, JudgeVerdict, ResearcherEvalInput } from './types.ts';

export interface RunEvalDeps {
  researcherFor: (modelId: string) => ResearcherPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  /** Optional LLM-as-a-judge. Best-effort: failure never affects the deterministic verdict. */
  judge?: (output: CandidateResult['rawOutput'], input: ResearcherEvalInput) => Promise<JudgeVerdict>;
}

export function classifyError(err: unknown): CandidateError {
  const message = err instanceof Error ? err.message : String(err);
  let type: CandidateError['type'] = 'unknown';
  if (/timeout|timed out/i.test(message)) type = 'timeout';
  else if (/schema|zod|parse|validation|invalid/i.test(message)) type = 'schema';
  else if (/api key|provider|rate limit|status|fetch|network|econn|unauthorized/i.test(message)) type = 'provider';
  return { type, message };
}

async function runOnce(model: string, input: ResearcherEvalInput, deps: RunEvalDeps): Promise<CandidateResult> {
  const { provider, modelId } = deps.providerOf(model);
  const start = deps.clock();
  try {
    const researcher = deps.researcherFor(model);
    const raw = await researcher.propose({
      profile: input.profile,
      marketContext: { symbol: 'BTCUSDT', ts: '2026-06-17T00:00:00Z', features: { vps_bot_results: 1 } },
      marketRegime: 'ranging',
      similarHypotheses: [],
      botResults: input.botResults,
      tradeEvidence: input.tradeEvidence,
      maxHypotheses: 2,
      focus: 'loss_reduction',
    });
    const latencyMs = deps.clock() - start;
    const score = scoreResearcherOutput(raw, input);

    let judge: JudgeVerdict | null = null;
    if (deps.judge) {
      try {
        judge = await deps.judge(raw, input);
      } catch (judgeErr) {
        process.stderr.write(`judge failed for ${model}: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}\n`);
      }
    }

    return { model, provider, modelId, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null, judge };
  } catch (err) {
    return { model, provider, modelId, latencyMs: deps.clock() - start, verdict: 'FAIL', score: null, rawOutput: null, error: classifyError(err), judge: null };
  }
}

export async function runEval(input: ResearcherEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const repeat = input.repeat ?? 1;
  const perModel: CandidateResult[] = [];
  const aggregates = [];

  for (const model of input.models) {
    const runs: CandidateResult[] = [];
    for (let i = 0; i < repeat; i++) {
      const result = await runOnce(model, input, deps);
      runs.push(result);
      perModel.push(result);
    }
    aggregates.push(aggregateRuns(runs));
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
