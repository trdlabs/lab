import { sma } from './trend.ts';

export function atr(
  highs: readonly number[], lows: readonly number[], closes: readonly number[], period: number,
): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period <= 0 || n <= period) return out;
  const tr = new Array<number>(n);
  tr[0] = highs[0]! - lows[0]!;
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!),
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export function realizedVol(closes: readonly number[], window: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (window <= 0 || n <= window) return out;
  const rets = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) rets[i] = closes[i - 1]! !== 0 ? (closes[i]! - closes[i - 1]!) / closes[i - 1]! : 0;
  for (let i = window; i < n; i++) {
    let mean = 0;
    for (let j = i - window + 1; j <= i; j++) mean += rets[j]!;
    mean /= window;
    let v = 0;
    for (let j = i - window + 1; j <= i; j++) { const d = rets[j]! - mean; v += d * d; }
    out[i] = Math.sqrt(v / window);
  }
  return out;
}

export interface BollingerPoint { upper: number; mid: number; lower: number; pctB: number; bandwidth: number; }

export function bollinger(values: readonly number[], period: number, k: number): (BollingerPoint | null)[] {
  const n = values.length;
  const out: (BollingerPoint | null)[] = new Array(n).fill(null);
  if (period <= 0) return out;
  const mid = sma(values, period);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i]!; sumSq += values[i]! * values[i]!;
    if (i >= period) { sum -= values[i - period]!; sumSq -= values[i - period]! * values[i - period]!; }
    if (i >= period - 1) {
      const m = mid[i] as number;
      const variance = Math.max(sumSq / period - m * m, 0);
      const sd = Math.sqrt(variance);
      const upper = m + k * sd, lower = m - k * sd;
      const pctB = upper === lower ? 0.5 : (values[i]! - lower) / (upper - lower);
      const bandwidth = m === 0 ? 0 : (upper - lower) / m;
      out[i] = { upper, mid: m, lower, pctB, bandwidth };
    }
  }
  return out;
}
