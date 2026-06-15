// src/adapters/platform/validate-probe.test.ts
import { describe, it, expect } from 'vitest';
import { runValidateProbe } from './validate-probe.ts';
import { ContractIncompatibleError } from './research-contract.ts';
import { GatewayValidationError } from './gateway-errors.ts';
import { ConsoleAgentEventSink } from './console-agent-event-sink.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import type { ResearchPlatformPort, ResearchCapabilityDescriptor, ValidationReport } from '../../ports/research-platform.port.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const bundle = assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' });

async function typesOf(sink: ConsoleAgentEventSink, probeId: string): Promise<string[]> {
  return (await sink.listByTask(probeId)).map((e) => e.type);
}

const okDescriptor: ResearchCapabilityDescriptor = {
  contractVersion: '031', supportedContractVersions: ['031'],
  marketDataKinds: [], runModes: [], metricCatalog: [], robustnessCatalog: [],
};

describe('runValidateProbe', () => {
  it('emits started then completed on an accepted report', async () => {
    const sink = new ConsoleAgentEventSink();
    const r = await runValidateProbe({ platform: new MockResearchPlatformAdapter(), events: sink, probeId: 'p:ok', integration: 'mock', bundle });
    expect(await typesOf(sink, 'p:ok')).toEqual(['platform.validate.started', 'platform.validate.completed']);
    expect(r.report.status).toBe('accepted');
  });

  it('emits started, completed, rejected on a rejected report', async () => {
    const sink = new ConsoleAgentEventSink();
    const rejected: ValidationReport = { status: 'rejected', issues: [{ severity: 'error', code: 'x', message: 'm', path: '/p' }], executed: false };
    const platform: ResearchPlatformPort = {
      async discover() { return okDescriptor; },
      async listDatasets() { return { datasets: [] }; },
      async validateModule() { return rejected; },
      async submitOverlayRun() { throw new Error('not implemented'); },
      async getRunStatus() { throw new Error('not implemented'); },
      async getRunResult() { throw new Error('not implemented'); },
    };
    await runValidateProbe({ platform, events: sink, probeId: 'p:rej', integration: 'mcp', bundle });
    expect(await typesOf(sink, 'p:rej')).toEqual(['platform.validate.started', 'platform.validate.completed', 'platform.validate.rejected']);
  });

  it('emits started then failed and rethrows on a gateway error', async () => {
    const sink = new ConsoleAgentEventSink();
    const platform: ResearchPlatformPort = {
      async discover() { return okDescriptor; },
      async listDatasets() { return { datasets: [] }; },
      async validateModule() { throw new GatewayValidationError({ category: 'sandbox_module_error', code: 'bundle_load_failed', message: 'x' }); },
      async submitOverlayRun() { throw new Error('not implemented'); },
      async getRunStatus() { throw new Error('not implemented'); },
      async getRunResult() { throw new Error('not implemented'); },
    };
    await expect(runValidateProbe({ platform, events: sink, probeId: 'p:err', integration: 'mcp', bundle }))
      .rejects.toBeInstanceOf(GatewayValidationError);
    expect(await typesOf(sink, 'p:err')).toEqual(['platform.validate.started', 'platform.validate.failed']);
  });

  it('emits started, contract.incompatible, failed and rethrows on a contract mismatch', async () => {
    const sink = new ConsoleAgentEventSink();
    const platform: ResearchPlatformPort = {
      async discover() { throw new ContractIncompatibleError('031.1', '031.9', ['031.9']); },
      async listDatasets() { return { datasets: [] }; },
      async validateModule() { return { status: 'accepted', issues: [], executed: false }; },
      async submitOverlayRun() { throw new Error('not implemented'); },
      async getRunStatus() { throw new Error('not implemented'); },
      async getRunResult() { throw new Error('not implemented'); },
    };
    await expect(runValidateProbe({ platform, events: sink, probeId: 'p:bad', integration: 'mcp', bundle }))
      .rejects.toBeInstanceOf(ContractIncompatibleError);
    expect(await typesOf(sink, 'p:bad')).toEqual(['platform.validate.started', 'platform.contract.incompatible', 'platform.validate.failed']);
  });
});
