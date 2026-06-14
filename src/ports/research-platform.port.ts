import type {
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
} from '@trading-platform/sdk/agent';

export type { ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult };

/**
 * Research-platform lifecycle as seen by trading-lab research orchestration.
 * Separate from PlatformGatewayPort (market-context + the mock backtest path).
 * Grows in SP-7.1+ with validate / submit / status / result / artifacts / cancel.
 */
export interface ResearchPlatformPort {
  discover(): Promise<ResearchCapabilityDescriptor>;
  listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult>;
}
