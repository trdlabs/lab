// src/domain/hypothesis-rules.ts

/** Research-only overlay intents. NOT executable orders or risk authority — the runner/platform
 *  owns sizing, fills and execution. Action-specific param schemas land in SP-4. */
export const OVERLAY_ACTIONS = [
  'skip_entry', 'allow_entry', 'scale_in', 'scale_out',
  'tighten_stop', 'widen_stop', 'exit_now', 'adjust_size', 'no_op',
] as const;
export type OverlayAction = (typeof OVERLAY_ACTIONS)[number];

/** Baseline features the lab always knows how to source. Allowed set for a cycle is this
 *  union the profile's own (normalized) requiredMarketFeatures. */
export const LAB_FEATURE_CATALOG = [
  'ohlcv', 'volume', 'oi', 'funding', 'liquidations', 'cvd', 'market_context', 'market_regime',
] as const;

const FEATURE_SYNONYMS: Record<string, string> = {
  open_interest: 'oi', openinterest: 'oi',
  funding_rate: 'funding', fundingrate: 'funding',
  liqs: 'liquidations', liquidation: 'liquidations',
  cumulative_volume_delta: 'cvd',
  candles: 'ohlcv', candle: 'ohlcv', ohlc: 'ohlcv', price: 'ohlcv',
  vol: 'volume',
  regime: 'market_regime',
};

/** Lowercase, trim, collapse non-alphanumeric runs to '_', strip edge '_', then apply synonyms. */
export function normalizeFeature(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return FEATURE_SYNONYMS[slug] ?? slug;
}

/** Substring markers that signal live-execution intent in research-only text. Conservative by design. */
export const LIVE_INTENT_DENYLIST = [
  'place order', 'placeorder', 'market order', 'marketorder', 'limit order',
  'submit order', 'send order', 'execute trade', 'live trade', 'live trading',
  'real money', 'broker', 'exchange api',
] as const;

/** Markers that signal use of future information. */
export const LOOKAHEAD_DENYLIST = [
  'future candle', 'next candle close', 'next close known', 'future price',
  'lookahead', 'look-ahead', 'look ahead', 'knowledge of the future',
] as const;

/** Claims on runner-owned authority (sizing / fills / execution). */
export const AUTHORITY_DENYLIST = [
  'set leverage', 'adjust leverage', 'position sizing', 'risk sizing',
  'manage fills', 'own execution', 'execution authority',
] as const;

/** Tokens forbidden in rule param keys/values (safe-JSON guard). */
export const PARAM_DENYLIST = [
  'order', 'placeorder', 'marketorder', 'exchange', 'leverage',
  'apikey', 'api_key', 'secret', 'live', 'withdraw',
] as const;
