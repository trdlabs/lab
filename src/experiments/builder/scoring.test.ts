import { describe, expect, it } from 'vitest';
import { scoreBuilderOutput } from './scoring.ts';
import type { BuilderOutput } from '../../ports/builder.port.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import { longOiHypotheses } from './fixtures.ts';

const hyp = longOiHypotheses()[0]!;

function makeOutput(overrides: Partial<BuilderOutput> & { entrySource?: string } = {}): BuilderOutput {
  const { entrySource, ...rest } = overrides;
  const src = entrySource ?? `export const overlay = {
  appliesTo: 'long',
  rules: [{ when: 'OI drops > 10%', action: 'skip_entry', params: { lookback: 3 } }],
};`;
  return {
    manifest: {
      moduleId: `overlay-${hyp.id}`,
      moduleKind: 'hypothesis_overlay',
      appliesTo: 'long',
      entry: 'index.ts',
      exports: ['overlay'],
      capabilities: ['open_interest'],
      sdkContractVersion: 'builder-sdk-v0',
    },
    files: { 'index.ts': src },
    ...rest,
  };
}

describe('scoreBuilderOutput', () => {
  it('passes a valid overlay with correct structure', () => {
    const result = scoreBuilderOutput(makeOutput(), hyp);
    expect(result.verdict).toBe('PASS');
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it('fails when entry file is missing', () => {
    const output = makeOutput();
    output.files = {};
    const result = scoreBuilderOutput(output, hyp);
    expect(result.checks.find((c) => c.id === 'entry_file_present')!.contribution).toBe(0);
    expect(result.verdict).toBe('FAIL');
  });

  it('fails when overlay export is absent', () => {
    const result = scoreBuilderOutput(makeOutput({ entrySource: 'export const notOverlay = {}' }), hyp);
    expect(result.checks.find((c) => c.id === 'overlay_export')!.contribution).toBe(0);
    expect(result.verdict).toBe('FAIL');
  });

  it('fails when forbidden pattern process.env is present', () => {
    const src = `export const overlay = { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: { key: process.env.SECRET } }] };`;
    const result = scoreBuilderOutput(makeOutput({ entrySource: src }), hyp);
    expect(result.checks.find((c) => c.id === 'no_forbidden_patterns')!.contribution).toBe(0);
    expect(result.verdict).toBe('FAIL');
  });

  it('fails when forbidden pattern eval() is present', () => {
    const src = `export const overlay = { appliesTo: 'long', rules: [{ when: eval('x'), action: 'skip_entry', params: {} }] };`;
    const result = scoreBuilderOutput(makeOutput({ entrySource: src }), hyp);
    expect(result.checks.find((c) => c.id === 'no_forbidden_patterns')!.contribution).toBe(0);
  });

  it('fails when manifest entry is not index.ts', () => {
    const output = makeOutput();
    (output.manifest as { entry: string }).entry = 'main.ts';
    output.files = { 'main.ts': output.files['index.ts']! };
    const result = scoreBuilderOutput(output, hyp);
    expect(result.checks.find((c) => c.id === 'manifest_entry_index')!.contribution).toBe(0);
  });

  it('fails when manifest exports does not include overlay', () => {
    const output = makeOutput();
    (output.manifest as { exports: string[] }).exports = ['other'];
    const result = scoreBuilderOutput(output, hyp);
    expect(result.checks.find((c) => c.id === 'manifest_exports_overlay')!.contribution).toBe(0);
  });

  it('penalises appliesTo mismatch', () => {
    const output = makeOutput();
    (output.manifest as { appliesTo: string }).appliesTo = 'short';
    const result = scoreBuilderOutput(output, hyp);
    expect(result.checks.find((c) => c.id === 'applies_to_matches')!.contribution).toBe(0);
  });

  it('penalises empty rules array', () => {
    const src = `export const overlay = { appliesTo: 'long', rules: [] };`;
    const result = scoreBuilderOutput(makeOutput({ entrySource: src }), hyp);
    expect(result.checks.find((c) => c.id === 'overlay_has_rules')!.contribution).toBe(0);
  });
});
