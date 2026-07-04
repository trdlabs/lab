// src/orchestrator/handlers/signed-evidence-flow.integration.test.ts
//
// End-to-end integration test for slice 079 (signed backtest evidence on paper-intake
// submissions), on in-memory infra: seeds a real wfo PAPER_CANDIDATE champion (baseline +
// members + runs, mirroring paper-start.handler.test.ts's fixture recipe) + a fixture
// `signedEvidence` provider (via buildFixtureSignedEvidence, matching the champion's
// datasetScope) + matching trustedSigners, then drives paperStartHandler end to end and
// asserts the full chain: evidence verified (no rejection, submission proceeds), evidence
// JSON landed in the CAS as a `signed_backtest_evidence` put, submitProvenCandidate (fake
// transport) received an evidenceArtifactRef that — once run through the SAME wire mapper
// paper-intake.port.ts uses in production (buildPaperIntakeRequest) — surfaces inside
// evidence.artifactRefs, and the submission was admitted.
//
// A second suite closes the composition-wiring gap: it drives the handler through the REAL
// selectSignedEvidence('fixture') provider with trustedSigners wired the way composeRuntime
// wires them (provider.trustedSigners UNION env), proving the fixture source actually reaches
// submit — and, as a control, that dropping the provider's signer fails closed.
import { describe, it, expect } from 'vitest';
import { paperStartHandler } from './paper-start.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchExperiment, ExperimentRunMember } from '../../domain/research-experiment.ts';
import type { StrategyBacktestRun } from '../../domain/strategy-backtest-run.ts';
import type { PaperIntakePort, SubmitProvenCandidateArgs } from '../../adapters/platform/paper-intake.port.ts';
import { buildPaperIntakeRequest } from '../../adapters/platform/paper-intake.port.ts';
import { FakeStrategyBuilder } from '../../adapters/builder/fake-strategy-builder.ts';
import { assembleStrategyBundle } from '../../domain/strategy-bundle.ts';
import { buildFixtureSignedEvidence } from '../../research/fixture-signed-evidence.ts';
import { selectSignedEvidence } from '../../adapters/platform/select-signed-evidence.ts';
import type { SignedEvidenceProviderPort } from '../../ports/signed-evidence-provider.port.ts';

const NOW = '2026-07-04T00:00:00.000Z';

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

const CHAMPION_TASK: ResearchTask = {
  id: 't1', taskType: 'paper.start', source: 'operator', correlationId: 'c1', status: 'running',
  payload: { experimentId: 'exp-wfo', baselineExperimentId: 'exp-base' }, createdAt: NOW, updatedAt: NOW,
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

/** Seeds a real wfo PAPER_CANDIDATE champion (profile, bundle artifact, baseline + wfo experiments,
 *  holdout members, holdout runs) into in-memory services and returns the assembled bundle. Call
 *  BEFORE installing any artifacts.put spy so the bundle-artifact put isn't counted. */
async function seedChampion(services: AppServices): Promise<{ bundle: Awaited<ReturnType<typeof assembleStrategyBundle>> }> {
  await services.strategyProfiles.create(profile());

  const builder = new FakeStrategyBuilder();
  const built = await builder.build({ spec: { description: 'test' }, authoringDoc: '' });
  const bundle = await assembleStrategyBundle(built);

  const bundleArtifactRef = await services.artifacts.put(
    JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
  );

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

  await services.strategyBacktests.createSubmitted(
    backtestRun({ id: 'run-base', platformRunId: 'plat-run-base', bundleHash: bundle.bundleHash }),
  );
  await services.strategyBacktests.createSubmitted(
    backtestRun({ id: 'run-var', platformRunId: 'plat-run-var', bundleHash: bundle.bundleHash }),
  );

  return { bundle };
}

/** Records every event appended after the spy is installed. */
function spyEvents(services: AppServices): { type: string; payload: Record<string, unknown> }[] {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const original = services.events.append.bind(services.events);
  services.events.append = async (evt) => {
    events.push({ type: evt.type, payload: evt.payload });
    return original(evt);
  };
  return events;
}

describe('signed-evidence flow (079): champion -> fixture signedEvidence -> verify -> CAS -> submitProvenCandidate', () => {
  it('provides evidence matching the champion scope, verifies it, puts it in the CAS, and submits it admitted with a resolvable artifactRefs entry', async () => {
    const intakeCalls: SubmitProvenCandidateArgs[] = [];
    const paperIntake: PaperIntakePort = {
      enabled: true,
      submitProvenCandidate: async (args) => {
        intakeCalls.push(args);
        return {
          ok: true, candidateId: 'cand-079', admissionStatus: 'admitted', admissionReasonCode: null, idempotentReplay: false,
        };
      },
    };

    const trustedSigners: Record<string, string> = {};
    const signedEvidence: SignedEvidenceProviderPort = {
      available: true,
      provide: async (args) => {
        // provide() is called with the REAL bundleHash + platformRunId of the champion's holdout
        // run — build the fixture evidence over exactly that scope so verify's hash-pin + scope
        // checks pass, exactly as the real backtester would sign over the submitted run's scope.
        const built = buildFixtureSignedEvidence({
          backtesterRunId: args.backtesterRunId,
          bundleHash: args.bundleHash,
          datasetRef: args.datasetRef,
          window: { fromMs: Date.parse(args.window.from), toMs: Date.parse(args.window.to) },
          symbols: args.symbols,
          timeframe: args.timeframe,
        });
        Object.assign(trustedSigners, built.trustedSigners); // wire the matching signer before provide() resolves
        return built.evidence;
      },
    };

    const services = makeServices({ paperIntake, signedEvidence, trustedSigners, paperEvidenceRequired: false });
    await seedChampion(services);

    const puts: { content_hash: string; kind: string }[] = [];
    const originalPut = services.artifacts.put.bind(services.artifacts);
    services.artifacts.put = async (content, meta) => {
      const ref = await originalPut(content, meta);
      puts.push({ content_hash: ref.content_hash, kind: meta.kind });
      return ref;
    };

    const events = spyEvents(services);

    await paperStartHandler(CHAMPION_TASK, services);

    // Evidence verified: no rejection/required event, submission actually happened.
    expect(events.map((e) => e.type)).not.toContain('paper.evidence_rejected');
    expect(events.map((e) => e.type)).not.toContain('paper.evidence_required');

    // Evidence JSON landed in the CAS as a signed_backtest_evidence put.
    const evidencePut = puts.find((p) => p.kind === 'signed_backtest_evidence');
    expect(evidencePut).toBeDefined();

    // submitProvenCandidate received an evidenceArtifactRef equal to the CAS content-hash.
    expect(intakeCalls).toHaveLength(1);
    expect(intakeCalls[0]?.evidenceArtifactRef).toBe(evidencePut?.content_hash);

    // Run the SAME wire mapper paper-intake.port.ts uses in production: the request's
    // evidence.artifactRefs must contain the evidence content-hash ref.
    const wireRequest = buildPaperIntakeRequest(intakeCalls[0]!);
    expect(wireRequest.evidence.artifactRefs).toContain(evidencePut?.content_hash);

    // Submission admitted.
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row?.submissionStatus).toBe('submitted');
    expect(row?.admissionStatus).toBe('admitted');
    expect(events).toContainEqual({
      type: 'paper.candidate_submitted',
      payload: { experimentId: 'exp-wfo', candidateId: 'cand-079', admissionStatus: 'admitted', idempotentReplay: false },
    });
  });
});

describe('signed-evidence flow (079): composition wiring — real selectSignedEvidence(fixture) reaches submit', () => {
  function admittingIntake(calls: SubmitProvenCandidateArgs[]): PaperIntakePort {
    return {
      enabled: true,
      submitProvenCandidate: async (args) => {
        calls.push(args);
        return { ok: true, candidateId: 'cand-fix', admissionStatus: 'admitted', admissionReasonCode: null, idempotentReplay: false };
      },
    };
  }

  it('wiring provider.trustedSigners (as composeRuntime does) lets the fixture source submit an admitted candidate — even under LAB_PAPER_EVIDENCE_REQUIRED', async () => {
    const intakeCalls: SubmitProvenCandidateArgs[] = [];
    // The exact object composeRuntime constructs from LAB_SIGNED_EVIDENCE_SOURCE=fixture.
    const signedEvidence = selectSignedEvidence({
      LAB_SIGNED_EVIDENCE_SOURCE: 'fixture', NODE_ENV: 'test',
    } as unknown as NodeJS.ProcessEnv);

    // Mirror composeRuntime's merge: provider.trustedSigners UNION env (env {} here).
    const services = makeServices({
      paperIntake: admittingIntake(intakeCalls),
      signedEvidence,
      trustedSigners: { ...(signedEvidence.trustedSigners ?? {}) },
      paperEvidenceRequired: true,
    });
    await seedChampion(services);
    const events = spyEvents(services);

    await paperStartHandler(CHAMPION_TASK, services);

    expect(events.map((e) => e.type)).not.toContain('paper.evidence_rejected');
    expect(events.map((e) => e.type)).not.toContain('paper.evidence_required');
    expect(intakeCalls).toHaveLength(1);
    expect(intakeCalls[0]?.evidenceArtifactRef).toBeDefined();
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row?.submissionStatus).toBe('submitted');
    expect(row?.admissionStatus).toBe('admitted');
  });

  it('control: dropping the provider signer (trustedSigners {}) fails closed — the merge is load-bearing', async () => {
    const intakeCalls: SubmitProvenCandidateArgs[] = [];
    const signedEvidence = selectSignedEvidence({
      LAB_SIGNED_EVIDENCE_SOURCE: 'fixture', NODE_ENV: 'test',
    } as unknown as NodeJS.ProcessEnv);

    const services = makeServices({
      paperIntake: admittingIntake(intakeCalls),
      signedEvidence,
      trustedSigners: {}, // the pre-fix wiring: provider.trustedSigners discarded
      paperEvidenceRequired: true,
    });
    await seedChampion(services);
    const events = spyEvents(services);

    await paperStartHandler(CHAMPION_TASK, services);

    expect(events).toContainEqual({
      type: 'paper.evidence_rejected',
      payload: { experimentId: 'exp-wfo', reason: 'evidence_signature_invalid' },
    });
    expect(intakeCalls).toHaveLength(0);
    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toBeFalsy(); // rejected verify returns before any upsert — no submission row created
  });
});
