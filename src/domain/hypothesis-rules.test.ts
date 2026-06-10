// src/domain/hypothesis-rules.test.ts
import { describe, it, expect } from 'vitest';
import {
  OVERLAY_ACTIONS, LAB_FEATURE_CATALOG, normalizeFeature,
  LIVE_INTENT_DENYLIST, LOOKAHEAD_DENYLIST, PARAM_DENYLIST, AUTHORITY_DENYLIST,
} from './hypothesis-rules.ts';

describe('hypothesis-rules', () => {
  it('exposes the overlay action allowlist', () => {
    expect(OVERLAY_ACTIONS).toContain('skip_entry');
    expect(OVERLAY_ACTIONS).toContain('no_op');
  });

  it('exposes the lab feature catalog', () => {
    expect([...LAB_FEATURE_CATALOG]).toEqual(
      ['ohlcv', 'volume', 'oi', 'funding', 'liquidations', 'cvd', 'market_context', 'market_regime'],
    );
  });

  it('normalizes case, separators and trims', () => {
    expect(normalizeFeature('  Open Interest ')).toBe('oi');
    expect(normalizeFeature('CVD')).toBe('cvd');
    expect(normalizeFeature('funding-rate')).toBe('funding');
    expect(normalizeFeature('market regime')).toBe('market_regime');
  });

  it('maps known synonyms', () => {
    expect(normalizeFeature('open_interest')).toBe('oi');
    expect(normalizeFeature('liqs')).toBe('liquidations');
    expect(normalizeFeature('candles')).toBe('ohlcv');
  });

  it('leaves unknown features as a normalized slug', () => {
    expect(normalizeFeature('Order Book Imbalance')).toBe('order_book_imbalance');
  });

  it('exposes non-empty denylists', () => {
    expect(LIVE_INTENT_DENYLIST.length).toBeGreaterThan(0);
    expect(LOOKAHEAD_DENYLIST.length).toBeGreaterThan(0);
    expect(PARAM_DENYLIST).toContain('leverage');
    expect(AUTHORITY_DENYLIST.length).toBeGreaterThan(0);
  });
});
