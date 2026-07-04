import type { CanonicalRowV2 } from '@trdlabs/sdk/historical';
export type { CanonicalRowV2 };

export interface MarketHistoryWindow {
  readonly symbol: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface MarketHistoryReadPort {
  /** Canonical rows for [fromMs, toMs], ascending by minute_ts, deduped (last-wins). May be []. */
  getRows(window: MarketHistoryWindow): Promise<readonly CanonicalRowV2[]>;
}
