import { describe, it, expect } from 'vitest';
import { assertEvidenceReadiness } from './composition.ts';

describe('assertEvidenceReadiness (Task 4 fail-closed boot guard) [I1 boot-half]', () => {
  it('throws when evidence is required but no signed-evidence source is available', () => {
    expect(() => assertEvidenceReadiness(true, false)).toThrow(
      /LAB_PAPER_EVIDENCE_REQUIRED.*LAB_SIGNED_EVIDENCE_SOURCE=none|refusing to boot/,
    );
  });

  it('does not throw when evidence is required and a source is available', () => {
    expect(() => assertEvidenceReadiness(true, true)).not.toThrow();
  });

  it('does not throw when evidence is not required, regardless of availability', () => {
    expect(() => assertEvidenceReadiness(false, false)).not.toThrow();
    expect(() => assertEvidenceReadiness(false, true)).not.toThrow();
  });
});
