// src/domain/overlay-manifest-meta.ts
// Lab-native carrier for the rich 017 overlay-manifest fields. Deliberately no platform SDK
// import: the lab builder SDK contract and the platform 017 manifest contract stay separate. The
// platform projection (createOverlayManifest) happens only at the toSubmittedBundle wire boundary.
import type { HypothesisProposal } from './hypothesis.ts';
import type { StrategyProfile } from './strategy-profile.ts';
import type { ModuleManifest } from './module-bundle.ts';

/** Deterministic module version for SP-7.1b overlay manifests (platform requires only a non-empty string). */
export const OVERLAY_MANIFEST_VERSION = '0.1.0';
/** Canonical overlay interception point — matches the SDK overlay templates + 017 valid fixtures. */
export const OVERLAY_INTERCEPTION_POINT = 'post_entry_management';

/** Lab-native projection of the platform 017 OverlayManifestInput rich fields. */
export interface OverlayManifestMeta {
  id: string;
  version: string;
  name: string;
  summary: string;
  rationale: string;
  author: 'human' | 'agent';
  targetStrategyRef: string;
  interceptionPoint: string;
  paramsSchema: Record<string, unknown>;
}

/**
 * Deterministically derive the rich 017 overlay fields from research context. Pure: same inputs →
 * byte-identical output. Reads only labManifest.moduleId, hypothesis.targetBehavior/thesis,
 * profile.coreIdea/id; everything else is a deterministic constant / safe default.
 */
export function deriveOverlayManifestMeta(
  hypothesis: HypothesisProposal,
  profile: StrategyProfile,
  labManifest: ModuleManifest,
): OverlayManifestMeta {
  return {
    id: labManifest.moduleId,
    version: OVERLAY_MANIFEST_VERSION,
    name: hypothesis.targetBehavior,
    summary: hypothesis.thesis,
    rationale: profile.coreIdea,
    author: 'agent',
    targetStrategyRef: `strategy:${profile.id}`,
    interceptionPoint: OVERLAY_INTERCEPTION_POINT,
    paramsSchema: { type: 'object', additionalProperties: false },
  };
}
