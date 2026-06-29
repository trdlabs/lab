import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';
import type { Direction } from '../domain/strategy-profile.ts';
import type { MarketRegime } from '../ports/platform-gateway.port.ts';
import { buildMarketContextMath, type TermMath, type TermMathRow } from './market-context-math.ts';
import { TERM_CONFIGS, type TermConfig } from './term-config.ts';

/** A single trade's window can't hold enough 15m/1h bars — micro(1m)+short(5m) only. */
export const TRADE_TERM_CONFIGS: readonly TermConfig[] =
  TERM_CONFIGS.filter((t) => t.key === 'micro' || t.key === 'short');

export interface TradeContextMath {
  readonly tradeId: string; readonly symbol: string;
  readonly entryMs: number; readonly exitMs: number;
  readonly realizedPnl: number; readonly pnlPct: number | null; readonly closeReason: string | null;
  readonly atEntry: readonly TermMath[];
  readonly atExit: readonly TermMath[];
  readonly microRows: readonly TermMathRow[];
  readonly notes: readonly string[];
}

export interface TradeContextMathInput {
  readonly tradeId: string; readonly symbol: string;
  readonly rows: readonly CanonicalRowV2[];
  readonly entryMs: number; readonly exitMs: number;
  readonly realizedPnl: number; readonly pnlPct: number | null; readonly closeReason: string | null;
  readonly direction: Direction; readonly regime: MarketRegime;
  readonly requiredFeatures: readonly string[];
  readonly microTableRows?: number;
}

export function buildTradeContextMath(input: TradeContextMathInput, nowMs: number): TradeContextMath {
  const { rows } = input;
  const microTableRows = input.microTableRows ?? 10;
  const head = {
    tradeId: input.tradeId, symbol: input.symbol, entryMs: input.entryMs, exitMs: input.exitMs,
    realizedPnl: input.realizedPnl, pnlPct: input.pnlPct, closeReason: input.closeReason,
  };

  if (rows.length === 0) {
    return { ...head, atEntry: [], atExit: [], microRows: [], notes: ['No market history rows for this trade window.'] };
  }

  const fromMs = rows[0]!.minute_ts;
  const baseInput = {
    symbol: input.symbol, direction: input.direction, regime: input.regime,
    requiredFeatures: input.requiredFeatures, terms: TRADE_TERM_CONFIGS,
  };

  // Slice rows to the snapshot bar (ascending minute_ts); fallback to first row.
  // The engine does NOT filter by window.toMs — caller must pre-slice.
  let entryIdx = 0;
  for (let i = 0; i < rows.length; i++) { if (rows[i]!.minute_ts <= input.entryMs) entryIdx = i; else break; }
  let exitIdx = 0;
  for (let i = 0; i < rows.length; i++) { if (rows[i]!.minute_ts <= input.exitMs) exitIdx = i; else break; }

  const atEntryMath = buildMarketContextMath(
    { ...baseInput, rows: rows.slice(0, entryIdx + 1), window: { fromMs, toMs: input.entryMs } }, nowMs);
  const atExitMath = buildMarketContextMath(
    { ...baseInput, rows: rows.slice(0, exitIdx + 1), window: { fromMs, toMs: input.exitMs } }, nowMs);

  const microExit = atExitMath.terms.find((t) => t.config.key === 'micro');
  const microRows = microExit ? microExit.rows.slice(-microTableRows) : [];

  const entryKeys = new Set(atEntryMath.terms.map((t) => t.config.key));
  const warmupNotes = atExitMath.terms
    .filter((t) => !entryKeys.has(t.config.key))
    .map((t) => `Term ${t.config.label} unavailable at entry: insufficient warmup before the trade.`);
  const notes = Array.from(new Set([...atEntryMath.notes, ...atExitMath.notes, ...warmupNotes]));

  return { ...head, atEntry: atEntryMath.terms, atExit: atExitMath.terms, microRows, notes };
}
