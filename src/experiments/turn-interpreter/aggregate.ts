import type { ModelAggregate } from './types.ts';

export const ENV_RECOMMEND_MARGIN = 0.05;

export function rankAggregates(aggregates: ModelAggregate[], judgeEnabled: boolean): ModelAggregate[] {
  return [...aggregates].sort((a, b) => {
    if (judgeEnabled && a.judgeMean !== undefined && b.judgeMean !== undefined && a.judgeMean !== b.judgeMean) {
      return b.judgeMean - a.judgeMean;
    }
    if (a.meanScore !== b.meanScore) return b.meanScore - a.meanScore;
    if (a.passRate !== b.passRate) return b.passRate - a.passRate;
    return a.meanLatencyMs - b.meanLatencyMs;
  });
}

export function recommendEnv(
  ranked: ModelAggregate[],
  opts: { incumbentModelId: string; threshold: number; margin?: number },
): { decision: 'own-env' | 'keep-sharing'; recommendedModelId: string | null; incumbentScore: number; bestScore: number; delta: number; reason: string } {
  const margin = opts.margin ?? ENV_RECOMMEND_MARGIN;
  const incumbent = ranked.find((a) => a.modelId === opts.incumbentModelId);
  const best = ranked[0];
  const incumbentScore = incumbent?.meanScore ?? 0;
  const bestScore = best?.meanScore ?? 0;
  const delta = bestScore - incumbentScore;
  if (best && best.modelId !== opts.incumbentModelId && bestScore >= opts.threshold && delta >= margin) {
    return {
      decision: 'own-env',
      recommendedModelId: best.modelId,
      incumbentScore,
      bestScore,
      delta,
      reason: `${best.modelId} clears threshold ${opts.threshold} and beats incumbent by ${delta.toFixed(3)} (≥ ${margin})`,
    };
  }
  return {
    decision: 'keep-sharing',
    recommendedModelId: null,
    incumbentScore,
    bestScore,
    delta,
    reason: `no candidate both clears ${opts.threshold} and beats incumbent by ≥ ${margin}`,
  };
}
