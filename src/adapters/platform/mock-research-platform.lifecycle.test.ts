import { describe, it, expect } from 'vitest';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

const bundle = { manifest: { moduleId: 'm1' }, files: { 'index.ts': '' }, bundleHash: 'sha256:x', bundleContractVersion: '1' } as unknown as ModuleBundle;
const opts = { baselineModuleRef: { id: 'strategy:p1', version: '1.0.0' }, run: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-12-31' }, seed: 7 } };

describe('MockResearchPlatformAdapter lifecycle', () => {
  it('submitOverlayRun returns a handle, getRunResult returns a completed baseline-vs-variant summary', async () => {
    const a = new MockResearchPlatformAdapter();
    const handle = await a.submitOverlayRun(bundle, opts);
    expect(handle.runId).toBeTruthy();
    const status = await a.getRunStatus(handle.runId);
    expect(status.status).toBe('completed');
    const res = await a.getRunResult(handle.runId);
    expect(res.kind).toBe('summary');
    if (res.kind === 'summary') {
      expect(res.summary.status).toBe('completed');
      expect(res.summary.comparison).toBeDefined();
      for (const k of ['pnl', 'max_drawdown', 'win_rate', 'sharpe', 'total_trades', 'profit_factor', 'top_trade_contribution_pct']) {
        expect(res.summary.comparison!.variant).toHaveProperty(k);
      }
    }
  });
});
