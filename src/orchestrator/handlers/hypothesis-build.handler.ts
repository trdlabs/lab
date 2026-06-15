// src/orchestrator/handlers/hypothesis-build.handler.ts
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, MODULE_BUNDLE_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { deriveOverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';
import { validateBundle } from '../../validation/build-validator.ts';
import { evaluateBacktest } from '../../validation/evaluator.ts';
import { normalizeFeature, LAB_FEATURE_CATALOG } from '../../domain/hypothesis-rules.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { BacktestRun, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';

export const HypothesisBuildPayloadSchema = z.object({
  hypothesisId: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function event(taskId: string, type: string, payload: Record<string, unknown>) {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}
function sha256(input: string): string {
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export const hypothesisBuildHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(HypothesisBuildPayloadSchema, task.payload);
  if (parsed.status === 'invalid') {
    throw new Error(`invalid hypothesis.build payload: ${JSON.stringify(parsed.issues)}`);
  }
  const payload = parsed.data;
  const params = payload.params ?? {};

  const hypothesis = await services.hypotheses.findById(payload.hypothesisId);
  if (!hypothesis) throw new Error(`hypothesis not found: ${payload.hypothesisId}`);
  if (hypothesis.status !== 'validated') throw new Error(`hypothesis is not validated: ${hypothesis.id} (${hypothesis.status})`);

  const profile = await services.strategyProfiles.findById(hypothesis.strategyProfileId);
  if (!profile) throw new Error(`strategy profile not found: ${hypothesis.strategyProfileId}`);

  const now = () => new Date().toISOString();
  const buildId = randomUUID();
  await services.events.append(event(task.id, 'build.started', { hypothesisId: hypothesis.id, builder: services.builder.adapter, model: services.builder.model }));

  const build: HypothesisBuild = {
    id: buildId, hypothesisId: hypothesis.id, strategyProfileId: profile.id, status: 'generating',
    builderAdapter: services.builder.adapter, builderModel: services.builder.model,
    bundleHash: null, bundleArtifactRef: null, manifest: null,
    sdkContractVersion: SDK_CONTRACT_VERSION, bundleContractVersion: MODULE_BUNDLE_CONTRACT_VERSION,
    issues: [], attempt: 1, createdAt: now(), updatedAt: now(),
  };
  await services.builds.createGenerating(build);

  // Builder (failure → build_failed, terminal for this attempt; no side-effects after)
  await services.events.append(event(task.id, 'builder.started', { buildId }));
  let out;
  try {
    out = await services.builder.build({ hypothesis, profile, sdkDoc: '' });
  } catch (err) {
    const issues: ValidationIssue[] = [{ code: 'builder_failed', severity: 'error', path: 'builder', message: errMsg(err) }];
    await services.builds.markBuildFailed(buildId, issues);
    await services.events.append(event(task.id, 'builder.failed', { buildId, error: errMsg(err) }));
    await services.events.append(event(task.id, 'build_failed', { buildId, codes: ['builder_failed'] }));
    return;
  }
  await services.events.append(event(task.id, 'builder.completed', { buildId }));

  const overlayMeta = deriveOverlayManifestMeta(hypothesis, profile, out.manifest);
  const bundle = assembleBundle(out.manifest, out.files, overlayMeta);
  const allowedCapabilities = new Set<string>([...profile.requiredMarketFeatures.map(normalizeFeature), ...LAB_FEATURE_CATALOG]);
  const validation = validateBundle(bundle, { allowedImports: new Set<string>(), allowedCapabilities });
  if (validation.status === 'build_failed') {
    await services.builds.markBuildFailed(buildId, validation.issues);
    await services.events.append(event(task.id, 'build_failed', { buildId, codes: validation.issues.map((i) => i.code) }));
    return;
  }
  await services.events.append(event(task.id, 'build.validated', { buildId, bundleHash: bundle.bundleHash }));

  const ref = await services.artifacts.put(JSON.stringify(bundle), { kind: 'module_bundle', mime_type: 'application/json', producer: 'builder', metadata: { hypothesisId: hypothesis.id, buildId } });
  await services.builds.markCandidate(buildId, { bundleHash: bundle.bundleHash, bundleArtifactRef: ref, manifest: bundle.manifest });
  await services.events.append(event(task.id, 'artifact.stored', { buildId, artifactId: ref.artifact_id }));

  // Idempotency: same hypothesis + same params + same bundle must NOT re-submit (checked
  // BEFORE the platform side-effect, so reuse never triggers a duplicate backtest).
  const paramsHash = sha256(stableStringify(params));
  const existingRun = await services.backtests.findByIdentity(hypothesis.id, paramsHash, bundle.bundleHash);
  if (existingRun) {
    await services.events.append(event(task.id, 'backtest.reused', { runId: existingRun.id, platformRunId: existingRun.platformRunId, status: existingRun.status }));
    return;
  }

  // Submit (Orchestrator-owned side-effect)
  const baselineModuleId = `strategy:${profile.id}`;
  const variantModuleId = bundle.manifest.moduleId;
  const runRef = await services.platform.submitBacktest({ correlationId: task.correlationId, baselineModuleId, variantModuleId, params });

  const runId = randomUUID();
  const run: BacktestRun = {
    id: runId, hypothesisBuildId: buildId, hypothesisId: hypothesis.id, strategyProfileId: profile.id,
    platformRunId: runRef.platformRunId, correlationId: task.correlationId, params, paramsHash, bundleHash: bundle.bundleHash,
    status: 'submitted', baselineModuleId, variantModuleId,
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: SDK_CONTRACT_VERSION,
    submittedAt: now(), finishedAt: null, createdAt: now(), updatedAt: now(),
  };
  await services.backtests.createSubmitted(run);
  await services.builds.markSubmitted(buildId);
  await services.events.append(event(task.id, 'backtest.submitted', { runId, platformRunId: runRef.platformRunId }));

  // Resolve result (mock returns synchronously)
  const envelope = await services.platform.getBacktestResult(runRef);
  if (envelope.runStatus !== 'completed' || !envelope.comparison) {
    await services.backtests.markRejected(runId);
    await services.events.append(event(task.id, 'backtest.failed', { runId, runStatus: envelope.runStatus, hasComparison: !!envelope.comparison }));
    return;
  }
  const c = envelope.comparison;
  const completion: BacktestCompletion = {
    metrics: c.variant, baselineMetrics: c.baseline,
    deltaNetPnlUsd: c.variant.netPnlUsd - c.baseline.netPnlUsd,
    deltaMaxDrawdownPct: c.variant.maxDrawdownPct - c.baseline.maxDrawdownPct,
    isFragile: c.variant.topTradeContributionPct >= services.evaluatorThresholds.fragilityTopTradePct,
    artifactRefs: envelope.artifactRefs, platformContractVersion: c.platformContractVersion, finishedAt: now(),
  };
  await services.backtests.markCompleted(runId, completion);
  await services.events.append(event(task.id, 'backtest.completed', { runId, deltaNetPnlUsd: completion.deltaNetPnlUsd }));

  // Evaluate (deterministic)
  const outcome = evaluateBacktest(c, services.evaluatorThresholds);
  const evaluation: Evaluation = {
    id: randomUUID(), backtestRunId: runId, hypothesisId: hypothesis.id,
    decision: outcome.decision, reasons: outcome.reasons, metricsSnapshot: c,
    thresholds: services.evaluatorThresholds, createdAt: now(),
  };
  await services.evaluations.create(evaluation);
  await services.backtests.markEvaluated(runId);
  await services.events.append(event(task.id, 'evaluation.completed', { runId, decision: outcome.decision, reasons: outcome.reasons }));
};
