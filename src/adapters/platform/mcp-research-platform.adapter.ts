import { discover, listDatasets, validateModule, submitRun, getRunStatus as sdkGetRunStatus, getRunResult as sdkGetRunResult } from '@trading-platform/sdk/agent';
import type { GatewayTransport, ValidateModuleRequest, ControlledRunRequest } from '@trading-platform/sdk/agent';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  ValidateModuleOptions,
  SubmitOverlayRunOptions,
  RunJobHandle,
  RunStatusView,
  RunResultView,
} from '../../ports/research-platform.port.ts';
import { assertContractCompatible } from './research-contract.ts';
import type { GatewaySession } from './mcp-research-transport.ts';
import { toSubmittedBundle } from './submitted-bundle.ts';
import { GatewayValidationError, GatewayRunError } from './gateway-errors.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

/** Stateless over a live transport; the caller owns the session lifecycle (one session per probe). */
export class McpResearchPlatformAdapter implements ResearchPlatformPort {
  private readonly transport: GatewayTransport;
  private readonly acceptedContractVersion: string;

  constructor(transport: GatewayTransport, acceptedContractVersion: string) {
    this.transport = transport;
    this.acceptedContractVersion = acceptedContractVersion;
  }

  async discover(): Promise<ResearchCapabilityDescriptor> {
    const descriptor = await discover(this.transport);
    assertContractCompatible(descriptor, this.acceptedContractVersion);
    return descriptor;
  }

  async listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult> {
    return listDatasets(this.transport, filter);
  }

  async validateModule(bundle: ModuleBundle, options?: ValidateModuleOptions): Promise<ValidationReport> {
    const request: ValidateModuleRequest = {
      module: { kind: 'submitted', bundle: toSubmittedBundle(bundle) },
      ...(options?.dataNeeds !== undefined ? { dataNeeds: options.dataNeeds } : {}),
    };
    const result = await validateModule(this.transport, request);
    if (!result.ok) throw new GatewayValidationError(result.error);
    return result.report;
  }

  async submitOverlayRun(bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle> {
    if (opts.target.kind === 'registry_preset') {
      throw new GatewayRunError({
        category: 'validation_error',
        code: 'unsupported_target',
        message: 'registry presets are only supported on the backtester integration',
      });
    }
    const request: ControlledRunRequest = {
      datasetRef: { datasetId: opts.run.datasetId },
      module: { kind: 'submitted_overlay', bundle: toSubmittedBundle(bundle), baselineModuleRef: opts.target.moduleRef },
      symbols: opts.run.symbols,
      timeframe: opts.run.timeframe,
      period: opts.run.period,
      seed: opts.run.seed,
      mode: 'research',
      metrics: [...RESEARCH_RUN_METRICS],
      ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
      ...(opts.resumeToken !== undefined ? { resumeToken: opts.resumeToken } : {}),
      ...(opts.workflowId !== undefined ? { workflowId: opts.workflowId } : {}),
      ...(opts.callbackUrl !== undefined ? { callback: { url: opts.callbackUrl } } : {}),
    };
    const result = await submitRun(this.transport, request);
    if (!result.ok) throw new GatewayRunError(result.error);
    return result.handle;
  }

  async getRunStatus(runId: string): Promise<RunStatusView> {
    const result = await sdkGetRunStatus(this.transport, runId);
    if (!result.ok) throw new GatewayRunError(result.error);
    return result.view;
  }

  async getRunResult(runId: string): Promise<RunResultView> {
    const result = await sdkGetRunResult(this.transport, runId);
    if (!result.ok) throw new GatewayRunError(result.error);
    return result;
  }
}

/** Runtime-safe variant: opens a session per call and closes it. Boot constructs nothing live. */
export class LazyMcpResearchPlatformAdapter implements ResearchPlatformPort {
  private readonly connect: () => Promise<GatewaySession>;
  private readonly acceptedContractVersion: string;

  constructor(connect: () => Promise<GatewaySession>, acceptedContractVersion: string) {
    this.connect = connect;
    this.acceptedContractVersion = acceptedContractVersion;
  }

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

  async validateModule(bundle: ModuleBundle, options?: ValidateModuleOptions): Promise<ValidationReport> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).validateModule(bundle, options);
    } finally {
      await session.close();
    }
  }

  async submitOverlayRun(bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).submitOverlayRun(bundle, opts);
    } finally {
      await session.close();
    }
  }

  async getRunStatus(runId: string): Promise<RunStatusView> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).getRunStatus(runId);
    } finally {
      await session.close();
    }
  }

  async getRunResult(runId: string): Promise<RunResultView> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).getRunResult(runId);
    } finally {
      await session.close();
    }
  }
}
