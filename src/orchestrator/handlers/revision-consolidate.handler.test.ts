import { describe, it, expect } from 'vitest';
import { revisionConsolidateHandler } from './revision-consolidate.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';
import type { StrategyBacktestRun } from '../../domain/strategy-backtest-run.ts';
import type { PlatformRunConfig } from '../../ports/research-platform.port.ts';
import type { StrategyManifestMeta } from '../../ports/strategy-builder.port.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { RevisionRunRequest, RevisionRunResult, StrategyRevisionRunExecutor } from '../../ports/strategy-revision-run-executor.ts';
import type { StrategyConsolidatorPort, StrategyConsolidateArgs } from '../../ports/strategy-consolidator.port.ts';
import type { AgentCallOpts } from '../../ports/agent-call-opts.ts';
import { assembleStrategyBundle } from '../../domain/strategy-bundle.ts';
import { FakeStrategyConsolidator } from '../../adapters/consolidator/fake-strategy-consolidator.ts';
import { InMemoryQueueAdapter } from '../../adapters/queue/in-memory-queue.adapter.ts';
import { InMemoryTokenUsageRepository } from '../../adapters/repository/in-memory-token-usage.repository.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STACK_MANIFEST_META: StrategyManifestMeta = {
  id: 'stacked_strategy', version: '0.1.0', name: 'Stacked strategy', summary: 'Stacked composed strategy for consolidation.',
  rationale: 'Test fixture for revision.consolidate guard/reject paths.',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} }, params: {},
  capabilities: { platformSdk: true }, dataNeeds: { closedCandlesUpToCurrent: true }, hooks: ['onBarClose'],
};

const STACK_SOURCE = `
export default function createStrategyModule() {
  return {
    onBarClose(ctx) {
      return { kind: 'enter', side: 'short', rationale: 'stacked-enter' };
    },
  };
}
`;

// Triggers the F1 ambient-authority scan (process_access) in validateStrategyBundle WITHOUT
// tripping assembleStrategyBundle's self-containment check (which only forbids leftover
// import/require/from tokens in the bundled output — a bare `process.env` reference survives
// esbuild bundling untouched since it resolves against the global, not a module import).
const AMBIENT_AUTHORITY_SOURCE = `
export default function createStrategyModule() {
  return {
    onBarClose(ctx) {
      const secret = process.env.SECRET;
      return { kind: 'pass' };
    },
  };
}
`;

function task(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 'task-consolidate-1', taskType: 'revision.consolidate', source: 'operator', correlationId: 'corr-1',
    status: 'running', payload: { revisionId: 'rev-1', strategyProfileId: 'p1' },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function acceptedMetrics(): BacktestMetricBlock {
  return { netPnlUsd: 900, netPnlPct: 9, totalTrades: 30, winRate: 0.6, profitFactor: 1.8, maxDrawdownPct: 9, expectancyUsd: 30, sharpe: 1.5, topTradeContributionPct: 15 };
}

function samplePlatformRun(): PlatformRunConfig {
  return { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2026-01-01', to: '2026-02-01' }, seed: 1 };
}

/** Seeds a consolidatable accepted composed revision R with a linked strategyBacktests combo
 * run (non-null platformRun by default) and R.metrics — the baseline fixture every guard/reject
 * test starts from, then narrows via overrides. */
async function seedConsolidatableRevision(
  services: AppServices,
  opts: {
    revisionOverrides?: Partial<StrategyRevision>;
    platformRun?: PlatformRunConfig | null;
    skipComboRun?: boolean;
  } = {},
): Promise<StrategyRevision> {
  const bundle = await assembleStrategyBundle({ source: STACK_SOURCE, manifestMeta: STACK_MANIFEST_META });
  const bundleArtifactRef = await services.artifacts.put(
    JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test-fixture' },
  );

  if (!opts.skipComboRun) {
    const platformRun = opts.platformRun === undefined ? samplePlatformRun() : opts.platformRun;
    const comboRun: StrategyBacktestRun = {
      id: 'combo-run-1', strategyProfileId: 'p1', strategyBundleId: STACK_MANIFEST_META.id, bundleHash: bundle.bundleHash,
      paramsHash: 'hash1', runKind: 'revision_combo', platformRunId: 'plat-combo', correlationId: 'corr-1',
      params: {}, status: 'completed', metrics: acceptedMetrics(), platformRun,
      artifactRefs: [], platformContractVersion: 'v1', sdkContractVersion: 'v1', backend: 'research_platform',
      submittedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    await services.strategyBacktests.createSubmitted(comboRun);
  }

  const revision: StrategyRevision = {
    id: 'rev-1', strategyProfileId: 'p1', version: 2, hypothesisIds: ['h1'],
    mergedRuleSet: { order: ['h1'], rules: [] },
    bundleArtifactRef, bundleHash: bundle.bundleHash, comboBacktestRunId: 'combo-run-1',
    status: 'accepted', metrics: acceptedMetrics() as unknown as Record<string, unknown>,
    kind: 'composed', compositionDepth: 2,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...opts.revisionOverrides,
  };
  await services.revisions.create(revision);
  return revision;
}

function fakeExecutor(overrides: Partial<RevisionRunResult> = {}): { executor: StrategyRevisionRunExecutor; calls: RevisionRunRequest[] } {
  const calls: RevisionRunRequest[] = [];
  const executor: StrategyRevisionRunExecutor = {
    execute: async (req) => {
      calls.push(req);
      return { status: 'completed', runId: 'run-clean', platformRunId: 'plat-clean', metrics: acceptedMetrics(), ...overrides };
    },
  };
  return { executor, calls };
}

function spyConsolidator(inner: StrategyConsolidatorPort): { consolidator: StrategyConsolidatorPort; calls: StrategyConsolidateArgs[] } {
  const calls: StrategyConsolidateArgs[] = [];
  return {
    calls,
    consolidator: {
      adapter: inner.adapter,
      model: inner.model,
      consolidate: async (args) => { calls.push(args); return inner.consolidate(args); },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('revisionConsolidateHandler — guards, run-context, parity gate, fail-safe rejects (slice G3b, Task 8)', () => {
  it('already_consolidated: no-op, consolidator NOT called', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    const child: StrategyRevision = {
      id: 'rev-2', strategyProfileId: 'p1', version: 3, hypothesisIds: [],
      mergedRuleSet: {}, status: 'accepted', kind: 'consolidated', consolidatedFromRevisionId: R.id,
      bundleArtifactRef: R.bundleArtifactRef,
      compositionDepth: 1, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    };
    await services.revisions.create(child);

    const { consolidator, calls } = spyConsolidator(new FakeStrategyConsolidator());
    services.consolidator = consolidator;

    await revisionConsolidateHandler(task(), services);

    expect(calls).toHaveLength(0);
    const events = await services.events.listByTask('task-consolidate-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('revision.consolidation_skipped');
    expect(events[0]!.payload).toMatchObject({ reason: 'already_consolidated', newRevisionId: child.id });
    expect((await services.revisions.findById('rev-1'))!.status).toBe('accepted');
  });

  it('already_consolidated: recovers a crash-orphaned child baseline (consolidated:${child.id})', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    const child: StrategyRevision = {
      id: 'rev-child', strategyProfileId: R.strategyProfileId, version: R.version + 1,
      baseRevisionId: R.id, kind: 'consolidated', consolidatedFromRevisionId: R.id, semanticParentRevisionId: R.id,
      hypothesisIds: [...R.hypothesisIds], mergedRuleSet: R.mergedRuleSet, bundleArtifactRef: R.bundleArtifactRef,
      compositionDepth: 1, status: 'accepted', baselineValidationStatus: 'pending',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    await services.revisions.create(child); // child exists, but its baseline was never enqueued (crash gap)

    await revisionConsolidateHandler(task(), services);

    const baseline = await services.researchTasks.findByDedupeKey(`strategy.baseline:consolidated:${child.id}`);
    expect(baseline).not.toBeNull();
    expect(baseline!.payload['revisionId']).toBe(child.id);
    const skip = (await services.events.listByTask('task-consolidate-1')).find((e) => e.type === 'revision.consolidation_skipped');
    expect(skip!.payload).toMatchObject({ reason: 'already_consolidated', newRevisionId: child.id, deduped: false });
    // R itself is NOT fallback-baselined
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).toBeNull();
  });

  it('ensureBaselineForRevision guard: an existing child with no bundleArtifactRef → handler rejects, no baseline', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    const child: StrategyRevision = {
      id: 'rev-child-nobundle', strategyProfileId: R.strategyProfileId, version: R.version + 1,
      baseRevisionId: R.id, kind: 'consolidated', consolidatedFromRevisionId: R.id, semanticParentRevisionId: R.id,
      hypothesisIds: [], mergedRuleSet: {}, /* bundleArtifactRef intentionally absent */
      compositionDepth: 1, status: 'accepted', baselineValidationStatus: 'pending',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    await services.revisions.create(child);

    await expect(revisionConsolidateHandler(task(), services)).rejects.toThrow(/no bundleArtifactRef/);
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:consolidated:${child.id}`)).toBeNull();
  });

  it('not accepted: skips with not_consolidatable', async () => {
    const services = makeServices();
    await seedConsolidatableRevision(services, { revisionOverrides: { status: 'candidate' } });
    const { consolidator, calls } = spyConsolidator(new FakeStrategyConsolidator());
    services.consolidator = consolidator;

    await revisionConsolidateHandler(task(), services);

    expect(calls).toHaveLength(0);
    const events = await services.events.listByTask('task-consolidate-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('revision.consolidation_skipped');
    expect(events[0]!.payload['reason']).toBe('not_consolidatable');
  });

  it('not composed (kind:consolidated): skips with not_consolidatable', async () => {
    const services = makeServices();
    await seedConsolidatableRevision(services, { revisionOverrides: { kind: 'consolidated' } });
    const { consolidator, calls } = spyConsolidator(new FakeStrategyConsolidator());
    services.consolidator = consolidator;

    await revisionConsolidateHandler(task(), services);

    expect(calls).toHaveLength(0);
    const events = await services.events.listByTask('task-consolidate-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['reason']).toBe('not_consolidatable');
  });

  it('no bundleArtifactRef: skips with not_consolidatable', async () => {
    const services = makeServices();
    await seedConsolidatableRevision(services, { revisionOverrides: { bundleArtifactRef: undefined } });
    const { consolidator, calls } = spyConsolidator(new FakeStrategyConsolidator());
    services.consolidator = consolidator;

    await revisionConsolidateHandler(task(), services);

    expect(calls).toHaveLength(0);
    const events = await services.events.listByTask('task-consolidate-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['reason']).toBe('not_consolidatable');
  });

  it('reconstruct_failed: corrupt bundleArtifactRef payload — rejected, R stays accepted, no consolidated revision, falls back to accepted-baseline re-baseline (R1 #1)', async () => {
    const services = makeServices();
    const corruptRef = await services.artifacts.put('not-valid-json{{{', {
      kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test-fixture',
    });
    const R = await seedConsolidatableRevision(services, { revisionOverrides: { bundleArtifactRef: corruptRef } });
    const { consolidator, calls } = spyConsolidator(new FakeStrategyConsolidator());
    services.consolidator = consolidator;

    await revisionConsolidateHandler(task(), services);

    expect(calls).toHaveLength(0);
    const events = await services.events.listByTask('task-consolidate-1');
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('revision.consolidation_rejected');
    expect(events[0]!.payload['reason']).toBe('reconstruct_failed');
    expect(events[0]!.payload['detail']).toBeDefined();
    expect((await services.revisions.findById('rev-1'))!.status).toBe('accepted');
    expect(await services.revisions.findConsolidatedOf('rev-1')).toBeNull();

    // R1 #1: reconstruct_failed is still a terminal reject — R still gets the accepted:${R.id} fallback.
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).not.toBeNull();
    expect(events.map((e) => e.type)).toContain('revision.reject_rebaselined');
  });

  it('missing_run_context: comboBacktestRunId absent — rejected, no fallback to defaultPlatformRun, falls back to accepted-baseline re-baseline', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services, { revisionOverrides: { comboBacktestRunId: undefined } });
    const { consolidator, calls } = spyConsolidator(new FakeStrategyConsolidator());
    services.consolidator = consolidator;

    await revisionConsolidateHandler(task(), services);

    // No fallback: the consolidator is never reached, proving the handler never substituted
    // services.defaultPlatformRun for the missing combo-run context.
    expect(calls).toHaveLength(0);
    const events = await services.events.listByTask('task-consolidate-1');
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('revision.consolidation_rejected');
    expect(events[0]!.payload['reason']).toBe('missing_run_context');
    expect((await services.revisions.findById('rev-1'))!.status).toBe('accepted');
    expect(await services.revisions.findConsolidatedOf('rev-1')).toBeNull();

    // R1 #1: missing_run_context is still a terminal reject — R still gets the accepted:${R.id} fallback.
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).not.toBeNull();
    expect(events.map((e) => e.type)).toContain('revision.reject_rebaselined');
  });

  it('missing_run_context: combo run platformRun is null — rejected, no fallback to defaultPlatformRun, falls back to accepted-baseline re-baseline', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services, { platformRun: null });
    const { consolidator, calls } = spyConsolidator(new FakeStrategyConsolidator());
    services.consolidator = consolidator;

    await revisionConsolidateHandler(task(), services);

    expect(calls).toHaveLength(0);
    const events = await services.events.listByTask('task-consolidate-1');
    expect(events[0]!.payload['reason']).toBe('missing_run_context');
    expect((await services.revisions.findById('rev-1'))!.status).toBe('accepted');

    // R1 #1: missing_run_context is still a terminal reject — R still gets the accepted:${R.id} fallback.
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).not.toBeNull();
    expect(events.map((e) => e.type)).toContain('revision.reject_rebaselined');
  });

  it('consolidator_disabled: null consolidator — rejected', async () => {
    const services = makeServices();
    await seedConsolidatableRevision(services);
    services.consolidator = null;

    await revisionConsolidateHandler(task(), services);

    const events = await services.events.listByTask('task-consolidate-1');
    expect(events[0]!.payload['reason']).toBe('consolidator_disabled');
  });

  it('reject fallback: consolidator_disabled re-baselines R directly (accepted:${R.id}) + reject_rebaselined event', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    services.consolidator = null; // -> reject('consolidator_disabled')

    await revisionConsolidateHandler(task(), services);

    const events = await services.events.listByTask('task-consolidate-1');
    expect(events.map((e) => e.type)).toEqual(['revision.consolidation_rejected', 'revision.reject_rebaselined']);
    expect(events[0]!.payload['reason']).toBe('consolidator_disabled');
    expect(events[1]!.payload).toMatchObject({ revisionId: R.id, reason: 'consolidator_disabled', deduped: false });

    const baseline = await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`);
    expect(baseline).not.toBeNull();
    expect(baseline!.taskType).toBe('strategy.baseline');
    expect(baseline!.payload).toMatchObject({ strategyProfileId: R.strategyProfileId, bundleArtifactRef: R.bundleArtifactRef, revisionId: R.id });

    const updated = await services.revisions.findById(R.id);
    expect(updated!.baselineValidationStatus).toBe('pending');
  });

  it('consolidator_error: consolidate() throws — rejected with detail', async () => {
    const services = makeServices();
    await seedConsolidatableRevision(services);
    services.consolidator = {
      adapter: 'fake', model: 'fake',
      consolidate: async () => { throw new Error('llm blew up'); },
    };

    await revisionConsolidateHandler(task(), services);

    const events = await services.events.listByTask('task-consolidate-1');
    expect(events[0]!.type).toBe('revision.consolidation_rejected');
    expect(events[0]!.payload['reason']).toBe('consolidator_error');
    expect(events[0]!.payload['detail']).toBe('llm blew up');
    expect((await services.revisions.findById('rev-1'))!.status).toBe('accepted');
  });

  it('wires the token-budget onUsage into consolidator.consolidate (spec §4 step 4 / §5 / §11 #10)', async () => {
    const tokenUsage = new InMemoryTokenUsageRepository();
    const services = makeServices({ tokenUsage });
    await seedConsolidatableRevision(services);
    let receivedOpts: AgentCallOpts | undefined;
    services.consolidator = {
      adapter: 'fake', model: 'test',
      consolidate: async (_args, opts) => {
        receivedOpts = opts;
        await opts?.onUsage?.({ modelId: 'test', inputTokens: 700, outputTokens: 77, totalTokens: 777 });
        return { source: STACK_SOURCE, manifestMeta: STACK_MANIFEST_META };
      },
    };

    const t = task();
    await revisionConsolidateHandler(t, services);

    expect(receivedOpts?.onUsage).toBeTypeOf('function');
    expect(await tokenUsage.get(t.correlationId)).toBe(777);
  });

  it('bundle_invalid: consolidator output fails validateStrategyBundle — rejected', async () => {
    const services = makeServices();
    await seedConsolidatableRevision(services);
    services.consolidator = {
      adapter: 'fake', model: 'fake',
      consolidate: async () => ({ source: AMBIENT_AUTHORITY_SOURCE, manifestMeta: STACK_MANIFEST_META }),
    };

    await revisionConsolidateHandler(task(), services);

    const events = await services.events.listByTask('task-consolidate-1');
    expect(events[0]!.type).toBe('revision.consolidation_rejected');
    expect(events[0]!.payload['reason']).toBe('bundle_invalid');
    expect((await services.revisions.findById('rev-1'))!.status).toBe('accepted');
  });

  it('consolidation_run_unavailable: executor does not complete — rejected', async () => {
    const services = makeServices();
    await seedConsolidatableRevision(services);
    services.consolidator = new FakeStrategyConsolidator();
    const { executor } = fakeExecutor({ status: 'pending', metrics: undefined });
    services.revisionRunExecutor = executor;

    await revisionConsolidateHandler(task(), services);

    const events = await services.events.listByTask('task-consolidate-1');
    expect(events[0]!.payload['reason']).toBe('consolidation_run_unavailable');
  });

  it.each([
    ['reconstruct_failed', async (s: AppServices) => {
      const corruptRef = await s.artifacts.put('not-valid-json{{{', {
        kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test-fixture',
      });
      await s.revisions.updateStatus('rev-1', { bundleArtifactRef: corruptRef });
    }],
    ['consolidator_error', (s: AppServices) => {
      s.consolidator = {
        adapter: 'fake', model: 'fake',
        consolidate: async () => { throw new Error('llm blew up'); },
      };
    }],
    ['bundle_invalid', (s: AppServices) => {
      s.consolidator = {
        adapter: 'fake', model: 'fake',
        consolidate: async () => ({ source: AMBIENT_AUTHORITY_SOURCE, manifestMeta: STACK_MANIFEST_META }),
      };
    }],
    ['consolidation_run_unavailable', (s: AppServices) => {
      s.consolidator = new FakeStrategyConsolidator();
      const { executor } = fakeExecutor({ status: 'pending', metrics: undefined });
      s.revisionRunExecutor = executor;
    }],
  ] as const)('reject fallback: %s re-baselines R (accepted:${R.id})', async (reason, arrange) => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    await arrange(services);

    await revisionConsolidateHandler(task(), services);

    const events = await services.events.listByTask('task-consolidate-1');
    expect(events.find((e) => e.type === 'revision.consolidation_rejected')!.payload['reason']).toContain(reason.split(':')[0]);
    const rebase = events.find((e) => e.type === 'revision.reject_rebaselined');
    expect(rebase!.payload).toMatchObject({ revisionId: R.id, deduped: false });
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).not.toBeNull();
  });

  it('divergent metrics: rejected with metric/trade_count reasons + deltas; R stays accepted; no consolidated child; falls back to accepted-baseline re-baseline (R1 #1)', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    services.consolidator = new FakeStrategyConsolidator();
    const { executor } = fakeExecutor({ metrics: { ...acceptedMetrics(), totalTrades: 31 } });
    services.revisionRunExecutor = executor;

    await revisionConsolidateHandler(task(), services);

    const events = await services.events.listByTask('task-consolidate-1');
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('revision.consolidation_rejected');
    const reasons = events[0]!.payload['reasons'] as string[];
    expect(reasons).toContain('trade_count_changed');
    expect(events[0]!.payload['deltas']).toBeDefined();

    expect((await services.revisions.findById('rev-1'))!.status).toBe('accepted');
    expect(await services.revisions.findConsolidatedOf('rev-1')).toBeNull();

    // R1 #1: the reject fallback re-baselines R directly — was: expect(queued.some((q) =>
    // q.taskType === 'strategy.baseline')).toBe(false); that literal assertion encoded the
    // stranding bug this fix closes, not a coincidental invariant.
    const fallback = await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`);
    expect(fallback).not.toBeNull();
    expect(fallback!.payload['revisionId']).toBe(R.id);
    const evTypes = events.map((e) => e.type);
    expect(evTypes).toContain('revision.reject_rebaselined');
  });

  it('rejected is retryable: a second invocation with an equivalent executor proceeds past the parity gate, but the accept-path guard blocks a second baseline (R already fallback-rebaselined)', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    const { consolidator, calls: consolidatorCalls } = spyConsolidator(new FakeStrategyConsolidator());
    services.consolidator = consolidator;

    const divergent = fakeExecutor({ metrics: { ...acceptedMetrics(), totalTrades: 31 } });
    services.revisionRunExecutor = divergent.executor;

    await revisionConsolidateHandler(task(), services);
    const firstEvents = await services.events.listByTask('task-consolidate-1');
    expect(firstEvents[0]!.payload['reason'] ?? firstEvents[0]!.payload['reasons']).toBeTruthy();
    expect((await services.revisions.findById('rev-1'))!.status).toBe('accepted');
    expect(consolidatorCalls).toHaveLength(1);
    // The first reject already fell back to a direct R baseline (R1 #1).
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).not.toBeNull();

    // Swap in an executor that reports parity-equivalent metrics: the retry proceeds PAST the
    // parity gate and reaches the (Task 9) accept path — but the accept-path guard now finds R's
    // already-live accepted:${R.id} fallback baseline and skips materializing a consolidated
    // child (this is the cross-invocation double-baseline guard under test; previously this would
    // have wrongly materialized a second, non-dedupable baseline on top of R's fallback).
    const equivalent = fakeExecutor({ metrics: acceptedMetrics() });
    services.revisionRunExecutor = equivalent.executor;

    await revisionConsolidateHandler(task(), services);
    expect(consolidatorCalls).toHaveLength(2);
    expect(equivalent.calls).toHaveLength(1);
    expect(await services.revisions.findConsolidatedOf('rev-1')).toBeNull();
    const events = await services.events.listByTask('task-consolidate-1');
    expect(events[events.length - 1]!.payload).toMatchObject({ reason: 'reject_fallback_already_baselined' });
  });

  it('reject fallback is idempotent: a completed accepted-baseline is not rolled back, event deduped:true', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);

    // Simulate a prior fallback that already ran to completion.
    await services.researchTasks.create({
      id: 'rt-existing-baseline', taskType: 'strategy.baseline', source: task().source,
      correlationId: 'c-existing', dedupeKey: `strategy.baseline:accepted:${R.id}`, status: 'completed',
      payload: { strategyProfileId: R.strategyProfileId, bundleArtifactRef: R.bundleArtifactRef, revisionId: R.id },
      availableAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await services.revisions.updateStatus(R.id, { baselineValidationStatus: 'passed', updatedAt: '2026-01-01T00:00:00Z' });

    services.consolidator = null; // reject('consolidator_disabled')
    const beforeQueued = (services.taskQueue as InMemoryQueueAdapter).queued.length;

    await revisionConsolidateHandler(task(), services);

    expect((await services.revisions.findById(R.id))!.baselineValidationStatus).toBe('passed'); // NOT rolled back
    expect((services.taskQueue as InMemoryQueueAdapter).queued.length).toBe(beforeQueued);       // no new job
    const rebase = (await services.events.listByTask('task-consolidate-1')).find((e) => e.type === 'revision.reject_rebaselined');
    expect(rebase!.payload['deduped']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ACCEPT path (slice G3b Task 9): materialize consolidated revision + re-baseline
// ---------------------------------------------------------------------------

describe('revisionConsolidateHandler — accept path (slice G3b, Task 9)', () => {
  async function runHappyPath(services: AppServices, revisionOverrides: Partial<StrategyRevision> = {}): Promise<StrategyRevision> {
    const R = await seedConsolidatableRevision(services, { revisionOverrides });
    services.consolidator = new FakeStrategyConsolidator();
    const { executor } = fakeExecutor({ metrics: acceptedMetrics() });
    services.revisionRunExecutor = executor;

    await revisionConsolidateHandler(task(), services);
    return R;
  }

  it('materializes a consolidated revision with verbatim-inherited fields + reset depth', async () => {
    const services = makeServices();
    const R = await runHappyPath(services);

    const consolidated = await services.revisions.findConsolidatedOf(R.id);
    expect(consolidated).not.toBeNull();
    expect(consolidated!.kind).toBe('consolidated');
    expect(consolidated!.baseRevisionId).toBe(R.id);
    expect(consolidated!.consolidatedFromRevisionId).toBe(R.id);
    expect(consolidated!.semanticParentRevisionId).toBe(R.id);
    expect(consolidated!.compositionDepth).toBe(1);
    expect(consolidated!.version).toBe(R.version + 1);
    expect(consolidated!.status).toBe('accepted');
    expect(consolidated!.baselineValidationStatus).toBe('pending');
    expect(consolidated!.hypothesisIds).toEqual(R.hypothesisIds);
    expect(consolidated!.mergedRuleSet).toEqual(R.mergedRuleSet);
  });

  it('enqueues exactly one ready-bundle strategy.baseline task and emits revision.consolidated', async () => {
    const services = makeServices();
    const R = await runHappyPath(services);

    const consolidated = await services.revisions.findConsolidatedOf(R.id);
    expect(consolidated).not.toBeNull();

    const queued = (services.taskQueue as InMemoryQueueAdapter).queued;
    const baselineEnvelopes = queued.filter((q) => q.taskType === 'strategy.baseline');
    expect(baselineEnvelopes).toHaveLength(1);

    const baselineTask = await services.researchTasks.findByDedupeKey(`strategy.baseline:consolidated:${consolidated!.id}`);
    expect(baselineTask).not.toBeNull();
    expect(baselineTask!.payload['strategyProfileId']).toBe(R.strategyProfileId);
    expect(baselineTask!.payload['bundleArtifactRef']).toBeDefined();
    expect(baselineTask!.payload['revisionId']).toBe(consolidated!.id);

    const events = await services.events.listByTask('task-consolidate-1');
    const consolidatedEvent = events.find((e) => e.type === 'revision.consolidated');
    expect(consolidatedEvent).toBeDefined();
    expect(consolidatedEvent!.payload['fromRevisionId']).toBe(R.id);
    expect(consolidatedEvent!.payload['newRevisionId']).toBe(consolidated!.id);
    expect(consolidatedEvent!.payload['version']).toBe(consolidated!.version);
  });

  it('Style-A: a dropped unsupported_module_shape hypothesis is NOT rescued into hypothesisIds', async () => {
    const services = makeServices();
    const R = await runHappyPath(services, {
      hypothesisIds: ['h1'],
      dropped: [{ hypothesisId: 'h-dropped-style-a', reason: 'unsupported_module_shape', detail: 'unsupported module shape' }],
    });

    const consolidated = await services.revisions.findConsolidatedOf(R.id);
    expect(consolidated).not.toBeNull();
    expect(consolidated!.hypothesisIds).toEqual(R.hypothesisIds);
    expect(consolidated!.hypothesisIds).not.toContain('h-dropped-style-a');
  });

  it('findConsolidatedOf(R.id) after success returns the new consolidated revision (retry is a no-op)', async () => {
    const services = makeServices();
    const R = await runHappyPath(services);
    const consolidated = await services.revisions.findConsolidatedOf(R.id);
    expect(consolidated).not.toBeNull();

    // Retry: already_consolidated short-circuit — no new consolidated revision, no new baseline task.
    const beforeQueued = (services.taskQueue as InMemoryQueueAdapter).queued.length;
    await revisionConsolidateHandler(task(), services);
    const events = await services.events.listByTask('task-consolidate-1');
    expect(events[events.length - 1]!.type).toBe('revision.consolidation_skipped');
    expect(events[events.length - 1]!.payload['reason']).toBe('already_consolidated');
    expect((services.taskQueue as InMemoryQueueAdapter).queued.length).toBe(beforeQueued);
  });

  it('concurrent_revision (snapshot): a consolidated child of R at v+1 → ensure child baseline, R not fallback', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    const competitor: StrategyRevision = {
      id: 'rev-child-concurrent', strategyProfileId: R.strategyProfileId, version: R.version + 1,
      baseRevisionId: R.id, kind: 'consolidated', consolidatedFromRevisionId: R.id, semanticParentRevisionId: R.id,
      hypothesisIds: [], mergedRuleSet: {}, bundleArtifactRef: R.bundleArtifactRef,
      compositionDepth: 1, status: 'accepted', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    await services.revisions.create(competitor);
    services.consolidator = new FakeStrategyConsolidator();
    services.revisionRunExecutor = fakeExecutor({ metrics: acceptedMetrics() }).executor;

    // The child was pre-created, so the top-of-handler already_consolidated guard would short-circuit
    // BEFORE create-catch. Model the race: the top guard's FIRST findConsolidatedOf read misses a
    // concurrently-committing child (returns null), so the handler proceeds to acceptConsolidation,
    // create(consolidated at v+1) collides, and the create-catch discovers the child via its
    // listByProfile snapshot — the single-snapshot classification path under test.
    const realFind = services.revisions.findConsolidatedOf.bind(services.revisions);
    let first = true;
    services.revisions.findConsolidatedOf = async (id) => {
      if (first) { first = false; return null; }
      return realFind(id);
    };

    await revisionConsolidateHandler(task(), services);

    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:consolidated:${competitor.id}`)).not.toBeNull();
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).toBeNull();
    const ev = (await services.events.listByTask('task-consolidate-1')).find((e) => e.type === 'revision.consolidation_skipped');
    expect(ev!.payload).toMatchObject({ reason: 'concurrent_revision', newRevisionId: competitor.id });
  });

  it('concurrent_version_conflict: a non-child revision occupies v+1 → fall back to R (accepted:${R.id})', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    const competitor: StrategyRevision = {
      id: 'rev-competitor', strategyProfileId: R.strategyProfileId, version: R.version + 1,
      hypothesisIds: [], mergedRuleSet: {}, status: 'accepted', kind: 'composed',
      compositionDepth: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    await services.revisions.create(competitor);
    services.consolidator = new FakeStrategyConsolidator();
    services.revisionRunExecutor = fakeExecutor({ metrics: acceptedMetrics() }).executor;

    await revisionConsolidateHandler(task(), services);

    const rejected = (await services.events.listByTask('task-consolidate-1')).find((e) => e.type === 'revision.consolidation_rejected');
    expect(rejected!.payload).toMatchObject({ reason: 'concurrent_version_conflict', occupantRevisionId: competitor.id });
    expect((await services.events.listByTask('task-consolidate-1')).some((e) => e.type === 'revision.reject_rebaselined')).toBe(true);
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).not.toBeNull();
    expect(await services.revisions.findConsolidatedOf(R.id)).toBeNull();
  });

  it('unknown create error: version v+1 free → rethrow (worker retry)', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    services.consolidator = new FakeStrategyConsolidator();
    services.revisionRunExecutor = fakeExecutor({ metrics: acceptedMetrics() }).executor;
    const realCreate = services.revisions.create.bind(services.revisions);
    services.revisions.create = async (r) => { if (r.kind === 'consolidated') throw new Error('boom-transient'); return realCreate(r); };

    await expect(revisionConsolidateHandler(task(), services)).rejects.toThrow('boom-transient');
    expect(await services.researchTasks.findByDedupeKey(`strategy.baseline:accepted:${R.id}`)).toBeNull();
  });

  it('accept-path guard: an existing accepted:${R.id} fallback baseline → skip, no consolidated child', async () => {
    const services = makeServices();
    const R = await seedConsolidatableRevision(services);
    // Simulate a prior transient-reject attempt that already fell back to a direct R baseline.
    await services.researchTasks.create({
      id: 'rt-prior-fallback', taskType: 'strategy.baseline', source: task().source,
      correlationId: 'c-prior', dedupeKey: `strategy.baseline:accepted:${R.id}`, status: 'queued',
      payload: { strategyProfileId: R.strategyProfileId, bundleArtifactRef: R.bundleArtifactRef, revisionId: R.id },
      availableAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    services.consolidator = new FakeStrategyConsolidator();
    services.revisionRunExecutor = fakeExecutor({ metrics: acceptedMetrics() }).executor;

    await revisionConsolidateHandler(task(), services);

    // No consolidated child materialized; skip event with the guard reason.
    expect(await services.revisions.findConsolidatedOf(R.id)).toBeNull();
    const skip = (await services.events.listByTask('task-consolidate-1')).find((e) => e.type === 'revision.consolidation_skipped');
    expect(skip!.payload).toMatchObject({ reason: 'reject_fallback_already_baselined' });
    // Only the pre-existing accepted baseline exists; no consolidated:* task enqueued.
    const queued = (services.taskQueue as InMemoryQueueAdapter).queued;
    expect(queued.filter((q) => q.taskType === 'strategy.baseline').length).toBe(0); // no NEW enqueue (prior task pre-created directly, not via queue)
  });
});
