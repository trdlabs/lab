// src/experiments/strategy-analyst/eval-harness.ts
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import { scoreProfile } from './scoring.ts';
import type { CandidateError, CandidateResult, EvalRunResult, JudgeVerdict } from './types.ts';

export interface RunEvalInput {
  models: string[];
  fixtureId: string;
  fixtureText: string;
  fixtureFingerprint: string;
  threshold: number;
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

export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const perModel: CandidateResult[] = [];

  for (const model of input.models) {
    const { provider, modelId } = deps.providerOf(model);
    const start = deps.clock();
    try {
      const analyst = deps.analystFor(model);
      const raw = await analyst.analyze({ kind: 'manual_description', content: input.fixtureText, title: input.fixtureId });
      const latencyMs = deps.clock() - start;
      const score = scoreProfile(raw, { threshold: input.threshold });

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

      perModel.push({ model, provider, modelId, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null, judge });
    } catch (err) {
      const latencyMs = deps.clock() - start;
      perModel.push({ model, provider, modelId, latencyMs, verdict: 'FAIL', score: null, rawOutput: null, error: classifyError(err), judge: null });
    }
  }

  return {
    fixture: { id: input.fixtureId, fingerprint: input.fixtureFingerprint },
    threshold: input.threshold,
    judgeEnabled: deps.judge != null,
    models: input.models,
    perModel,
    overallSuccess: perModel.some((r) => r.verdict === 'PASS'),
  };
}
