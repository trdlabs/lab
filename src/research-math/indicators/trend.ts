export function sma(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (values[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

export function rsi(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdPoint { line: number; signal: number; hist: number; }

export function macd(
  values: readonly number[], fast: number, slow: number, signalPeriod: number,
): (MacdPoint | null)[] {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const out: (MacdPoint | null)[] = new Array(values.length).fill(null);
  const lineDefined: number[] = [];
  const lineIdx: number[] = [];
  const line: (number | null)[] = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? (emaFast[i] as number) - (emaSlow[i] as number) : null);
  for (let i = 0; i < line.length; i++) {
    if (line[i] != null) { lineDefined.push(line[i] as number); lineIdx.push(i); }
  }
  const sig = ema(lineDefined, signalPeriod);
  for (let j = 0; j < sig.length; j++) {
    if (sig[j] != null) {
      const i = lineIdx[j];
      const l = line[i] as number;
      out[i] = { line: l, signal: sig[j] as number, hist: l - (sig[j] as number) };
    }
  }
  return out;
}
