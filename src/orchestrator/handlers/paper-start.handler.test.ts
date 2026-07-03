// src/orchestrator/handlers/paper-start.handler.test.ts
import { describe, it, expect } from 'vitest';
import { paperStartHandler, PaperStartPayloadSchema } from './paper-start.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask, QueueEnvelope } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchExperiment, ExperimentRunMember } from '../../domain/research-experiment.ts';
import type { StrategyBacktestRun } from '../../domain/strategy-backtest-run.ts';
import type { PaperIntakePort, SubmitProvenCandidateArgs } from '../../adapters/platform/paper-intake.port.ts';
import { FakeStrategyBuilder } from '../../adapters/builder/fake-strategy-builder.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';

const NOW = '2026-07-03T00:00:00.000Z';

const DATASET_SCOPE = {
  datasetId: 'ds-1',
  symbols: ['ESPORTSUSDT'],
  timeframe: '1h',
  period: { from: '2026-06-12T00:00:00.000Z', to: '2026-06-19T00:00:00.000Z' },
};

const HOLDOUT_POLICY = {
  mode: 'trade_based' as const,
  minTradesTrain: 20,
  minTradesHoldout: 10,
  lowConfidenceThreshold: 0.5,
  minHistoryDays: 30,
};

function profile(): StrategyProfile {
  return {
    id: 'prof-1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:s', direction: 'long',
    coreIdea: 'oi-based entry filter', requiredMarketFeatures: ['oi', 'funding'], confidence: 0.6, unknowns: [],
    profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1', createdAt: NOW, updatedAt: NOW,
  };
}

function taskOf(payload: Record<string, unknown> = { experimentId: 'exp-wfo', baselineExperimentId: 'exp-base' }): ResearchTask {
  return { id: 't1', taskType: 'paper.start', source: 'operator', correlationId: 'c1', status: 'running', payload, createdAt: NOW, updatedAt: NOW };
}

type PaperCandidateIntakeResult = Awaited<ReturnType<PaperIntakePort['submitProvenCandidate']>>;

async function makeTestStrategyBundle(): Promise<AssembledStrategyBundle> {
  const builder = new FakeStrategyBuilder();
  const out = await builder.build({ spec: { description: 'test' }, authoringDoc: '' });
  return assembleStrategyBundle(out);
}

function backtestRun(over: Partial<StrategyBacktestRun>): StrategyBacktestRun {
  return {
    id: 'run-lab',
    strategyProfileId: 'prof-1',
    strategyBundleId: 'sb-1',
    bundleHash: 'sha256:x',
    paramsHash: 'ph',
    runKind: 'strategy_baseline',
    platformRunId: 'plat-run',
    correlationId: 'corr-1',
    params: {},
    status: 'completed',
    metrics: {
      netPnlUsd: 10, netPnlPct: 1, totalTrades: 5, winRate: 0.6, profitFactor: 1.5,
      maxDrawdownPct: 2, expectancyUsd: 2, sharpe: 1.1, topTradeContributionPct: 10,
    },
    platformRun: null,
    artifactRefs: [],
    platformContractVersion: 'v1',
    sdkContractVersion: 'v1',
    backend: 'research_platform',
    submittedAt: NOW,
    finishedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

interface MakeOpts {
  enabled?: boolean;
  result?: PaperCandidateIntakeResult;
  mismatchedBaselineHash?: boolean;
  seedExisting?: 'submitted' | 'failed';
  /** Only applied when seedExisting === 'submitted'; omit to seed a row WITHOUT monitorStatus (retry-edge). */
  monitorStatus?: 'watching' | 'window_complete' | 'stalled';
  /** Only applied when seedExisting === 'submitted'; omit to seed a row WITHOUT strategyName (pre-G4 legacy row). */
  strategyName?: string;
}

async function make(opts: MakeOpts = {}): Promise<{
  services: AppServices;
  intakeCalls: SubmitProvenCandidateArgs[];
  events: { type: string; payload: Record<string, unknown> }[];
  artifacts: { putHashes: string[]; getHashes: string[] };
  bundleHash: string;
  manifestId: string;
  queueCalls: { envelope: QueueEnvelope; opts?: { delayMs?: number } }[];
}> {
  const intakeCalls: SubmitProvenCandidateArgs[] = [];
  const result: PaperCandidateIntakeResult = opts.result ?? {
    ok: true, candidateId: 'cand-1', admissionStatus: 'admitted', admissionReasonCode: null, idempotentReplay: false,
  };
  const paperIntake: PaperIntakePort = {
    enabled: opts.enabled ?? true,
    submitProvenCandidate: async (args) => {
      intakeCalls.push(args);
      return result;
    },
  };

  const services = makeServices({ paperIntake });
  await services.strategyProfiles.create(profile());

  const bundle = await makeTestStrategyBundle();
  const bundleArtifactRef = await services.artifacts.put(
    JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
  );

  const putHashes: string[] = [];
  const originalPut = services.artifacts.put.bind(services.artifacts);
  services.artifacts.put = async (content, meta) => {
    const ref = await originalPut(content, meta);
    putHashes.push(ref.content_hash);
    return ref;
  };

  const getHashes: string[] = [];
  const originalGet = services.artifacts.get.bind(services.artifacts);
  services.artifacts.get = async (ref) => {
    getHashes.push(ref.content_hash);
    return originalGet(ref);
  };

  const baselineBundleHash = opts.mismatchedBaselineHash ? 'sha256:mismatched' : bundle.bundleHash;

  const baseline: ResearchExperiment = {
    id: 'exp-base', experimentKey: 'key-exp-base', experimentType: 'strategy_baseline_validation',
    strategyProfileId: 'prof-1', bundleHash: baselineBundleHash, bundleArtifactRef,
    datasetScope: DATASET_SCOPE, holdoutPolicy: HOLDOUT_POLICY, status: 'completed', createdAt: NOW, updatedAt: NOW,
  };
  const wfo: ResearchExperiment = {
    id: 'exp-wfo', experimentKey: 'key-exp-wfo', experimentType: 'walk_forward_optimization',
    strategyProfileId: 'prof-1', bundleHash: bundle.bundleHash,
    datasetScope: DATASET_SCOPE, holdoutPolicy: HOLDOUT_POLICY, status: 'completed',
    verdict: 'PAPER_CANDIDATE', verdictReason: 'wfo champion', createdAt: NOW, updatedAt: NOW,
  };
  await services.experiments.createExperiment(baseline);
  await services.experiments.createExperiment(wfo);

  const baseHoldout: ExperimentRunMember = {
    id: 'm-base-holdout', experimentId: 'exp-base', strategyBacktestRunId: 'run-base',
    role: 'holdout', periodFrom: DATASET_SCOPE.period.from, periodTo: DATASET_SCOPE.period.to,
    symbols: DATASET_SCOPE.symbols, paramsHash: 'ph-base', bundleHash: baselineBundleHash, createdAt: NOW,
  };
  const wfoHoldout: ExperimentRunMember = {
    id: 'm-wfo-holdout', experimentId: 'exp-wfo', strategyBacktestRunId: 'run-var',
    role: 'holdout', oos: true, periodFrom: DATASET_SCOPE.period.from, periodTo: DATASET_SCOPE.period.to,
    symbols: DATASET_SCOPE.symbols, paramsHash: 'ph-wfo', params: { dumpPct: 8 },
    bundleHash: bundle.bundleHash, createdAt: NOW,
    resultSummary: { decision: 'PAPER_CANDIDATE', totalTrades: 42, netPnlUsd: 500, maxDrawdownPct: 3.2, sharpe: 1.4 },
  };
  await services.experiments.addMember(baseHoldout);
  await services.experiments.addMember(wfoHoldout);

  await services.strategyBacktests.createSubmitted(
    backtestRun({ id: 'run-base', platformRunId: 'plat-run-base', bundleHash: baselineBundleHash }),
  );
  await services.strategyBacktests.createSubmitted(
    backtestRun({ id: 'run-var', platformRunId: 'plat-run-var', bundleHash: bundle.bundleHash }),
  );

  if (opts.seedExisting) {
    await services.paperSubmissions.upsertByExperimentId({
      id: 'existing-1', experimentId: 'exp-wfo', strategyProfileId: 'prof-1',
      submissionStatus: opts.seedExisting,
      ...(opts.seedExisting === 'submitted' ? { candidateId: 'cand-prior', admissionStatus: 'admitted' } : { error: { category: 'validation_error', code: 'x', message: 'prior fail' } }),
      ...(opts.seedExisting === 'submitted' && opts.monitorStatus ? { monitorStatus: opts.monitorStatus } : {}),
      ...(opts.seedExisting === 'submitted' && opts.strategyName ? { strategyName: opts.strategyName } : {}),
      idempotencyKey: 'wfo-champion:exp-wfo', bundleHash: bundle.bundleHash, createdAt: NOW, updatedAt: NOW,
    });
  }

  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const originalAppend = services.events.append.bind(services.events);
  services.events.append = async (evt) => {
    events.push({ type: evt.type, payload: evt.payload });
    return originalAppend(evt);
  };

  const queueCalls: { envelope: QueueEnvelope; opts?: { delayMs?: number } }[] = [];
  const originalEnqueue = services.taskQueue.enqueue.bind(services.taskQueue);
  services.taskQueue.enqueue = async (envelope, enqueueOpts) => {
    queueCalls.push({ envelope, opts: enqueueOpts });
    return originalEnqueue(envelope, enqueueOpts);
  };

  return { services, intakeCalls, events, artifacts: { putHashes, getHashes }, bundleHash: bundle.bundleHash, manifestId: bundle.manifest.id, queueCalls };
}

describe('paperStartHandler', () => {
  it('rejects an invalid payload', async () => {
    const { services } = await make();
    await expect(paperStartHandler(taskOf({}), services)).rejects.toThrow(/invalid paper\.start payload/);
  });

  it('skips when intake disabled: event, no submit, no ledger row', async () => {
    const { services, intakeCalls, events } = await make({ enabled: false });
    await paperStartHandler(taskOf(), services);
    expect(intakeCalls).toHaveLength(0);
    expect(events.map((e) => e.type)).toContain('paper.intake_skipped');
    expect(await services.paperSubmissions.findByExperimentId('exp-wfo')).toBeNull();
  });

  it('happy path: bytes in CAS (content_hash === bundleHash), ledger submitted, event with candidateId', async () => {
    const { services, artifacts, bundleHash, events, manifestId } = await make({
      result: { ok: true, candidateId: 'cand-1', admissionStatus: 'admitted', admissionReasonCode: null, idempotentReplay: false },
    });
    await paperStartHandler(taskOf(), services);
    expect(artifacts.putHashes).toContain(bundleHash);
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({
      submissionStatus: 'submitted', candidateId: 'cand-1', admissionStatus: 'admitted', idempotencyKey: 'wfo-champion:exp-wfo',
      strategyName: manifestId, monitorStatus: 'watching', observedTrades: 0, windowPolicy: services.paperWindowPolicy,
    });
    expect(events).toContainEqual({
      type: 'paper.candidate_submitted',
      payload: { experimentId: 'exp-wfo', candidateId: 'cand-1', admissionStatus: 'admitted', idempotentReplay: false },
    });
  });

  it('admitted: enqueues paper.monitor with delayMs = services.paperMonitorPollMs', async () => {
    const { services, queueCalls } = await make({
      result: { ok: true, candidateId: 'cand-1', admissionStatus: 'admitted', admissionReasonCode: null, idempotentReplay: false },
    });
    await paperStartHandler(taskOf(), services);
    const monitorCalls = queueCalls.filter((c) => c.envelope.taskType === 'paper.monitor');
    expect(monitorCalls).toHaveLength(1);
    expect(monitorCalls[0]?.envelope.dedupeKey).toBe('paper.monitor:exp-wfo:0');
    expect(monitorCalls[0]?.envelope.correlationId).toBe('c1');
    expect(monitorCalls[0]?.opts).toEqual({ delayMs: services.paperMonitorPollMs });
    const queuedTask = await services.researchTasks.findByDedupeKey('paper.monitor:exp-wfo:0');
    expect(queuedTask?.payload).toEqual({ experimentId: 'exp-wfo' });
  });

  it('already submitted with terminal monitorStatus (window_complete): old behavior, no monitor enqueued', async () => {
    const { services, intakeCalls, events, queueCalls } = await make({ seedExisting: 'submitted', monitorStatus: 'window_complete' });
    await paperStartHandler(taskOf(), services);
    expect(intakeCalls).toHaveLength(0);
    expect(events).toContainEqual({ type: 'paper.already_submitted', payload: { experimentId: 'exp-wfo', candidateId: 'cand-prior' } });
    expect(queueCalls.filter((c) => c.envelope.taskType === 'paper.monitor')).toHaveLength(0);
  });

  it('retry-edge: already-submitted fully-seeded row (strategyName present) seeds monitor fields + enqueues paper.monitor, no duplicate submit, no bundle reconstruction', async () => {
    const { services, intakeCalls, queueCalls, artifacts } = await make({ seedExisting: 'submitted', strategyName: 'already-set-strategy-name' });
    await paperStartHandler(taskOf(), services);
    expect(intakeCalls).toHaveLength(0);
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({
      monitorStatus: 'watching', observedTrades: 0, windowPolicy: services.paperWindowPolicy,
      strategyName: 'already-set-strategy-name',
    });
    expect(artifacts.getHashes).toHaveLength(0);
    const monitorCalls = queueCalls.filter((c) => c.envelope.taskType === 'paper.monitor');
    expect(monitorCalls).toHaveLength(1);
    expect(monitorCalls[0]?.envelope.dedupeKey).toBe('paper.monitor:exp-wfo:0');
    expect(monitorCalls[0]?.opts).toEqual({ delayMs: services.paperMonitorPollMs });
  });

  it('retry-edge: legacy already-submitted row without strategyName (pre-G4) backfills strategyName from the reconstructed bundle + seeds monitor fields + enqueues paper.monitor', async () => {
    const { services, intakeCalls, queueCalls, artifacts, manifestId } = await make({ seedExisting: 'submitted' });
    await paperStartHandler(taskOf(), services);
    expect(intakeCalls).toHaveLength(0);
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({
      strategyName: manifestId, monitorStatus: 'watching', observedTrades: 0, windowPolicy: services.paperWindowPolicy,
    });
    expect(artifacts.getHashes.length).toBeGreaterThan(0);
    const monitorCalls = queueCalls.filter((c) => c.envelope.taskType === 'paper.monitor');
    expect(monitorCalls).toHaveLength(1);
    expect(monitorCalls[0]?.envelope.dedupeKey).toBe('paper.monitor:exp-wfo:0');
    expect(monitorCalls[0]?.opts).toEqual({ delayMs: services.paperMonitorPollMs });
  });

  it('bundleHash mismatch wfo↔baseline → actionable error', async () => {
    const { services } = await make({ mismatchedBaselineHash: true });
    await expect(paperStartHandler(taskOf(), services)).rejects.toThrow(/bundleHash mismatch/);
  });

  it('ok:true + admissionStatus rejected → ledger rejected + paper.candidate_rejected, no throw, no monitor task', async () => {
    const { services, events, queueCalls } = await make({
      result: { ok: true, candidateId: 'cand-2', admissionStatus: 'rejected', admissionReasonCode: 'low_confidence', idempotentReplay: false },
    });
    await paperStartHandler(taskOf(), services);
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({ submissionStatus: 'rejected', candidateId: 'cand-2' });
    expect(row?.monitorStatus).toBeUndefined();
    expect(events).toContainEqual({
      type: 'paper.candidate_rejected',
      payload: { experimentId: 'exp-wfo', candidateId: 'cand-2', reasonCode: 'low_confidence' },
    });
    expect(queueCalls.filter((c) => c.envelope.taskType === 'paper.monitor')).toHaveLength(0);
  });

  it('ok:false internal_error → throws (retry), no ledger row', async () => {
    const { services } = await make({ result: { ok: false, error: { category: 'internal_error', code: 'x', message: 'boom' } } });
    await expect(paperStartHandler(taskOf(), services)).rejects.toThrow(/internal_error|boom/);
    expect(await services.paperSubmissions.findByExperimentId('exp-wfo')).toBeNull();
  });

  it('ok:false validation_error → ledger failed + error jsonb + paper.submission_failed, no throw', async () => {
    const { services, events } = await make({
      result: { ok: false, error: { category: 'validation_error', code: 'bad_input', message: 'nope' } },
    });
    await paperStartHandler(taskOf(), services);
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({ submissionStatus: 'failed', error: { category: 'validation_error', code: 'bad_input', message: 'nope' } });
    expect(events).toContainEqual({
      type: 'paper.submission_failed',
      payload: { experimentId: 'exp-wfo', category: 'validation_error', code: 'bad_input' },
    });
  });

  it('retry after failed row → port called again, row upserted to submitted', async () => {
    const { services, intakeCalls } = await make({
      seedExisting: 'failed',
      result: { ok: true, candidateId: 'cand-3', admissionStatus: 'admitted', admissionReasonCode: null, idempotentReplay: false },
    });
    await paperStartHandler(taskOf(), services);
    expect(intakeCalls).toHaveLength(1);
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({ submissionStatus: 'submitted', candidateId: 'cand-3', id: 'existing-1' });
  });
});

void PaperStartPayloadSchema;
