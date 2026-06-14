// src/adapters/platform/submitted-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { toSubmittedBundle } from './submitted-bundle.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

function sha256Hex(s: string): string { return createHash('sha256').update(s).digest('hex'); }
function canon(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const files = { 'index.ts': 'export const overlay = { rules: [] };', 'helpers/util.ts': 'export const u = 1;' };

describe('toSubmittedBundle', () => {
  const sub = toSubmittedBundle(assembleBundle(manifest, files));

  it('re-roots code files under module/ and adds manifest.json at root, all base64', () => {
    const paths = sub.files.map((f) => f.path).sort();
    expect(paths).toEqual(['manifest.json', 'module/helpers/util.ts', 'module/index.ts']);
    const idx = sub.files.find((f) => f.path === 'module/index.ts')!;
    expect(Buffer.from(idx.contentBase64, 'base64').toString('utf8')).toBe(files['index.ts']);
    const man = sub.files.find((f) => f.path === 'manifest.json')!;
    expect(JSON.parse(Buffer.from(man.contentBase64, 'base64').toString('utf8')).moduleId).toBe('m1');
  });

  it('descriptor.files lists manifest.json + module/** entries, sorted, with per-file sha256', () => {
    const d = sub.descriptor as { files: { path: string; sha256: string }[]; entryPoint: string; kind: string; contractVersion: string; bundleHash: string };
    expect(d.files.map((f) => f.path)).toEqual(['manifest.json', 'module/helpers/util.ts', 'module/index.ts']);
    expect(d.files.find((f) => f.path === 'module/index.ts')!.sha256).toBe(sha256Hex(files['index.ts']));
    expect(d.files.find((f) => f.path === 'manifest.json')!.sha256).toBe(sha256Hex(JSON.stringify(manifest)));
    expect(d.kind).toBe('overlay');
    expect(d.entryPoint).toBe('module/index.ts');
    expect(typeof d.contractVersion).toBe('string');
  });

  it('bundleHash replicates the platform formula (self-consistent)', () => {
    const d = sub.descriptor as { files: { path: string; sha256: string }[]; bundleHash: string };
    const manifestSha256 = sha256Hex(JSON.stringify(manifest));
    const expected = `sha256:${sha256Hex(canon({ manifestSha256, files: d.files }))}`;
    expect(d.bundleHash).toBe(expected);
  });

  it('every file path is a safe relative path (no traversal, no leading slash)', () => {
    for (const f of sub.files) {
      expect(f.path.startsWith('/')).toBe(false);
      expect(f.path.includes('..')).toBe(false);
    }
  });
});
