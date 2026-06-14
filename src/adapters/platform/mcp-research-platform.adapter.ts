import { discover, listDatasets } from '@trading-platform/sdk/agent';
import type { GatewayTransport } from '@trading-platform/sdk/agent';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
} from '../../ports/research-platform.port.ts';
import { assertContractCompatible } from './research-contract.ts';
import type { GatewaySession } from './mcp-research-transport.ts';

/** Stateless over a live transport; the caller owns the session lifecycle (one session per probe). */
export class McpResearchPlatformAdapter implements ResearchPlatformPort {
  constructor(
    private readonly transport: GatewayTransport,
    private readonly acceptedContractVersion: string,
  ) {}

  async discover(): Promise<ResearchCapabilityDescriptor> {
    const descriptor = await discover(this.transport);
    assertContractCompatible(descriptor, this.acceptedContractVersion);
    return descriptor;
  }

  async listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult> {
    return listDatasets(this.transport, filter);
  }
}

/** Runtime-safe variant: opens a session per call and closes it. Boot constructs nothing live. */
export class LazyMcpResearchPlatformAdapter implements ResearchPlatformPort {
  constructor(
    private readonly connect: () => Promise<GatewaySession>,
    private readonly acceptedContractVersion: string,
  ) {}

  async discover(): Promise<ResearchCapabilityDescriptor> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).discover();
    } finally {
      await session.close();
    }
  }

  async listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).listDatasets(filter);
    } finally {
      await session.close();
    }
  }
}
