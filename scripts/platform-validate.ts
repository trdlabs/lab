// scripts/platform-validate.ts
// platform:validate — narrow dry-run validation probe. No runtime boot, no DB.
// Flow: read bundle JSON (file arg or stdin) -> spawn MCP stdio gateway -> contract gate + validate_module -> print report -> close.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  loadResearchPlatformConfig, createGatewayTransport, withTimeout,
  type GatewaySession,
} from '../src/adapters/platform/mcp-research-transport.ts';
import { McpResearchPlatformAdapter } from '../src/adapters/platform/mcp-research-platform.adapter.ts';
import { ConsoleAgentEventSink } from '../src/adapters/platform/console-agent-event-sink.ts';
import { runValidateProbe } from '../src/adapters/platform/validate-probe.ts';
import type { ModuleBundle } from '../src/domain/module-bundle.ts';

function readBundle(): ModuleBundle {
  const arg = process.argv[2];
  const raw = arg && arg !== '-' ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');
  return JSON.parse(raw) as ModuleBundle;
}

async function main(): Promise<void> {
  const bundle = readBundle();
  const config = loadResearchPlatformConfig(process.env);
  const events = new ConsoleAgentEventSink();
  const probeId = `probe:${randomUUID()}`;
  let session: GatewaySession | undefined;

  try {
    const { report } = await withTimeout((async () => {
      session = await createGatewayTransport(config);
      const platform = new McpResearchPlatformAdapter(session.transport, config.expectedContractVersion);
      return runValidateProbe({ platform, events, probeId, integration: 'mcp', bundle });
    })(), config.discoveryTimeoutMs, 'platform:validate');

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (session) await session.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`platform:validate failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
