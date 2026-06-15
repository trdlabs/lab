// src/domain/overlay-manifest-meta.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deriveOverlayManifestMeta,
  OVERLAY_MANIFEST_VERSION,
  OVERLAY_INTERCEPTION_POINT,
  type OverlayManifestMeta,
} from './overlay-manifest-meta.ts';
import type { HypothesisProposal } from './hypothesis.ts';
import type { StrategyProfile } from './strategy-profile.ts';
import type { ModuleManifest } from './module-bundle.ts';

const labManifest: ModuleManifest = {
  moduleId: 'overlay-h1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: 'builder-sdk-v0',
};
// Only the fields the mapper reads are populated; cast keeps the unit test focused.
const hypothesis = { id: 'h1', thesis: 'Skip entries when oi trend persists', targetBehavior: 'filter entries' } as unknown as HypothesisProposal;
const profile = { id: 'p1', coreIdea: 'oi-based entry filter' } as unknown as StrategyProfile;

describe('deriveOverlayManifestMeta', () => {
  it('maps hypothesis + profile + lab manifest into the rich 017 overlay fields', () => {
    const meta = deriveOverlayManifestMeta(hypothesis, profile, labManifest);
    expect(meta).toEqual({
      id: 'overlay-h1',
      version: OVERLAY_MANIFEST_VERSION,
      name: 'filter entries',
      summary: 'Skip entries when oi trend persists',
      rationale: 'oi-based entry filter',
      author: 'agent',
      targetStrategyRef: 'strategy:p1',
      interceptionPoint: OVERLAY_INTERCEPTION_POINT,
      paramsSchema: { type: 'object', additionalProperties: false },
    } satisfies OverlayManifestMeta);
  });

  it('uses the agreed deterministic constants', () => {
    expect(OVERLAY_MANIFEST_VERSION).toBe('0.1.0');
    expect(OVERLAY_INTERCEPTION_POINT).toBe('post_entry_management');
  });

  it('is deterministic: identical inputs produce a deep-equal result', () => {
    expect(deriveOverlayManifestMeta(hypothesis, profile, labManifest))
      .toEqual(deriveOverlayManifestMeta(hypothesis, profile, labManifest));
  });

  it('does not import the platform SDK (lab-native, no contract mixing)', () => {
    const src = readFileSync(fileURLToPath(new URL('./overlay-manifest-meta.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('@trading-platform');
  });
});
