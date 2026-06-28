import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';
import type { Direction } from '../domain/strategy-profile.ts';
import type { MarketRegime } from '../ports/platform-gateway.port.ts';
import { ema, rsi, macd, type MacdPoint } from './indicators/trend.ts';
import { atr, realizedVol, bollinger, type BollingerPoint } from './indicators/volatility.ts';
import { stochastic, adx, type StochPoint, type AdxPoint } from './indicators/oscillators.ts';
import {
  swingHighLow, fibonacci, cvd, oiDelta, pctChangeOverWindow, liquidationAggregates, type FibLevels,
} from './indicators/levels.ts';
import { resampleRows } from './resample.ts';
import { TERM_CONFIGS, inferCadenceMs, isTermIncluded, type TermConfig } from './term-config.ts';

export interface CoverageFlags {
  readonly hasOhlc: boolean; readonly hasOi: boolean; readonly hasFunding: boolean;
  readonly hasLiquidations: boolean; readonly hasTaker: boolean;
}

export interface TermMathRow {
  readonly tsMs: number;
  readonly open: number; readonly high: number; readonly low: number; readonly close: number;
  readonly volume: number;
  readonly emaFast: number | null; readonly emaSlow: number | null;
  readonly rsi: number | null; readonly atr: number | null;
  readonly oi: number | null; readonly oiDelta: number | null; readonly cvd: number | null;
  readonly liqLong: number | null; readonly liqShort: number | null;
}

export interface TermIndicatorSnapshot {
  readonly close: number;
  readonly emaFast: number | null; readonly emaSlow: number | null;
  readonly emaTrend: 'above' | 'below' | 'cross' | 'unknown';
  readonly rsi: number | null; readonly rsiState: 'overbought' | 'oversold' | 'neutral' | 'unknown';
  readonly atr: number | null; readonly realizedVol: number | null;
  readonly macd: MacdPoint | null; readonly bollinger: BollingerPoint | null;
  readonly stochastic: StochPoint | null; readonly adx: AdxPoint | null;
  readonly fibonacci: FibLevels | null;
  readonly oiChangePct: number | null; readonly funding: number | null;
  readonly cvdNet: number | null; readonly cvdTrend: 'rising' | 'falling' | 'flat' | 'unknown';
  readonly liqLongTotal: number | null; readonly liqShortTotal: number | null; readonly liqImbalance: number | null;
}

export interface TermMath {
  readonly config: TermConfig; readonly barCount: number;
  readonly rows: readonly TermMathRow[]; readonly indicators: TermIndicatorSnapshot; readonly coverage: CoverageFlags;
}

export interface MarketContextMath {
  readonly symbol: string; readonly generatedAtMs: number;
  readonly window: { fromMs: number; toMs: number };
  readonly direction: Direction; readonly regime: MarketRegime;
  readonly requiredFeatures: readonly string[];
  readonly coverage: CoverageFlags; readonly terms: readonly TermMath[]; readonly notes: readonly string[];
}

export interface MarketContextMathInput {
  readonly symbol: string; readonly rows: readonly CanonicalRowV2[];
  readonly direction: Direction; readonly regime: MarketRegime;
  readonly requiredFeatures: readonly string[];
  readonly window: { fromMs: number; toMs: number };
  readonly terms?: readonly TermConfig[];
}

function coverageOf(rows: readonly CanonicalRowV2[]): CoverageFlags {
  return {
    hasOhlc: rows.some((r) => r.open != null && r.high != null && r.low != null),
    hasOi: rows.some((r) => r.has_oi),
    hasFunding: rows.some((r) => r.has_funding),
    hasLiquidations: rows.some((r) => r.has_liquidations),
    hasTaker: rows.some((r) => r.has_taker_flow),
  };
}

function rsiState(v: number | null): TermIndicatorSnapshot['rsiState'] {
  if (v == null) return 'unknown';
  if (v >= 70) return 'overbought';
  if (v <= 30) return 'oversold';
  return 'neutral';
}

function emaTrend(fast: number | null, slow: number | null): TermIndicatorSnapshot['emaTrend'] {
  if (fast == null || slow == null) return 'unknown';
  if (Math.abs(fast - slow) / (Math.abs(slow) || 1) < 1e-6) return 'cross';
  return fast > slow ? 'above' : 'below';
}

function cvdTrendOf(cvdSeries: readonly (number | null)[]): TermIndicatorSnapshot['cvdTrend'] {
  const defined = cvdSeries.filter((v): v is number => v != null);
  if (defined.length < 2) return 'unknown';
  const d = defined[defined.length - 1]! - defined[0]!;
  if (Math.abs(d) < 1e-9) return 'flat';
  return d > 0 ? 'rising' : 'falling';
}

function buildTerm(rows: readonly CanonicalRowV2[], cfg: TermConfig): TermMath {
  const cov = coverageOf(rows);
  const closes = rows.map((r) => r.close);
  const highs = rows.map((r) => r.high);
  const lows = rows.map((r) => r.low);
  const oiArr = rows.map((r) => (r.has_oi ? r.oi_total_usd : null));
  const buys = rows.map((r) => (r.has_taker_flow ? r.taker_buy_volume_usd : null));
  const sells = rows.map((r) => (r.has_taker_flow ? r.taker_sell_volume_usd : null));
  const liqL = rows.map((r) => (r.has_liquidations ? r.liq_long_usd : null));
  const liqS = rows.map((r) => (r.has_liquidations ? r.liq_short_usd : null));

  const emaF = ema(closes, cfg.emaFast);
  const emaS = ema(closes, cfg.emaSlow);
  const rsiArr = rsi(closes, cfg.rsiPeriod);
  const atrArr = cov.hasOhlc ? atr(highs, lows, closes, cfg.atrPeriod) : new Array(rows.length).fill(null);
  const rvArr = realizedVol(closes, cfg.realizedVolWindow);
  const macdArr = macd(closes, cfg.macd[0], cfg.macd[1], cfg.macd[2]);
  const bbArr = bollinger(closes, cfg.bbPeriod, cfg.bbK);
  const stochArr = cov.hasOhlc ? stochastic(highs, lows, closes, cfg.stoch[0], cfg.stoch[1], cfg.stoch[2]) : new Array(rows.length).fill(null);
  const adxArr = cov.hasOhlc ? adx(highs, lows, closes, cfg.adxPeriod) : new Array(rows.length).fill(null);
  const cvdArr = cov.hasTaker ? cvd(buys, sells) : new Array(rows.length).fill(null);
  const oiDeltaArr = oiDelta(oiArr);

  const tableRows: TermMathRow[] = rows.map((r, i) => ({
    tsMs: r.minute_ts,
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    emaFast: emaF[i] ?? null, emaSlow: emaS[i] ?? null, rsi: rsiArr[i] ?? null, atr: atrArr[i],
    oi: cov.hasOi ? r.oi_total_usd : null, oiDelta: oiDeltaArr[i] ?? null, cvd: cvdArr[i],
    liqLong: cov.hasLiquidations ? r.liq_long_usd : null, liqShort: cov.hasLiquidations ? r.liq_short_usd : null,
  })).slice(-cfg.maxRows);

  const last = rows.length - 1;
  const swing = cov.hasOhlc ? swingHighLow(highs, lows, cfg.swingWindow) : null;
  const liq = liquidationAggregates(liqL, liqS);
  const indicators: TermIndicatorSnapshot = {
    close: closes[last]!,
    emaFast: emaF[last] ?? null, emaSlow: emaS[last] ?? null, emaTrend: emaTrend(emaF[last] ?? null, emaS[last] ?? null),
    rsi: rsiArr[last] ?? null, rsiState: rsiState(rsiArr[last] ?? null),
    atr: atrArr[last], realizedVol: rvArr[last] ?? null,
    macd: macdArr[last] ?? null, bollinger: bbArr[last] ?? null, stochastic: stochArr[last], adx: adxArr[last],
    fibonacci: swing ? fibonacci(swing.swingHigh, swing.swingLow) : null,
    oiChangePct: cov.hasOi ? pctChangeOverWindow(oiArr, cfg.oiPctWindow) : null,
    funding: cov.hasFunding ? (rows[last]!.funding_rate ?? null) : null,
    cvdNet: cov.hasTaker ? (cvdArr[last] ?? null) : null, cvdTrend: cov.hasTaker ? cvdTrendOf(cvdArr) : 'unknown',
    liqLongTotal: liq.longTotal, liqShortTotal: liq.shortTotal, liqImbalance: liq.imbalance,
  };

  return { config: cfg, barCount: rows.length, rows: tableRows, indicators, coverage: cov };
}

export function buildMarketContextMath(input: MarketContextMathInput, nowMs: number): MarketContextMath {
  const configs = input.terms ?? TERM_CONFIGS;
  const overall = coverageOf(input.rows);
  const notes: string[] = [];
  const terms: TermMath[] = [];
  const cadence = inferCadenceMs(input.rows);

  if (input.rows.length === 0 || cadence == null) {
    notes.push('No market history rows available for this symbol/window.');
    return {
      symbol: input.symbol, generatedAtMs: nowMs, window: input.window,
      direction: input.direction, regime: input.regime, requiredFeatures: input.requiredFeatures,
      coverage: overall, terms: [], notes,
    };
  }

  for (const cfg of configs) {
    const resampled = cfg.tfMs === cadence ? [...input.rows] : resampleRows(input.rows, cfg.tfMs);
    if (!isTermIncluded(cadence, resampled.length, cfg)) {
      if (cadence > cfg.tfMs) notes.push(`Term ${cfg.label} skipped: source cadence ${Math.round(cadence / 60_000)}m is coarser than the term timeframe.`);
      else notes.push(`Term ${cfg.label} skipped: only ${resampled.length} bars (need ${cfg.minBars}).`);
      continue;
    }
    terms.push(buildTerm(resampled, cfg));
  }

  if (!overall.hasTaker) notes.push('Taker flow absent in this source → CVD shown as n/a.');
  if (!overall.hasOhlc) notes.push('OHLC high/low absent → ATR/Stochastic/ADX/Fibonacci shown as n/a.');

  return {
    symbol: input.symbol, generatedAtMs: nowMs, window: input.window,
    direction: input.direction, regime: input.regime, requiredFeatures: input.requiredFeatures,
    coverage: overall, terms, notes,
  };
}
