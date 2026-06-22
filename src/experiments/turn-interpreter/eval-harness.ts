import { scoreCase, scoreRun } from './scoring.ts';
import { normalizeTurnOutput } from '../../chat/normalize-turn-output.ts';
import { TurnInterpretationSchema } from '../../chat/turn-interpretation.ts';
import type { EvalCase, CandidateResult, CaseResult, EvalRunResult, ManifestMeta, JudgeVerdict, ModelAggregate } from './types.ts';
import type { TurnInterpreterPort } from '../../ports/turn-interpreter.port.ts';

export interface RunEvalInput {
  models: string[];
  datasetId: string;
  cases: EvalCase[];
  datasetFingerprint: string;
  threshold: number;
  repeat?: number;
}
export interface RunEvalDeps {
  interpreterFor: (modelId: string) => TurnInterpreterPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  judge?: (parsed: unknown, c: EvalCase) => Promise<JudgeVerdict>;
}

export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const repeat = input.repeat ?? 1;
  const candidates: CandidateResult[] = [];

  for (const modelId of input.models) {
    const { provider } = deps.providerOf(modelId);
    let interpreter: TurnInterpreterPort;
    try {
      interpreter = deps.interpreterFor(modelId);
    } catch (err) {
      candidates.push({ modelId, provider, ok: false, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const allCaseResults: CaseResult[] = [];
    const judgeVerdicts: JudgeVerdict[] = [];
    for (let r = 0; r < repeat; r++) {
      for (const c of input.cases) {
        const t0 = deps.clock();
        let raw: unknown = undefined;
        try {
          raw = await interpreter.interpret(c.message);
        } catch {
          raw = { __throw: true }; // becomes a schema-invalid miss in scoreCase
        }
        const latency = deps.clock() - t0;
        allCaseResults.push(scoreCase(raw, c, latency));
        if (deps.judge) {
          const parsed = TurnInterpretationSchema.safeParse(normalizeTurnOutput(raw));
          if (parsed.success) judgeVerdicts.push(await deps.judge(parsed.data, c));
        }
      }
    }
    const result = scoreRun(allCaseResults, { threshold: input.threshold });
    candidates.push({ modelId, provider, ok: true, result, judge: deps.judge ? judgeVerdicts : undefined });
  }

  const aggregates: ModelAggregate[] = candidates.map((c) => {
    const cases = c.result?.cases ?? [];
    const meanLatency = cases.length ? cases.reduce((a, x) => a + x.latencyMs, 0) / cases.length : 0;
    return {
      modelId: c.modelId, provider: c.provider, runs: repeat,
      meanScore: c.result?.score ?? 0,
      passRate: c.result ? (c.result.verdict === 'PASS' ? 1 : 0) : 0,
      meanLatencyMs: meanLatency,
      judgeMean: c.judge && c.judge.length ? c.judge.reduce((a, v) => a + v.overallScore, 0) / c.judge.length : undefined,
    };
  });

  const manifest: ManifestMeta = {
    datasetId: input.datasetId, datasetFingerprint: input.datasetFingerprint,
    models: input.models, repeat, threshold: input.threshold,
    caseCount: input.cases.length, judgeEnabled: Boolean(deps.judge),
  };
  return { manifest, candidates, aggregates };
}
