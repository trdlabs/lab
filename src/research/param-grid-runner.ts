import { expandGrid } from './param-grid.ts';
import { rankTopN } from './top-n-prefilter.ts';
import { computeStrategyParamsHash } from './strategy-run-identity.ts';
import { mapWithConcurrency } from './map-with-concurrency.ts';
import type { GridResult, RankedPoint } from './top-n-prefilter.ts';
import type { StrategyExperimentRunExecutor } from './strategy-experiment-run-executor.ts';
import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { ParameterGrid } from '../domain/research-experiment.ts';

export interface ParamGridRunnerDeps {
  strategyRunExecutor: StrategyExperimentRunExecutor;
  /** Max grid points in flight. Default 1 (serial); production wires
   *  RESEARCH_GRID_CONCURRENCY from env via composition.ts. */
  concurrency?: number;
}

export interface RunGridInput {
  experimentId: string;
  strategyBundle: AssembledStrategyBundle;
  strategyProfileId: string;
  trainRun: PlatformRunConfig; // period already = [from, T)
  grid: ParameterGrid;
  metrics: readonly string[];
  maxPoints: number;
  topN: number;
  minTradesTrain: number;
  foldId: number;
}

export interface GridRunOutput {
  allResults: GridResult[];
  ranked: RankedPoint[];
  submitted: number;
  rejected: number;
}

export class ParamGridRunner {
  private readonly d: ParamGridRunnerDeps;

  constructor(deps: ParamGridRunnerDeps) {
    this.d = deps;
  }

  async runGrid(input: RunGridInput): Promise<GridRunOutput> {
    const points = expandGrid(input.grid, input.maxPoints);

    const allResults = await mapWithConcurrency(points, this.d.concurrency ?? 1, async (point) => {
      const outcome = await this.d.strategyRunExecutor.execute({
        experimentId: input.experimentId,
        role: 'train',
        strategyBundle: input.strategyBundle,
        strategyProfileId: input.strategyProfileId,
        run: input.trainRun,
        params: point,
        metrics: [...input.metrics],
      });

      const paramsHash = computeStrategyParamsHash({
        bundleHash: input.strategyBundle.bundleHash,
        platformRun: input.trainRun,
        params: point,
      });

      const result: GridResult = {
        point,
        paramsHash,
        status: outcome.status,
        strategyBacktestRunId: outcome.runId,
        ...(outcome.status === 'completed' ? { metrics: outcome.metrics, tradeCount: outcome.totalTrades } : {}),
      };
      return result;
    });

    const ranked = rankTopN(allResults, { n: input.topN, minTradesTrain: input.minTradesTrain });
    const rejected = allResults.filter((r) => r.status !== 'completed').length;

    return { allResults, ranked, submitted: points.length, rejected };
  }
}
