// platform:discover — narrow read-only capability probe. No runtime boot, no DB.
// Flow: load env -> spawn MCP stdio gateway -> discover + listDatasets -> audit (console) -> print -> close.
import { randomUUID } from 'node:crypto';
import {
  loadResearchPlatformConfig, createGatewayTransport, withTimeout,
  type GatewaySession,
} from '../src/adapters/platform/mcp-research-transport.ts';
import { McpResearchPlatformAdapter } from '../src/adapters/platform/mcp-research-platform.adapter.ts';
import { ConsoleAgentEventSink } from '../src/adapters/platform/console-agent-event-sink.ts';
import { runDiscoveryProbe } from '../src/adapters/platform/discovery-probe.ts';

async function main(): Promise<void> {
  const config = loadResearchPlatformConfig(process.env);
  const events = new ConsoleAgentEventSink();
  const probeId = `probe:${randomUUID()}`;
  let session: GatewaySession | undefined;

  try {
    const result = await withTimeout((async () => {
      session = await createGatewayTransport(config);
      const platform = new McpResearchPlatformAdapter(session.transport, config.expectedContractVersion);
      return runDiscoveryProbe({ platform, events, probeId, integration: 'mcp', command: config.command });
    })(), config.discoveryTimeoutMs, 'platform:discover');

    process.stdout.write(`${JSON.stringify({ descriptor: result.descriptor, datasets: result.datasets }, null, 2)}\n`);
  } finally {
    if (session) await session.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`platform:discover failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
