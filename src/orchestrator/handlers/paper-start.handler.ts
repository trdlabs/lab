// src/orchestrator/handlers/paper-start.handler.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { reconstructStrategyBundle } from '../../research/reconstruct-strategy-bundle.ts';
import { buildChampionSubmission } from '../../research/champion-evidence.ts';
import { event } from './backtest-support.ts';

export const PaperStartPayloadSchema = z.object({
  experimentId: z.string().min(1),
  baselineExperimentId: z.string().min(1),
});

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
  const res = await services.paperIntake.submitProvenCandidate(args);
  const now = new Date().toISOString();

  if (res.ok) {
    const rejected = res.admissionStatus === 'rejected';
    await services.paperSubmissions.upsertByExperimentId({
      id: randomUUID(), experimentId, strategyProfileId: wfo.strategyProfileId,
      submissionStatus: rejected ? 'rejected' : 'submitted',
      candidateId: res.candidateId, admissionStatus: res.admissionStatus,
      admissionReasonCode: res.admissionReasonCode ?? undefined,
      idempotencyKey: args.idempotencyKey, bundleHash: bundle.bundleHash,
      ...(wfoHoldout.params ? { params: wfoHoldout.params } : {}),
      createdAt: now, updatedAt: now,
    });
    await services.events.append(event(task.id, 'paper.candidate_submitted', {
      experimentId, candidateId: res.candidateId, admissionStatus: res.admissionStatus, idempotentReplay: res.idempotentReplay,
    }));
    if (rejected) await services.events.append(event(task.id, 'paper.candidate_rejected', { experimentId, candidateId: res.candidateId, reasonCode: res.admissionReasonCode }));
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
