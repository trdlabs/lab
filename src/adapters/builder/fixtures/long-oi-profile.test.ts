import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalystProfileOutputSchema } from '../../../domain/strategy-profile.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(__dirname, 'long-oi-profile.json'), 'utf8');
const fixture = JSON.parse(raw) as Record<string, unknown>;

describe('long-oi-profile fixture guard', () => {
  it('direction === "long"', () => {
    expect(fixture['direction']).toBe('long');
  });

  it('.profile parses as valid AnalystProfileOutput', () => {
    const result = AnalystProfileOutputSchema.safeParse(fixture['profile']);
    if (!result.success) {
      throw new Error(`AnalystProfileOutputSchema failed: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  it('.profile.direction === "long" (nested invariant, not just top-level)', () => {
    const profile = fixture['profile'] as Record<string, unknown>;
    expect(profile['direction']).toBe('long');
  });

  it('has required StrategyProfile structural fields', () => {
    expect(typeof fixture['id']).toBe('string');
    expect(typeof fixture['version']).toBe('number');
    expect(typeof fixture['sourceKind']).toBe('string');
    expect(typeof fixture['sourceFingerprint']).toBe('string');
    expect(typeof fixture['contractVersion']).toBe('string');
    expect(typeof fixture['createdAt']).toBe('string');
    expect(typeof fixture['updatedAt']).toBe('string');
    expect(typeof fixture['coreIdea']).toBe('string');
    expect(Array.isArray(fixture['requiredMarketFeatures'])).toBe(true);
    expect(Array.isArray(fixture['unknowns'])).toBe(true);
    expect(typeof fixture['confidence']).toBe('number');
    expect(fixture['sourceArtifactRef']).toBeTruthy();
  });
});
