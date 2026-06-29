import type { TradeContextMath } from './trade-context-math.ts';
import type { TermMath } from './market-context-math.ts';
import { summaryLine, rowLine, isoMinute, tableHeaderLines } from './format-market-context-math.ts';

function summariesFor(label: string, terms: readonly TermMath[]): string[] {
  return terms.map((t) => `${label} ${t.config.label}: ${summaryLine(t)}`);
}

export function formatTradeContextMath(tc: TradeContextMath): string {
  const pnlPct = tc.pnlPct == null ? '' : ` (${tc.pnlPct >= 0 ? '+' : ''}${tc.pnlPct.toFixed(2)}%)`;
  const durMin = Math.round((tc.exitMs - tc.entryMs) / 60_000);
  const lines: string[] = [
    `### Trade ${tc.tradeId} · ${tc.symbol} · pnl ${tc.realizedPnl.toFixed(2)}${pnlPct} · close=${tc.closeReason ?? 'unknown'}`,
    `entry ${isoMinute(tc.entryMs)} → exit ${isoMinute(tc.exitMs)} (${durMin}m)`,
    ...summariesFor('@entry', tc.atEntry),
    ...summariesFor('@exit', tc.atExit),
  ];
  const micro = tc.atExit.find((t) => t.config.key === 'micro');
  if (micro && tc.microRows.length > 0) {
    const [cols, sep] = tableHeaderLines(micro.config);
    lines.push(cols, sep, ...tc.microRows.map(rowLine));
  }
  if (tc.notes.length > 0) lines.push(`> Notes: ${tc.notes.join(' ')}`);
  return lines.join('\n');
}

export function formatTradeContexts(tcs: readonly TradeContextMath[]): string {
  if (tcs.length === 0) return '';
  return ['## Per-trade context (losing trades)', '', ...tcs.map((tc) => formatTradeContextMath(tc) + '\n')]
    .join('\n').trimEnd() + '\n';
}
