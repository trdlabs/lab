import { randomUUID } from 'node:crypto';
import type { WorkflowHandler } from '../workflow-router.ts';
import { StrategyAnalystInputSchema } from '../../domain/strategy-source.ts';
import {
  AnalystProfileOutputSchema, STRATEGY_PROFILE_CONTRACT_VERSION,
  type StrategyProfile, type AnalystProfileOutput,
} from '../../domain/strategy-profile.ts';
import { sourceFingerprint } from '../../domain/fingerprint.ts';
import { validateWithSchema } from '../../validation/validator.ts';

export const strategyOnboardHandler: WorkflowHandler = async (task, services) => {
  const inputResult = validateWithSchema(StrategyAnalystInputSchema, task.payload);
  if (inputResult.status === 'invalid') {
    throw new Error(`invalid strategy.onboard payload: ${JSON.stringify(inputResult.issues)}`);
  }
  const input = inputResult.data;

  const fingerprint = sourceFingerprint(input.kind, input.content);

  const existing = await services.strategyProfiles.findByFingerprint(fingerprint);
  if (existing) {
    await services.events.append({
      id: randomUUID(), taskId: task.id, type: 'strategy.onboard.deduped',
      payload: { fingerprint, strategyId: existing.id }, createdAt: new Date().toISOString(),
    });
    return; // idempotent; worker marks completed; LLM not called
  }

  const sourceRef = await services.artifacts.put(input.content, {
    kind: 'strategy_source', mime_type: 'text/plain', producer: 'strategy-onboarding',
    metadata: { sourceKind: input.kind, uri: input.uri ?? null, title: input.title ?? null },
  });

  const auditBase = {
    taskId: task.id, model: services.analyst.model, adapter: services.analyst.adapter, sourceFingerprint: fingerprint,
  };
  await services.events.append({
    id: randomUUID(), taskId: task.id, type: 'strategy_analyst.started',
    payload: { ...auditBase }, createdAt: new Date().toISOString(),
  });

  let output: AnalystProfileOutput;
  try {
    output = await services.analyst.analyze(input);
  } catch (err) {
    await services.events.append({
      id: randomUUID(), taskId: task.id, type: 'strategy_analyst.failed',
      payload: { ...auditBase, error: err instanceof Error ? err.message : String(err) },
      createdAt: new Date().toISOString(),
    });
    throw err;
  }

  await services.events.append({
    id: randomUUID(), taskId: task.id, type: 'strategy_analyst.completed',
    payload: { ...auditBase, direction: output.direction, confidence: output.confidence },
    createdAt: new Date().toISOString(),
  });

  const outputResult = validateWithSchema(AnalystProfileOutputSchema, output);
  if (outputResult.status === 'invalid') {
    throw new Error(`analyst returned invalid profile: ${JSON.stringify(outputResult.issues)}`);
  }
  const profileOut = outputResult.data;

  const now = new Date().toISOString();
  const profile: StrategyProfile = {
    id: randomUUID(),
    version: 1,
    sourceKind: input.kind,
    sourceFingerprint: fingerprint,
    direction: profileOut.direction,
    coreIdea: profileOut.coreIdea,
    requiredMarketFeatures: profileOut.requiredMarketFeatures,
    confidence: profileOut.confidence,
    unknowns: profileOut.unknowns,
    profile: profileOut,
    sourceArtifactRef: sourceRef,
    contractVersion: STRATEGY_PROFILE_CONTRACT_VERSION,
    createdAt: now,
    updatedAt: now,
  };
  await services.strategyProfiles.create(profile);
};
