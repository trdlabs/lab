import { describe, it, expect } from 'vitest';
import { STRATEGY_RUN_KIND, type StrategyBacktestRun } from './strategy-backtest-run.ts';

describe('StrategyBacktestRun', () => {
  it('STRATEGY_RUN_KIND is the baseline literal', () => {
    expect(STRATEGY_RUN_KIND).toBe('strategy_baseline');
  });
  it('a run row omits every hypothesis/overlay field', () => {
    const run: StrategyBacktestRun = {
      id: 'sbr_1', strategyProfileId: 'p1', strategyBundleId: 'mod_long_oi', bundleHash: 'sha256:abc',
      paramsHash: 'ph1', runKind: STRATEGY_RUN_KIND, platformRunId: 'run_1', correlationId: 'sanity',
      params: {}, status: 'submitted', metrics: null, platformRun: null, artifactRefs: [],
      admission: null,
      platformContractVersion: 'pending', sdkContractVersion: 'builder-sdk-v0', backend: 'research_platform',
      submittedAt: 't', finishedAt: null, createdAt: 't', updatedAt: 't',
    };
    // @ts-expect-error hypothesisId does not exist on a strategy baseline run
    run.hypothesisId;
    expect(run.strategyBundleId).toBe('mod_long_oi');
  });
});
