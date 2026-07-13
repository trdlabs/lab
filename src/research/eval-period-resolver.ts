// src/research/eval-period-resolver.ts
import type { DatasetDescriptor } from '../ports/research-run-lifecycle.ts';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';

export type EvalPeriodFallbackReason =
  | 'no_datasets'
  | 'dataset_not_found'
  | 'no_date_range'
  | 'invalid_range';

export interface ResolvedEvalPeriod {
  readonly runConfig: PlatformRunConfig;
  readonly source: 'dataset' | 'fallback';
  readonly fallbackReason?: EvalPeriodFallbackReason;
}

/** Pure. Never throws, no I/O, no clock. Binds `fallback.period` to the dateRange of the dataset
 *  matching `fallback.datasetId` + `fallback.timeframe`; any miss/invalid returns `fallback` with a
 *  reason. The handler owns discovery I/O + event emission (R3b-1 §3.1). */
export function resolveEvalPeriod(
  datasets: readonly DatasetDescriptor[],
  fallback: PlatformRunConfig,
): ResolvedEvalPeriod {
  if (datasets.length === 0) {
    return { runConfig: fallback, source: 'fallback', fallbackReason: 'no_datasets' };
  }
  const match = datasets.find(
    (d) => d.datasetId === fallback.datasetId && d.timeframe === fallback.timeframe,
  );
  if (!match) {
    return { runConfig: fallback, source: 'fallback', fallbackReason: 'dataset_not_found' };
  }
  const range = match.dateRange;
  if (!range || !range.from || !range.to) {
    return { runConfig: fallback, source: 'fallback', fallbackReason: 'no_date_range' };
  }
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
    return { runConfig: fallback, source: 'fallback', fallbackReason: 'invalid_range' };
  }
  return {
    runConfig: { ...fallback, period: { from: range.from, to: range.to } },
    source: 'dataset',
  };
}
