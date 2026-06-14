// src/adapters/platform/submitted-bundle.ts
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type { SubmittedBundle } from '@trading-platform/sdk/agent';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

const MODULE_DIR = 'module';

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Sorted-key canonical JSON (strings/arrays/objects only) — mirrors the platform's 018 canonicalJson. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * Map a lab ModuleBundle to the platform's submitted-bundle wire shape (spec §5).
 *  - lab `files` keys are bare relative paths → re-rooted under `module/`; `manifest.json` at root
 *  - `descriptor.files` = `manifest.json` + all `module/**` payload entries (sorted, per-file sha256), per the 019 contract
 *  - `bundleHash` replicates `trading-platform/.../bundle-hash.ts::computeBundleHash`
 */
export function toSubmittedBundle(bundle: ModuleBundle): SubmittedBundle {
  const manifestJson = JSON.stringify(bundle.manifest);
  const manifestSha256 = sha256Hex(manifestJson);

  // One sorted payload list (manifest.json + module/**) drives both descriptor.files and files[].
  const payload = [
    { path: 'manifest.json', source: manifestJson },
    ...Object.entries(bundle.files).map(([rel, source]) => ({ path: `${MODULE_DIR}/${rel}`, source })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const descriptorFiles = payload.map((f) => ({ path: f.path, sha256: sha256Hex(f.source) }));
  const bundleHash = `sha256:${sha256Hex(canonicalJson({ manifestSha256, files: descriptorFiles }))}`;

  const descriptor = {
    contractVersion: CONTRACT_VERSION,
    kind: 'overlay' as const, // lab moduleKind 'hypothesis_overlay' → platform 'overlay'
    entryPoint: `${MODULE_DIR}/${bundle.manifest.entry}`,
    files: descriptorFiles,
    bundleHash,
  };

  const files = payload.map((f) => ({ path: f.path, contentBase64: Buffer.from(f.source, 'utf8').toString('base64') }));

  return { manifest: bundle.manifest, files, descriptor };
}
