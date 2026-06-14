# SP-7 (slice 1) Platform Capability Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `trading-lab` a read-only platform capability-discovery path over MCP (`discover_research_contract` + `list_datasets`) behind a new `ResearchPlatformPort`, with a fail-closed contract-version handshake, AgentEvent audit, a config gate (mock default), and a thin `platform:discover` CLI — touching zero execution authority and keeping runtime boot independent of `trading-platform`.

**Architecture:** Hexagonal. A new `ResearchPlatformPort` (separate from the untouched `PlatformGatewayPort`) is implemented by `MockResearchPlatformAdapter` (default) and `McpResearchPlatformAdapter` (over a `GatewayTransport` from `@trading-platform/sdk/agent`). A transport factory owns the MCP stdio-client lifecycle. The only live consumer in slice 1 is the `platform:discover` CLI, which audits to a console `AgentEventRepository` (no DB). Composition gates the field by `TRADING_PLATFORM_INTEGRATION`; the `mcp` branch is lazy (per-call session) so boot never spawns the gateway.

**Tech Stack:** TypeScript (ESM, `node --experimental-strip-types`, Node ≥22), pnpm, Vitest, `@trading-platform/sdk/agent` (+ `/agent/mcp-transport`), `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-06-14-trading-lab-sp7-platform-discovery-design.md`

---

## File Structure

**Create**
- `src/ports/research-platform.port.ts` — `ResearchPlatformPort` + re-exported SDK types.
- `src/adapters/platform/research-contract.ts` — `ContractIncompatibleError` + `assertContractCompatible` (pure).
- `src/adapters/platform/mock-research-platform.adapter.ts` — `MockResearchPlatformAdapter`.
- `src/adapters/platform/mcp-research-platform.adapter.ts` — `McpResearchPlatformAdapter` (over a live transport) + `LazyMcpResearchPlatformAdapter` (per-call session).
- `src/adapters/platform/mcp-research-transport.ts` — narrow config (`loadResearchPlatformConfig`), `buildChildEnv`, `withTimeout`, `createGatewayTransport`, `GatewaySession`.
- `src/adapters/platform/console-agent-event-sink.ts` — `ConsoleAgentEventSink` (implements `AgentEventRepository`, no DB).
- `src/adapters/platform/discovery-probe.ts` — `runDiscoveryProbe` (orchestrates the 5 AgentEvents).
- `src/adapters/platform/select-research-platform.ts` — `selectResearchPlatform(integration)`.
- `scripts/platform-discover.ts` — thin CLI.
- Tests next to each module + `src/adapters/platform/sdk-import-boundary.guard.test.ts` + `src/adapters/platform/discovery.integration.test.ts`.

**Modify**
- `package.json` — deps + `platform:discover` script.
- `src/config/env.ts` — `TRADING_PLATFORM_INTEGRATION`.
- `src/orchestrator/app-services.ts` — `researchPlatform` field.
- `src/composition.ts` — wire `researchPlatform`.
- `.env.example`, `README.md`.

---

## Task 1: Add dependencies & verify real SDK / MCP exports (spike)

**Why first:** Do not write adapter code against guessed export names. Confirm the actual exports of `@trading-platform/sdk/agent`, `@trading-platform/sdk/agent/mcp-transport`, `@trading-platform/sdk` (root), and `@modelcontextprotocol/sdk` against the installed packages.

**Files:**
- Modify: `package.json`
- Temp: `scripts/_verify-sdk-exports.ts` (deleted at the end)

- [ ] **Step 1: Inspect the sibling SDK package surface**

Read `../trading-platform/packages/sdk/package.json` and confirm:
- `"name": "@trading-platform/sdk"`,
- it exposes subpath exports `./agent` and `./agent/mcp-transport`,
- whether it ships compiled output (an `exports`/`main` pointing at `dist/*.js`) and which script builds it (e.g. `build`/`tsc`).

If it ships from source-compiled `dist`, build it first from that repo:

Run (from the trading-platform repo root): `pnpm --filter @trading-platform/sdk build`
Expected: the SDK's `dist` (or configured output) is produced with no errors. (If the package already exposes built artifacts, skip.)

- [ ] **Step 2: Add the dependencies to trading-lab**

Run:
```bash
pnpm add @modelcontextprotocol/sdk
pnpm add @trading-platform/sdk@file:../trading-platform/packages/sdk
```
Expected: `package.json` `dependencies` gains `@modelcontextprotocol/sdk` and `@trading-platform/sdk` (a `file:` link to the sibling package); `pnpm install` completes.

(If the two repos share a pnpm workspace instead, use the workspace reference your monorepo already uses — the requirement is only that `@trading-platform/sdk/agent` resolves.)

- [ ] **Step 3: Write a throwaway export-verification script**

Create `scripts/_verify-sdk-exports.ts`:
```ts
import {
  discover, listDatasets, GATEWAY_TOOL_NAMES,
} from '@trading-platform/sdk/agent';
import type {
  ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult, GatewayTransport,
} from '@trading-platform/sdk/agent';
import { createMcpTransport } from '@trading-platform/sdk/agent/mcp-transport';
import type { McpClientLike } from '@trading-platform/sdk/agent/mcp-transport';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Reference the type-only imports so unused-import errors surface real export problems.
type _Types = [ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult, GatewayTransport, McpClientLike];

console.log(JSON.stringify({
  workflow: [typeof discover, typeof listDatasets],
  tools: GATEWAY_TOOL_NAMES,
  transport: typeof createMcpTransport,
  contractVersion: CONTRACT_VERSION,
  mcp: [typeof Client, typeof StdioClientTransport],
}, null, 2));
```

- [ ] **Step 4: Run the verification script**

Run: `node --experimental-strip-types scripts/_verify-sdk-exports.ts`
Expected: prints JSON showing `workflow: ["function","function"]`, `tools` = the 8 tool names incl. `"discover_research_contract"` and `"list_datasets"`, `transport: "function"`, a non-empty `contractVersion` string, and `mcp: ["function","function"]`. If any import path errors, correct the import path in the script (and record the correct one) before proceeding — the `.client/index.js` / `.client/stdio.js` subpaths are the ones the adapters will use.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (the verification script typechecks; confirms the type-only imports resolve).

- [ ] **Step 6: Delete the throwaway script & commit**

```bash
rm scripts/_verify-sdk-exports.ts
git add package.json pnpm-lock.yaml
git commit -m "build(sp7): add @trading-platform/sdk + @modelcontextprotocol/sdk; verify agent exports"
```

---

## Task 2: `ResearchPlatformPort` + `MockResearchPlatformAdapter`

**Files:**
- Create: `src/ports/research-platform.port.ts`
- Create: `src/adapters/platform/mock-research-platform.adapter.ts`
- Test: `src/adapters/platform/mock-research-platform.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/mock-research-platform.adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';

describe('MockResearchPlatformAdapter', () => {
  it('discover() returns a contract-compatible descriptor', async () => {
    const a = new MockResearchPlatformAdapter();
    const d = await a.discover();
    expect(d.contractVersion).toBe(CONTRACT_VERSION);
    expect(d.supportedContractVersions).toContain(CONTRACT_VERSION);
    expect(Array.isArray(d.marketDataKinds)).toBe(true);
    expect(Array.isArray(d.metricCatalog)).toBe(true);
  });

  it('listDatasets() returns a datasets array', async () => {
    const a = new MockResearchPlatformAdapter();
    const r = await a.listDatasets();
    expect(Array.isArray(r.datasets)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/mock-research-platform.adapter.test.ts`
Expected: FAIL — cannot find module `./mock-research-platform.adapter.ts`.

- [ ] **Step 3: Create the port**

Create `src/ports/research-platform.port.ts`:
```ts
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
```

- [ ] **Step 4: Create the mock adapter**

Create `src/adapters/platform/mock-research-platform.adapter.ts`:
```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/mock-research-platform.adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ports/research-platform.port.ts src/adapters/platform/mock-research-platform.adapter.ts src/adapters/platform/mock-research-platform.adapter.test.ts
git commit -m "feat(sp7): ResearchPlatformPort + MockResearchPlatformAdapter"
```

---

## Task 3: Contract-version check (`research-contract.ts`)

**Files:**
- Create: `src/adapters/platform/research-contract.ts`
- Test: `src/adapters/platform/research-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/research-contract.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { assertContractCompatible, ContractIncompatibleError } from './research-contract.ts';
import type { ResearchCapabilityDescriptor } from '../../ports/research-platform.port.ts';

function descriptor(contractVersion: string, supported: string[]): ResearchCapabilityDescriptor {
  return {
    contractVersion,
    supportedContractVersions: supported,
    marketDataKinds: [],
    runModes: [],
    metricCatalog: [],
    robustnessCatalog: [],
  };
}

describe('assertContractCompatible', () => {
  it('passes when expected equals contractVersion', () => {
    expect(() => assertContractCompatible(descriptor('031.2', []), '031.2')).not.toThrow();
  });

  it('passes when expected is in supportedContractVersions', () => {
    expect(() => assertContractCompatible(descriptor('031.3', ['031.2', '031.3']), '031.2')).not.toThrow();
  });

  it('throws ContractIncompatibleError otherwise, carrying expected/actual/supported', () => {
    try {
      assertContractCompatible(descriptor('031.3', ['031.3']), '031.1');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractIncompatibleError);
      const e = err as ContractIncompatibleError;
      expect(e.expected).toBe('031.1');
      expect(e.actual).toBe('031.3');
      expect(e.supported).toEqual(['031.3']);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/research-contract.test.ts`
Expected: FAIL — cannot find module `./research-contract.ts`.

- [ ] **Step 3: Implement**

Create `src/adapters/platform/research-contract.ts`:
```ts
import type { ResearchCapabilityDescriptor } from '../../ports/research-platform.port.ts';

export class ContractIncompatibleError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly supported: readonly string[],
  ) {
    super(
      `platform contract ${actual} is incompatible with expected ${expected} ` +
      `(supported: ${supported.length ? supported.join(', ') : 'none'})`,
    );
    this.name = 'ContractIncompatibleError';
  }
}

/** Fail-closed: throw unless the expected version is the platform's version or in its supported set. */
export function assertContractCompatible(
  descriptor: ResearchCapabilityDescriptor,
  expected: string,
): void {
  const ok =
    descriptor.contractVersion === expected ||
    descriptor.supportedContractVersions.includes(expected);
  if (!ok) {
    throw new ContractIncompatibleError(expected, descriptor.contractVersion, descriptor.supportedContractVersions);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/research-contract.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/research-contract.ts src/adapters/platform/research-contract.test.ts
git commit -m "feat(sp7): fail-closed contract-version check + ContractIncompatibleError"
```

---

## Task 4: `McpResearchPlatformAdapter` (over a live transport)

**Files:**
- Create: `src/adapters/platform/mcp-research-platform.adapter.ts`
- Test: `src/adapters/platform/mcp-research-platform.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/mcp-research-platform.adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { GatewayToolName, GatewayTransport } from '@trading-platform/sdk/agent';
import { McpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import { ContractIncompatibleError } from './research-contract.ts';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/mcp-research-platform.adapter.test.ts`
Expected: FAIL — cannot find module `./mcp-research-platform.adapter.ts`.

- [ ] **Step 3: Implement (only the live-transport adapter for now)**

Create `src/adapters/platform/mcp-research-platform.adapter.ts`:
```ts
import { discover, listDatasets } from '@trading-platform/sdk/agent';
import type { GatewayTransport } from '@trading-platform/sdk/agent';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
} from '../../ports/research-platform.port.ts';
import { assertContractCompatible } from './research-contract.ts';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/mcp-research-platform.adapter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/mcp-research-platform.adapter.ts src/adapters/platform/mcp-research-platform.adapter.test.ts
git commit -m "feat(sp7): McpResearchPlatformAdapter over a GatewayTransport (+ contract check)"
```

---

## Task 5: Transport module — config, child-env, timeout, factory

**Files:**
- Create: `src/adapters/platform/mcp-research-transport.ts`
- Test: `src/adapters/platform/mcp-research-transport.test.ts`

- [ ] **Step 1: Write the failing test (pure parts only)**

Create `src/adapters/platform/mcp-research-transport.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import { loadResearchPlatformConfig, buildChildEnv, withTimeout } from './mcp-research-transport.ts';

describe('loadResearchPlatformConfig', () => {
  it('parses TRADING_PLATFORM_* with defaults', () => {
    const cfg = loadResearchPlatformConfig({
      TRADING_PLATFORM_GATEWAY_COMMAND: 'node',
      TRADING_PLATFORM_GATEWAY_ARGS: '--experimental-strip-types ../tp/bin/start.ts',
    });
    expect(cfg.command).toBe('node');
    expect(cfg.args).toEqual(['--experimental-strip-types', '../tp/bin/start.ts']);
    expect(cfg.discoveryTimeoutMs).toBe(15000);
    expect(cfg.expectedContractVersion).toBe(CONTRACT_VERSION);
    expect(cfg.gatewayConfigPath).toBeUndefined();
  });

  it('honors overrides', () => {
    const cfg = loadResearchPlatformConfig({
      TRADING_PLATFORM_GATEWAY_COMMAND: 'node',
      TRADING_PLATFORM_GATEWAY_CONFIG: '/etc/gw.json',
      TRADING_PLATFORM_DISCOVERY_TIMEOUT_MS: '500',
      TRADING_PLATFORM_EXPECTED_CONTRACT: '031.7',
    });
    expect(cfg.gatewayConfigPath).toBe('/etc/gw.json');
    expect(cfg.discoveryTimeoutMs).toBe(500);
    expect(cfg.expectedContractVersion).toBe('031.7');
  });

  it('throws when the gateway command is missing', () => {
    expect(() => loadResearchPlatformConfig({})).toThrow(/TRADING_PLATFORM_GATEWAY_COMMAND/);
  });
});

describe('buildChildEnv', () => {
  it('maps gatewayConfigPath to MCP_GATEWAY_CONFIG and drops undefined base entries', () => {
    const cfg = loadResearchPlatformConfig({ TRADING_PLATFORM_GATEWAY_COMMAND: 'node', TRADING_PLATFORM_GATEWAY_CONFIG: '/etc/gw.json' });
    const env = buildChildEnv(cfg, { KEEP: 'yes', DROP: undefined });
    expect(env.KEEP).toBe('yes');
    expect('DROP' in env).toBe(false);
    expect(env.MCP_GATEWAY_CONFIG).toBe('/etc/gw.json');
  });

  it('omits MCP_GATEWAY_CONFIG when no gateway config path', () => {
    const cfg = loadResearchPlatformConfig({ TRADING_PLATFORM_GATEWAY_COMMAND: 'node' });
    const env = buildChildEnv(cfg, {});
    expect('MCP_GATEWAY_CONFIG' in env).toBe(false);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7);
  });

  it('rejects with a labeled error when the promise is too slow', async () => {
    const slow = new Promise((r) => setTimeout(() => r(1), 50));
    await expect(withTimeout(slow, 5, 'discover')).rejects.toThrow(/discover timed out after 5ms/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/mcp-research-transport.test.ts`
Expected: FAIL — cannot find module `./mcp-research-transport.ts`.

- [ ] **Step 3: Implement**

Create `src/adapters/platform/mcp-research-transport.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpTransport } from '@trading-platform/sdk/agent/mcp-transport';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type { GatewayTransport } from '@trading-platform/sdk/agent';

export interface ResearchPlatformConfig {
  command: string;
  args: string[];
  gatewayConfigPath?: string;
  discoveryTimeoutMs: number;
  expectedContractVersion: string;
}

export interface GatewaySession {
  transport: GatewayTransport;
  close(): Promise<void>;
}

export function loadResearchPlatformConfig(source: NodeJS.ProcessEnv): ResearchPlatformConfig {
  const command = source.TRADING_PLATFORM_GATEWAY_COMMAND;
  if (!command) throw new Error('TRADING_PLATFORM_GATEWAY_COMMAND is required for mcp integration');
  const rawArgs = source.TRADING_PLATFORM_GATEWAY_ARGS ?? '';
  const args = rawArgs.split(/\s+/).filter((a) => a.length > 0);
  const timeout = Number(source.TRADING_PLATFORM_DISCOVERY_TIMEOUT_MS);
  return {
    command,
    args,
    gatewayConfigPath: source.TRADING_PLATFORM_GATEWAY_CONFIG || undefined,
    discoveryTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15000,
    expectedContractVersion: source.TRADING_PLATFORM_EXPECTED_CONTRACT || CONTRACT_VERSION,
  };
}

/** Inherit the parent env (defined string entries only) + inject MCP_GATEWAY_CONFIG for the child. */
export function buildChildEnv(config: ResearchPlatformConfig, base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string') env[k] = v;
  }
  if (config.gatewayConfigPath) env.MCP_GATEWAY_CONFIG = config.gatewayConfigPath;
  return env;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Spawn the gateway over stdio and wrap it as a GatewayTransport. Caller owns close(). */
export async function createGatewayTransport(config: ResearchPlatformConfig): Promise<GatewaySession> {
  const stdio = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: buildChildEnv(config, process.env),
  });
  const client = new Client({ name: 'trading-lab', version: '0.0.1' });
  await client.connect(stdio);
  return {
    transport: createMcpTransport(client),
    close: async () => { await client.close(); },
  };
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run src/adapters/platform/mcp-research-transport.test.ts && pnpm typecheck`
Expected: PASS (7 tests) and typecheck clean. (`createGatewayTransport` is covered by the integration test in Task 12.)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/mcp-research-transport.ts src/adapters/platform/mcp-research-transport.test.ts
git commit -m "feat(sp7): research-platform transport factory + narrow config + timeout"
```

---

## Task 6: `ConsoleAgentEventSink`

**Files:**
- Create: `src/adapters/platform/console-agent-event-sink.ts`
- Test: `src/adapters/platform/console-agent-event-sink.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/console-agent-event-sink.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { ConsoleAgentEventSink } from './console-agent-event-sink.ts';

describe('ConsoleAgentEventSink', () => {
  it('buffers appended events and lists them by task', async () => {
    const sink = new ConsoleAgentEventSink();
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await sink.append({ id: '1', taskId: 'probe:a', type: 'x', payload: {}, createdAt: 'now' });
    await sink.append({ id: '2', taskId: 'probe:b', type: 'y', payload: {}, createdAt: 'now' });
    expect(await sink.listByTask('probe:a')).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(2);
    write.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/console-agent-event-sink.test.ts`
Expected: FAIL — cannot find module `./console-agent-event-sink.ts`.

- [ ] **Step 3: Implement**

Create `src/adapters/platform/console-agent-event-sink.ts`:
```ts
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';

/** DB-free AgentEvent sink for the platform:discover CLI: prints each event and keeps an in-memory log. */
export class ConsoleAgentEventSink implements AgentEventRepository {
  private readonly events: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    this.events.push(event);
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  async listByTask(taskId: string): Promise<AgentEvent[]> {
    return this.events.filter((e) => e.taskId === taskId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/console-agent-event-sink.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/console-agent-event-sink.ts src/adapters/platform/console-agent-event-sink.test.ts
git commit -m "feat(sp7): ConsoleAgentEventSink (DB-free audit for the discover CLI)"
```

---

## Task 7: `runDiscoveryProbe`

**Files:**
- Create: `src/adapters/platform/discovery-probe.ts`
- Test: `src/adapters/platform/discovery-probe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/discovery-probe.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { runDiscoveryProbe } from './discovery-probe.ts';
import { ContractIncompatibleError } from './research-contract.ts';
import { ConsoleAgentEventSink } from './console-agent-event-sink.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import type { ResearchPlatformPort } from '../../ports/research-platform.port.ts';

async function typesOf(sink: ConsoleAgentEventSink, probeId: string): Promise<string[]> {
  return (await sink.listByTask(probeId)).map((e) => e.type);
}

describe('runDiscoveryProbe', () => {
  it('emits started, completed, datasets.listed in order on success', async () => {
    const sink = new ConsoleAgentEventSink();
    const r = await runDiscoveryProbe({
      platform: new MockResearchPlatformAdapter(), events: sink,
      probeId: 'probe:ok', integration: 'mock', command: 'node',
    });
    expect(await typesOf(sink, 'probe:ok')).toEqual([
      'platform.discover.started', 'platform.discover.completed', 'platform.datasets.listed',
    ]);
    expect(r.descriptor.contractVersion).toBeDefined();
    expect(Array.isArray(r.datasets.datasets)).toBe(true);
  });

  it('emits contract.incompatible then failed, and rethrows, on a contract mismatch', async () => {
    const sink = new ConsoleAgentEventSink();
    const bad: ResearchPlatformPort = {
      async discover() { throw new ContractIncompatibleError('031.1', '031.9', ['031.9']); },
      async listDatasets() { return { datasets: [] }; },
    };
    await expect(runDiscoveryProbe({
      platform: bad, events: sink, probeId: 'probe:bad', integration: 'mcp', command: 'node',
    })).rejects.toBeInstanceOf(ContractIncompatibleError);
    expect(await typesOf(sink, 'probe:bad')).toEqual([
      'platform.discover.started', 'platform.contract.incompatible', 'platform.discover.failed',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/discovery-probe.test.ts`
Expected: FAIL — cannot find module `./discovery-probe.ts`.

- [ ] **Step 3: Implement**

Create `src/adapters/platform/discovery-probe.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/discovery-probe.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/discovery-probe.ts src/adapters/platform/discovery-probe.test.ts
git commit -m "feat(sp7): runDiscoveryProbe with ordered AgentEvent audit"
```

---

## Task 8: `LazyMcpResearchPlatformAdapter` (per-call session)

**Files:**
- Modify: `src/adapters/platform/mcp-research-platform.adapter.ts`
- Test: `src/adapters/platform/lazy-mcp-research-platform.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/adapters/platform/lazy-mcp-research-platform.adapter.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import type { GatewayTransport } from '@trading-platform/sdk/agent';
import { LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import type { GatewaySession } from './mcp-research-transport.ts';

const descriptor = { contractVersion: '031.2', supportedContractVersions: ['031.2'], marketDataKinds: [], runModes: [], metricCatalog: [], robustnessCatalog: [] };

function fakeSession(): { session: GatewaySession; closed: () => number } {
  let closes = 0;
  const transport: GatewayTransport = {
    async call(tool) { return tool === 'discover_research_contract' ? descriptor : { datasets: [] }; },
  };
  return { session: { transport, close: async () => { closes += 1; } }, closed: () => closes };
}

describe('LazyMcpResearchPlatformAdapter', () => {
  it('does not connect at construction (boot-safe)', () => {
    const connect = vi.fn(async () => fakeSession().session);
    new LazyMcpResearchPlatformAdapter(connect, '031.2');
    expect(connect).not.toHaveBeenCalled();
  });

  it('connects per call and closes in finally', async () => {
    const fs = fakeSession();
    const connect = vi.fn(async () => fs.session);
    const a = new LazyMcpResearchPlatformAdapter(connect, '031.2');
    const d = await a.discover();
    expect(d.contractVersion).toBe('031.2');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(fs.closed()).toBe(1);
    await a.listDatasets();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(fs.closed()).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/lazy-mcp-research-platform.adapter.test.ts`
Expected: FAIL — `LazyMcpResearchPlatformAdapter` is not exported.

- [ ] **Step 3: Append the lazy adapter to the adapter module**

Add to `src/adapters/platform/mcp-research-platform.adapter.ts` (below `McpResearchPlatformAdapter`):
```ts
import type { GatewaySession } from './mcp-research-transport.ts';

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
```

(The `import type { GatewaySession }` line goes with the other imports at the top of the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/lazy-mcp-research-platform.adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform/mcp-research-platform.adapter.ts src/adapters/platform/lazy-mcp-research-platform.adapter.test.ts
git commit -m "feat(sp7): LazyMcpResearchPlatformAdapter (per-call session, boot-safe)"
```

---

## Task 9: `platform:discover` CLI

**Files:**
- Create: `scripts/platform-discover.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the CLI**

Create `scripts/platform-discover.ts`:
```ts
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
```

- [ ] **Step 2: Add the package.json script**

In `package.json`, add to `scripts` (after `"worker"`):
```json
    "platform:discover": "node --experimental-strip-types scripts/platform-discover.ts",
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Smoke the failure path (no DB, fail-closed on missing config)**

Run: `pnpm platform:discover`
Expected: exits non-zero with `platform:discover failed: TRADING_PLATFORM_GATEWAY_COMMAND is required for mcp integration` (no DATABASE_URL / REDIS_URL needed — the CLI never boots the runtime).

- [ ] **Step 5: Commit**

```bash
git add scripts/platform-discover.ts package.json
git commit -m "feat(sp7): platform:discover CLI (narrow, DB-free, fail-closed)"
```

---

## Task 10: Composition gate — selector + env + AppServices field

**Files:**
- Create: `src/adapters/platform/select-research-platform.ts`
- Test: `src/adapters/platform/select-research-platform.test.ts`
- Modify: `src/config/env.ts`
- Modify: `src/orchestrator/app-services.ts`
- Modify: `src/composition.ts`

- [ ] **Step 1: Write the failing selector test**

Create `src/adapters/platform/select-research-platform.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { selectResearchPlatform } from './select-research-platform.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import * as transport from './mcp-research-transport.ts';

describe('selectResearchPlatform', () => {
  it('defaults to the mock adapter', () => {
    expect(selectResearchPlatform('mock')).toBeInstanceOf(MockResearchPlatformAdapter);
  });

  it('returns a lazy mcp adapter for mcp without opening a transport', () => {
    const spy = vi.spyOn(transport, 'createGatewayTransport');
    const a = selectResearchPlatform('mcp');
    expect(a).toBeInstanceOf(LazyMcpResearchPlatformAdapter);
    expect(spy).not.toHaveBeenCalled(); // construction is inert; no gateway spawn at boot
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/select-research-platform.test.ts`
Expected: FAIL — cannot find module `./select-research-platform.ts`.

- [ ] **Step 3: Implement the selector**

Create `src/adapters/platform/select-research-platform.ts`:
```ts
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type { ResearchPlatformPort } from '../../ports/research-platform.port.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import { loadResearchPlatformConfig, createGatewayTransport } from './mcp-research-transport.ts';

/**
 * Boot-safe: the mcp branch defers all config loading + transport creation into the per-call
 * connect thunk, so composeRuntime never spawns the gateway and never depends on trading-platform.
 */
export function selectResearchPlatform(integration: 'mock' | 'mcp'): ResearchPlatformPort {
  if (integration === 'mcp') {
    return new LazyMcpResearchPlatformAdapter(
      () => createGatewayTransport(loadResearchPlatformConfig(process.env)),
      process.env.TRADING_PLATFORM_EXPECTED_CONTRACT || CONTRACT_VERSION,
    );
  }
  return new MockResearchPlatformAdapter();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/select-research-platform.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the env flag**

In `src/config/env.ts`, add to the `Env` interface (after `TRADING_LAB_CALLBACK_TOKEN`):
```ts
  TRADING_PLATFORM_INTEGRATION: 'mock' | 'mcp';
```
And in `loadEnv`'s returned object (after `TRADING_LAB_CALLBACK_TOKEN`):
```ts
    TRADING_PLATFORM_INTEGRATION: source.TRADING_PLATFORM_INTEGRATION === 'mcp' ? 'mcp' : 'mock',
```

- [ ] **Step 6: Add the AppServices field**

In `src/orchestrator/app-services.ts`, add the import (with the other `../ports/*` type imports):
```ts
import type { ResearchPlatformPort } from '../ports/research-platform.port.ts';
```
And add to the `AppServices` interface (after `platform: PlatformGatewayPort;`):
```ts
  researchPlatform: ResearchPlatformPort;
```

- [ ] **Step 7: Wire it in composition**

In `src/composition.ts`, add the import (near the other adapter imports):
```ts
import { selectResearchPlatform } from './adapters/platform/select-research-platform.ts';
```
And in the `services` object literal in `composeRuntime` (after `platform: new MockPlatformGatewayAdapter(),`):
```ts
    researchPlatform: selectResearchPlatform(env.TRADING_PLATFORM_INTEGRATION),
```

- [ ] **Step 8: Run the full suite + typecheck**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS — `AppServices` is satisfied everywhere it is constructed (including `test/support/make-services.ts`). If `make-services.ts` (or any test fixture) constructs `AppServices` and now fails to typecheck, add `researchPlatform: new MockResearchPlatformAdapter(),` to that fixture (import from `../../src/adapters/platform/mock-research-platform.adapter.ts`).

- [ ] **Step 9: Commit**

```bash
git add src/adapters/platform/select-research-platform.ts src/adapters/platform/select-research-platform.test.ts src/config/env.ts src/orchestrator/app-services.ts src/composition.ts
git commit -m "feat(sp7): gate researchPlatform by TRADING_PLATFORM_INTEGRATION (mock default, boot-safe)"
```

---

## Task 11: SDK import-boundary guard

**Files:**
- Create: `src/adapters/platform/sdk-import-boundary.guard.test.ts`

- [ ] **Step 1: Write the guard test**

Create `src/adapters/platform/sdk-import-boundary.guard.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// @trading-platform/* may be imported ONLY from the research-platform port and the platform adapter dir.
const ALLOWED_FILES = new Set<string>(['src/ports/research-platform.port.ts']);
const ALLOWED_DIR = 'src/adapters/platform/';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).filter((s): s is string => s !== undefined);
}

describe('SDK import boundary', () => {
  const files = walk('src');

  it('covers a meaningful file set (sanity)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    it(`${file} imports @trading-platform/* only from the platform boundary`, () => {
      const sdk = importSpecifiers(file).filter((s) => s.startsWith('@trading-platform/'));
      if (sdk.length === 0) return;
      const allowed = ALLOWED_FILES.has(file) || file.startsWith(ALLOWED_DIR);
      expect(allowed, `${file} imports ${sdk.join(', ')} outside the platform boundary`).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Run the guard (must pass — confirms no leakage)**

Run: `pnpm vitest run src/adapters/platform/sdk-import-boundary.guard.test.ts`
Expected: PASS — only `src/ports/research-platform.port.ts` and `src/adapters/platform/*` import `@trading-platform/*`.

- [ ] **Step 3: Confirm the read boundary is still clean**

Run: `pnpm vitest run src/read-api/read-boundary.guard.test.ts`
Expected: PASS — the read boundary imports nothing matching `/trading-platform/` (the new SDK imports live only on the write/adapter side).

- [ ] **Step 4: Commit**

```bash
git add src/adapters/platform/sdk-import-boundary.guard.test.ts
git commit -m "test(sp7): SDK import-boundary guard (@trading-platform/* confined to port+adapter)"
```

---

## Task 12: Integration test (opt-in) + docs

**Files:**
- Create: `src/adapters/platform/discovery.integration.test.ts`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Write the opt-in integration test**

Create `src/adapters/platform/discovery.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadResearchPlatformConfig, createGatewayTransport } from './mcp-research-transport.ts';
import { McpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';

// Opt-in: needs a real gateway. Set RUN_PLATFORM_INTEGRATION=true + TRADING_PLATFORM_GATEWAY_COMMAND/ARGS.
const enabled = process.env.RUN_PLATFORM_INTEGRATION === 'true' && !!process.env.TRADING_PLATFORM_GATEWAY_COMMAND;

describe.skipIf(!enabled)('platform discovery integration (real gateway over stdio)', () => {
  it('discovers a compatible contract and lists datasets', async () => {
    const config = loadResearchPlatformConfig(process.env);
    const session = await createGatewayTransport(config);
    try {
      const platform = new McpResearchPlatformAdapter(session.transport, config.expectedContractVersion);
      const descriptor = await platform.discover();
      expect(typeof descriptor.contractVersion).toBe('string');
      expect(descriptor.contractVersion.length).toBeGreaterThan(0);
      const datasets = await platform.listDatasets();
      expect(Array.isArray(datasets.datasets)).toBe(true);
    } finally {
      await session.close();
    }
  }, 30000);
});
```

- [ ] **Step 2: Verify it is skipped by default**

Run: `pnpm vitest run src/adapters/platform/discovery.integration.test.ts`
Expected: the suite is SKIPPED (no `RUN_PLATFORM_INTEGRATION`), test run is green.

- [ ] **Step 3: (Optional, environment-permitting) run it against the real gateway**

Run (point the vars at the sibling gateway bin):
```bash
RUN_PLATFORM_INTEGRATION=true \
TRADING_PLATFORM_GATEWAY_COMMAND=node \
TRADING_PLATFORM_GATEWAY_ARGS="--experimental-strip-types ../trading-platform/src/research/mcp-gateway/bin/start-gateway.ts" \
pnpm vitest run src/adapters/platform/discovery.integration.test.ts
```
Expected: PASS — the gateway starts over stdio (anonymous, zero secrets), discovery returns a compatible `contractVersion`, datasets is an array. (If your gateway entrypoint differs, adjust COMMAND/ARGS to whatever `bin/start-gateway.ts` requires.)

- [ ] **Step 4: Document env in `.env.example`**

Append to `.env.example` (create the file if it does not exist):
```bash
# --- SP-7: trading-platform research gateway (read-only capability discovery) ---
# Default is mock; runtime boot never contacts trading-platform.
TRADING_PLATFORM_INTEGRATION=mock
# Required only when running `pnpm platform:discover` (or INTEGRATION=mcp):
TRADING_PLATFORM_GATEWAY_COMMAND=
TRADING_PLATFORM_GATEWAY_ARGS=
# Optional path forwarded to the gateway child as MCP_GATEWAY_CONFIG (dataset registry etc.):
TRADING_PLATFORM_GATEWAY_CONFIG=
TRADING_PLATFORM_DISCOVERY_TIMEOUT_MS=15000
# Optional; defaults to the SDK CONTRACT_VERSION:
TRADING_PLATFORM_EXPECTED_CONTRACT=
```

- [ ] **Step 5: Document the CLI in `README.md`**

Append a section to `README.md`:
```markdown
## Platform capability discovery (SP-7 slice 1)

Read-only probe of the `trading-platform` research gateway over MCP — no execution, no DB, no
runtime boot. It spawns the gateway over stdio (anonymous, zero secrets), calls
`discover_research_contract` + `list_datasets`, audits the five `platform.*` AgentEvents to stdout,
prints the capability descriptor + datasets, and exits non-zero on a contract mismatch / timeout /
unreachable gateway (fail-closed).

```bash
TRADING_PLATFORM_GATEWAY_COMMAND=node \
TRADING_PLATFORM_GATEWAY_ARGS="--experimental-strip-types ../trading-platform/src/research/mcp-gateway/bin/start-gateway.ts" \
pnpm platform:discover
```

The contract-version handshake is mandatory and fail-closed, but on-demand only: it never blocks
`pnpm worker` / `pnpm ingress` boot. The runtime gate is `TRADING_PLATFORM_INTEGRATION` (`mock`
default); the SDK import is confined to `src/ports/research-platform.port.ts` + `src/adapters/platform/`.
```

- [ ] **Step 6: Full suite + typecheck**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS (integration suite skipped).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/platform/discovery.integration.test.ts .env.example README.md
git commit -m "test(sp7): opt-in discovery integration + .env.example + README"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §5 `ResearchPlatformPort` (re-exported SDK types, old port untouched) | Task 2 |
| §6 `McpResearchPlatformAdapter` + `MockResearchPlatformAdapter` + boot-safety | Tasks 2, 4, 8 |
| §6 / §9 contract handshake (fail-closed, typed error) | Tasks 3, 4, 7 |
| §7 transport factory (`GatewaySession`, child-env `MCP_GATEWAY_CONFIG`) | Task 5 |
| §8 config & env (`TRADING_PLATFORM_*`, timeout) | Tasks 5, 10 |
| §10 AgentEvent audit (5 events, synthetic probe id) | Tasks 6, 7 |
| §11 `platform:discover` CLI (narrow, DB-free) | Task 9 |
| §12 composition gate (mock default, lazy mcp, boot opens nothing) | Task 10 |
| §13 decoupling/import discipline + deps | Tasks 1, 11 |
| §14 testing (unit + timeout + boot independence + integration) | Tasks 4–8, 10, 12 |
| §15 verification (DoD) | Tasks 9 (smoke), 11 (guards), 12 (integration) |
| §1 SDK export verification (user refinement #1) | Task 1 |
| CLI no-DB audit behavior (user refinement #2) | Tasks 6, 9 |

No spec section is left without a task.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to". Every code step shows complete code; every run step shows command + expected output. The only environment-dependent step is Task 1's install mechanism and Task 12 step 3's gateway command — both give concrete commands plus an explicit "adjust if your entrypoint differs" note, which is honest given cross-repo packaging.

**3. Type consistency:** `ResearchPlatformPort.discover()/listDatasets()`, `McpResearchPlatformAdapter(transport, acceptedContractVersion)`, `LazyMcpResearchPlatformAdapter(connect, acceptedContractVersion)`, `GatewaySession{transport,close}`, `ResearchPlatformConfig{command,args,gatewayConfigPath?,discoveryTimeoutMs,expectedContractVersion}`, `ContractIncompatibleError{expected,actual,supported}`, `assertContractCompatible(descriptor,expected)`, `runDiscoveryProbe(DiscoveryProbeDeps)→DiscoveryProbeResult`, `selectResearchPlatform('mock'|'mcp')`, event types `platform.discover.started|completed|failed`, `platform.contract.incompatible`, `platform.datasets.listed` — names are identical across tasks. Workflow functions `discover`/`listDatasets` return bare DTOs (no `ok` envelope), matching the SDK.
