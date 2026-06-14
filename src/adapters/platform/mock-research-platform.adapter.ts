import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
} from '../../ports/research-platform.port.ts';

export class MockResearchPlatformAdapter implements ResearchPlatformPort {
  async discover(): Promise<ResearchCapabilityDescriptor> {
    return {
      contractVersion: CONTRACT_VERSION,
      supportedContractVersions: [CONTRACT_VERSION],
      marketDataKinds: [
        { kind: 'funding', access: 'as_of_freshness', coverageStates: ['present'], presentZeroDistinct: true, since: '2020-01-01' },
      ],
      runModes: [{ mode: 'single', description: 'mock single run' }],
      metricCatalog: ['netPnlUsd', 'sharpe', 'maxDrawdownPct'],
      robustnessCatalog: ['seed_sweep'],
    };
  }

  async listDatasets(_filter?: ListDatasetsFilter): Promise<ListDatasetsResult> {
    return {
      datasets: [
        {
          datasetId: 'mock-ds-1',
          symbols: ['BTCUSDT'],
          dateRange: { from: '2023-01-01', to: '2023-12-31' },
          timeframe: '1h',
          coveredKinds: [{ kind: 'funding', state: 'present' }],
        },
      ],
    };
  }
}
