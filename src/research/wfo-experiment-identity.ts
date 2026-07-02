import { createHash } from 'node:crypto';
import { stableStringify } from '../orchestrator/handlers/backtest-support.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function computeWfoExperimentKey(input: {
  baselineExperimentId: string;
  bundleHash: string;
}): string {
  return sha(stableStringify({
    v: 1,
    kind: 'strategy_wfo',
    baselineExperimentId: input.baselineExperimentId,
    bundleHash: input.bundleHash,
  }));
}
