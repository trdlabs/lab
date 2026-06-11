// src/validation/build-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateBundle } from './build-validator.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest, type ModuleBundle } from '../domain/module-bundle.ts';

const allowed = { allowedImports: new Set<string>(), allowedCapabilities: new Set<string>(['oi', 'funding']) };

function man(over: Partial<ModuleManifest> = {}): ModuleManifest {
  return { moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION, ...over };
}
function bundle(m: ModuleManifest, files: Record<string, string>): ModuleBundle {
  return assembleBundle(m, files);
}
const goodFiles = { 'index.ts': 'export const overlay = { rules: [] };' };

function codes(b: ModuleBundle) { return validateBundle(b, allowed).issues.map((i) => i.code); }

describe('validateBundle', () => {
  it('passes a clean bundle', () => {
    const r = validateBundle(bundle(man(), goodFiles), allowed);
    expect(r.status).toBe('built');
    expect(r.issues).toEqual([]);
  });

  it('manifest_invalid when a required field is empty', () => {
    expect(codes(bundle(man({ moduleId: '' }), goodFiles))).toContain('manifest_invalid');
  });

  it('disallowed_module_kind when kind is wrong', () => {
    const b = bundle({ ...man(), moduleKind: 'other' as unknown as 'hypothesis_overlay' }, goodFiles);
    expect(codes(b)).toContain('disallowed_module_kind');
  });

  it('missing_entry when entry file absent', () => {
    expect(codes(bundle(man({ entry: 'nope.ts' }), goodFiles))).toContain('missing_entry');
  });

  it('missing_export when export not present in entry source', () => {
    expect(codes(bundle(man({ exports: ['ghost'] }), goodFiles))).toContain('missing_export');
  });

  it('restricted_import on a code token (process.env)', () => {
    expect(codes(bundle(man(), { 'index.ts': 'export const overlay = {}; const x = process.env.SECRET;' }))).toContain('restricted_import');
  });

  it('restricted_import on a builtin module specifier (import from fs)', () => {
    expect(codes(bundle(man(), { 'index.ts': "import { readFileSync } from 'fs';\nexport const overlay = {};" }))).toContain('restricted_import');
  });

  it('restricted_import on a require of a builtin', () => {
    expect(codes(bundle(man(), { 'index.ts': "const cp = require('child_process');\nexport const overlay = {};" }))).toContain('restricted_import');
  });

  it('restricted_import on an import specifier outside the allowlist', () => {
    expect(codes(bundle(man(), { 'index.ts': "import x from 'left-pad';\nexport const overlay = {};" }))).toContain('restricted_import');
  });

  it('does NOT false-positive on a builtin substring inside an identifier or object key', () => {
    // 'offset' contains 'fs' and 'https' is a bare key — neither is an import, so neither is restricted.
    const r = validateBundle(bundle(man(), { 'index.ts': 'export const overlay = { offset: 1, https: false };' }), allowed);
    expect(r.status).toBe('built');
  });

  it('capability_violation when a declared capability is not allowed', () => {
    expect(codes(bundle(man({ capabilities: ['oi', 'leverage'] }), goodFiles))).toContain('capability_violation');
  });

  it('bundle_hash_mismatch when the hash does not match content', () => {
    const b = bundle(man(), goodFiles);
    const tampered: ModuleBundle = { ...b, bundleHash: 'sha256:0000' };
    expect(codes(tampered)).toContain('bundle_hash_mismatch');
  });

  it('sdk_contract_mismatch on a wrong sdk contract version', () => {
    expect(codes(bundle(man({ sdkContractVersion: 'builder-sdk-v9' }), goodFiles))).toContain('sdk_contract_mismatch');
  });
});
