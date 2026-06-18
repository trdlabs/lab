/**
 * Static SDK reference doc injected into the Builder agent prompt.
 * Covers: overlay module format, StrategyContext API, OverlayDecision union, code examples.
 * Real RAG over living SDK docs arrives in SP-5.
 */
export const BUILDER_SDK_DOC = `
# Builder SDK — Overlay Module Reference

## Module Format

The builder produces a **hypothesis overlay module**: a single TypeScript file that exports a
constant named \`overlay\`. The build validator REQUIRES the entry file to contain the string
\`overlay\` as an exported identifier.

### Minimal valid overlay (data-driven rules, preferred format)

\`\`\`ts
// index.ts
export const overlay = {
  appliesTo: 'long',            // 'long' | 'short' | 'both' — must match hypothesis
  rules: [
    {
      when: 'OI trend persists for 3+ consecutive bars',
      action: 'skip_entry',     // see ACTION CATALOG below
      params: { lookback: 3, oiDropPct: 5 },  // concrete numeric thresholds, not placeholders
    },
  ],
};
\`\`\`

### Data-driven rules — more complete example with OI + liquidation conditions

\`\`\`ts
// index.ts — skip long entry when OI spikes alongside price drop
export const overlay = {
  appliesTo: 'long',
  rules: [
    {
      when: 'OI rises >8% over 3 bars while price drops >2%: crowded long dump signal',
      action: 'skip_entry',
      params: { oiRiseThresholdPct: 8, priceDropThresholdPct: 2, lookback: 3 },
    },
    {
      when: 'Long liquidations exceed 1.5x short liquidations in last 2 bars',
      action: 'skip_entry',
      params: { liquidationRatio: 1.5, lookback: 2 },
    },
  ],
};
\`\`\`

### Overlay with logic (function-based, for conditional checks)

In functional style the return value is an **OverlayDecision** — NOT the same as data-driven action names.
Valid return kinds: \`'pass'\`, \`'veto'\`, \`'patch'\`, \`'annotate'\`.
To "skip an entry" functionally, return \`{kind:'veto', reasonCode:'...', rationale:'...'}\`.

\`\`\`ts
// index.ts
export const overlay = function apply(ctx) {
  // ctx.data.closedCandles(N) returns the last N CLOSED bars (no lookahead)
  const candles = ctx.data.closedCandles(3);
  const risingCandles = candles.filter((c) => c.close > c.open).length;

  // Veto entry when 2+ of last 3 candles are green (OI trend proxy)
  if (ctx.position === null && risingCandles >= 2) {
    return { kind: 'veto', reasonCode: 'consecutive_green_candles', rationale: 'Entry skipped: bullish candle trend suggests OI overextension' };
  }
  return { kind: 'pass' };
};
\`\`\`

### Overlay combining OI data (when market data is available)

\`\`\`ts
// index.ts
export const overlay = function apply(ctx) {
  if (ctx.position === null) {
    // Only filter entries (position === null means we are evaluating a pending entry)
    const oi = ctx.market?.openInterest;
    if (oi !== undefined && oi.value > 0) {
      // Veto entry when OI is abnormally high (proxy for crowded trade)
      const candles = ctx.data.closedCandles(5);
      const avgClose = candles.reduce((s, c) => s + c.close, 0) / candles.length;
      if (ctx.bar.close < avgClose * 0.99) {
        return { kind: 'veto', reasonCode: 'oi_high_price_weak', rationale: 'High OI with weakening price: crowded long, skip entry' };
      }
    }
  }
  return { kind: 'pass' };
};
\`\`\`

## StrategyContext API (read-only, passed to every hook)

\`\`\`ts
interface StrategyContext {
  symbol: string;                 // e.g. 'EDGEUSDT'
  bar: {                          // CURRENT (closed) bar
    ts: number;                   // Unix ms
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  position: {                     // null if no open position
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
    stop?: number;
    take?: number;
  } | null;
  pendingIntent: {                 // null if no pending order
    kind: string;
    side?: 'long' | 'short';
    createdTs: number;
  } | null;
  portfolio: {
    equity: number;
    openPositions: number;
  };
  data: {
    closedCandles(lookback: number): readonly Bar[];   // bars BEFORE current (no lookahead)
    indicatorAsOf(name: string): number | undefined;  // pre-declared indicator as-of bar
  };
  indicators: {
    value(name: string, ...args: number[]): number | undefined;  // e.g. value('sma', 20)
  };
  market?: {                       // ONLY present when OI/liquidations data was loaded
    openInterest?: { value: number; trend?: 'up' | 'down' | 'flat' };
    liquidationsLong?: number;     // liquidation volume for long positions
    liquidationsShort?: number;    // liquidation volume for short positions
  };
  params: Record<string, unknown>; // run-level params from backtester
  clock: { now(): number };        // deterministic simulated clock (ms)
  rng: { next(): number };         // seeded deterministic RNG [0, 1)
}
\`\`\`

## OverlayDecision Union (return from function-based overlay ONLY)

These return kinds are for **functional overlays** (Style B). Do NOT use them in data-driven rules.

\`\`\`ts
// Pass through — do nothing, let base strategy proceed
{ kind: 'pass' }

// Veto the base decision (blocks entry/exit/stop action)
{ kind: 'veto'; reasonCode: string; rationale?: string }

// Patch the base decision (e.g. tighten stop price)
{ kind: 'patch'; patch: object }

// Annotate only — add metadata without affecting decision
{ kind: 'annotate'; tags?: string[]; notes?: string }
\`\`\`

> **Important distinction**: Functional overlays return \`{kind:'veto'}\` to skip an entry.
> Data-driven rules use \`action:'skip_entry'\`. These are two separate style systems — never mix them.

## ACTION CATALOG (data-driven rules only)

| action | description |
|--------|-------------|
| skip_entry | veto the pending entry intent |
| allow_entry | force-allow a blocked entry |
| tighten_stop | move stop closer to current price |
| widen_stop | move stop further from current price |
| exit_now | close position immediately |
| scale_in | add to existing position (DCA mode) |
| scale_out | partial exit |
| adjust_size | modify position sizing hint |
| no_op | explicitly do nothing (annotate only) |

## FORBIDDEN — will fail build validation

- ANY \`import\` / \`require\` / \`from\` statement
- \`process.env\`, \`eval\`, \`new Function\`, \`fetch\`, \`WebSocket\`
- Forward-looking data: accessing future bars, price targets from the future
- Live trading intent in text: "place order", "market order", "broker", "exchange api"

## Manifest Requirements

\`\`\`ts
manifest: {
  moduleId: 'overlay-<hypothesisId>',  // e.g. "overlay-h-abc123"
  moduleKind: 'hypothesis_overlay',    // MUST be exactly this literal
  appliesTo: 'long' | 'short' | 'both',
  entry: 'index.ts',                   // always 'index.ts'
  exports: ['overlay'],                // MUST be exactly ['overlay']
  capabilities: string[],             // ONLY features from hypothesis.requiredFeatures
  sdkContractVersion: 'builder-sdk-v0', // MUST be exactly this value
}
\`\`\`
`.trim();
