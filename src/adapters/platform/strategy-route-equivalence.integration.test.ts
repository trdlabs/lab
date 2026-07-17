// Docker-gated integration: drives a REAL trading-backtester instance with a lab-authored
// shortAfterPump strategy bundle and asserts the result hash matches the frozen golden
// (sha256:0be9931c…). Skips (does not fail) unless RUN_BACKTESTER_INTEGRATION=true and
// BACKTESTER_API_URL are set — mirrors the gating pattern in http-backtester.integration.test.ts.
//
// Run the real proof with:
//   RUN_BACKTESTER_INTEGRATION=true BACKTESTER_API_URL=<url> [BACKTESTER_API_TOKEN=<tok>] \
//     pnpm vitest run src/adapters/platform/strategy-route-equivalence.integration.test.ts

import { describe, it, expect } from 'vitest';
import { BacktesterClient } from '@trdlabs/backtester-sdk/client';
import { FakeStrategyBuilder } from '../builder/fake-strategy-builder.ts';
import { assembleStrategyBundle } from '../../domain/strategy-bundle.ts';
import { validateStrategyBundle } from '../../validation/strategy-bundle-validator.ts';
import { HttpBacktesterAdapter } from './http-backtester.adapter.ts';

const enabled = process.env.RUN_BACKTESTER_INTEGRATION === 'true' && !!process.env.BACKTESTER_API_URL;

// FROZEN — never refreeze. Source:
// /home/alexxxnikolskiy/projects/trading-backtester/apps/backtester/test/fixtures/overlay/goldens/baseline.hash
const GOLDEN_RESULT_HASH = 'sha256:0be9931ce4f3b11f78a4e78810505767e018c4e160dd5b059558259a7e05a2df';

// Scope matching the backtester's shortAfterPump baseline golden run.
// Sourced from: apps/backtester/test/fixtures/overlay/requests/baseline.json
// TODO(integration): confirm scope against backtester golden run — the M3 metrics/period wire
// concerns from Task 8 surface here; the real run validates scope correctness.
const STRATEGY_SCOPE = {
  datasetRef: 'pump-fixture-1m',
  symbols: ['BTCUSDT'] as string[],
  timeframe: '1m',
  window: {
    fromMs: Date.parse('2025-01-01T00:00:00Z'), // 1735689600000
    toMs: Date.parse('2025-01-01T00:30:00Z'),   // 1735691400000
  },
};

describe.skipIf(!enabled)('strategy-route equivalence (lab-authored shortAfterPump == golden)', () => {
  it(
    'lab-authored shortAfterPump bundle → submitStrategyRun → status:equivalent + resultHash === golden 0be9931c',
    async () => {
      const out = await new FakeStrategyBuilder().build({ spec: {}, authoringDoc: '' });
      const assembled = await assembleStrategyBundle(out);

      const verdict = validateStrategyBundle(assembled);
      expect(verdict.status).toBe('valid');

      const adapter = new HttpBacktesterAdapter(
        new BacktesterClient({
          baseUrl: process.env.BACKTESTER_API_URL as string,
          token: process.env.BACKTESTER_API_TOKEN ?? '',
        }),
        { goldenResultHash: GOLDEN_RESULT_HASH },
      );

      const result = await adapter.submitStrategyRun({
        bundleBytes: assembled.bytes,
        bundleHash: assembled.bundleHash,
        manifest: assembled.manifest,
        curatedBundleHash: assembled.bundleHash,
        scope: STRATEGY_SCOPE,
      });

      expect(result.status).toBe('equivalent');
      expect(result.resultHash).toBe(GOLDEN_RESULT_HASH);
    },
    120_000,
  );
});
