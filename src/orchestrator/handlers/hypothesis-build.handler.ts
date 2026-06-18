// src/orchestrator/handlers/hypothesis-build.handler.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, MODULE_BUNDLE_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { deriveOverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';
import { validateBundle } from '../../validation/build-validator.ts';
import { normalizeFeature, LAB_FEATURE_CATALOG } from '../../domain/hypothesis-rules.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import { event, errMsg, computeParamsHash, sha256, stableStringify } from './backtest-support.ts';
import { BUILDER_SDK_DOC } from '../../adapters/builder/builder-sdk-doc.ts';
import { runPlatformBacktest } from './run-platform-backtest.ts';

export const HypothesisBuildPayloadSchema = z.object({
  hypothesisId: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  backtestBackend: z.enum(['research_platform']).optional(),
  /** Depth in the research→build→backtest cycle chain, propagated from research.run_cycle. */
  cycleDepth: z.number().int().min(0).default(0),
  platformRun: z.object({
    datasetId: z.string().min(1),
    symbols: z.array(z.string().min(1)).min(1),
    timeframe: z.string().min(1),
    period: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    seed: z.number().int(),
  }).optional(),
});

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

  if (payload.platformRun === undefined) {
    const issues: ValidationIssue[] = [{ code: 'missing_platform_run_config', severity: 'error', path: 'platformRun', message: 'platformRun is required' }];
    await services.builds.markBuildFailed(buildId, issues);
    await services.events.append(event(task.id, 'build_failed', { buildId, codes: ['missing_platform_run_config'] }));
    return;
  }

  // Builder (failure → build_failed, terminal for this attempt; no side-effects after)
  await services.events.append(event(task.id, 'builder.started', { buildId }));
  let out;
  try {
    out = await services.builder.build({ hypothesis, profile, sdkDoc: BUILDER_SDK_DOC });
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

  const baselineRef = { id: `strategy:${profile.id}`, version: services.baselineVersion };
  const paramsHash = computeParamsHash(params, { platformRun: payload.platformRun!, baselineRef });

  const existingRun = await services.backtests.findByIdentity(hypothesis.id, paramsHash, bundle.bundleHash);
  if (existingRun) {
    await services.events.append(event(task.id, 'backtest.reused', { runId: existingRun.id, platformRunId: existingRun.platformRunId, status: existingRun.status, backend: existingRun.backend }));
    return;
  }

  const { datasets } = await services.researchPlatform.listDatasets();
  if (datasets.length === 0) {
    const issues: ValidationIssue[] = [{ code: 'datasets_unavailable', severity: 'error', path: '', message: 'No datasets available from research platform' }];
    await services.builds.markBuildFailed(buildId, issues);
    await services.events.append(event(task.id, 'research_platform.datasets_unavailable', { buildId, reason: 'no datasets returned — research platform may be misconfigured or data source unavailable' }));
    await services.events.append(event(task.id, 'build_failed', { buildId, codes: ['datasets_unavailable'] }));
    return;
  }
  const resumeToken = sha256(stableStringify({ v: 1, hypothesisId: hypothesis.id, paramsHash, bundleHash: bundle.bundleHash }));
  await runPlatformBacktest({
    services, task, buildId, bundle, profile, hypothesisId: hypothesis.id,
    params, platformRun: payload.platformRun!, paramsHash, baselineRef, resumeToken,
    cycleDepth: payload.cycleDepth,
  });
};
