import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';
import type {
  ResearchPlatformPort, ResearchCapabilityDescriptor, ListDatasetsResult,
} from '../../ports/research-platform.port.ts';
import { ContractIncompatibleError } from './research-contract.ts';

export interface DiscoveryProbeDeps {
  platform: ResearchPlatformPort;
  events: AgentEventRepository;
  probeId: string;
  integration: string;
  command: string;
}

export interface DiscoveryProbeResult {
  descriptor: ResearchCapabilityDescriptor;
  datasets: ListDatasetsResult;
}

function mkEvent(taskId: string, type: string, payload: Record<string, unknown>): AgentEvent {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runDiscoveryProbe(deps: DiscoveryProbeDeps): Promise<DiscoveryProbeResult> {
  const { platform, events, probeId, integration, command } = deps;
  await events.append(mkEvent(probeId, 'platform.discover.started', { integration, command }));

  let descriptor: ResearchCapabilityDescriptor;
  try {
    descriptor = await platform.discover();
  } catch (err) {
    if (err instanceof ContractIncompatibleError) {
      await events.append(mkEvent(probeId, 'platform.contract.incompatible', {
        expected: err.expected, actual: err.actual, supported: [...err.supported],
      }));
    }
    await events.append(mkEvent(probeId, 'platform.discover.failed', { error: errMsg(err) }));
    throw err;
  }

  await events.append(mkEvent(probeId, 'platform.discover.completed', {
    contractVersion: descriptor.contractVersion,
    marketDataKinds: descriptor.marketDataKinds.length,
    runModes: descriptor.runModes.length,
    metricCatalog: descriptor.metricCatalog.length,
    robustnessCatalog: descriptor.robustnessCatalog.length,
  }));

  const datasets = await platform.listDatasets();
  await events.append(mkEvent(probeId, 'platform.datasets.listed', { count: datasets.datasets.length }));

  return { descriptor, datasets };
}
