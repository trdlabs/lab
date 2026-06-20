import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';
import type { ResearchPlatformPort, SubmitOverlayRunOptions } from '../../ports/research-platform.port.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';
import { ContractIncompatibleError } from './research-contract.ts';
import { runOverlayBacktest, type PollOptions, type PlatformRunOutcome } from '../../research/run-backtest.ts';
import { mapPlatformComparison } from '../../domain/platform-comparison.ts';

export interface RunProbeDeps {
  platform: ResearchPlatformPort;
  events: AgentEventRepository;
  probeId: string;
  integration: string;
  bundle: ModuleBundle;
  opts: SubmitOverlayRunOptions;
  poll: PollOptions;
}

export interface RunProbeResult {
  outcome: PlatformRunOutcome;
  comparison?: ComparisonSummary;
}

function mkEvent(taskId: string, type: string, payload: Record<string, unknown>): AgentEvent {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runBacktestProbe(deps: RunProbeDeps): Promise<RunProbeResult> {
  const { platform, events, probeId, integration, bundle, opts, poll } = deps;
  await events.append(mkEvent(probeId, 'platform.run.started', { integration, bundleHash: bundle.bundleHash, target: opts.target }));

  // Fail-closed contract gate (discover() asserts contract compatibility inside the adapter).
  try {
    await platform.discover();
  } catch (err) {
    if (err instanceof ContractIncompatibleError) {
      await events.append(mkEvent(probeId, 'platform.contract.incompatible', { expected: err.expected, actual: err.actual, supported: [...err.supported] }));
    }
    await events.append(mkEvent(probeId, 'platform.run.failed', { error: errMsg(err) }));
    throw err;
  }

  let outcome: PlatformRunOutcome;
  try {
    outcome = await runOverlayBacktest(platform, bundle, opts, poll);
  } catch (err) {
    await events.append(mkEvent(probeId, 'platform.run.failed', { error: errMsg(err) }));
    throw err;
  }
  await events.append(mkEvent(probeId, 'platform.run.submitted', { runId: outcome.runId }));

  if (outcome.status === 'pending') {
    await events.append(mkEvent(probeId, 'platform.run.pending', { runId: outcome.runId }));
    return { outcome };
  }
  if (outcome.status === 'rejected') {
    await events.append(mkEvent(probeId, 'platform.run.rejected', { runId: outcome.runId, terminalCode: outcome.terminalCode }));
    return { outcome };
  }
  const comparison = mapPlatformComparison(outcome.summary);
  await events.append(mkEvent(probeId, 'platform.run.completed', {
    runId: outcome.runId, artifactIds: outcome.artifactIds,
    deltaNetPnlUsd: comparison.variant.netPnlUsd - comparison.baseline.netPnlUsd,
  }));
  return { outcome, comparison };
}
