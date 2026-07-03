// src/research/compose-revision-bundle.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { composeRevisionBundle, type OverlayModuleInput } from './compose-revision-bundle.ts';
import { assembleStrategyBundle } from '../domain/strategy-bundle.ts';
import type { StrategyManifestMeta } from '../ports/strategy-builder.port.ts';
import type { RuleAction } from '../domain/hypothesis.ts';

const BASE_MANIFEST_META: StrategyManifestMeta = {
  id: 'short_after_pump',
  version: '0.1.0',
  name: 'Short after pump',
  summary: 'Short after a sharp pump.',
  rationale: 'Pumps without fundamentals often revert.',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  params: {},
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
  hooks: ['onBarClose'],
};

// Trivial, controlled base module — always 'enter' — so overlay effects are unambiguous.
const BASE_SOURCE = `
export default function createStrategyModule() {
  return {
    onBarClose(ctx) {
      return { kind: 'enter', side: 'short', rationale: 'base-enter' };
    },
  };
}
`;

function ruleAction(): RuleAction {
  return { appliesTo: 'short', rules: [{ when: 'test condition', action: 'skip_entry', params: {} }] };
}

const VETO_OVERLAY = `
export const overlay = function apply(ctx) {
  return { kind: 'veto', reasonCode: 'test_veto', rationale: 'blocked' };
};
`;

const PATCH_OVERLAY = `
export const overlay = function apply(ctx) {
  return { kind: 'patch', patch: { side: 'long' } };
};
`;

const ANNOTATE_OVERLAY = `
export const overlay = function apply(ctx) {
  return { kind: 'annotate', notes: 'note-A', tags: ['tag1'] };
};
`;

const PASS_SPY_OVERLAY = `
export const overlay = function apply(ctx) {
  globalThis.__composeSpyCalls = (globalThis.__composeSpyCalls || 0) + 1;
  return { kind: 'pass' };
};
`;

// Overlay authored to the documented (single-arg) SDK signature but with the SAME internal const
// name as another overlay below, to exercise namespace isolation via structural IIFE scoping.
function namedConstOverlay(kind: 'veto' | 'annotate', label: string): string {
  const body =
    kind === 'veto'
      ? `{ kind: 'veto', reasonCode: '${label}' }`
      : `{ kind: 'annotate', notes: '${label}' }`;
  return `
export const overlay = function apply(ctx) {
  const marker = '${label}';
  return ${body};
};
`;
}

const DATA_ONLY_OVERLAY = `
export const overlay = {
  appliesTo: 'short',
  rules: [
    { when: 'OI trend persists for 3+ consecutive bars', action: 'skip_entry', params: { lookback: 3 } },
  ],
};
`;

async function loadComposedModule(sourceOverride: string, manifestMeta: StrategyManifestMeta) {
  const bundle = await assembleStrategyBundle({ source: sourceOverride, manifestMeta });
  const dir = await mkdtemp(join(tmpdir(), 'compose-revision-bundle-'));
  const file = join(dir, 'bundle.mjs');
  await writeFile(file, bundle.bytes);
  const mod = (await import(pathToFileURL(file).href)) as { default: () => { onBarClose(ctx: unknown): unknown } };
  return { bundle, instance: mod.default() };
}

const STUB_CTX = { symbol: 'EDGEUSDT', bar: { ts: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 } };

describe('composeRevisionBundle', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__composeSpyCalls;
  });

  it('is deterministic: two calls produce byte-identical source and identical bundleHash', async () => {
    const overlays: OverlayModuleInput[] = [{ hypothesisId: 'h1', source: VETO_OVERLAY }];
    const ruleActions = { h1: ruleAction() };

    const r1 = composeRevisionBundle({ baseSource: BASE_SOURCE, baseManifestMeta: BASE_MANIFEST_META, overlays, ruleActions, revisionVersion: 1 });
    const r2 = composeRevisionBundle({ baseSource: BASE_SOURCE, baseManifestMeta: BASE_MANIFEST_META, overlays, ruleActions, revisionVersion: 1 });

    expect(r1.output.source).toBe(r2.output.source);

    const b1 = await assembleStrategyBundle(r1.output);
    const b2 = await assembleStrategyBundle(r2.output);
    expect(b1.bundleHash).toBe(b2.bundleHash);
  });

  it('manifestMeta.id carries the -rev<version> suffix', () => {
    const result = composeRevisionBundle({
      baseSource: BASE_SOURCE,
      baseManifestMeta: BASE_MANIFEST_META,
      overlays: [],
      ruleActions: {},
      revisionVersion: 3,
    });
    expect(result.output.manifestMeta.id).toBe('short_after_pump-rev3');
  });

  it('composes a Style-A data-only overlay as unsupported, not thrown', () => {
    const overlays: OverlayModuleInput[] = [{ hypothesisId: 'h-data', source: DATA_ONLY_OVERLAY }];
    const result = composeRevisionBundle({
      baseSource: BASE_SOURCE,
      baseManifestMeta: BASE_MANIFEST_META,
      overlays,
      ruleActions: { 'h-data': ruleAction() },
      revisionVersion: 1,
    });
    expect(result.included).toEqual([]);
    expect(result.unsupported).toEqual([
      { hypothesisId: 'h-data', detail: 'data-driven overlay (free-text when) cannot be deterministically composed lab-side' },
    ]);
    expect(result.mergedRuleSet.order).toEqual([]);
    expect(result.mergedRuleSet.rules).toEqual([]);
  });

  it('base enter + overlay veto -> idle', async () => {
    const overlays: OverlayModuleInput[] = [{ hypothesisId: 'h1', source: VETO_OVERLAY }];
    const result = composeRevisionBundle({ baseSource: BASE_SOURCE, baseManifestMeta: BASE_MANIFEST_META, overlays, ruleActions: { h1: ruleAction() }, revisionVersion: 1 });
    expect(result.included).toEqual(['h1']);

    const { instance } = await loadComposedModule(result.output.source, result.output.manifestMeta);
    const decision = instance.onBarClose(STUB_CTX) as { kind: string; rationale?: string };
    expect(decision).toEqual({ kind: 'idle', rationale: 'test_veto' });
  });

  it('base enter + patch -> patched decision', async () => {
    const overlays: OverlayModuleInput[] = [{ hypothesisId: 'h1', source: PATCH_OVERLAY }];
    const result = composeRevisionBundle({ baseSource: BASE_SOURCE, baseManifestMeta: BASE_MANIFEST_META, overlays, ruleActions: { h1: ruleAction() }, revisionVersion: 1 });

    const { instance } = await loadComposedModule(result.output.source, result.output.manifestMeta);
    const decision = instance.onBarClose(STUB_CTX) as { kind: string; side?: string; rationale?: string };
    expect(decision).toEqual({ kind: 'enter', side: 'long', rationale: 'base-enter' });
  });

  it('annotate -> decision unchanged plus a rationale note', async () => {
    const overlays: OverlayModuleInput[] = [{ hypothesisId: 'h1', source: ANNOTATE_OVERLAY }];
    const result = composeRevisionBundle({ baseSource: BASE_SOURCE, baseManifestMeta: BASE_MANIFEST_META, overlays, ruleActions: { h1: ruleAction() }, revisionVersion: 1 });

    const { instance } = await loadComposedModule(result.output.source, result.output.manifestMeta);
    const decision = instance.onBarClose(STUB_CTX) as { kind: string; side?: string; rationale?: string };
    expect(decision.kind).toBe('enter');
    expect(decision.side).toBe('short');
    expect(decision.rationale).toBe('base-enter | note-A; tag1');
  });

  it('two overlays: first veto stops the second from ever being invoked', async () => {
    const overlays: OverlayModuleInput[] = [
      { hypothesisId: 'h1', source: VETO_OVERLAY },
      { hypothesisId: 'h2', source: PASS_SPY_OVERLAY },
    ];
    const result = composeRevisionBundle({
      baseSource: BASE_SOURCE,
      baseManifestMeta: BASE_MANIFEST_META,
      overlays,
      ruleActions: { h1: ruleAction(), h2: ruleAction() },
      revisionVersion: 1,
    });
    expect(result.included).toEqual(['h1', 'h2']);

    const { instance } = await loadComposedModule(result.output.source, result.output.manifestMeta);
    const decision = instance.onBarClose(STUB_CTX) as { kind: string; rationale?: string };
    expect(decision).toEqual({ kind: 'idle', rationale: 'test_veto' });
    expect((globalThis as Record<string, unknown>).__composeSpyCalls).toBeUndefined();
  });

  it('two overlays with same-named internal consts compose without collision', async () => {
    const overlays: OverlayModuleInput[] = [
      { hypothesisId: 'h1', source: namedConstOverlay('annotate', 'first') },
      { hypothesisId: 'h2', source: namedConstOverlay('veto', 'second') },
    ];
    const result = composeRevisionBundle({
      baseSource: BASE_SOURCE,
      baseManifestMeta: BASE_MANIFEST_META,
      overlays,
      ruleActions: { h1: ruleAction(), h2: ruleAction() },
      revisionVersion: 1,
    });
    expect(result.included).toEqual(['h1', 'h2']);

    // Real bundle compiles and executes cleanly despite both overlay IIFEs declaring `const marker`.
    const { instance } = await loadComposedModule(result.output.source, result.output.manifestMeta);
    const decision = instance.onBarClose(STUB_CTX) as { kind: string; rationale?: string };
    // annotate (first) applies, then veto (second) terminates -> idle with second's reasonCode.
    expect(decision).toEqual({ kind: 'idle', rationale: 'second' });
  });

  it('mergedRuleSet carries order + rules for included hypotheses, and optional theses', () => {
    const overlays: OverlayModuleInput[] = [
      { hypothesisId: 'h1', source: VETO_OVERLAY },
      { hypothesisId: 'h-data', source: DATA_ONLY_OVERLAY },
    ];
    const ruleActions = { h1: ruleAction(), 'h-data': ruleAction() };
    const result = composeRevisionBundle({
      baseSource: BASE_SOURCE,
      baseManifestMeta: BASE_MANIFEST_META,
      overlays,
      ruleActions,
      revisionVersion: 1,
      theses: { h1: 'thesis for h1' },
    });
    expect(result.mergedRuleSet).toEqual({
      order: ['h1'],
      rules: [ruleActions.h1],
      theses: ['thesis for h1'],
    });
  });
});
