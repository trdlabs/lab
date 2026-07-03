// src/orchestrator/handlers/paper-bridge.integration.test.ts
//
// End-to-end integration test for the paper-bridge (G2) chain: a completed strategy_baseline
// experiment (with a real wrapper artifact in the in-memory CAS) + a PAPER_CANDIDATE WFO
// experiment, both with seeded holdout run members pointing at StrategyBacktestRun rows whose
// *platform* ids are deliberately distinct from their *lab* ids — mirrors the real shape (lab
// mints its own row id; the platform mints an independent run id) and lets this test prove
// buildChampionSubmission's evidence.baselineRunId/variantRunId project the platform id, never
// the lab id. Composition style mirrors new-strategy-holdout.integration.test.ts: real in-memory
// services via makeServices(), only the platform-facing edge (paperIntake) is a capturing fake.
import { describe, it, expect } from 'vitest';
import { paperStartHandler } from './paper-start.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchExperiment, ExperimentRunMember } from '../../domain/research-experiment.ts';
import type { StrategyBacktestRun } from '../../domain/strategy-backtest-run.ts';
import type { PaperIntakePort, SubmitProvenCandidateArgs } from '../../adapters/platform/paper-intake.port.ts';
import { FakeStrategyBuilder } from '../../adapters/builder/fake-strategy-builder.ts';
import { assembleStrategyBundle } from '../../domain/strategy-bundle.ts';

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

function taskOf(payload: Record<string, unknown> = { experimentId: 'exp-wfo', baselineExperimentId: 'exp-base' }): ResearchTask {
  return { id: 't1', taskType: 'paper.start', source: 'operator', correlationId: 'c1', status: 'running', payload, createdAt: NOW, updatedAt: NOW };
}

describe('paper-bridge integration (paperStartHandler, end-to-end on in-memory infra)', () => {
  it('submits the WFO champion with platform-id evidence, CAS bytes, ledger + event', async () => {
    // --- capturing paperIntake fake: the only non-real edge (platform HTTP boundary) ---
    const intakeCalls: SubmitProvenCandidateArgs[] = [];
    const paperIntake: PaperIntakePort = {
      enabled: true,
      submitProvenCandidate: async (args) => {
        intakeCalls.push(args);
        return { ok: true, candidateId: 'cand-int-1', admissionStatus: 'admitted', admissionReasonCode: null, idempotentReplay: false };
      },
    };

    const services = makeServices({ paperIntake });
    await services.strategyProfiles.create(profile());

    // Real assembled bundle (FakeStrategyBuilder → assembleStrategyBundle), stored as the
    // baseline's wrapper artifact — reconstructStrategyBundle() rebuilds it from this ref.
    const builder = new FakeStrategyBuilder();
    const built = await builder.build({ spec: { description: 'test' }, authoringDoc: '' });
    const bundle = await assembleStrategyBundle(built);
    const bundleArtifactRef = await services.artifacts.put(
      JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
      { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
    );

    // Seed: completed baseline experiment (bundleArtifactRef → real wrapper artifact) +
    // PAPER_CANDIDATE WFO experiment on the same bundleHash.
    const baseline: ResearchExperiment = {
      id: 'exp-base', experimentKey: 'key-exp-base', experimentType: 'strategy_baseline_validation',
      strategyProfileId: 'prof-1', bundleHash: bundle.bundleHash, bundleArtifactRef,
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

    // Seed holdout run members. Lab ids ('run-base' / 'run-var') are deliberately distinct from
    // the StrategyBacktestRun rows' platformRunId ('plat-run-base' / 'plat-run-var') below — the
    // integration assertion pins evidence to the platform id, never the lab row id.
    const baseHoldout: ExperimentRunMember = {
      id: 'm-base-holdout', experimentId: 'exp-base', strategyBacktestRunId: 'run-base',
      role: 'holdout', periodFrom: DATASET_SCOPE.period.from, periodTo: DATASET_SCOPE.period.to,
      symbols: DATASET_SCOPE.symbols, paramsHash: 'ph-base', bundleHash: bundle.bundleHash, createdAt: NOW,
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

    // Seed StrategyBacktestRun rows: lab id (row primary key) != platform id (submitted run id).
    await services.strategyBacktests.createSubmitted(
      backtestRun({ id: 'run-base', platformRunId: 'plat-run-base', bundleHash: bundle.bundleHash }),
    );
    await services.strategyBacktests.createSubmitted(
      backtestRun({ id: 'run-var', platformRunId: 'plat-run-var', bundleHash: bundle.bundleHash }),
    );

    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const originalAppend = services.events.append.bind(services.events);
    services.events.append = async (evt) => {
      events.push({ type: evt.type, payload: evt.payload });
      return originalAppend(evt);
    };

    await paperStartHandler(taskOf(), services);

    // --- evidence: platform ids, not lab ids ---
    expect(intakeCalls).toHaveLength(1);
    const args = intakeCalls[0]!;
    expect(args.evidence.baselineRunId).toBe('plat-run-base');
    expect(args.evidence.variantRunId).toBe('plat-run-var');
    expect(args.evidence.baselineRunId).not.toBe('run-base');
    expect(args.evidence.variantRunId).not.toBe('run-var');

    // --- strategyName pin: the fixture bundle's manifest.id, not profile.id ---
    expect(args.identity.strategyName).toBe(bundle.manifest.id);

    // --- CAS: bytes artifact content_hash === bundleHash actually exists in the store ---
    const bytesBuf = await services.artifacts.get({
      artifact_id: bundle.bundleHash, uri: `memory://${bundle.bundleHash}`, content_hash: bundle.bundleHash,
      kind: 'strategy_bundle_bytes', size_bytes: 0, mime_type: 'application/javascript',
      created_at: NOW, producer: 'test', metadata: {},
    });
    expect(bytesBuf.equals(Buffer.from(bundle.bytes))).toBe(true);

    // --- ledger: submitted ---
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({ submissionStatus: 'submitted', candidateId: 'cand-int-1', bundleHash: bundle.bundleHash });

    // --- events: paper.candidate_submitted present ---
    expect(events.map((e) => e.type)).toContain('paper.candidate_submitted');
  });
});
