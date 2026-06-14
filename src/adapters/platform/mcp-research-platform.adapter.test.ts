import { describe, it, expect } from 'vitest';
import type { GatewayToolName, GatewayTransport, ValidateModuleResult } from '@trading-platform/sdk/agent';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import { McpResearchPlatformAdapter, LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import { ContractIncompatibleError } from './research-contract.ts';
import { GatewayValidationError } from './gateway-errors.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

function fakeTransport(responses: Partial<Record<GatewayToolName, unknown>>): {
  transport: GatewayTransport; calls: Array<{ tool: string; args: unknown }>;
} {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const transport: GatewayTransport = {
    async call(tool, args) { calls.push({ tool, args }); return responses[tool]; },
  };
  return { transport, calls };
}

const descriptor = (cv: string, supported: string[]) => ({
  contractVersion: cv, supportedContractVersions: supported,
  marketDataKinds: [], runModes: [], metricCatalog: [], robustnessCatalog: [],
});

describe('McpResearchPlatformAdapter', () => {
  it('discover() calls discover_research_contract and returns the descriptor', async () => {
    const { transport, calls } = fakeTransport({ discover_research_contract: descriptor('031.2', ['031.2']) });
    const a = new McpResearchPlatformAdapter(transport, '031.2');
    const d = await a.discover();
    expect(calls).toEqual([{ tool: 'discover_research_contract', args: {} }]);
    expect(d.contractVersion).toBe('031.2');
  });

  it('discover() throws ContractIncompatibleError on an incompatible version', async () => {
    const { transport } = fakeTransport({ discover_research_contract: descriptor('031.9', ['031.9']) });
    const a = new McpResearchPlatformAdapter(transport, '031.2');
    await expect(a.discover()).rejects.toBeInstanceOf(ContractIncompatibleError);
  });

  it('listDatasets() calls list_datasets with the filter', async () => {
    const { transport, calls } = fakeTransport({ list_datasets: { datasets: [] } });
    const a = new McpResearchPlatformAdapter(transport, '031.2');
    const r = await a.listDatasets({ symbol: 'BTCUSDT' });
    expect(calls).toEqual([{ tool: 'list_datasets', args: { symbol: 'BTCUSDT' } }]);
    expect(r.datasets).toEqual([]);
  });
});

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const bundle = assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' });

function transportReturning(result: ValidateModuleResult): { transport: GatewayTransport; calls: { tool: string; payload: unknown }[] } {
  const calls: { tool: string; payload: unknown }[] = [];
  const transport: GatewayTransport = { call: async (tool: string, payload: unknown) => { calls.push({ tool, payload }); return result; } };
  return { transport, calls };
}

describe('McpResearchPlatformAdapter.validateModule', () => {
  it('sends a submitted bundle to validate_module and returns the report on ok', async () => {
    const okReport = { status: 'accepted', issues: [], executed: false } as const;
    const { transport, calls } = transportReturning({ ok: true, report: okReport });
    const report = await new McpResearchPlatformAdapter(transport, CONTRACT_VERSION).validateModule(bundle);
    expect(report).toEqual(okReport);
    expect(calls[0]!.tool).toBe('validate_module');
    expect((calls[0]!.payload as { module: { kind: string } }).module.kind).toBe('submitted');
  });

  it('throws GatewayValidationError on an ok:false envelope', async () => {
    const { transport } = transportReturning({ ok: false, error: { category: 'validation_error', code: 'invalid_module', message: 'bad' } });
    await expect(new McpResearchPlatformAdapter(transport, CONTRACT_VERSION).validateModule(bundle))
      .rejects.toBeInstanceOf(GatewayValidationError);
  });

  it('Lazy variant opens and closes a session around the call', async () => {
    const okReport = { status: 'accepted', issues: [], executed: false } as const;
    const { transport } = transportReturning({ ok: true, report: okReport });
    let closed = false;
    const lazy = new LazyMcpResearchPlatformAdapter(
      async () => ({ transport, close: async () => { closed = true; } }),
      CONTRACT_VERSION,
    );
    const report = await lazy.validateModule(bundle);
    expect(report).toEqual(okReport);
    expect(closed).toBe(true);
  });
});
