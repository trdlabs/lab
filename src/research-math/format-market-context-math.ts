import type { MarketContextMath, TermMath, TermMathRow } from './market-context-math.ts';

function num(v: number | null, digits = 2): string {
  return v == null ? 'n/a' : Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function summaryLine(t: TermMath): string {
  const i = t.indicators;
  const parts = [
    `EMA ${num(i.emaFast)}/${num(i.emaSlow)} (${i.emaTrend})`,
    `RSI ${num(i.rsi)} (${i.rsiState})`,
    `ATR ${num(i.atr)}`,
    `realizedVol ${i.realizedVol == null ? 'n/a' : (i.realizedVol * 100).toFixed(3) + '%'}`,
    i.macd ? `MACD ${num(i.macd.line)}/${num(i.macd.signal)}/${num(i.macd.hist)}` : 'MACD n/a',
    i.bollinger ? `BB %B ${num(i.bollinger.pctB)} bw ${(i.bollinger.bandwidth * 100).toFixed(2)}%` : 'BB n/a',
    i.stochastic ? `Stoch ${num(i.stochastic.k)}/${num(i.stochastic.d)}` : 'Stoch n/a',
    i.adx ? `ADX ${num(i.adx.adx)} (+DI ${num(i.adx.plusDi)} -DI ${num(i.adx.minusDi)})` : 'ADX n/a',
    i.fibonacci ? `Fib 0.618=${num(i.fibonacci.levels['0.618']!)}` : 'Fib n/a',
    `OIΔ ${i.oiChangePct == null ? 'n/a' : i.oiChangePct.toFixed(2) + '%'}`,
    `CVD ${i.cvdNet == null ? 'n/a' : num(i.cvdNet) + ' (' + i.cvdTrend + ')'}`,
    `liq L/S ${num(i.liqLongTotal)}/${num(i.liqShortTotal)} (imb ${num(i.liqImbalance)})`,
    `funding ${i.funding == null ? 'n/a' : i.funding}`,
  ];
  return parts.join(' · ');
}

function rowLine(r: TermMathRow): string {
  return `| ${isoMinute(r.tsMs)} | ${num(r.open)} | ${num(r.high)} | ${num(r.low)} | ${num(r.close)} | ${num(r.volume, 0)} | ${num(r.emaFast)} | ${num(r.emaSlow)} | ${num(r.rsi)} | ${num(r.atr)} | ${num(r.oi, 0)} | ${num(r.oiDelta, 0)} | ${r.cvd == null ? 'n/a' : num(r.cvd, 0)} | ${num(r.liqLong, 0)} | ${num(r.liqShort, 0)} |`;
}

function termSection(t: TermMath): string {
  const header = `### ${t.config.label} · ${t.barCount} bars`;
  const cols = `| ts | open | high | low | close | vol | ema${t.config.emaFast} | ema${t.config.emaSlow} | rsi${t.config.rsiPeriod} | atr${t.config.atrPeriod} | oi | oiΔ | cvd | liqL | liqS |`;
  const sep = `|----|------|------|-----|-------|-----|------|-------|-------|-------|----|-----|-----|------|------|`;
  return [header, summaryLine(t), '', cols, sep, ...t.rows.map(rowLine)].join('\n');
}

export function formatMarketContextMath(math: MarketContextMath): string {
  const c = math.coverage;
  const cov = `Coverage: OHLC ${c.hasOhlc ? '✓' : '✗'} · OI ${c.hasOi ? '✓' : '✗'} · funding ${c.hasFunding ? '✓' : '✗'} · liquidations ${c.hasLiquidations ? '✓' : '✗'} · taker ${c.hasTaker ? '✓' : '✗'}`;
  const lines: string[] = [
    `## Market Context: ${math.symbol} — regime: ${math.regime} · bias: ${math.direction}`,
    `Required features: ${math.requiredFeatures.join(', ') || '(none)'}`,
    cov,
    `Window: ${isoMinute(math.window.fromMs)} → ${isoMinute(math.window.toMs)}`,
    '',
  ];
  for (const t of math.terms) { lines.push(termSection(t), ''); }
  if (math.notes.length > 0) lines.push(`> Notes: ${math.notes.join(' ')}`);
  return lines.join('\n').trimEnd() + '\n';
}
