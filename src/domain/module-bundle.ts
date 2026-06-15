// src/domain/module-bundle.ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DIRECTIONS } from './strategy-profile.ts';
import type { OverlayManifestMeta } from './overlay-manifest-meta.ts';

export const MODULE_BUNDLE_CONTRACT_VERSION = 'module-bundle-v1';
export const SDK_CONTRACT_VERSION = 'builder-sdk-v0';

export const ModuleManifestSchema = z.object({
  moduleId: z.string().min(1),
  moduleKind: z.literal('hypothesis_overlay'),
  appliesTo: z.enum(DIRECTIONS),
  entry: z.string().min(1),
  exports: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.string()),
  sdkContractVersion: z.string().min(1),
}).strict();
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

export interface ModuleBundle {
  manifest: ModuleManifest;
  files: Record<string, string>;
  bundleHash: string;
  bundleContractVersion: string;
  overlayMeta?: OverlayManifestMeta;
}

/** Deterministic JSON with sorted object keys (so file paths and manifest keys
 *  canonicalize regardless of insertion order). No NUL separator needed — structural JSON is unambiguous. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Lab computes the hash over {manifest, files} only; overlayMeta is additive and excluded from the hash. */
export function assembleBundle(
  manifest: ModuleManifest,
  files: Record<string, string>,
  overlayMeta?: OverlayManifestMeta,
): ModuleBundle {
  const canonical = stableStringify({ manifest, files });
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    manifest,
    files,
    bundleHash: `sha256:${hex}`,
    bundleContractVersion: MODULE_BUNDLE_CONTRACT_VERSION,
    ...(overlayMeta !== undefined ? { overlayMeta } : {}),
  };
}
