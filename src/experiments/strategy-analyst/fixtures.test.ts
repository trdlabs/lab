// src/experiments/strategy-analyst/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveFixture, fingerprintSource, FIXTURES } from './fixtures.ts';

describe('resolveFixture', () => {
  it('resolves the long-oi fixture to its notes/rubric paths and sourceDir', () => {
    const ref = resolveFixture('long-oi');
    expect(ref.id).toBe('long-oi');
    expect(ref.sourceDir).toBe('docs/fixtures/strategies/long-oi-code');
    expect(ref.notesPath).toBe('docs/fixtures/strategies/long-oi-strategy-research-notes.md');
    expect(ref.rubricPath).toBe('docs/fixtures/strategies/long-oi-strategy-rubric.md');
  });

  it('throws a clear error for an unknown fixture id', () => {
    expect(() => resolveFixture('nope')).toThrow(/unknown fixture/i);
  });

  it('FIXTURES is the registry of known ids', () => {
    expect(Object.keys(FIXTURES)).toContain('long-oi');
  });

  it('tags long-oi as a long-direction fixture', () => {
    expect(resolveFixture('long-oi').direction).toBe('long');
  });

  it('resolves the short-pump fixture to its source/notes/rubric paths + short direction', () => {
    const ref = resolveFixture('short-pump');
    expect(ref.id).toBe('short-pump');
    expect(ref.sourcePath).toBe('docs/fixtures/strategies/short-pump-strategy-source.md');
    expect(ref.notesPath).toBe('docs/fixtures/strategies/short-pump-strategy-research-notes.md');
    expect(ref.rubricPath).toBe('docs/fixtures/strategies/short-pump-strategy-rubric.md');
    expect(ref.direction).toBe('short');
  });

  it('FIXTURES registers both fixtures', () => {
    expect(Object.keys(FIXTURES)).toEqual(expect.arrayContaining(['long-oi', 'short-pump']));
  });
});

describe('fingerprintSource', () => {
  it('is a sha256: prefixed stable hash', () => {
    const fp = fingerprintSource('hello');
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprintSource('hello')).toBe(fp); // deterministic
    expect(fingerprintSource('hello2')).not.toBe(fp);
  });
});

describe('FixtureRef sourceDir / kind fields', () => {
  it('long-oi resolves to the vendored CODE dir as bot_code; short-pump stays prose', () => {
    const longOi = resolveFixture('long-oi');
    expect(longOi.sourceDir).toBe('docs/fixtures/strategies/long-oi-code');
    expect(longOi.kind).toBe('bot_code');
    const shortPump = resolveFixture('short-pump');
    expect(shortPump.sourcePath).toMatch(/short-pump-strategy-source\.md$/);
  });
});

describe('short-pump fixture files exist and fingerprint', () => {
  it('source/notes/rubric files are readable and the source fingerprints', () => {
    const ref = resolveFixture('short-pump');
    const source = readFileSync(ref.sourcePath!, 'utf8');
    expect(source.length).toBeGreaterThan(200);
    expect(readFileSync(ref.notesPath, 'utf8').length).toBeGreaterThan(1000);
    expect(readFileSync(ref.rubricPath, 'utf8').length).toBeGreaterThan(200);
    expect(fingerprintSource(source)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
