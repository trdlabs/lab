// src/domain/module-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { assembleBundle, ModuleManifestSchema, MODULE_BUNDLE_CONTRACT_VERSION, SDK_CONTRACT_VERSION, type ModuleManifest } from './module-bundle.ts';
import type { OverlayManifestMeta } from './overlay-manifest-meta.ts';

function manifest(over: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
    entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'],
    sdkContractVersion: SDK_CONTRACT_VERSION, ...over,
  };
}

describe('assembleBundle', () => {
  it('produces a sha256 bundleHash and the contract version', () => {
    const b = assembleBundle(manifest(), { 'index.ts': 'export const overlay = {};' });
    expect(b.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.bundleContractVersion).toBe(MODULE_BUNDLE_CONTRACT_VERSION);
  });

  it('is independent of manifest/files key order (canonical)', () => {
    const filesA = { 'a.ts': 'x', 'b.ts': 'y' };
    const filesB = { 'b.ts': 'y', 'a.ts': 'x' };
    const mA = manifest({ capabilities: ['oi', 'funding'] });
    const mB: ModuleManifest = { sdkContractVersion: SDK_CONTRACT_VERSION, capabilities: ['oi', 'funding'], exports: ['overlay'], entry: 'index.ts', appliesTo: 'long', moduleKind: 'hypothesis_overlay', moduleId: 'm1' };
    expect(assembleBundle(mA, filesA).bundleHash).toBe(assembleBundle(mB, filesB).bundleHash);
  });

  it('changes the hash when a file changes', () => {
    const h1 = assembleBundle(manifest(), { 'index.ts': 'export const overlay = {a:1};' }).bundleHash;
    const h2 = assembleBundle(manifest(), { 'index.ts': 'export const overlay = {a:2};' }).bundleHash;
    expect(h1).not.toBe(h2);
  });

  it('ignores any caller-supplied bundleHash (only manifest+files drive it)', () => {
    // assembleBundle has no hash parameter; the manifest schema forbids extra keys,
    // so a sneaked hash cannot reach the canonical input.
    const parsed = ModuleManifestSchema.safeParse({ ...manifest(), bundleHash: 'sha256:deadbeef' });
    expect(parsed.success).toBe(false);
  });
});

describe('assembleBundle overlayMeta', () => {
  const files = { 'index.ts': 'export const overlay = {};' };
  const meta: OverlayManifestMeta = {
    id: 'm1', version: '0.1.0', name: 'n', summary: 's', rationale: 'r', author: 'agent',
    targetStrategyRef: 'strategy:p1', interceptionPoint: 'post_entry_management',
    paramsSchema: { type: 'object', additionalProperties: false },
  };

  it('attaches overlayMeta when provided', () => {
    expect(assembleBundle(manifest(), files, meta).overlayMeta).toEqual(meta);
  });

  it('omits overlayMeta when not provided', () => {
    expect(assembleBundle(manifest(), files).overlayMeta).toBeUndefined();
  });

  it('does not change bundleHash when overlayMeta is attached (hash covers manifest+files only)', () => {
    expect(assembleBundle(manifest(), files, meta).bundleHash).toBe(assembleBundle(manifest(), files).bundleHash);
  });
});
