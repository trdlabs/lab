import { describe, it, expect } from 'vitest';
import { cycleScorecardMarkdownUrl, CYCLE_SCORECARD_ROUTE, READ_API_V1_PREFIX } from './paths.ts';

describe('cycleScorecardMarkdownUrl', () => {
  it('builds the /v1-prefixed markdown path from the shared route template', () => {
    expect(cycleScorecardMarkdownUrl('c-1')).toBe('/v1/cycles/c-1/scorecard?format=markdown');
  });
  it('percent-encodes the correlationId', () => {
    expect(cycleScorecardMarkdownUrl('a/b c')).toBe('/v1/cycles/a%2Fb%20c/scorecard?format=markdown');
  });
  it('exposes the constants the app mounts', () => {
    expect(READ_API_V1_PREFIX).toBe('/v1');
    expect(CYCLE_SCORECARD_ROUTE).toBe('/cycles/:correlationId/scorecard');
  });
});
