// src/experiments/turn-interpreter/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import {
  loadCases,
  resolveDataset,
  fingerprintCases,
  DATASETS,
  EvalCaseSchema,
  DatasetSchema,
} from './fixtures.ts';
import { SUBJECTS } from '../../chat/turn-interpretation.ts';

describe('dataset resolution', () => {
  it('resolves the default dataset id', () => {
    expect(resolveDataset('turn-interpretations-v1')).toBe(DATASETS['turn-interpretations-v1']);
  });

  it('throws on an unknown dataset id', () => {
    expect(() => resolveDataset('nope')).toThrow(/unknown dataset/);
  });
});

describe('loadCases — turn-interpretations-v1', () => {
  const cases = loadCases('turn-interpretations-v1');

  it('loads a non-empty, schema-valid case set', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    for (const c of cases) expect(() => EvalCaseSchema.parse(c)).not.toThrow();
  });

  it('covers every subject at least once', () => {
    const covered = new Set(cases.map((c) => c.expect.subject));
    for (const s of SUBJECTS) expect(covered).toContain(s);
  });

  it('has anti-fabrication cases (absentConstraints)', () => {
    const antiFabCount = cases.filter((c) => (c.expect.absentConstraints?.length ?? 0) > 0).length;
    expect(antiFabCount).toBeGreaterThanOrEqual(4);
  });

  it('has reference cases', () => {
    const refCount = cases.filter((c) => (c.expect.references?.length ?? 0) > 0).length;
    expect(refCount).toBeGreaterThanOrEqual(2);
  });

  it('has hasStrategyText cases', () => {
    const stratCount = cases.filter((c) => c.expect.hasStrategyText === true).length;
    expect(stratCount).toBeGreaterThanOrEqual(4);
  });

  it('contains both RU and EN cases', () => {
    const langs = new Set(cases.map((c) => c.lang));
    expect(langs).toContain('ru');
    expect(langs).toContain('en');
  });

  it('has unique case ids', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('fingerprintCases', () => {
  it('is sha256-prefixed and stable for identical input', () => {
    const cases = loadCases('turn-interpretations-v1');
    const fp = fingerprintCases(cases);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprintCases(cases)).toBe(fp);
  });

  it('differs for different input order', () => {
    const cases = loadCases('turn-interpretations-v1');
    const fp1 = fingerprintCases(cases);
    const fp2 = fingerprintCases([...cases].reverse());
    expect(fp1).not.toBe(fp2);
  });
});

describe('DatasetSchema validation', () => {
  it('rejects a case with empty id', () => {
    expect(() =>
      DatasetSchema.parse({
        version: 'x',
        cases: [{ id: '', lang: 'ru', message: 'm', expect: { subject: 'strategy' } }],
      }),
    ).toThrow();
  });

  it('rejects a case with an invalid subject', () => {
    expect(() =>
      DatasetSchema.parse({
        version: 'x',
        cases: [{ id: 'x', lang: 'ru', message: 'm', expect: { subject: 'invalid_subject' } }],
      }),
    ).toThrow();
  });
});
