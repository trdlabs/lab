// SP-8.2 acceptance: the vendored @trading-platform/sdk 0.3.0 must carry the
// feature-038 7-metric METRIC_CATALOG. METRIC_CATALOG is not in the SDK public
// exports map, so we read the compiled artifact directly by absolute path.
// Note: the SDK is ESM-only (exports map, no `main`). import.meta.resolve is
// shimmed away by Vite/Vitest. Explicit dist subpaths are blocked by exports map.
// We locate the package root via process.cwd() + known node_modules layout.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('SP-8.2: vendored SDK feature-038 METRIC_CATALOG', () => {
  it('vendored SDK METRIC_CATALOG carries the feature-038 7-metric set', () => {
    // The package is installed at a predictable node_modules path relative to
    // the project root (process.cwd() in Vitest = repo root).
    const sdkRoot = join(process.cwd(), 'node_modules', '@trading-platform', 'sdk');
    const catalogJs = join(sdkRoot, 'dist', 'contract', 'research', 'catalogs.js');
    expect(existsSync(catalogJs)).toBe(true);
    const src = readFileSync(catalogJs, 'utf8');
    for (const m of [
      'pnl',
      'sharpe',
      'max_drawdown',
      'win_rate',
      'total_trades',
      'profit_factor',
      'top_trade_contribution_pct',
    ]) {
      expect(src).toContain(`'${m}'`);
    }
  });
});
