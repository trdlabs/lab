// src/experiments/operator-rag/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import { loadCases, fingerprintCases, resolveDataset, DATASETS, EvalCaseSchema } from './fixtures.ts';

describe('fixtures - resolveDataset', () => {
  it('returns a path for known dataset', () => {
    const path = resolveDataset('strategy-retrieval-v1');
    expect(path).toContain('strategy-retrieval-v1.json');
  });

  it('throws on unknown dataset id', () => {
    expect(() => resolveDataset('nonexistent-dataset')).toThrow('unknown dataset');
  });

  it('lists known datasets', () => {
    expect(Object.keys(DATASETS)).toContain('strategy-retrieval-v1');
  });
});

describe('fixtures - loadCases', () => {
  it('loads strategy-retrieval-v1 without error', () => {
    const cases = loadCases('strategy-retrieval-v1');
    expect(cases.length).toBeGreaterThan(0);
  });

  it('every case has required fields', () => {
    const cases = loadCases('strategy-retrieval-v1');
    for (const c of cases) {
      expect(c.id).toBeTruthy();
      expect(c.query).toBeTruthy();
      expect(['ru', 'en', 'mixed']).toContain(c.language);
      expect(Array.isArray(c.expectedRelevantIds)).toBe(true);
      expect(typeof c.gradedRelevance).toBe('object');
    }
  });

  it('no duplicate ids in the dataset', () => {
    const cases = loadCases('strategy-retrieval-v1');
    const ids = cases.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('includes cases for all required categories', () => {
    const cases = loadCases('strategy-retrieval-v1');
    const ids = cases.map((c) => c.id);
    // Exact copies
    expect(ids.some((id) => id.startsWith('exact-copy'))).toBe(true);
    // Russian paraphrases
    expect(ids.some((id) => id.startsWith('ru-paraphrase'))).toBe(true);
    // English paraphrases
    expect(ids.some((id) => id.startsWith('en-paraphrase'))).toBe(true);
    // Mixed RU/EN
    expect(ids.some((id) => id.startsWith('mixed-'))).toBe(true);
    // Shared-entry/different-risk negatives
    expect(ids.some((id) => id.startsWith('negative-shared-entry-diff-risk'))).toBe(true);
    // Shared-symbol negatives
    expect(ids.some((id) => id.startsWith('negative-shared-symbol'))).toBe(true);
    // No-match cases
    expect(ids.some((id) => id.startsWith('no-match'))).toBe(true);
  });

  it('all expectedExactIds appear in expectedRelevantIds', () => {
    const cases = loadCases('strategy-retrieval-v1');
    for (const c of cases) {
      if (c.expectedExactId != null) {
        expect(c.expectedRelevantIds).toContain(c.expectedExactId);
      }
    }
  });

  it('all expectedRelevantIds have gradedRelevance >= 1', () => {
    const cases = loadCases('strategy-retrieval-v1');
    for (const c of cases) {
      for (const rid of c.expectedRelevantIds) {
        const grade = c.gradedRelevance[rid] ?? 0;
        expect(grade).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('expectedExactId cases have grade 3', () => {
    const cases = loadCases('strategy-retrieval-v1');
    for (const c of cases) {
      if (c.expectedExactId != null) {
        expect(c.gradedRelevance[c.expectedExactId]).toBe(3);
      }
    }
  });

  it('has cases with language ru, en, and mixed', () => {
    const cases = loadCases('strategy-retrieval-v1');
    const langs = new Set(cases.map((c) => c.language));
    expect(langs).toContain('ru');
    expect(langs).toContain('en');
    expect(langs).toContain('mixed');
  });

  it('has no-match cases (empty expectedRelevantIds)', () => {
    const cases = loadCases('strategy-retrieval-v1');
    const noMatchCases = cases.filter((c) => c.expectedRelevantIds.length === 0);
    expect(noMatchCases.length).toBeGreaterThan(0);
  });
});

describe('fixtures - fingerprintCases', () => {
  it('returns a sha256 prefixed string', () => {
    const cases = loadCases('strategy-retrieval-v1');
    const fp = fingerprintCases(cases);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic (same input -> same output)', () => {
    const cases = loadCases('strategy-retrieval-v1');
    expect(fingerprintCases(cases)).toBe(fingerprintCases(cases));
  });

  it('changes when cases change', () => {
    const cases = loadCases('strategy-retrieval-v1');
    const modified = [...cases];
    const first = modified[0];
    if (first === undefined) throw new Error('dataset must have at least one case');
    modified[0] = { ...first, query: first.query + ' MODIFIED' };
    expect(fingerprintCases(modified)).not.toBe(fingerprintCases(cases));
  });
});

describe('EvalCaseSchema validation', () => {
  it('rejects expectedExactId not in expectedRelevantIds', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-1',
      query: 'some query',
      language: 'en',
      filters: {},
      expectedRelevantIds: ['id-a'],
      gradedRelevance: { 'id-a': 2 },
      expectedExactId: 'id-b', // not in expectedRelevantIds
    });
    expect(result.success).toBe(false);
  });

  it('rejects expectedRelevantId with grade 0', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-2',
      query: 'some query',
      language: 'ru',
      filters: {},
      expectedRelevantIds: ['id-a'],
      gradedRelevance: { 'id-a': 0 }, // grade 0 is not allowed for a relevant id
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid language', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-3',
      query: 'some query',
      language: 'fr', // not allowed
      filters: {},
      expectedRelevantIds: [],
      gradedRelevance: {},
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid case with no expectedRelevantIds', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'no-match-1',
      query: 'esoteric query',
      language: 'en',
      filters: {},
      expectedRelevantIds: [],
      gradedRelevance: {},
    });
    expect(result.success).toBe(true);
  });
});
