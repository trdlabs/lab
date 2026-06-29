// Curated capability menu for the researcher — what the market-context blocks expose, so the
// LLM anchors hypotheses on real signals instead of inferring them from numbers. Kept separate
// from the critic/refiner PLATFORM_DATA_CAPABILITIES (different audience).
export const RESEARCHER_CAPABILITIES = [
  'AVAILABLE RESEARCH DATA & INDICATORS — anchor hypotheses on these only; a field shown n/a is genuinely absent, never assume it:',
  'Market data: OHLCV candles, volume, open interest (with rising/falling/flat trend), long/short liquidations, funding rate, taker buy/sell volume (→ CVD).',
  'Indicators (computed per timeframe-term and per losing-trade window): EMA, RSI, ATR, realized volatility, MACD, Bollinger Bands (%B and bandwidth), Stochastic, ADX (+DI/−DI), Fibonacci retracements, classic floor Pivots, TTM Squeeze, taker Pressure, OI delta, CVD, liquidation aggregates, funding.',
  'Per-trade context gives indicator snapshots at the entry bar (@entry), the exit bar (@exit), and a post-exit bar (@post, ~60m after exit) of each losing trade, plus a micro table spanning the exit. Use them to reason about both entry quality (what conditions preceded the loss → entry filters) and exit quality (was the stop too tight or the exit premature — did price reverse or keep moving favourably after exit → tighten_stop / widen_stop / exit-timing / trailing).',
  'Execution, fills, leverage and risk sizing stay runner-owned — never prescribe them.',
].join('\n');
