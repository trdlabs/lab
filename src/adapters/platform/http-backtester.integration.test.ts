// Opt-in integration: drives a REAL trading-backtester instance through the adapter + client with a
// strategy-signals bundle (what the backtester executes today). Skips (does not fail) unless
// RUN_BACKTESTER_INTEGRATION=true and BACKTESTER_API_URL is set — mirrors the pg/Docker gating in the
// backtester repo. Needs the backtester running with its Docker sandbox available.

import { describe, it, expect } from 'vitest';
import { BacktesterClient } from '@trdlabs/backtester-sdk/client';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { HttpBacktesterAdapter } from './http-backtester.adapter.ts';

const enabled = process.env.RUN_BACKTESTER_INTEGRATION === 'true' && !!process.env.BACKTESTER_API_URL;
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'expired', 'timed_out']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const strategyBundle: ModuleBundle = {
  manifest: { moduleId: 'lab_overlay_probe', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'module.mjs', exports: ['apply'], capabilities: [], sdkContractVersion: 'builder-sdk-v0' },
  files: { 'module.mjs': 'export default { apply(_ctx){ return { kind: "pass" }; } };' },
  bundleHash: 'sha256:integration',
  bundleContractVersion: 'module-bundle-v1',
};

describe.skipIf(!enabled)('HttpBacktesterAdapter integration (real backtester)', () => {
  it('submits a strategy-signals bundle and reads a completed result', async () => {
    const adapter = new HttpBacktesterAdapter(
      new BacktesterClient({ baseUrl: process.env.BACKTESTER_API_URL as string, token: process.env.BACKTESTER_API_TOKEN ?? '' }),
    );

    const handle = await adapter.submitOverlayRun(strategyBundle, {
      target: { kind: 'registry_preset' },
      run: {
        datasetId: 'smoke-btc-1m',
        symbols: ['BTCUSDT'],
        timeframe: '1m',
        period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
        seed: 42,
      },
    });

    let view = await adapter.getRunStatus(handle.runId);
    for (let i = 0; i < 120 && !TERMINAL.has(view.status); i += 1) {
      await sleep(500);
      view = await adapter.getRunStatus(handle.runId);
    }
    expect(view.status).toBe('completed');

    const result = await adapter.getRunResult(handle.runId);
    expect(result.kind).toBe('summary');
    if (result.kind === 'summary') {
      // Preset-driven overlay run → a real baseline-vs-variant comparison.
      expect(result.summary.runKind).toBe('baseline-vs-variant');
      expect(result.summary.comparison).toBeDefined();
      expect(Object.keys(result.summary.metrics).length).toBeGreaterThan(0);
    }
  }, 120_000);
});
