import { describe, it, expect } from 'vitest';
import { buildStrategyRetrievalText, buildStrategyRetrievalDocument } from './strategy-retrieval-document.ts';
import type { StrategyProfile, AnalystProfileOutput } from '../domain/strategy-profile.ts';
import type { ArtifactRef } from '../domain/types.ts';

const ref: ArtifactRef = {
  artifact_id: 'sha256:aa', uri: 'memory://aa', content_hash: 'sha256:aa', kind: 'strategy_source',
  size_bytes: 1, mime_type: 'text/plain', created_at: '2026-06-11T00:00:00Z', producer: 'test', metadata: {},
};

const sampleAnalystOutput: AnalystProfileOutput = {
  direction: 'long',
  coreIdea: 'Buy when OI increases and funding flips positive',
  summary: 'This is a momentum strategy using open interest divergence',
  requiredMarketFeatures: ['oi', 'funding'],
  entryConditions: ['OI rising 5%', 'Funding positive'],
  exitConditions: ['OI drops 3%', 'TP at 2R'],
  timeframes: ['1h', '4h'],
  indicators: ['OI', 'Funding Rate'],
  parameters: [{ name: 'oi_threshold', value: 0.05, unit: '%', description: 'OI rise threshold', tunable: true }],
  watchLifecycleSummary: 'Watch for 15m candle close',
  positionManagementSummary: 'Scale in at 0.5% intervals',
  riskManagementSummary: 'Max 2% risk per trade',
  runnerOwnedAuthorities: ['position sizing'],
  confidence: 0.8,
  unknowns: ['How does it behave in ranging markets?'],
  evidence: ['Source mentions OI divergence as key signal'],
};

const makeProfile = (over: Partial<StrategyProfile> = {}): StrategyProfile => ({
  id: 'p1',
  version: 1,
  sourceKind: 'article',
  sourceFingerprint: 'sha256:fp1',
  direction: 'long',
  coreIdea: 'Buy when OI increases and funding flips positive',
  requiredMarketFeatures: ['oi', 'funding'],
  confidence: 0.8,
  unknowns: ['How does it behave in ranging markets?'],
  profile: sampleAnalystOutput,
  sourceArtifactRef: ref,
  contractVersion: 'strategy-profile-v1',
  createdAt: '2026-06-11T00:00:00Z',
  updatedAt: '2026-06-11T00:00:00Z',
  ...over,
});

describe('buildStrategyRetrievalText', () => {
  it('produces a labelled document with all sections in fixed order', () => {
    const text = buildStrategyRetrievalText(makeProfile());
    const lines = text.split('\n');
    // direction appears before core idea
    const dirIdx = lines.findIndex((l) => l.startsWith('direction:'));
    const coreIdx = lines.findIndex((l) => l.startsWith('core idea:'));
    const summaryIdx = lines.findIndex((l) => l.startsWith('summary:'));
    const entryIdx = lines.findIndex((l) => l.startsWith('entry conditions:'));
    const exitIdx = lines.findIndex((l) => l.startsWith('exit conditions:'));
    const riskIdx = lines.findIndex((l) => l.startsWith('risk management:'));
    const posIdx = lines.findIndex((l) => l.startsWith('position management:'));
    const paramsIdx = lines.findIndex((l) => l.startsWith('parameters:'));
    const unknownsIdx = lines.findIndex((l) => l.startsWith('unknowns:'));

    expect(dirIdx).toBeGreaterThanOrEqual(0);
    expect(coreIdx).toBeGreaterThan(dirIdx);
    expect(summaryIdx).toBeGreaterThan(coreIdx);
    expect(entryIdx).toBeGreaterThan(summaryIdx);
    expect(exitIdx).toBeGreaterThan(entryIdx);
    expect(riskIdx).toBeGreaterThan(exitIdx);
    expect(posIdx).toBeGreaterThan(riskIdx);
    expect(paramsIdx).toBeGreaterThan(posIdx);
    expect(unknownsIdx).toBeGreaterThan(paramsIdx);
  });

  it('includes values from profile fields', () => {
    const text = buildStrategyRetrievalText(makeProfile());
    expect(text).toContain('long');
    expect(text).toContain('OI increases');
    expect(text).toContain('momentum strategy');
    expect(text).toContain('OI rising');
    expect(text).toContain('oi_threshold');
    expect(text).toContain('ranging markets');
  });

  it('omits section cleanly when field is empty/null', () => {
    const p = makeProfile({
      profile: { ...sampleAnalystOutput, riskManagementSummary: null, positionManagementSummary: null, unknowns: [] },
    });
    const text = buildStrategyRetrievalText(p);
    expect(text).not.toContain('risk management:');
    expect(text).not.toContain('position management:');
    expect(text).not.toContain('unknowns:');
  });

  it('contentHash is stable regardless of JS object key order', () => {
    const p1 = makeProfile({ profile: { ...sampleAnalystOutput } });
    // Build a second profile with the same logical content but object keys in different order
    const shuffled: AnalystProfileOutput = {
      unknowns: sampleAnalystOutput.unknowns,
      evidence: sampleAnalystOutput.evidence,
      confidence: sampleAnalystOutput.confidence,
      runnerOwnedAuthorities: sampleAnalystOutput.runnerOwnedAuthorities,
      riskManagementSummary: sampleAnalystOutput.riskManagementSummary,
      positionManagementSummary: sampleAnalystOutput.positionManagementSummary,
      watchLifecycleSummary: sampleAnalystOutput.watchLifecycleSummary,
      parameters: sampleAnalystOutput.parameters,
      indicators: sampleAnalystOutput.indicators,
      timeframes: sampleAnalystOutput.timeframes,
      exitConditions: sampleAnalystOutput.exitConditions,
      entryConditions: sampleAnalystOutput.entryConditions,
      requiredMarketFeatures: sampleAnalystOutput.requiredMarketFeatures,
      summary: sampleAnalystOutput.summary,
      coreIdea: sampleAnalystOutput.coreIdea,
      direction: sampleAnalystOutput.direction,
    };
    const p2 = makeProfile({ profile: shuffled });
    expect(buildStrategyRetrievalText(p1)).toBe(buildStrategyRetrievalText(p2));
  });

  it('contentHash changes when a profile field changes', () => {
    const p1 = makeProfile();
    const p2 = makeProfile({ profile: { ...sampleAnalystOutput, coreIdea: 'COMPLETELY DIFFERENT IDEA' } });
    expect(buildStrategyRetrievalText(p1)).not.toBe(buildStrategyRetrievalText(p2));
  });
});

describe('buildStrategyRetrievalDocument', () => {
  const fakeEmbedding = [0.1, 0.2, 0.3] as const;

  it('assembles a StrategyRetrievalDocument with correct fields', () => {
    const profile = makeProfile();
    const doc = buildStrategyRetrievalDocument(profile, {
      embedding: fakeEmbedding,
      embeddingModel: 'test-model',
      indexVersion: 1,
      indexedAt: '2026-06-11T00:00:00Z',
    });

    expect(doc.strategyProfileId).toBe('p1');
    expect(doc.embeddingModel).toBe('test-model');
    expect(doc.indexVersion).toBe(1);
    expect(doc.indexedAt).toBe('2026-06-11T00:00:00Z');
    expect(doc.embedding).toEqual(fakeEmbedding);
    expect(doc.content).toBe(buildStrategyRetrievalText(profile));
    expect(doc.contentHash).toMatch(/^sha256:/);
  });

  it('contentHash differs when content differs', () => {
    const p1 = makeProfile();
    const p2 = makeProfile({ profile: { ...sampleAnalystOutput, coreIdea: 'DIFFERENT' } });
    const d1 = buildStrategyRetrievalDocument(p1, { embedding: fakeEmbedding, embeddingModel: 'm', indexVersion: 1, indexedAt: 'now' });
    const d2 = buildStrategyRetrievalDocument(p2, { embedding: fakeEmbedding, embeddingModel: 'm', indexVersion: 1, indexedAt: 'now' });
    expect(d1.contentHash).not.toBe(d2.contentHash);
  });

  it('contentHash is stable across key-order permutations', () => {
    const p1 = makeProfile();
    const shuffled: AnalystProfileOutput = {
      unknowns: sampleAnalystOutput.unknowns,
      evidence: sampleAnalystOutput.evidence,
      confidence: sampleAnalystOutput.confidence,
      runnerOwnedAuthorities: sampleAnalystOutput.runnerOwnedAuthorities,
      riskManagementSummary: sampleAnalystOutput.riskManagementSummary,
      positionManagementSummary: sampleAnalystOutput.positionManagementSummary,
      watchLifecycleSummary: sampleAnalystOutput.watchLifecycleSummary,
      parameters: sampleAnalystOutput.parameters,
      indicators: sampleAnalystOutput.indicators,
      timeframes: sampleAnalystOutput.timeframes,
      exitConditions: sampleAnalystOutput.exitConditions,
      entryConditions: sampleAnalystOutput.entryConditions,
      requiredMarketFeatures: sampleAnalystOutput.requiredMarketFeatures,
      summary: sampleAnalystOutput.summary,
      coreIdea: sampleAnalystOutput.coreIdea,
      direction: sampleAnalystOutput.direction,
    };
    const p2 = makeProfile({ profile: shuffled });
    const d1 = buildStrategyRetrievalDocument(p1, { embedding: fakeEmbedding, embeddingModel: 'm', indexVersion: 1, indexedAt: 'now' });
    const d2 = buildStrategyRetrievalDocument(p2, { embedding: fakeEmbedding, embeddingModel: 'm', indexVersion: 1, indexedAt: 'now' });
    expect(d1.contentHash).toBe(d2.contentHash);
  });

  it('metadata carries expected fields', () => {
    const profile = makeProfile({ version: 2, createdAt: '2026-06-12T00:00:00Z' });
    const doc = buildStrategyRetrievalDocument(profile, { embedding: fakeEmbedding, embeddingModel: 'm', indexVersion: 1, indexedAt: 'now' });
    expect(doc.metadata.direction).toBe('long');
    expect(doc.metadata.profileVersion).toBe(2);
    expect(doc.metadata.createdAt).toBe('2026-06-12T00:00:00Z');
  });
});
describe('outcome embargo (S4) — retrieval document', () => {
  it('renders byte-identically when the profile carries runtime embargo extras', () => {
    const clean = makeProfile();
    const dirty = {
      ...clean,
      holdoutValidation: { holdoutSharpe: 987654.321 },
      promotion: { verdict: 'passed' },
      evaluationWindow: { from: '2031-12-31', to: '2031-12-31' },
    } as unknown as StrategyProfile;
    expect(buildStrategyRetrievalText(dirty)).toBe(buildStrategyRetrievalText(clean));
  });

  it('document content and contentHash are unaffected by runtime embargo extras', () => {
    const opts = { embedding: [0.1, 0.2], embeddingModel: 'm', indexVersion: 1, indexedAt: '2026-01-01T00:00:00Z' };
    const clean = makeProfile();
    const dirty = { ...clean, holdoutValidation: { t: '2031-12-31' } } as unknown as StrategyProfile;
    const a = buildStrategyRetrievalDocument(clean, opts);
    const b = buildStrategyRetrievalDocument(dirty, opts);
    expect(b.content).toBe(a.content);
    expect(b.contentHash).toBe(a.contentHash);
    expect(JSON.stringify(b)).not.toContain('2031-12-31');
  });
});