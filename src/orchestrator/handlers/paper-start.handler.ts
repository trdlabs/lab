// src/orchestrator/handlers/paper-start.handler.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler, HandlerDeps } from '../workflow-router.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { PaperSubmission } from '../../domain/paper-submission.ts';
import type { ResearchExperiment } from '../../domain/research-experiment.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { reconstructStrategyBundle } from '../../research/reconstruct-strategy-bundle.ts';
import { buildChampionSubmission } from '../../research/champion-evidence.ts';
import { verifySignedEvidence } from '../../research/verify-signed-evidence.ts';
import { createAndEnqueueTask } from '../task-intake.ts';
import { event } from './backtest-support.ts';

export const PaperStartPayloadSchema = z.object({
  experimentId: z.string().min(1),
  baselineExperimentId: z.string().min(1),
});

/**
 * Retry-edge guard: an already-submitted champion whose ledger row has no live monitor yet
 * (undefined monitorStatus — e.g. a pre-G4 row — or still 'watching'). Seeds the monitor fields
 * cheaply computable here via `updateMonitorState` (defined-fields-only patch — NEVER a second
 * upsert, per upsertByExperimentId's full-replace semantics) and (re)schedules paper.monitor at
 * attempt 0 in a FRESH monitor epoch. The epoch (Date.now()) namespaces the dedupeKey so a revival
 * of a dead chain is never swallowed by the original chain's already-created attempt-0 key — while
 * still deduping honest double-runs of paper.start within the same millisecond.
 */
async function ensureMonitorScheduled(
  task: ResearchTask,
  services: HandlerDeps,
  experimentId: string,
  existing: PaperSubmission,
  baseline: ResearchExperiment,
): Promise<void> {
  const patch: Partial<Pick<PaperSubmission, 'monitorStatus' | 'observedTrades' | 'windowPolicy' | 'strategyName'>> = {};
  if (existing.monitorStatus === undefined) patch.monitorStatus = 'watching';
  if (existing.observedTrades === undefined) patch.observedTrades = 0;
  if (existing.windowPolicy === undefined) patch.windowPolicy = { ...services.paperWindowPolicy };
  if (existing.strategyName === undefined) {
    // Legacy pre-G4 ledger row: strategyName didn't exist when it was written. Reconstruct the
    // bundle (same CAS path the fresh-submission flow uses) to backfill it — self-healing: once
    // this patch lands, subsequent calls for this row skip the reconstruction entirely.
    if (!baseline.bundleArtifactRef) throw new Error(`baseline experiment ${baseline.id} has no bundleArtifactRef — re-run strategy.baseline`);
    const bundle = await reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef);
    patch.strategyName = bundle.manifest.id;
  }
  if (Object.keys(patch).length > 0) {
    await services.paperSubmissions.updateMonitorState(experimentId, { ...patch, updatedAt: new Date().toISOString() });
  }
  const epoch = Date.now();
  await createAndEnqueueTask(
    {
      taskType: 'paper.monitor', source: task.source, payload: { experimentId, epoch },
      correlationId: task.correlationId, dedupeKey: `paper.monitor:${experimentId}:${epoch}:0`,
      delayMs: services.paperMonitorPollMs,
    },
    { repo: services.researchTasks, queue: services.taskQueue },
  );
}

export const paperStartHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(PaperStartPayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid paper.start payload: ${JSON.stringify(parsed.issues)}`);
  const { experimentId, baselineExperimentId } = parsed.data;

  const wfo = await services.experiments.findById(experimentId);
  if (!wfo) throw new Error(`research_experiment ${experimentId} not found`);
  if (wfo.experimentType !== 'walk_forward_optimization' || wfo.verdict !== 'PAPER_CANDIDATE') {
    throw new Error(`experiment ${experimentId} is not a PAPER_CANDIDATE wfo experiment (type=${wfo.experimentType}, verdict=${wfo.verdict})`);
  }
  const baseline = await services.experiments.findById(baselineExperimentId);
  if (!baseline) throw new Error(`baseline experiment ${baselineExperimentId} not found`);
  if (wfo.bundleHash !== baseline.bundleHash) {
    throw new Error(`bundleHash mismatch: wfo ${wfo.bundleHash} != baseline ${baseline.bundleHash} — champion must be the baseline-validated bundle`);
  }

  if (!services.paperIntake.enabled) {
    await services.events.append(event(task.id, 'paper.intake_skipped', { experimentId, reason: 'intake_disabled' }));
    return;
  }
  const existing = await services.paperSubmissions.findByExperimentId(experimentId);
  if (existing?.submissionStatus === 'submitted') {
    if (existing.monitorStatus === undefined || existing.monitorStatus === 'watching') {
      await ensureMonitorScheduled(task, services, experimentId, existing, baseline);
      return;
    }
    await services.events.append(event(task.id, 'paper.already_submitted', { experimentId, candidateId: existing.candidateId ?? null }));
    return;
  }

  if (!baseline.bundleArtifactRef) throw new Error(`baseline experiment ${baselineExperimentId} has no bundleArtifactRef — re-run strategy.baseline`);
  const bundle = await reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef);
  const bytesRef = await services.artifacts.put(Buffer.from(bundle.bytes), {
    kind: 'strategy_bundle_bytes', mime_type: 'application/javascript', producer: 'paper-start-handler',
  });
  if (bytesRef.content_hash !== bundle.bundleHash) {
    throw new Error(`artifact store content_hash ${bytesRef.content_hash} != bundleHash ${bundle.bundleHash} — CAS naming drift`);
  }

  const profile = await services.strategyProfiles.findById(wfo.strategyProfileId);
  if (!profile) throw new Error(`strategy_profile ${wfo.strategyProfileId} not found`);
  const [wfoMembers, baselineMembers] = await Promise.all([
    services.experiments.listMembers(experimentId), services.experiments.listMembers(baselineExperimentId),
  ]);
  const wfoHoldout = wfoMembers.find((m) => m.role === 'holdout' && m.oos === true);
  const baseHoldout = baselineMembers.find((m) => m.role === 'holdout');
  if (!wfoHoldout?.strategyBacktestRunId || !baseHoldout?.strategyBacktestRunId) {
    throw new Error(`holdout member run ids missing (wfo=${wfoHoldout?.strategyBacktestRunId}, baseline=${baseHoldout?.strategyBacktestRunId})`);
  }
  const [variantRun, baselineRun] = await Promise.all([
    services.strategyBacktests.findById(wfoHoldout.strategyBacktestRunId),
    services.strategyBacktests.findById(baseHoldout.strategyBacktestRunId),
  ]);
  if (!variantRun || !baselineRun) throw new Error('holdout StrategyBacktestRun rows missing');

  const args = buildChampionSubmission({
    wfoExperiment: wfo, wfoMembers, baselineExperiment: baseline, baselineMembers,
    profile, baselineRun, variantRun, bundleManifestId: bundle.manifest.id, correlationId: task.correlationId,
  });

  let evidenceArtifactRef: string | undefined;
  if (services.signedEvidence.available) {
    const scope = { from: wfo.datasetScope.period.from, to: wfo.datasetScope.period.to };
    const evidence = await services.signedEvidence.provide({
      backtesterRunId: variantRun.platformRunId, bundleHash: bundle.bundleHash,
      datasetRef: wfo.datasetScope.datasetId, window: scope,
      symbols: wfo.datasetScope.symbols, timeframe: wfo.datasetScope.timeframe,
    });
    if (!evidence) {
      if (services.paperEvidenceRequired) {
        await services.events.append(event(task.id, 'paper.evidence_required', { experimentId, reason: 'provider_returned_null' }));
        return; // [I1] no submit
      }
      // not required (non-079 intake) → fall through, submit without evidence
    } else {
      const check = verifySignedEvidence(evidence, {
        bundleHash: bundle.bundleHash, datasetRef: wfo.datasetScope.datasetId,
        window: { fromMs: Date.parse(wfo.datasetScope.period.from), toMs: Date.parse(wfo.datasetScope.period.to) },
        symbols: wfo.datasetScope.symbols, timeframe: wfo.datasetScope.timeframe,
      }, services.trustedSigners);
      if (!check.ok) {
        await services.events.append(event(task.id, 'paper.evidence_rejected', { experimentId, reason: check.reason }));
        return; // [I1]+[I3] no submit, no ref
      }
      const evRef = await services.artifacts.put(JSON.stringify(evidence), { kind: 'signed_backtest_evidence', mime_type: 'application/json', producer: 'paper-start-handler' });
      evidenceArtifactRef = evRef.content_hash; // [I3] ref only AFTER verify passes
    }
  } else if (services.paperEvidenceRequired) {
    // defense-in-depth (boot guard should already have failed): never submit unsigned to a 079 intake
    await services.events.append(event(task.id, 'paper.evidence_required', { experimentId, reason: 'provider_unavailable' }));
    return;
  }
  const res = await services.paperIntake.submitProvenCandidate({ ...args, ...(evidenceArtifactRef ? { evidenceArtifactRef } : {}) });
  const now = new Date().toISOString();

  if (res.ok) {
    const rejected = res.admissionStatus === 'rejected';
    const admitted = res.admissionStatus === 'admitted';
    await services.paperSubmissions.upsertByExperimentId({
      id: randomUUID(), experimentId, strategyProfileId: wfo.strategyProfileId,
      submissionStatus: rejected ? 'rejected' : 'submitted',
      candidateId: res.candidateId, admissionStatus: res.admissionStatus,
      admissionReasonCode: res.admissionReasonCode ?? undefined,
      idempotencyKey: args.idempotencyKey, bundleHash: bundle.bundleHash,
      ...(wfoHoldout.params ? { params: wfoHoldout.params } : {}),
      ...(admitted ? {
        strategyName: args.identity.strategyName,
        monitorStatus: 'watching' as const,
        observedTrades: 0,
        windowPolicy: { ...services.paperWindowPolicy },
      } : {}),
      createdAt: now, updatedAt: now,
    });
    await services.events.append(event(task.id, 'paper.candidate_submitted', {
      experimentId, candidateId: res.candidateId, admissionStatus: res.admissionStatus, idempotentReplay: res.idempotentReplay,
    }));
    if (rejected) await services.events.append(event(task.id, 'paper.candidate_rejected', { experimentId, candidateId: res.candidateId, reasonCode: res.admissionReasonCode }));
    if (admitted) {
      // First tick of a fresh submission → epoch 0, attempt 0. Revivals (ensureMonitorScheduled)
      // open their own epoch so they are never dedup-swallowed by this key.
      await createAndEnqueueTask(
        {
          taskType: 'paper.monitor', source: task.source, payload: { experimentId },
          correlationId: task.correlationId, dedupeKey: `paper.monitor:${experimentId}:0:0`,
          delayMs: services.paperMonitorPollMs,
        },
        { repo: services.researchTasks, queue: services.taskQueue },
      );
    }
    return;
  }
  if (res.error.category === 'internal_error') {
    throw new Error(`paper intake internal_error: ${res.error.code} ${res.error.message}`);
  }
  await services.paperSubmissions.upsertByExperimentId({
    id: randomUUID(), experimentId, strategyProfileId: wfo.strategyProfileId,
    submissionStatus: 'failed', error: { category: res.error.category, code: res.error.code, message: res.error.message },
    idempotencyKey: args.idempotencyKey, bundleHash: bundle.bundleHash,
    ...(wfoHoldout.params ? { params: wfoHoldout.params } : {}),
    createdAt: now, updatedAt: now,
  });
  await services.events.append(event(task.id, 'paper.submission_failed', { experimentId, category: res.error.category, code: res.error.code }));
};
