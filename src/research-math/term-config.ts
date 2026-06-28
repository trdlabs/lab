import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

export type TermKey = 'micro' | 'short' | 'swing' | 'long';

export interface TermConfig {
  readonly key: TermKey;
  readonly label: string;
  readonly tfMs: number;
  readonly maxRows: number;
  readonly minBars: number;
  readonly emaFast: number;
  readonly emaSlow: number;
  readonly rsiPeriod: number;
  readonly atrPeriod: number;
  readonly realizedVolWindow: number;
  readonly macd: readonly [number, number, number];
  readonly bbPeriod: number;
  readonly bbK: number;
  readonly stoch: readonly [number, number, number];
  readonly adxPeriod: number;
  readonly swingWindow: number;
  readonly oiPctWindow: number;
}

const MIN = 60_000;

export const TERM_CONFIGS: readonly TermConfig[] = [
  {
    key: 'micro', label: 'Micro (1m)', tfMs: MIN, maxRows: 30, minBars: 30,
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, realizedVolWindow: 14,
    macd: [8, 21, 5], bbPeriod: 8, bbK: 2, stoch: [5, 3, 3], adxPeriod: 9, swingWindow: 60, oiPctWindow: 30,
  },
  {
    key: 'short', label: 'Short (5m)', tfMs: 5 * MIN, maxRows: 24, minBars: 30,
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, realizedVolWindow: 14,
    macd: [8, 21, 5], bbPeriod: 10, bbK: 2, stoch: [5, 3, 3], adxPeriod: 9, swingWindow: 48, oiPctWindow: 24,
  },
  {
    key: 'swing', label: 'Swing (15m)', tfMs: 15 * MIN, maxRows: 24, minBars: 30,
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, realizedVolWindow: 14,
    macd: [12, 26, 9], bbPeriod: 20, bbK: 2, stoch: [14, 3, 3], adxPeriod: 14, swingWindow: 48, oiPctWindow: 24,
  },
  {
    key: 'long', label: 'Long (1h)', tfMs: 60 * MIN, maxRows: 24, minBars: 28,
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, realizedVolWindow: 14,
    macd: [12, 26, 9], bbPeriod: 20, bbK: 2, stoch: [14, 3, 3], adxPeriod: 14, swingWindow: 48, oiPctWindow: 24,
  },
];

export function inferCadenceMs(rows: readonly Pick<CanonicalRowV2, 'minute_ts'>[]): number | null {
  let min: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i]!.minute_ts - rows[i - 1]!.minute_ts;
    if (gap > 0 && (min === null || gap < min)) min = gap;
  }
  return min;
}

export function isTermIncluded(cadenceMs: number, barCount: number, cfg: TermConfig): boolean {
  return cadenceMs <= cfg.tfMs && barCount >= cfg.minBars;
}
