// src/experiments/strategy-analyst/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import { resolveFixture, fingerprintSource, FIXTURES } from './fixtures.ts';

describe('resolveFixture', () => {
  it('resolves the long-oi fixture to its source/notes/rubric paths', () => {
    const ref = resolveFixture('long-oi');
    expect(ref.id).toBe('long-oi');
    expect(ref.sourcePath).toBe('docs/fixtures/strategies/long-oi-strategy-source.md');
    expect(ref.notesPath).toBe('docs/fixtures/strategies/long-oi-strategy-research-notes.md');
    expect(ref.rubricPath).toBe('docs/fixtures/strategies/long-oi-strategy-rubric.md');
  });

  it('throws a clear error for an unknown fixture id', () => {
    expect(() => resolveFixture('nope')).toThrow(/unknown fixture/i);
  });

  it('FIXTURES is the registry of known ids', () => {
    expect(Object.keys(FIXTURES)).toContain('long-oi');
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
