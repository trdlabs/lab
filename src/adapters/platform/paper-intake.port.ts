// Paper-intake port (G2-инкремент, 2026-07-03): отправка proven-бандла в платформенный
// intake paper-кандидатов с identity-полями (strategyName/side/params — платформа 062
// проецирует их в bot_bundle.metadata; без них promotion производит незапускаемый бандл).
// Dedicated axis LAB_PAPER_INTAKE_* — ОТДЕЛЬНАЯ от research-transport и bot-results
// (паттерн select-bot-results: своя ось, свой env, boot-safe селектор).

import { submitPaperCandidate } from '@trading-platform/sdk/intake';
import { createHttpIntakeTransport } from '@trading-platform/sdk/intake/http-transport';
import type {
  PaperCandidateIntakeRequest,
  PaperCandidateIntakeResult,
  IntakeTransport,
} from '@trading-platform/sdk/intake';
import type { AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';

/** Identity, которую платформа проецирует в bot_bundle.metadata (только 'long'|'short'). */
export interface PaperIntakeIdentity {
  readonly strategyName: string;
  readonly side: 'long' | 'short';
  readonly params?: Record<string, unknown>;
}

export interface PaperIntakeEvidence {
  readonly baselineRunId: string;
  readonly variantRunId: string;
  readonly datasetRef: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly metricsSnapshot: Record<string, unknown>;
  readonly improvementSummary: string;
  readonly riskNotes?: string | null;
}

export interface SubmitProvenCandidateArgs {
  readonly bundle: Pick<AssembledStrategyBundle, 'bundleHash'>;
  readonly identity: PaperIntakeIdentity;
  readonly evidence: PaperIntakeEvidence;
  readonly idempotencyKey: string;
  readonly workflowId?: string;
  readonly correlationId?: string;
  readonly evidenceArtifactRef?: string;
}

export interface PaperIntakePort {
  readonly enabled: boolean;
  submitProvenCandidate(args: SubmitProvenCandidateArgs): Promise<PaperCandidateIntakeResult>;
}

/** Чистый маппер: proven-бандл + identity + evidence → intake-запрос (тестируется без сети). */
export function buildPaperIntakeRequest(args: SubmitProvenCandidateArgs): PaperCandidateIntakeRequest {
  // SDK ≥0.9.1 типизирует identity-поля strategy-блока нативно.
  const strategy: PaperCandidateIntakeRequest['strategy'] = {
    strategyProfileRef: null,
    moduleRef: null,
    moduleBundleHash: args.bundle.bundleHash,
    strategyName: args.identity.strategyName,
    side: args.identity.side,
    ...(args.identity.params ? { params: args.identity.params } : {}),
  };
  return {
    source: 'trading-lab',
    idempotencyKey: args.idempotencyKey,
    agentDecision: 'recommendation_for_paper',
    evidence: {
      baselineRunId: args.evidence.baselineRunId,
      variantRunId: args.evidence.variantRunId,
      artifactRefs: args.evidenceArtifactRef ? [args.bundle.bundleHash, args.evidenceArtifactRef] : [args.bundle.bundleHash],
      externalEvidenceRef: null,
      datasetRef: args.evidence.datasetRef,
      window: { fromMs: args.evidence.window.fromMs, toMs: args.evidence.window.toMs },
      symbols: [...args.evidence.symbols],
      timeframe: args.evidence.timeframe,
      metricsSnapshot: args.evidence.metricsSnapshot,
      comparisonSnapshot: null,
      improvementSummary: args.evidence.improvementSummary,
      evaluationVerdict: { recommendationForPaper: true, summary: args.evidence.improvementSummary },
      riskNotes: args.evidence.riskNotes ?? null,
    },
    strategy,
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    ...(args.correlationId ? { correlationId: args.correlationId } : {}),
  };
}

export function createSdkPaperIntake(opts: {
  readonly baseUrl: string;
  readonly token?: string;
  readonly transport?: IntakeTransport; // тестовая инъекция (fake transport)
}): PaperIntakePort {
  const transport = opts.transport
    ?? createHttpIntakeTransport({ baseUrl: opts.baseUrl, ...(opts.token ? { token: opts.token } : {}) });
  return {
    enabled: true,
    submitProvenCandidate: (args) => submitPaperCandidate(transport, buildPaperIntakeRequest(args)),
  };
}

/** Boot-safe селектор своей env-оси: без LAB_PAPER_INTAKE_URL порт выключен (submit → ошибка вызывателю). */
export function selectPaperIntake(source: NodeJS.ProcessEnv): PaperIntakePort {
  const baseUrl = source.LAB_PAPER_INTAKE_URL;
  if (!baseUrl) {
    return {
      enabled: false,
      submitProvenCandidate: async () => ({
        ok: false,
        error: { category: 'validation_error', code: 'paper_intake_disabled', message: 'LAB_PAPER_INTAKE_URL is not set' },
      }),
    };
  }
  return createSdkPaperIntake({ baseUrl, token: source.LAB_PAPER_INTAKE_TOKEN });
}
