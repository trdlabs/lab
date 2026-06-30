// Curated capability menu for the researcher — what the market-context blocks expose, so the
// LLM anchors hypotheses on real signals instead of inferring them from numbers. Kept separate
// from the critic/refiner PLATFORM_DATA_CAPABILITIES (different audience).
export const RESEARCHER_CAPABILITIES = [
  'AVAILABLE RESEARCH DATA & INDICATORS — anchor hypotheses on these only; a field shown n/a is genuinely absent, never assume it:',
  'Market data: OHLCV candles, volume, open interest (with rising/falling/flat trend), long/short liquidations, funding rate, taker buy/sell volume (→ CVD).',
  'Indicators (computed per timeframe-term and per losing-trade window): EMA, RSI, ATR, realized volatility, MACD, Bollinger Bands (%B and bandwidth), Stochastic, ADX (+DI/−DI), Fibonacci retracements, classic floor Pivots, TTM Squeeze, taker Pressure, OI delta, CVD, liquidation aggregates, funding.',
  'Per-trade context gives indicator snapshots at the entry bar (@entry), the exit bar (@exit), and a post-exit bar (@post, ~60m after exit) of each losing trade, plus a micro table spanning the exit. Use them to reason about both entry quality (what conditions preceded the loss → entry filters) and exit quality (was the stop too tight or the exit premature — did price reverse or keep moving favourably after exit → tighten_stop / widen_stop / exit-timing / trailing).',
  'GENERALIZE — every rule must be symbol-agnostic: express the observed pattern as a market regime keyed on the indicators above, never on a specific symbol or its absolute price levels. The observed trades are examples of a regime, not the target. Cite specific trades only in `rationale` as evidence; keep `params` clean (numeric thresholds / enums) — no trade names or prices in params.',
  'Execution, fills, leverage and risk sizing stay runner-owned — never prescribe them.',
].join('\n');

// Profit-improvement pass framing — used when focus === 'profit_improvement'. The @post tail shows
// whether price kept moving favourably after exit; if so, the exit left profit on the table.
export const RESEARCHER_PROFIT_FRAMING = [
  'TASK — PROFIT IMPROVEMENT: these are WINNING trades. For each, the @post tail shows what price did after the exit.',
  'When price continued favourably after exit, the exit left profit on the table — propose adjustments that capture it: a larger take-profit, a trailing stop, holding longer, or a partial scale-out instead of a full close (scale_out / widen_stop / exit_now-timing).',
  'Anchor each proposal in the per-trade @entry/@exit/@post evidence, not generic advice.',
].join('\n');

// Applied to BOTH passes — the profile is a revisable hypothesis, not a fixed baseline.
export const RESEARCHER_PROFILE_CRITICAL_FRAMING = [
  'BE CRITICAL OF THE PROFILE: treat the strategy profile as a revisable hypothesis, not a fixed baseline to only add to.',
  'You may propose to relax, remove, or replace existing checks/filters and retire stale rules — e.g. allow_entry / no_op to counter an over-restrictive baked-in skip_entry, or change an exit rule — not only adding new constraints, whenever you judge it improves trading.',
  'The profile\'s currently-active overlay rules are listed below (when present) — critique them.',
].join('\n');
