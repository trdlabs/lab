export function swingHighLow(
  highs: readonly number[], lows: readonly number[], window: number,
): { swingHigh: number; swingLow: number } {
  const n = highs.length;
  const start = Math.max(0, n - window);
  let hi = -Infinity, lo = Infinity;
  for (let i = start; i < n; i++) { if (highs[i]! > hi) hi = highs[i]!; if (lows[i]! < lo) lo = lows[i]!; }
  return { swingHigh: hi, swingLow: lo };
}

export interface FibLevels { swingHigh: number; swingLow: number; levels: Record<string, number>; }

const FIB_RATIOS: ReadonlyArray<[string, number]> = [
  ['0', 0], ['0.236', 0.236], ['0.382', 0.382], ['0.5', 0.5], ['0.618', 0.618],
  ['0.786', 0.786], ['1', 1], ['1.272', 1.272], ['1.618', 1.618],
];

export function fibonacci(swingHigh: number, swingLow: number): FibLevels {
  const diff = swingHigh - swingLow;
  const levels: Record<string, number> = {};
  for (const [k, r] of FIB_RATIOS) levels[k] = swingHigh - diff * r;
  return { swingHigh, swingLow, levels };
}

export function cvd(buys: readonly (number | null)[], sells: readonly (number | null)[]): (number | null)[] {
  const n = buys.length;
  const out: (number | null)[] = new Array(n).fill(null);
  let cum = 0, started = false;
  for (let i = 0; i < n; i++) {
    if (buys[i] != null && sells[i] != null) {
      cum += (buys[i] as number) - (sells[i] as number);
      out[i] = cum; started = true;
    } else {
      out[i] = started ? cum : null;
    }
  }
  return out;
}

export function oiDelta(oi: readonly (number | null)[]): (number | null)[] {
  const n = oi.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) if (oi[i] != null && oi[i - 1] != null) out[i] = (oi[i] as number) - (oi[i - 1] as number);
  return out;
}

export function pctChangeOverWindow(series: readonly (number | null)[], window: number): number | null {
  const n = series.length;
  if (n === 0) return null;
  const last = series[n - 1];
  const refIdx = n - 1 - window;
  let ref: number | null = refIdx >= 0 ? (series[refIdx] ?? null) : null;
  if (ref == null) { for (const v of series) { if (v != null) { ref = v; break; } } }
  if (last == null || ref == null || ref === 0) return null;
  return ((last - ref) / ref) * 100;
}

export function liquidationAggregates(
  longs: readonly (number | null)[], shorts: readonly (number | null)[],
): { longTotal: number | null; shortTotal: number | null; imbalance: number | null } {
  let lt = 0, st = 0, anyL = false, anyS = false;
  for (const v of longs) if (v != null) { lt += v; anyL = true; }
  for (const v of shorts) if (v != null) { st += v; anyS = true; }
  const longTotal = anyL ? lt : null;
  const shortTotal = anyS ? st : null;
  const imbalance = longTotal != null && shortTotal != null && lt + st !== 0 ? (lt - st) / (lt + st) : null;
  return { longTotal, shortTotal, imbalance };
}

export interface PivotLevels { pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number; }

export function pivots(high: number, low: number, close: number): PivotLevels {
  const pp = (high + low + close) / 3;
  const range = high - low;
  return {
    pp,
    r1: 2 * pp - low,
    s1: 2 * pp - high,
    r2: pp + range,
    s2: pp - range,
    r3: high + 2 * (pp - low),
    s3: low - 2 * (high - pp),
  };
}

export interface TakerPressure { bias: number | null; buyShare: number | null; }

export function takerPressure(
  buys: readonly (number | null)[], sells: readonly (number | null)[], window: number,
): TakerPressure {
  const n = buys.length;
  const start = window > 0 ? Math.max(0, n - window) : n;
  let sumBuy = 0, sumSell = 0, any = false;
  for (let i = start; i < n; i++) {
    const b = buys[i], s = sells[i];
    if (b != null && s != null) { sumBuy += b; sumSell += s; any = true; }
  }
  const total = sumBuy + sumSell;
  if (!any || total === 0) return { bias: null, buyShare: null };
  return { bias: (sumBuy - sumSell) / total, buyShare: sumBuy / total };
}
