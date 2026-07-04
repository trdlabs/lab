import { describe, expect, it } from 'vitest';
import { buildPaperIntakeRequest, createSdkPaperIntake, selectPaperIntake } from './paper-intake.port.ts';
import type { SubmitProvenCandidateArgs } from './paper-intake.port.ts';

const ARGS: SubmitProvenCandidateArgs = {
  bundle: { bundleHash: 'sha256:' + 'a'.repeat(64) },
  identity: { strategyName: 'long_oi_llm', side: 'long', params: { warmup: { candlesMin: 20 } } },
  evidence: {
    baselineRunId: 'run-base', variantRunId: 'run-var', datasetRef: 'vps-slice-2026-06',
    window: { fromMs: 1, toMs: 2 }, symbols: ['INUSDT'], timeframe: '1m',
    metricsSnapshot: { netPnlUsd: 12.3 }, improvementSummary: 'variant beats baseline',
  },
  idempotencyKey: 'champ-1',
  workflowId: 'wf-1',
};

describe('buildPaperIntakeRequest', () => {
  it('несёт identity-поля поверх strategy-ref (платформа 062 проецирует их в metadata)', () => {
    const req = buildPaperIntakeRequest(ARGS);
    const strategy = req.strategy as Record<string, unknown>;
    expect(strategy.moduleBundleHash).toBe(ARGS.bundle.bundleHash);
    expect(strategy.strategyName).toBe('long_oi_llm');
    expect(strategy.side).toBe('long');
    expect(strategy.params).toEqual({ warmup: { candlesMin: 20 } });
    expect(req.evidence.artifactRefs).toEqual([ARGS.bundle.bundleHash]);
    expect(req.evidence.evaluationVerdict.recommendationForPaper).toBe(true);
    expect(req.source).toBe('trading-lab');
    expect(req.idempotencyKey).toBe('champ-1');
  });

  it('params отсутствует в strategy, когда identity.params не задан', () => {
    const req = buildPaperIntakeRequest({ ...ARGS, identity: { strategyName: 's', side: 'short' } });
    expect('params' in (req.strategy as Record<string, unknown>)).toBe(false);
  });

  it('appends evidenceArtifactRef to artifactRefs when present', () => {
    const req = buildPaperIntakeRequest({ ...ARGS, evidenceArtifactRef: 'sha256:ev' });
    expect(req.evidence.artifactRefs).toEqual([ARGS.bundle.bundleHash, 'sha256:ev']);
  });

  it('omits it → artifactRefs byte-identical to prior behavior', () => {
    const req = buildPaperIntakeRequest(ARGS);
    expect(req.evidence.artifactRefs).toEqual([ARGS.bundle.bundleHash]);
  });
});

describe('createSdkPaperIntake / fake transport', () => {
  it('шлёт собранный request через транспорт и возвращает результат SDK', async () => {
    const sent: unknown[] = [];
    const port = createSdkPaperIntake({
      baseUrl: 'http://unused',
      transport: {
        submit: async (request) => {
          sent.push(request);
          return { ok: true, candidateId: 'c-1', admissionStatus: 'admitted', admissionReasonCode: null, idempotentReplay: false };
        },
      },
    });
    const res = await port.submitProvenCandidate(ARGS);
    expect(port.enabled).toBe(true);
    expect(res.ok).toBe(true);
    const body = sent[0] as { strategy: Record<string, unknown> };
    expect(body.strategy.strategyName).toBe('long_oi_llm');
    expect(body.strategy.side).toBe('long');
  });
});

describe('selectPaperIntake', () => {
  it('без LAB_PAPER_INTAKE_URL — выключен, submit возвращает типизированную ошибку', async () => {
    const port = selectPaperIntake({} as NodeJS.ProcessEnv);
    expect(port.enabled).toBe(false);
    const res = await port.submitProvenCandidate(ARGS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('paper_intake_disabled');
  });

  it('с URL — включён', () => {
    const port = selectPaperIntake({ LAB_PAPER_INTAKE_URL: 'http://127.0.0.1:9999' } as NodeJS.ProcessEnv);
    expect(port.enabled).toBe(true);
  });
});
