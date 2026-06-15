// src/adapters/platform/submitted-bundle.preflight.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { preflightValidate } from '@trading-platform/sdk/builder';
import type { SubmittedBundle } from '@trading-platform/sdk/agent';
import { toSubmittedBundle } from './submitted-bundle.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';
import type { OverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';

const manifest: ModuleManifest = {
  moduleId: 'overlay-m1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const meta: OverlayManifestMeta = {
  id: 'overlay-m1', version: '0.1.0', name: 'filter entries', summary: 'skip on oi trend',
  rationale: 'oi-based entry filter', author: 'agent', targetStrategyRef: 'strategy:p1',
  interceptionPoint: 'post_entry_management', paramsSchema: { type: 'object', additionalProperties: false },
};

/** Materialize a projected SubmittedBundle into a temp dir: files[] → paths, descriptor → bundle.json. */
function materialize(sub: SubmittedBundle): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp71b-preflight-'));
  for (const f of sub.files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(f.contentBase64, 'base64'));
  }
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(sub.descriptor));
  return dir;
}

describe('toSubmittedBundle projected bundle passes SDK preflight (subset smoke)', () => {
  it('has no schema_invalid / forbidden_capability / unsupported_contract_version issues', () => {
    const sub = toSubmittedBundle(assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' }, meta));
    const dir = materialize(sub);
    try {
      const res = preflightValidate({ bundleDir: dir });
      const codes = res.issues.map((i) => i.code);
      expect(codes).not.toContain('schema_invalid');
      expect(codes).not.toContain('forbidden_capability');
      expect(codes).not.toContain('unsupported_contract_version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
