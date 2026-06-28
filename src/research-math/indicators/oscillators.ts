function smaTail(values: readonly (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0, count = 0;
  const buf: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { buf.length = 0; sum = 0; count = 0; continue; } // restart on gap
    buf.push(v); sum += v; count++;
    if (buf.length > period) { sum -= buf.shift() as number; count--; }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

export interface StochPoint { k: number; d: number; }

export function stochastic(
  highs: readonly number[], lows: readonly number[], closes: readonly number[],
  kPeriod: number, dPeriod: number, smooth: number,
): (StochPoint | null)[] {
  const n = closes.length;
  const out: (StochPoint | null)[] = new Array(n).fill(null);
  const rawK: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
    rawK[i] = hh === ll ? 50 : (100 * (closes[i] - ll)) / (hh - ll);
  }
  const kSmoothed = smaTail(rawK, smooth);
  const dLine = smaTail(kSmoothed, dPeriod);
  for (let i = 0; i < n; i++) {
    if (kSmoothed[i] != null && dLine[i] != null) out[i] = { k: kSmoothed[i] as number, d: dLine[i] as number };
  }
  return out;
}

export interface AdxPoint { adx: number; plusDi: number; minusDi: number; }

export function adx(
  highs: readonly number[], lows: readonly number[], closes: readonly number[], period: number,
): (AdxPoint | null)[] {
  const n = closes.length;
  const out: (AdxPoint | null)[] = new Array(n).fill(null);
  if (period <= 0 || n < 2 * period) return out;
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  let trSum = 0, pdmSum = 0, mdmSum = 0;
  for (let i = 1; i <= period; i++) { trSum += tr[i]; pdmSum += plusDM[i]; mdmSum += minusDM[i]; }
  const dx = new Array<number | null>(n).fill(null);
  const pDi = new Array<number | null>(n).fill(null);
  const mDi = new Array<number | null>(n).fill(null);
  const at = (ts: number, pd: number, md: number) => {
    const p = ts === 0 ? 0 : (100 * pd) / ts;
    const m = ts === 0 ? 0 : (100 * md) / ts;
    const denom = p + m;
    return { p, m, dxv: denom === 0 ? 0 : (100 * Math.abs(p - m)) / denom };
  };
  let r = at(trSum, pdmSum, mdmSum);
  dx[period] = r.dxv; pDi[period] = r.p; mDi[period] = r.m;
  for (let i = period + 1; i < n; i++) {
    trSum = trSum - trSum / period + tr[i];
    pdmSum = pdmSum - pdmSum / period + plusDM[i];
    mdmSum = mdmSum - mdmSum / period + minusDM[i];
    r = at(trSum, pdmSum, mdmSum);
    dx[i] = r.dxv; pDi[i] = r.p; mDi[i] = r.m;
  }
  const firstAdx = 2 * period - 1;
  let sum = 0;
  for (let i = period; i <= firstAdx; i++) sum += dx[i] as number;
  let adxPrev = sum / period;
  out[firstAdx] = { adx: adxPrev, plusDi: pDi[firstAdx] as number, minusDi: mDi[firstAdx] as number };
  for (let i = firstAdx + 1; i < n; i++) {
    adxPrev = (adxPrev * (period - 1) + (dx[i] as number)) / period;
    out[i] = { adx: adxPrev, plusDi: pDi[i] as number, minusDi: mDi[i] as number };
  }
  return out;
}
