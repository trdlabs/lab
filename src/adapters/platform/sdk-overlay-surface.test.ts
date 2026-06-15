// SP-8.1 acceptance: the vendored @trading-platform/sdk must expose feature 037's
// `submitted_overlay` ModuleSelector variant (and stay on the run-lifecycle surface
// SP-7.2 builds on). The type-level `overlaySelector` construction below fails `tsc`
// against the pre-037 0.1.0 tarball (the variant does not exist) and compiles against
// 0.2.0 — the genuine red→green for this slice.
import { describe, it, expect } from 'vitest';
import {
  submitRun,
  getRunStatus,
  getRunResult,
  awaitCompletion,
  cancelRun,
  readArtifactPage,
  isTerminal,
} from '@trading-platform/sdk/agent';
import { SDK_VERSION } from '@trading-platform/sdk';
import type { ModuleSelector, Ref, SubmittedBundle } from '@trading-platform/sdk/agent';

const baselineRef: Ref = { id: 'strategy:demo', version: '1.0.0' };
const submittedBundle: SubmittedBundle = { manifest: {}, files: [], descriptor: {} };
const overlaySelector: ModuleSelector = {
  kind: 'submitted_overlay',
  bundle: submittedBundle,
  baselineModuleRef: baselineRef,
};

describe('SP-8.1: vendored SDK feature-037 surface', () => {
  it('exposes the submitted_overlay ModuleSelector variant', () => {
    expect(overlaySelector.kind).toBe('submitted_overlay');
    if (overlaySelector.kind === 'submitted_overlay') {
      expect(overlaySelector.baselineModuleRef.id).toBe('strategy:demo');
    }
  });

  it('is the refreshed 0.2.0 build', () => {
    expect(SDK_VERSION).toBe('0.2.0');
  });

  it('still exports the run-lifecycle workflow functions (regression guard)', () => {
    expect(typeof submitRun).toBe('function');
    expect(typeof getRunStatus).toBe('function');
    expect(typeof getRunResult).toBe('function');
    expect(typeof awaitCompletion).toBe('function');
    expect(typeof cancelRun).toBe('function');
    expect(typeof readArtifactPage).toBe('function');
    expect(typeof isTerminal).toBe('function');
  });
});
